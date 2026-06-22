import net from 'net';
import dnsSocket from 'dns-socket';


const ProbeTimeoutMS = 4000;
const ProbeHostname = 'example.com';

export class FlagValidationError extends Error {
    constructor(flag, detail, example) {
        super(`${flag} is invalid: ${detail}. ${example}`);
        this.name = 'FlagValidationError';
        this.warningCode = 'INVALID_FLAG';
    }
}

//Strictly validate all flags where extensive validation is necessary
//Flags validated: --ip, --port, --dns-server, --dns-ip, --dns-port
export async function validateFlags(args){
//--ip and --port
if (!net.isIP(args["ip"])) {
    throw new FlagValidationError('--ip', 'must be a valid IPv4 or IPv6 address', 'Provide an address like 127.0.0.1');
}

if (!Number.isInteger(args["port"]) || args["port"] < 1 || args["port"] > 65535) {
    throw new FlagValidationError('--port', 'must be an integer between 1 and 65535', 'Choose a port between 1 and 65535');
}
//test if valid proxy can be created
await probeBindAddress(args["ip"], args["port"]);

//--dns-server
if(args["dns-type"] === "https"){
    await probeDoHServer(args["dns-server"]);
}

//--dns-ip and --dns-port
if(args["dns-type"] === "unencrypted"){
    if (!net.isIP(args["dns-ip"])) {
        throw new FlagValidationError('--dns-ip', 'must be a valid IPv4 or IPv6 address', 'Provide an address like 127.0.0.1');
    }
    if (!Number.isInteger(args["dns-port"]) || args["dns-port"] < 1 || args["dns-port"] > 65535) {
        throw new FlagValidationError('--dns-port', 'must be an integer between 1 and 65535', 'Choose a port between 1 and 65535');
    }
    await probeUnencryptedDns(args["dns-ip"], args["dns-port"]);
}

}

//test if with the values given with --ip and --port can actually create a proxy
async function probeBindAddress(ip, port) {
return new Promise((resolve, reject) => {
    const server = net.createServer();
    const cleanup = () => {
        server.removeAllListeners();
        server.close(() => resolve());
    };

    server.once('error', err => {
        server.close(() => reject(err));
    });

    server.listen(port, ip, () => {
        cleanup();
    });
});
}


async function probeDoHServer(dnsServer) {
let dohUrl;
try {
    dohUrl = new URL(dnsServer);
} catch {
    throw new FlagValidationError('--dns-server', 'must be a valid URL', 'Use a DNS endpoint URL like https://cloudflare-dns.com/dns-query');
}

if (dohUrl.protocol !== 'https:' && dohUrl.protocol !== 'http:') {
    throw new FlagValidationError('--dns-server', 'must use http:// or https:// protocol', 'Use a DNS endpoint URL like https://cloudflare-dns.com/dns-query');
}
dohUrl.searchParams.set('name', ProbeHostname);
dohUrl.searchParams.set('type', 'A');

const controller = new AbortController();
const timeoutId = setTimeout(() => {
    controller.abort();
}, ProbeTimeoutMS);

try {
    const response = await fetch(dohUrl.toString(), {
        headers: {Accept: 'application/dns-json'},
        signal: controller.signal,
    });

    if (!response.ok) {
        throw new FlagValidationError(
            '--dns-server',
            `DoH probe failed with HTTP status ${response.status}`,
            'Use a DNS-over-HTTPS endpoint that supports JSON DNS responses, for example https://cloudflare-dns.com/dns-query'
        );
    }

    let result;
    try {
        result = await response.json();
    } catch {
        throw new FlagValidationError(
            '--dns-server',
            'DoH probe response is not valid JSON',
            'Use a DNS-over-HTTPS endpoint that returns DNS JSON data'
        );
    }

    const hasIpv4Answer = Array.isArray(result.Answer)
        && result.Answer.some(answer => typeof answer?.data === 'string' && net.isIP(answer.data));

    if (!hasIpv4Answer) {
        throw new FlagValidationError(
            '--dns-server',
            `DoH probe returned no usable A record for ${ProbeHostname}`,
            'Use a DNS-over-HTTPS endpoint like https://cloudflare-dns.com/dns-query'
        );
    }
} catch (error) {
    if (error?.name === 'AbortError') {
        throw new FlagValidationError(
            '--dns-server',
            `DoH probe timed out after ${ProbeTimeoutMS}ms`,
            'Use a reachable DNS-over-HTTPS endpoint'
        );
    }

    throw error;
} finally {
    clearTimeout(timeoutId);
}
}

async function probeUnencryptedDns(dnsIp, dnsPort){

return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
        reject(new FlagValidationError(`--dns-ip`, `DNS probe timed out after ${ProbeTimeoutMS}ms`, ""));
    }, ProbeTimeoutMS);
    const dnsProbeSocket = dnsSocket();
    dnsProbeSocket.query(
        {
            questions: [{ type: 'A', name: ProbeHostname }],
        },
        dnsPort,
        dnsIp,
        (err, res) => {
            clearTimeout(timer);
            if (err) {
                reject(err);
                return;
            }
            const answer = res?.answers?.find(
                a => a.type === 'A' && typeof a.data === 'string' && net.isIP(a.data)
            );
            if (!answer) {
                reject(new FlagValidationError("--dns-ip", `DNS probe returned no usable A record for ${probeHostname}`, ""));
                return;
            }
            resolve(answer.data);
        }
    );
});
}