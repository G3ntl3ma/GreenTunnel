import util from 'util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {exec as _exec, spawn} from 'child_process';
import Registry from 'winreg';
import getLogger from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = getLogger('system-proxy');
const exec = util.promisify(_exec);

export class UnsupportedSystemProxyError extends Error {
	constructor() {
		super([
			'================= ERROR ================',
			'GreenTunnel cannot enable automatic system proxy',
			'Reason: GNOME (gsettings) is required on Linux.',
			'Tip: run with --system-proxy=false and set the proxy manually',
			'========================================'
		].join('\n'));
		this.name = 'UnsupportedSystemProxyError';
		this.warningCode = 'LINUX_GNOME_REQUIRED';
	}
}

class SystemProxy {
	static async setProxy(ip, port) {
		throw new Error('You have to implement the method setProxy!');
	}
	static async unsetProxy() {
		throw new Error('You have to implement the method unsetProxy!');
	}
}

// TODO: Add path http_proxy and https_proxy
// TODO: Support for non-gnome
class LinuxSystemProxy extends SystemProxy {
	static initialSettings = null;

	//Check if GNOME is installed and can be used
	static async ensureSupported() {
		const desktop = String(process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase();
		if (!desktop.includes("gnome") && !desktop.includes("unity")) {
			throw new UnsupportedSystemProxyError();
		}

		try {
			const { stdout } = await exec('gsettings writable org.gnome.system.proxy mode');
			if (!/^true$/i.test(String(stdout || '').trim())) {
				throw new UnsupportedSystemProxyError();
			}
		} catch (error) {
			if (error instanceof UnsupportedSystemProxyError) {
				throw error;
			}

			throw new UnsupportedSystemProxyError();
		}
	}

	static async findInitialState() {
		if (this.initialSettings) {
			return;
		}

		const [modeRaw, httpHostRaw, httpPortRaw, httpsHostRaw, httpsPortRaw] = await Promise.all([
			exec('gsettings get org.gnome.system.proxy mode'),
			exec('gsettings get org.gnome.system.proxy.http host'),
			exec('gsettings get org.gnome.system.proxy.http port'),
			exec('gsettings get org.gnome.system.proxy.https host'),
			exec('gsettings get org.gnome.system.proxy.https port'),
		]);

		this.initialSettings = {
			mode: LinuxSystemProxy._parseGSettingsString(modeRaw.stdout),
			httpHost: LinuxSystemProxy._parseGSettingsString(httpHostRaw.stdout),
			httpPort: LinuxSystemProxy._parseGSettingsNumber(httpPortRaw.stdout),
			httpsHost: LinuxSystemProxy._parseGSettingsString(httpsHostRaw.stdout),
			httpsPort: LinuxSystemProxy._parseGSettingsNumber(httpsPortRaw.stdout),
		};
		logger.debug('[SYSTEM PROXY] captured initial linux proxy settings');
	}

	static _parseGSettingsString(rawValue) {
		const trimmed = String(rawValue || '').trim();
		if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
			return trimmed.slice(1, -1);
		}

		return trimmed;
	}

	static _parseGSettingsNumber(rawValue) {
		const matched = String(rawValue || '').match(/(-?\d+)\s*$/);
		if (!matched) {
			return 0;
		}

		const parsed = Number.parseInt(matched[1], 10);
		return Number.isNaN(parsed) ? 0 : parsed;
	}

	static _quoteShellString(value) {
		const normalizedValue = String(value || '');
		return `'${normalizedValue.replace(/'/g, `'\"'\"'`)}'`;
	}

	static async setProxy(ip, port) {
		await this.ensureSupported();
		await this.findInitialState();
		await exec('gsettings set org.gnome.system.proxy mode manual');
		await exec(`gsettings set org.gnome.system.proxy.http host ${LinuxSystemProxy._quoteShellString(ip)}`);
		await exec(`gsettings set org.gnome.system.proxy.http port ${port}`);
		await exec(`gsettings set org.gnome.system.proxy.https host ${LinuxSystemProxy._quoteShellString(ip)}`);
		await exec(`gsettings set org.gnome.system.proxy.https port ${port}`);
	}

	static async unsetProxy() {
		if (!this.initialSettings) {
			logger.debug('[SYSTEM PROXY] no initial linux proxy settings to restore');
			return;
		}

		await exec(`gsettings set org.gnome.system.proxy mode ${this.initialSettings.mode || 'none'}`);
		await exec(`gsettings set org.gnome.system.proxy.http host ${LinuxSystemProxy._quoteShellString(this.initialSettings.httpHost)}`);
		await exec(`gsettings set org.gnome.system.proxy.http port ${this.initialSettings.httpPort}`);
		await exec(`gsettings set org.gnome.system.proxy.https host ${LinuxSystemProxy._quoteShellString(this.initialSettings.httpsHost)}`);
		await exec(`gsettings set org.gnome.system.proxy.https port ${this.initialSettings.httpsPort}`);
		this.initialSettings = null;
		logger.debug('[SYSTEM PROXY] restored initial linux proxy settings');
	}
}

