'use strict';
/**
 * tv_net.js - HTTP(S) for G's TV (Node 8, no npm modules): JSON, byte ranges of a video file, and the
 * phone hand-off's mailbox (request(): GET / POST). Plain http is allowed only for a source the viewer
 * added (a link from their own phone); the lineup and the mailbox are https.
 *
 * Network as G's Music (spotify.js): mgu-uplink gives an app with "mguInternet": true a route out and writes
 * its lease to <data>/uplink.json; the unit's own resolver doesn't reach the internet, so host names go
 * to the lease's DNS servers. Without a lease (a PC, the emulator) the system resolver is used.
 * Redirects (archive.org /download -> a data node) are followed, at most 5.
 */
const https = require('https');
const http = require('http');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const url = require('url');

/**
 * Optional ca.pem in the data folder: PEM roots to trust instead of Node's bundled ones (as
 * mgu-updater's ca_file). Only a regular file owned by root and not writable by group or others
 * counts: the app's own uid can write its data folder, so a file it (or anything running as it)
 * put there must not be able to replace the TLS roots. Anything else: null, Node's bundled roots.
 */
function trustedCa(dir) {
    const file = path.join(dir, 'ca.pem');
    try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022)) return null;
        return fs.readFileSync(file, 'utf8');
    } catch (e) { return null; }
}

const MAX_JSON = 16 * 1024 * 1024;

function NetError(message, code, status) {
    const e = new Error(message);
    e.code = code; e.status = status;
    return e;
}

class Net {
    constructor(dataDir, log) {
        this.dataDir = dataDir; this.log = log;
        this.agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
        this.plain = new http.Agent({ keepAlive: true, maxSockets: 2 });
        this.redirects = new Map();         // url -> final url (data node), kept while it works
        this.ca = trustedCa(dataDir);
        this.bytes = 0;
    }

    lease() {
        const files = [path.join(this.dataDir, 'uplink.json'), '/run/mgu-uplink/lease.json'];
        for (let i = 0; i < files.length; i++) {
            try {
                const l = JSON.parse(fs.readFileSync(files[i], 'utf8'));
                if (l && l.ip) return l;
            } catch (e) { /* next */ }
        }
        return null;
    }

    _lookup() {
        const l = this.lease();
        const servers = l && Array.isArray(l.dns) ? l.dns.filter((s) => typeof s === 'string' && s) : [];
        if (!servers.length) return undefined;
        const key = servers.join(',');
        if (key !== this._dnsKey) { this._resolver = new dns.Resolver(); this._resolver.setServers(servers); this._dnsKey = key; }
        const resolver = this._resolver;
        return (hostname, options, cb) => {
            if (typeof options === 'function') cb = options;
            resolver.resolve4(hostname, (err, addrs) => {
                if (err || !addrs || !addrs.length) { cb(err || new Error('no address for ' + hostname)); return; }
                cb(null, addrs[0], 4);
            });
        };
    }

    /** GET href: resolves { status, headers, body, url } (the final URL after redirects). */
    get(href, headers, maxBody, hops) { return this.request('GET', href, headers, null, maxBody, hops); }

    /**
     * method href (http: or https: only; GET redirects followed, at most 5): resolves
     * { status, headers, body, url }. body: a string or Buffer for POST.
     */
    request(method, href, headers, body, maxBody, hops) {
        hops = hops || 0;
        maxBody = maxBody || 1024 * 1024;
        return new Promise((resolve, reject) => {
            const u = url.parse(href);
            const tls = u.protocol === 'https:';
            if (!tls && u.protocol !== 'http:') { reject(NetError('only http(s) URLs', 'URL')); return; }
            if (!u.hostname) { reject(NetError('no host in the URL', 'URL')); return; }
            const opts = { method, host: u.hostname, port: u.port || (tls ? 443 : 80), path: u.path, agent: tls ? this.agent : this.plain,
                headers: Object.assign({ 'User-Agent': 'GsTV/0.4 (BMW iDrive 7 head unit)' }, headers || {}), timeout: 15000 };
            if (body != null) opts.headers['Content-Length'] = Buffer.byteLength(body);
            const lookup = this._lookup();
            if (lookup) opts.lookup = lookup;
            if (tls && this.ca) opts.ca = this.ca;
            const req = (tls ? https : http).request(opts, (res) => {
                if (method === 'GET' && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    if (hops >= 5) { reject(NetError('too many redirects', 'REDIRECT', res.statusCode)); return; }
                    const next = url.resolve(href, res.headers.location);
                    this.request(method, next, headers, null, maxBody, hops + 1).then(resolve, reject);
                    return;
                }
                const chunks = []; let n = 0, done = false;
                res.on('data', (c) => {
                    if (done) return;
                    n += c.length; this.bytes += c.length;
                    if (n > maxBody) { done = true; req.abort(); reject(NetError('response too large', 'TOOBIG')); return; }
                    chunks.push(c);
                });
                res.on('end', () => { if (!done) { done = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: href }); } });
                res.on('error', reject);
                res.setTimeout(20000, () => { req.abort(); reject(NetError('stalled', 'ETIMEDOUT')); });
            });
            req.on('timeout', () => { req.abort(); reject(NetError('timed out', 'ETIMEDOUT')); });
            req.on('error', reject);
            if (body != null) req.write(body);
            req.end();
        });
    }

    async json(href) {
        const r = await this.get(href, { Accept: 'application/json' }, MAX_JSON);
        if (r.status !== 200) throw NetError('HTTP ' + r.status + ' for ' + url.parse(href).hostname, 'HTTP', r.status);
        try { return JSON.parse(r.body.toString('utf8')); } catch (e) { throw NetError('not JSON from ' + url.parse(href).hostname, 'JSON'); }
    }

    /**
     * Bytes start..end (inclusive) of href: resolves { body, total }. The data node a redirect led to is
     * asked directly next time; when that fails, the original URL again.
     */
    async range(href, start, end) {
        const direct = this.redirects.get(href);
        const want = end - start + 1;
        const h = { Range: 'bytes=' + start + '-' + end };
        let r;
        try { r = await this.get(direct || href, h, want + 65536); } catch (e) {
            if (!direct) throw e;
            this.redirects.delete(href);
            r = await this.get(href, h, want + 65536);
        }
        if (r.status === 206) {
            if (r.url !== href) this.redirects.set(href, r.url);
            const cr = /\/(\d+)\s*$/.exec(r.headers['content-range'] || '');
            return { body: r.body, total: cr ? Number(cr[1]) : null };
        }
        if (direct && r.status >= 400) { this.redirects.delete(href); return this.range(href, start, end); }
        if (r.status === 200) throw NetError('the server ignores byte ranges', 'NORANGE', 200);
        throw NetError('HTTP ' + r.status, 'HTTP', r.status);
    }
}

module.exports = { Net, NetError };
