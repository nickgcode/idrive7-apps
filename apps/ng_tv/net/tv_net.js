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
const url = require('url');
// the uplink lease, its DNS servers and the optional root-owned ca.pem (kit/uplink.js), as G's Music uses them
const uplink = require('./kit/uplink');

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
        this.ca = uplink.trustedCa(dataDir);
        this.bytes = 0;
        this._lookupFor = uplink.resolver();     // the lease's DNS servers (_lookup)
    }

    lease() { return uplink.lease(this.dataDir); }

    /** http(s).request's lookup through the lease's DNS servers; undefined: the system resolver */
    _lookup() { return this._lookupFor(this.lease()); }

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

    /**
     * Several byte ranges of href in one request (0.7.0, the sound: a programme's audio is hundreds of small
     * pieces between the video's): list = [[start, end] inclusive, ...] -> [Buffer, ...] in the same order.
     * The server answers multipart/byteranges (archive.org does, 600 ranges in one request) or, when it joined
     * them, one range covering them all; each asked range is cut out of whatever came. Redirects as range().
     */
    async ranges(href, list) {
        if (!list.length) return [];
        if (list.length === 1) return [(await this.range(href, list[0][0], list[0][1])).body];
        const want = list.reduce((a, r) => a + r[1] - r[0] + 1, 0);
        const h = { Range: 'bytes=' + list.map((r) => r[0] + '-' + r[1]).join(',') };
        const direct = this.redirects.get(href);
        let r;
        try { r = await this.get(direct || href, h, want + list.length * 160 + 65536); } catch (e) {
            if (!direct) throw e;
            this.redirects.delete(href);
            r = await this.get(href, h, want + list.length * 160 + 65536);
        }
        if (direct && r.status >= 400) { this.redirects.delete(href); return this.ranges(href, list); }
        if (r.status === 200) throw NetError('the server ignores byte ranges', 'NORANGE', 200);
        if (r.status !== 206) throw NetError('HTTP ' + r.status, 'HTTP', r.status);
        if (r.url !== href) this.redirects.set(href, r.url);
        const parts = [];
        const ct = String(r.headers['content-type'] || ''), bm = /boundary=("?)([^";]+)\1/i.exec(ct);
        if (/multipart\/byteranges/i.test(ct) && bm) parts.push.apply(parts, multipart(r.body));
        else {
            const cr = /bytes\s+(\d+)-(\d+)/.exec(r.headers['content-range'] || '');
            if (!cr) throw NetError('no Content-Range in the answer', 'HTTP', 206);
            parts.push({ s: Number(cr[1]), e: Number(cr[2]), body: r.body });
        }
        return list.map((q) => {
            const p = parts.filter((x) => x.s <= q[0] && x.e >= q[1])[0];
            if (!p) throw NetError('range ' + q[0] + '-' + q[1] + ' missing from the answer', 'RANGE', 206);
            return p.body.slice(q[0] - p.s, q[1] - p.s + 1);
        });
    }
}

/** The parts of a multipart/byteranges body: [{ s, e, body }] (each part's length from its Content-Range). */
function multipart(b) {
    const out = [];
    let p = 0;
    for (let guard = 0; guard < 100000; guard++) {
        const hs = b.indexOf('Content-Range:', p, 'latin1') >= 0 ? b.indexOf('Content-Range:', p, 'latin1') : b.indexOf('content-range:', p, 'latin1');
        if (hs < 0) break;
        const he = b.indexOf('\r\n\r\n', hs, 'latin1');
        if (he < 0) break;
        const m = /bytes\s+(\d+)-(\d+)/i.exec(b.toString('latin1', hs, he));
        if (!m) break;
        const s = Number(m[1]), e = Number(m[2]), start = he + 4;
        if (start + (e - s + 1) > b.length) throw NetError('a byte range was cut short', 'RANGE', 206);
        out.push({ s, e, body: b.slice(start, start + e - s + 1) });
        p = start + (e - s + 1);
    }
    return out;
}

module.exports = { Net, NetError };
