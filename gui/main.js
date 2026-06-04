const { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage } = require('electron');
const windowStateKeeper = require('electron-window-state');
const debug = /--debug/.test(process.argv[2]);
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const net = require('net');

// disable any dialog box!
const electron = require('electron');
const dialog = electron.dialog;
dialog.showErrorBox = function(title, content) {
    console.log(`${title}\n${content}`);
};

const setupEvents = require('./installers/windows/setupEvents');
const { UnsupportedSystemProxyError } = require('../src/utils/system-proxy');

if (setupEvents.handleSquirrelEvent()) {
    return;
}

let win, tray, proxy;
let Proxy;
let isOn = false;
let hasConfirmedSystemProxyThisLaunch = false;
const WINDOW_SIZE_PRESETS = {
    small: { width: 260, height: 260 },
    medium: { width: 300, height: 300 },
    large: { width: 360, height: 360 },
};
const SYSTEM_PROXY_CONFIRM_MESSAGE = 'Starting GreenTunnel with automatic system proxy enabled will temporarily change the system proxy settings. The settings will be restored when GreenTunnel is deactivated. Do you want to proceed?';
const LINUX_GNOME_REQUIREMENT_WARNING_MESSAGE = 'Automatic system proxy on Linux currently requires GNOME (gsettings). GreenTunnel was not enabled.';
const DEFAULT_PROXY_SETTINGS = {
    ip: '127.0.0.1',
    port: 8000,
    httpsOnly: false,
    dns: {
        type: 'https',
        server: 'https://cloudflare-dns.com/dns-query',
        ip: '8.8.8.8',
        port: 53,
    },
    systemProxy: true,
    tlsRecordFragmentation: false,
};
const PROXY_SETTINGS_FILE_NAME = 'proxy-settings.json';
const DNS_TYPES = new Set(['https', 'tls', 'unencrypted']);

const menuItems = [
    {
        label: 'Enable',
        type: 'normal',
        click: () => enableWithConfirmation(),
    },
    {
        label: 'Run At Login',
        type: 'checkbox',
    },
    {
        type: 'separator',
    },
    {
        label: 'Source Code',
        type: 'normal',
        click: () => shell.openExternal('https://github.com/SadeghHayeri/GreenTunnel'),
    },
    {
        label: 'Donate',
        type: 'normal',
        click: () => shell.openExternal('https://github.com/SadeghHayeri/GreenTunnel#donation'),
    },
    {
        label: 'Quit',
        type: 'normal',
        click: async () => {
            try {
                if (isOn) {
                    await turnOff();
                }
            } finally {
                app.quit();
            }
        },
    },
];
let proxySettings = cloneSettings(DEFAULT_PROXY_SETTINGS);

function cloneSettings(settings) {
    return JSON.parse(JSON.stringify(settings));
}

function getProxySettingsFilePath() {
    return path.join(app.getPath('userData'), PROXY_SETTINGS_FILE_NAME);
}

async function saveProxySettings(settings) {
    const filePath = getProxySettingsFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8');
}

async function loadProxySettings() {
    const defaults = cloneSettings(DEFAULT_PROXY_SETTINGS);
    const filePath = getProxySettingsFilePath();

    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return normalizeProxySettings(parsed);
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return defaults;
        }

        console.warn(
            `[GUI SETTINGS] Failed to load persisted settings from ${filePath}. Using defaults. ${String(error?.message || error)}`
        );
        return defaults;
    }
}

function assertValidPort(value, label) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`${label} must be an integer between 1 and 65535.`);
    }
}

function normalizeProxySettings(rawSettings) {
    const next = {
        ip: String(rawSettings?.ip ?? '').trim(),
        port: Number(rawSettings?.port),
        httpsOnly: Boolean(rawSettings?.httpsOnly),
        dns: {
            type: String(rawSettings?.dns?.type ?? '').trim(),
            server: String(rawSettings?.dns?.server ?? '').trim(),
            ip: String(rawSettings?.dns?.ip ?? '').trim(),
            port: Number(rawSettings?.dns?.port),
        },
        systemProxy: Boolean(rawSettings?.systemProxy),
        tlsRecordFragmentation: Boolean(rawSettings?.tlsRecordFragmentation),
    };

    if (!net.isIP(next.ip)) {
        throw new Error('IP must be a valid IP address.');
    }

    assertValidPort(next.port, 'Port');

    if (!DNS_TYPES.has(next.dns.type)) {
        throw new Error('DNS type must be one of: https, tls, unencrypted.');
    }

    try {
        // Keep behavior aligned with CLI (--dns-server validation)
        new URL(next.dns.server);
    } catch (error) {
        throw new Error('DNS server must be a valid URL.');
    }

    if (!net.isIP(next.dns.ip)) {
        throw new Error('DNS IP must be a valid IP address.');
    }

    assertValidPort(next.dns.port, 'DNS port');
    return next;
}

async function turnOff() {
    isOn = false;

    if (proxy) {
        await proxy.stop();
        proxy = null;
    }

    try {
        if (win && win.webContents) {
            win.webContents.send('changeStatus', isOn);
        }
    } catch (e) {}

    menuItems[0].label = 'Enable';
    menuItems[0].click = () => enableWithConfirmation();
    tray.setContextMenu(Menu.buildFromTemplate(menuItems));

    const iconPath = path.join(__dirname, 'images/iconDisabledTemplate.png');
    const trayIcon = nativeImage.createFromPath(iconPath);
    tray.setImage(trayIcon);
}

