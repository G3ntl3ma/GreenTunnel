#!/usr/bin/env node

import chalk from 'chalk';
import clear from 'clear';
import ora from 'ora';
import debug from 'debug';
import yargs from 'yargs';
import net from 'net';
import { createInterface } from 'readline/promises';
import { hideBin } from 'yargs/helpers';
import { Proxy, config, getLogger } from '../src/index.js';

const logger = getLogger('cli');
const SYSTEM_PROXY_CONFIRMATION_MESSAGE = 'The --system-proxy option overrides the current proxy settings. After GreenTunnel is closed, the settings will be restored. Type "yes" to proceed';
const SYSTEM_PROXY_WARNING_CODES = {
	LINUX_GNOME_REQUIRED: 'LINUX_GNOME_REQUIRED',
};
const DOH_PROBE_TIMEOUT_MS = 4000;
const DOH_PROBE_HOSTNAME = 'example.com';

const argv = yargs(hideBin(process.argv))
	.usage('Usage: green-tunnel [options]')
	.usage('Usage: gt [options]')
	.alias('help', 'h')
	.alias('version', 'V')

	.option('ip', {
		type: 'string',
		describe: 'ip address to bind proxy server',
		default: '127.0.0.1',
		coerce: val => {
			validateIpFlag('--ip', val);
			return val;
		}
	})

	.option('port', {
		type: 'number',
		describe: 'port address to bind proxy server',
		default: config.port,
		coerce: val => {
			validatePortFlag('--port', val);
			return val;
		}
	})

	.option('https-only', {
		type: 'boolean',
		describe: 'Block insecure HTTP requests',
		default: config.httpsOnly,
	})

	.option('dns-type', {
		type: 'string',
		choices: ['https', 'tls', 'unencrypted'],
		default: config.dns.type,
	})

	.option('dns-server', {
		type: 'string',
		default: config.dns.server,
		coerce: val => {
			validateDnsServerUrl(val);
			return val;
		}
	})

	.option('dns-ip', {
		type: 'string',
		default: config.dns.ip,
		coerce: val => {
			validateIpFlag('--dns-ip', val);
			return val;
		}
	})

	.option('dns-port', {
		type: 'number',
		default: config.dns.port,
		coerce: val => {
			validatePortFlag('--dns-port', val);
			return val;
		}
	})

	.option('silent', {
		alias: 's',
		type: 'boolean',
		describe: 'run in silent mode',
		default: false,
	})

	.option('verbose', {
		alias: 'v',
		type: 'boolean',
		describe: 'debug mode',
		default: false,
	})

	.option('system-proxy', {
		type: 'boolean',
		describe: 'automatic set system-proxy',
		default: true,
	})

	.option('yes', {
		type: 'boolean',
		describe: 'confirm system-proxy override in non-interactive mode',
		default: false,
	})

	.option('tls-record-fragmentation', {
		type: 'boolean',
		describe: 'enable TLS record fragmentation',
		default: false
	})

	.example('$0')
	.example('$0 --ip 127.0.0.1 --port 8000')
	.example('$0 --dns-server https://doh.securedns.eu/dns-query')
	.epilog('ISSUES:  https://github.com/SadeghHayeri/GreenTunnel/issues\n' +
		'DONATE:  https://github.com/SadeghHayeri/GreenTunnel#donation')
	.strict()
	.parseSync();

const MAIN_COLOR = '84C66F';

function createFlagValidationError(flagName, details, hint) {
	return new Error(`${flagName} is invalid: ${details}. ${hint}`);
}

function validateDnsServerUrl(dnsServer) {
	let parsedUrl;
	try {
		parsedUrl = new URL(dnsServer);
	} catch {
		throw createFlagValidationError('--dns-server', 'must be a valid URL', 'Use a DNS endpoint URL like https://cloudflare-dns.com/dns-query');
	}

	if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
		throw createFlagValidationError('--dns-server', 'must use http:// or https:// protocol', 'Use a DNS endpoint URL like https://cloudflare-dns.com/dns-query');
	}

	return parsedUrl;
}

function validatePortFlag(flagName, value) {
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw createFlagValidationError(flagName, 'must be an integer between 1 and 65535', 'Choose a port between 1 and 65535');
	}
}

function validateIpFlag(flagName, value) {
	if (!net.isIP(value)) {
		throw createFlagValidationError(flagName, 'must be a valid IPv4 or IPv6 address', 'Provide an address like 127.0.0.1');
	}
}

