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
import { UnsupportedSystemProxyError } from '../src/utils/system-proxy.js';

const logger = getLogger('cli');
const systemProxyConfirmationMessage = 'The --system-proxy option overrides the current proxy settings.\nAfter GreenTunnel is closed, the settings will be restored.\nType "yes" to proceed';
const DOHProbeTimeoutMS = 4000;
const DOHProbeHostname = 'example.com';

//Check all options given, check for typos and validate all options
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
	dohUrl.searchParams.set('name', DOHProbeHostname);
	dohUrl.searchParams.set('type', 'A');

	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, DOHProbeTimeoutMS);

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
				`DoH probe returned no usable A record for ${DOHProbeHostname}`,
				'Use a DNS-over-HTTPS endpoint like https://cloudflare-dns.com/dns-query'
			);
		}
	} catch (error) {
		if (error?.name === 'AbortError') {
			throw createFlagValidationError(
				'--dns-server',
				`DoH probe timed out after ${DOHProbeTimeoutMS}ms`,
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

//Print out all Info for the CLI
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
	console.log('      ' + chalk.hex(MAIN_COLOR)(' https://github.com/SadeghHayeri/GreenTunnel \n\n'));

	console.log(chalk.white(`proxy-server-address:\t\t${argv['ip']}`))
	console.log(chalk.white(`proxy-server-port:\t\t${argv['port']}`))
	console.log(chalk.white(`https-only:\t\t\t${argv['https-only']}`))
	console.log(chalk.white(`TLS Record Fragmentation:\t${argv['tls-record-fragmentation']}`))
	console.log(chalk.white(`DNS Type:\t\t\t${argv['dns-type']}`));

	if(argv["dns-type"]=== "unencrypted"){
		console.log(chalk.white(`DNS-Server :\t\t\t${argv['dns-server']}`));
		console.log(chalk.white(`DNS Port:\t\t\t${argv['dns-port']}`));
	}
}

function showSpinner() {
	console.log('');
	ora({
		indent: 27,
		text: '',
		color: 'green'
	}).start();
	console.log('\n\n' + chalk.white(`Press Ctrl+C to exit`) + '\n\n\n')
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
		const answer = String(await rl.question(`${systemProxyConfirmationMessage} `)).trim().toLowerCase();
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

	//confirm that the user is ok with overwriting the system proxy settings
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

	//close the application properly. Make sure all system settings are restored
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
	const warning = startStatus?.error;
    if (warning instanceof UnsupportedSystemProxyError) {
		throw warning;
	}

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