async function turnOn() {
    if (proxy) {
        await proxy.stop();
        proxy = null;
    }

    proxy = new Proxy({
        ip: proxySettings.ip,
        port: proxySettings.port,
        httpsOnly: proxySettings.httpsOnly,
        dns: {
            type: proxySettings.dns.type,
            server: proxySettings.dns.server,
            ip: proxySettings.dns.ip,
            port: proxySettings.dns.port,
        },
        source: 'GUI',
        tlsRecordFragmentation: proxySettings.tlsRecordFragmentation,
    });
    
    const startStatus = await proxy.start({setProxy: proxySettings.systemProxy});
    const warning = startStatus?.error;
    if (warning instanceof UnsupportedSystemProxyError) {
        await turnOff();
        await showLinuxGnomeRequirementWarning();
        return false;
    }
    isOn = true;

    win.webContents.send('changeStatus', isOn);

    menuItems[0].label = 'Disable';
    menuItems[0].click = () => turnOff();
    tray.setContextMenu(Menu.buildFromTemplate(menuItems));

    const iconPath = path.join(__dirname, 'images/IconTemplate.png');
    const trayIcon = nativeImage.createFromPath(iconPath);
    tray.setImage(trayIcon);
    return true;
}

async function confirmSystemProxyActivation() {
    const dialogOptions = {
        type: 'warning',
        buttons: ['Proceed', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: SYSTEM_PROXY_CONFIRM_MESSAGE,
    };

    const response = win
        ? await dialog.showMessageBox(win, dialogOptions)
        : await dialog.showMessageBox(dialogOptions);

    return response.response === 0;
}

async function showLinuxGnomeRequirementWarning() {
    const dialogOptions = {
        type: 'warning',
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
        message: LINUX_GNOME_REQUIREMENT_WARNING_MESSAGE,
    };

    const response = win
        ? await dialog.showMessageBox(win, dialogOptions)
        : await dialog.showMessageBox(dialogOptions);

    return response.response === 0;
}

async function enableWithConfirmation() {
    if (isOn) {
        return;
    }

    if (proxySettings.systemProxy) {
        if (!hasConfirmedSystemProxyThisLaunch) {
            const shouldProceed = await confirmSystemProxyActivation();
            if (!shouldProceed) {
                return;
            }
            hasConfirmedSystemProxyThisLaunch = true;
        }
    }

    await turnOn();
}

function createWindow() {
    const stateManager = windowStateKeeper();

    win = new BrowserWindow({
        width: 300,
        height: 300,
        x: stateManager.x,
        y: stateManager.y,
        maximizable: false,
        minimizable: true,
        fullscreenable: false,
        resizable: false,
        show: false,

        title: 'Green Tunnel',
        frame: false,
        transparent: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    // save states
    stateManager.manage(win);

    win.loadFile('./view/main-page/index.html');

    win.on('ready-to-show', function() {
        win.show();
        win.focus();
    });

    win.on('closed', () => {
        win = null;
    });

    if (debug)
        win.webContents.openDevTools();
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (win === null) {
        createWindow();
    }
});

app.whenReady().then(async () => {
    // green-tunnel is an ES module — must use dynamic import
    const gt = await import('green-tunnel');
    Proxy = gt.Proxy;
    proxySettings = await loadProxySettings();

    createWindow();

    const iconPath = path.join(__dirname, 'images/iconDisabledTemplate.png');
    const trayIcon = nativeImage.createFromPath(iconPath);
    tray = new Tray(trayIcon);
    tray.setToolTip('Green Tunnel');
    tray.setContextMenu(Menu.buildFromTemplate(menuItems));

    tray.on('double-click', () => {
        if (win.isVisible())
            win.hide();
        else
            win.show();
    });
});

app.on('before-quit', async (e) => {
    if (isOn) {
        e.preventDefault();
        await turnOff();
        app.quit();
    }
});

ipcMain.on('close-button', (event, arg) => {
    // Treat "close" as "disable" so system proxy is restored.
    // App will remain in tray (user can re-enable later).
    Promise.resolve()
        .then(async () => {
            if (isOn) await turnOff();
        })
        .finally(() => {
            if (os.platform() === 'darwin')
                app.hide();
            else if (win)
                win.hide();
        });
});

ipcMain.on('on-off-button', (event, arg) => {
    if (isOn)
        turnOff();
    else
        enableWithConfirmation();
});

ipcMain.on('set-window-size', (event, preset) => {
    const selectedPreset = WINDOW_SIZE_PRESETS[preset];
    if (!win || !selectedPreset) {
        return;
    }

    const [currentWidth, currentHeight] = win.getSize();
    const [currentX, currentY] = win.getPosition();
    const nextX = currentX + Math.round((currentWidth - selectedPreset.width) / 2);
    const nextY = currentY + Math.round((currentHeight - selectedPreset.height) / 2);

    // setBounds is more reliable for frameless non-resizable windows than setSize alone.
    win.setBounds({
        x: nextX,
        y: nextY,
        width: selectedPreset.width,
        height: selectedPreset.height,
    }, true);
});

ipcMain.handle('get-proxy-settings', () => {
    return cloneSettings(proxySettings);
});

ipcMain.handle('update-proxy-settings', async (event, nextSettings) => {
    const normalized = normalizeProxySettings(nextSettings);
    await saveProxySettings(normalized);
    proxySettings = normalized;

    if (isOn) {
        await turnOn();
    }

    return cloneSettings(proxySettings);
});

ipcMain.handle('reset-proxy-settings', async () => {
    const defaults = normalizeProxySettings(cloneSettings(DEFAULT_PROXY_SETTINGS));
    await saveProxySettings(defaults);
    proxySettings = defaults;

    if (isOn) {
        await turnOn();
    }

    return cloneSettings(proxySettings);
});