async function probeDoHServer(dnsServer) {
	const dohUrl = validateDnsServerUrl(dnsServer);
	dohUrl.searchParams.set('name', DOH_PROBE_HOSTNAME);
	dohUrl.searchParams.set('type', 'A');

	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, DOH_PROBE_TIMEOUT_MS);

	try {
		const response = await fetch(dohUrl.toString(), {
			headers: {Accept: 'application/dns-json'},
			signal: controller.signal,
		});

		if (!response.ok) {
			throw createFlagValidationError(
				'--dns-server',
				`DoH probe failed with HTTP status ${response.status}`,
				'Use a DNS-over-HTTPS endpoint that supports JSON DNS responses, for example https://cloudflare-dns.com/dns-query'
			);
		}

		let result;
		try {
			result = await response.json();
		} catch {
			throw createFlagValidationError(
				'--dns-server',
				'DoH probe response is not valid JSON',
				'Use a DNS-over-HTTPS endpoint that returns DNS JSON data'
			);
		}

		const hasIpv4Answer = Array.isArray(result.Answer)
			&& result.Answer.some(answer => typeof answer?.data === 'string' && net.isIP(answer.data));

		if (!hasIpv4Answer) {
			throw createFlagValidationError(
				'--dns-server',
				`DoH probe returned no usable A record for ${DOH_PROBE_HOSTNAME}`,
				'Use a DNS-over-HTTPS endpoint like https://cloudflare-dns.com/dns-query'
			);
		}
	} catch (error) {
		if (error?.name === 'AbortError') {
			throw createFlagValidationError(
				'--dns-server',
				`DoH probe timed out after ${DOH_PROBE_TIMEOUT_MS}ms`,
				'Use a reachable DNS-over-HTTPS endpoint'
			);
		}

		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function validateCliFlags() {
	validateIpFlag('--ip', argv['ip']);
	validatePortFlag('--port', argv['port']);

	const dnsType = argv['dns-type'];
	if (dnsType === 'https') {
		await probeDoHServer(argv['dns-server']);
	}

	if (dnsType === 'unencrypted') {
		validateIpFlag('--dns-ip', argv['dns-ip']);
		validatePortFlag('--dns-port', argv['dns-port']);
	}
}

function printBanner() {
	console.log();
	console.log('                          ' + chalk.bgHex(MAIN_COLOR)('    '));
	console.log('                       ' + chalk.bgHex(MAIN_COLOR)('          '));
	console.log('                      ' + chalk.bgHex(MAIN_COLOR)('            '));
	console.log('                      ' + chalk.bgHex(MAIN_COLOR)('     ') + '  ' + chalk.bgHex(MAIN_COLOR)('     '));
	console.log('                      ' + chalk.bgHex(MAIN_COLOR)('   ') + '      ' + chalk.bgHex(MAIN_COLOR)('   '));
	console.log('                      ' + chalk.bgHex(MAIN_COLOR)(' ') + '          ' + chalk.bgHex(MAIN_COLOR)(' '));
	console.log();
	console.log('                      ' + chalk.hex(MAIN_COLOR).bold('Green') + ' ' + chalk.bold.white('Tunnel'));
}

function printAlert(proxy) {
	console.log('\n');
	console.log('    ' + chalk.bgHex(MAIN_COLOR).black(' Note: GreenTunnel does not hide your IP address '));
	console.log('      ' + chalk.hex(MAIN_COLOR)(' https://github.com/SadeghHayeri/GreenTunnel '));
	console.log('\n      ' + chalk.white(` GreenTunnel is running at ${proxy.server.address().address}:${proxy.server.address().port}. `));
	console.log('\n\n\n\n\n' + chalk.white(`Press Ctrl+C to exit`))
}

function showSpinner() {
	console.log('');
	ora({
		indent: 27,
		text: '',
		color: 'green'
	}).start();
}

function printSystemProxyWarning(systemProxyWarning) {
	if (!systemProxyWarning) {
		return;
	}

	if (systemProxyWarning.code === SYSTEM_PROXY_WARNING_CODES.LINUX_GNOME_REQUIRED) {
		console.warn(chalk.yellow('\nWarning: Automatic system proxy is not supported on this Linux desktop.'));
		console.warn(chalk.yellow('GreenTunnel is running, but your system proxy settings were not changed.'));
		console.warn(chalk.yellow('Current support requires GNOME (gsettings).\n'));
	}
}

async function canProceedWithSystemProxy() {
	if (!argv['system-proxy']) {
		return true;
	}

	if (argv['yes']) {
		return true;
	}

	const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	if (!isInteractive) {
		throw new Error('The --yes option is required in non-interactive mode when --system-proxy=true.');
	}

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout
	});

	try {
		const answer = String(await rl.question(`${SYSTEM_PROXY_CONFIRMATION_MESSAGE} `)).trim().toLowerCase();
		return answer === 'yes' || answer === 'y';
	} finally {
		rl.close();
	}
}

async function main() {
	if (argv['verbose']) {
		debug.enable(argv['verbose']);
	}

	await validateCliFlags();

	const hasConfirmation = await canProceedWithSystemProxy();
	if (!hasConfirmation) {
		console.log('Startup canceled.');
		process.exit(0);
		return;
	}

	const proxy = new Proxy({
		ip: argv['ip'],
		port: parseInt(argv['port'], 10),
		httpsOnly: argv['https-only'],
		dns: {
			type: argv['dns-type'],
			server: argv['dns-server'],
			ip: argv['dns-ip'],
			port: argv['dns-port']
		},
		source: 'CLI',
		'tlsRecordFragmentation': argv['tls-record-fragmentation']
	});

	const exitTrap = async () => {
		logger.debug('Caught interrupt signal');
		await proxy.stop();
		logger.debug('Successfully Closed!');

		if (!argv['silent']) {
			clear();
		}
		process.exit(0);
	};

	const errorTrap = error => {
		logger.error(error);
	};

	process.on('SIGINT', exitTrap);
	process.on('SIGTERM', () => {
		exitTrap();
	});
	process.on('SIGBREAK', () => {
		exitTrap();
	});
	process.on('unhandledRejection', errorTrap);
	process.on('uncaughtException', errorTrap);

	const startStatus = await proxy.start({ setProxy: argv['system-proxy'] });
	printSystemProxyWarning(startStatus.systemProxyWarning);

	if (!argv['silent'] && !argv['verbose']) {
		clear();
		printBanner();
		printAlert(proxy);
		showSpinner();
	}
}

main().catch(error => {
	console.error(String(error?.message || error));
	process.exit(1);
});