// TODO: Support for lan connections too
// TODO: move scripts to ../scripts/darwin
class DarwinSystemProxy extends SystemProxy {
	static initialSettings = null;

	static async findInitialState() {
		if (this.initialSettings) {
			return;
		}

		const wifiAdaptor = await DarwinSystemProxy._findWifiAdaptor();
		const [httpProxyRaw, httpsProxyRaw] = await Promise.all([
			exec(`networksetup -getwebproxy '${wifiAdaptor}'`),
			exec(`networksetup -getsecurewebproxy '${wifiAdaptor}'`),
		]);

		this.initialSettings = {
			wifiAdaptor,
			http: DarwinSystemProxy._parseProxyState(httpProxyRaw.stdout),
			https: DarwinSystemProxy._parseProxyState(httpsProxyRaw.stdout),
		};
		logger.debug('[SYSTEM PROXY] captured initial darwin proxy settings');
	}

	static _parseProxyState(rawValue) {
		const state = {
			enabled: false,
			server: '',
			port: 0,
		};

		for (const line of String(rawValue || '').split('\n')) {
			const separatorIndex = line.indexOf(':');
			if (separatorIndex === -1) {
				continue;
			}

			const key = line.slice(0, separatorIndex).trim();
			const value = line.slice(separatorIndex + 1).trim();
			if (key === 'Enabled') {
				state.enabled = /^yes$/i.test(value);
			} else if (key === 'Server') {
				state.server = value;
			} else if (key === 'Port') {
				const parsed = Number.parseInt(value, 10);
				state.port = Number.isNaN(parsed) ? 0 : parsed;
			}
		}

		return state;
	}

	static async _findWifiAdaptor() {
		return (await exec(`sh -c "networksetup -listnetworkserviceorder | grep \`route -n get 0.0.0.0 | grep 'interface' | cut -d ':' -f2\` -B 1 | head -n 1 | cut -d ' ' -f2"`)).stdout.trim();
	}

	static async setProxy(ip, port) {
		await this.findInitialState();
		const wifiAdaptor = await DarwinSystemProxy._findWifiAdaptor();

		await exec(`networksetup -setwebproxy '${wifiAdaptor}' ${ip} ${port}`);
		await exec(`networksetup -setsecurewebproxy '${wifiAdaptor}' ${ip} ${port}`);
	}

	static async unsetProxy() {
		if (!this.initialSettings) {
			logger.debug('[SYSTEM PROXY] no initial darwin proxy settings to restore');
			return;
		}

		const { wifiAdaptor, http, https } = this.initialSettings;

		if (http.enabled && http.server && http.port > 0) {
			await exec(`networksetup -setwebproxy '${wifiAdaptor}' ${http.server} ${http.port}`);
			await exec(`networksetup -setwebproxystate '${wifiAdaptor}' on`);
		} else {
			await exec(`networksetup -setwebproxystate '${wifiAdaptor}' off`);
		}

		if (https.enabled && https.server && https.port > 0) {
			await exec(`networksetup -setsecurewebproxy '${wifiAdaptor}' ${https.server} ${https.port}`);
			await exec(`networksetup -setsecurewebproxystate '${wifiAdaptor}' on`);
		} else {
			await exec(`networksetup -setsecurewebproxystate '${wifiAdaptor}' off`);
		}

		this.initialSettings = null;
		logger.debug('[SYSTEM PROXY] restored initial darwin proxy settings');
	}
}


class WindowsSystemProxy extends SystemProxy{
	static proxySettingsSchema = [
		{ name: 'ProxyEnable', type: Registry.REG_DWORD },
		{ name: 'ProxyServer', type: Registry.REG_SZ },
		{ name: 'ProxyOverride', type: Registry.REG_SZ },
		{ name: 'ProxyHttp1.1', type: Registry.REG_DWORD },
		{ name: 'MigrateProxy', type: Registry.REG_DWORD },
		{ name: 'AutoConfigURL', type: Registry.REG_SZ },
		{ name: 'AutoDetect', type: Registry.REG_DWORD },
	];

	static initialSettings = {};

static async findInitialState(regKey) {
		const settings = {};
		for (const setting of this.proxySettingsSchema) {
			const rawValue = await this._asyncRegGet(regKey, setting.name);
			if (!rawValue.exists) {
				settings[setting.name] = { exists: false, type: setting.type };
				continue;
			}

			settings[setting.name] = {
				exists: true,
				type: setting.type,
				value: this._normalizeRegValue(setting.type, rawValue.value),
			};
		}

		this.initialSettings = settings;
		logger.debug(`[SYSTEM PROXY] captured initial settings (${Object.keys(settings).join(', ')})`);
	}

