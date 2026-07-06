import util from 'util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {exec as _exec, execFile as _execFile, spawn} from 'child_process';
import Registry from 'winreg';
import getLogger from '../logger.js';
import { resetWininetSettings } from '../scripts/windows/wininet-reset-settings.js';
import { reset } from 'koffi';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = getLogger('system-proxy');
const exec = util.promisify(_exec);
const execFile = util.promisify(_execFile);

export class UnsupportedSystemProxyError extends Error {
	constructor() {
		super([
			'================= ERROR ================',
			'GreenTunnel cannot enable automatic system proxy',
			'Reason: a writable GSettings proxy schema (gsettings/dconf) was not found.',
			'This needs a GNOME/GTK-based desktop session (GNOME, Unity, Xfce, Cinnamon, MATE, ...).',
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
// Support is capability-based: any session where the GSettings proxy schema is
// present and writable works (GNOME, Unity, Xfce, Cinnamon, MATE, ...)
class LinuxSystemProxy extends SystemProxy {
	static initialSettings = null;

	static _gsettingsGet(schema, key) {
		return execFile('gsettings', ['get', schema, key]);
	}

	static _gsettingsSet(schema, key, value) {
		return execFile('gsettings', ['set', schema, key, String(value)]);
	}

	// Verify the requirements for GreenTunnel to function on Linux are given
	static async ensureSupported() {
		let writable;
		try {
			writable = await execFile('gsettings', ['writable', 'org.gnome.system.proxy', 'mode']);
		} catch {
			// gsettings binary missing, schema not installed, or no dconf session.
			throw new UnsupportedSystemProxyError();
		}

		if (!/^true$/i.test(String(writable.stdout || '').trim())) {
			throw new UnsupportedSystemProxyError();
		}
	}

	static async findInitialState() {
		if (this.initialSettings) {
			return;
		}

		const [modeRaw, httpHostRaw, httpPortRaw, httpsHostRaw, httpsPortRaw] = await Promise.all([
			LinuxSystemProxy._gsettingsGet('org.gnome.system.proxy', 'mode'),
			LinuxSystemProxy._gsettingsGet('org.gnome.system.proxy.http', 'host'),
			LinuxSystemProxy._gsettingsGet('org.gnome.system.proxy.http', 'port'),
			LinuxSystemProxy._gsettingsGet('org.gnome.system.proxy.https', 'host'),
			LinuxSystemProxy._gsettingsGet('org.gnome.system.proxy.https', 'port'),
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

	// gsettings prints strings wrapped in single quotes, e.g. 'none' or '127.0.0.1'.
	static _parseGSettingsString(rawValue) {
		const trimmed = String(rawValue || '').trim();
		if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
			return trimmed.slice(1, -1);
		}

		return trimmed;
	}

	static _parseGSettingsNumber(rawValue) {
		const parsed = Number.parseInt(String(rawValue || '').trim(), 10);
		return Number.isNaN(parsed) ? 0 : parsed;
	}

	static async setProxy(ip, port) {
		await this.ensureSupported();
		await this.findInitialState();
		await LinuxSystemProxy._gsettingsSet('org.gnome.system.proxy', 'mode', 'manual');
		await LinuxSystemProxy._gsettingsSet('org.gnome.system.proxy.http', 'host', ip);
		await LinuxSystemProxy._gsettingsSet('org.gnome.system.proxy.http', 'port', port);
		await LinuxSystemProxy._gsettingsSet('org.gnome.system.proxy.https', 'host', ip);
		await LinuxSystemProxy._gsettingsSet('org.gnome.system.proxy.https', 'port', port);
	}

	static async unsetProxy() {
		if (!this.initialSettings) {
			logger.debug('[SYSTEM PROXY] no initial linux proxy settings to restore');
			return;
		}

		await LinuxSystemProxy._gsettingsSet('org.gnome.system.proxy', 'mode', this.initialSettings.mode || 'none');
		await LinuxSystemProxy._gsettingsSet('org.gnome.system.proxy.http', 'host', this.initialSettings.httpHost);
		await LinuxSystemProxy._gsettingsSet('org.gnome.system.proxy.http', 'port', this.initialSettings.httpPort);
		await LinuxSystemProxy._gsettingsSet('org.gnome.system.proxy.https', 'host', this.initialSettings.httpsHost);
		await LinuxSystemProxy._gsettingsSet('org.gnome.system.proxy.https', 'port', this.initialSettings.httpsPort);
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
		resetWininetSettings();
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