	static async setProxy(ip, port) {
		const regKey = new Registry({
			hive: Registry.HKCU,
			key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
		});

        await this.findInitialState(regKey);
		try {
			await Promise.all([
				WindowsSystemProxy._asyncRegSet(regKey, 'MigrateProxy', Registry.REG_DWORD, 1),
				WindowsSystemProxy._asyncRegSet(regKey, 'ProxyEnable', Registry.REG_DWORD, 1),
				WindowsSystemProxy._asyncRegSet(regKey, 'ProxyHttp1.1', Registry.REG_DWORD, 0),
				WindowsSystemProxy._asyncRegSet(regKey, 'ProxyServer', Registry.REG_SZ, `${ip}:${port}`),
				// Avoid `<local>` here because underlying reg command parsing treats `<`/`>` as redirection.
				WindowsSystemProxy._asyncRegSet(regKey, 'ProxyOverride', Registry.REG_SZ, '*.local;localhost;127.*;[::1]'),
			]);
		} catch (regError) {
			throw regError;
		}
		await WindowsSystemProxy._resetWininetProxySettings();
	}

	static async unsetProxy() {
		const regKey = new Registry({
			hive: Registry.HKCU,
			key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
		});

		const restoreTasks = this.proxySettingsSchema.map(setting => {
			const initialSetting = this.initialSettings[setting.name];
			if (!initialSetting) {
				return Promise.resolve();
			}

			if (!initialSetting.exists) {
				return WindowsSystemProxy._asyncRegRemove(regKey, setting.name);
			}

			return WindowsSystemProxy._asyncRegSet(regKey, setting.name, setting.type, initialSetting.value);
		});

		await Promise.all(restoreTasks);
		logger.debug('[SYSTEM PROXY] restored initial proxy settings');
		await WindowsSystemProxy._resetWininetProxySettings();
	}

	static _asyncRegSet(regKey, name, type, value) {
		return new Promise((resolve, reject) => {
			regKey.set(name, type, value, e => {
				if (e) {
					reject(e);
				} else {
					resolve();
				}
			})
		});
	}
	static _asyncRegGet(regKey, name) {
		return new Promise((resolve, reject) => {
			regKey.get(name, (e, value) => {
				if (e) {
					if (WindowsSystemProxy._isRegValueMissingError(e)) {
						resolve({ exists: false });
						return;
					}

					reject(e);
				} else {
					resolve({ exists: true, value: value.value });
				}
			});
		});
	}
	static _asyncRegRemove(regKey, name) {
		return new Promise((resolve, reject) => {
			regKey.remove(name, e => {
				if (e) {
					if (WindowsSystemProxy._isRegValueMissingError(e)) {
						resolve();
						return;
					}
					reject(e);
				} else {
					resolve();
				}
			});
		});
	}

	static _isRegValueMissingError(error) {
		const message = String(error?.message || error || '');
		return /unable to find|not found|wurde nicht gefunden|nicht gefunden/i.test(message);
	}

	static _normalizeRegValue(type, value) {
		if (type !== Registry.REG_DWORD) {
			return value ?? '';
		}

		if (typeof value === 'number') {
			return value;
		}

		const raw = String(value).trim();
		if (!raw) {
			return 0;
		}

		const parsed = /^0x/i.test(raw) ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10);
		return Number.isNaN(parsed) ? 0 : parsed;
	}

	static _resetWininetProxySettings() {
		return new Promise((resolve, reject) => {
			const scriptPath = path.join(__dirname, '..', 'scripts', 'windows', 'wininet-reset-settings.ps1');
			const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { windowsHide: true });
			child.stdout.setEncoding('utf8');
			let settled = false;
			let out = '';
			let errOut = '';
			child.stdout.on("data", (data) => {
				out += String(data);
				if (data.includes('True')) {
					if (settled) return;
					settled = true;
					resolve();
				} else {
					// keep waiting for close; some environments don't print True
				}
			});

			child.stderr.on("data", (err) => {
				errOut += String(err);
				if (settled) return;
				settled = true;
				reject(err);
			});

			child.on('close', (code, signal) => {
				if (settled) return;
				settled = true;
				if (code === 0) {
					resolve();
				} else {
					reject(errOut || out || `wininet reset exited with code ${code}`);
				}
			});

			child.stdin.end();
		});
	}
}

function getSystemProxy() {
	switch (os.platform()) {
		case 'darwin':
			return DarwinSystemProxy;
		case 'linux':
			return LinuxSystemProxy;
		case 'win32':
		case 'win64':
			return WindowsSystemProxy;
		case 'unknown os':
		default:
			throw new Error(`UNKNOWN OS TYPE ${os.platform()}`);
	}
}

export async function setProxy(ip, port) {
	try {
		const systemProxy = getSystemProxy();
		await systemProxy.setProxy(ip, port);
	} catch (error) {
		logger.debug(`[SYSTEM PROXY] error on SetProxy (${error})`)
		throw error;
	}
}

export async function unsetProxy() {
	try {
		const systemProxy = getSystemProxy();
		await systemProxy.unsetProxy();
	} catch (error) {
		logger.debug(`[SYSTEM PROXY] error on UnsetProxy (${error})`)
		throw error;
	}
}


