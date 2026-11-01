'use strict';
/**
 * spotify.js - a small Spotify Web API client for the head unit (Node 8, no npm modules).
 *
 * Auth: the Authorization Code with PKCE flow is done on the car with the phone (signin.js: a QR code,
 * saveSignIn() below). It gives spotify-auth.json { client_id, refresh_token, ... }; from then on this client only refreshes (POST https://accounts.spotify.com/api/token,
 * grant_type=refresh_token, client_id - no secret with PKCE) and keeps the refresh token Spotify may
 * rotate, written atomically back into the same file. Nothing secret is in the package.
 *
 * Network: mgu-uplink (mgu-store) gives an app whose package.json says "mguInternet": true a route out and
 * writes the lease to <data>/uplink.json ({ interface, ip, dns: [...] , ... }, present only while online).
 * The unit's own resolver does not reach the internet, so host names are resolved through the lease's DNS
 * servers (as mgu-updater's fetch.js does). Offline, connections fail with EHOSTUNREACH.
 *
 * Endpoints (developer.spotify.com/documentation/web-api): GET /v1/me/player (204 = nothing playing),
 * PUT /v1/me/player/play | pause, POST /v1/me/player/next | previous, PUT /v1/me/player/seek?position_ms=,
 * PUT /v1/me/player/shuffle?state=, GET /v1/me/player/devices, GET /v1/me/player/recently-played, GET /v1/me/tracks, PUT /v1/me/player/repeat?state=track|context|off,
 * GET /v1/me/library/contains?uris=, PUT /v1/me/library?uris=.
 * Player commands are Premium-only (403 otherwise).
 * The Play button with nothing playing (start()): resumes what Spotify still has (GET /me/player, paused);
 * with no player state, the last track from GET /me/player/recently-played?limit=1 in its album / playlist
 * (PUT /me/player/play { context_uri, offset: { uri } }, else { uris: [track] }); with nothing to resume,
 * the Liked Songs (GET /me/tracks, paged, LIKED_CAP at most) shuffled here, LIKED_PLAY of them as a
 * uris list, with shuffle on. No active device: one from GET /me/player/devices (the last one seen
 * playing, else a phone, else the first) as device_id, which also moves playback there. Scopes:
 * recently-played needs user-read-recently-played, Liked Songs user-library-read; a sign-in without them
 * (the token's scope list, or Spotify's 403 on those reads) gives 'SCOPE': sign in again.
 * The Previous button (back()): as other players, more than RESTART_MS into the track restarts it
 * (seek to 0); otherwise the track before.
 */
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

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

const ACCOUNTS = 'accounts.spotify.com';
const API = 'api.spotify.com';
const MAX_BODY = 4 * 1024 * 1024;
const RESTART_MS = 3000;            // Previous: past this far into the track, back to its start instead
const LIKED_CAP = 300;              // start(): Liked Songs read at most (50 per page)
const LIKED_PLAY = 100;             // ... and played of them, picked at random, as one uris list
const SCOPE_RECENT = 'user-read-recently-played', SCOPE_LIBRARY = 'user-library-read';
/** start()'s own refusals, a short line for the screen as their message */
const START_CODES = ['SCOPE', 'NOPLAYER', 'EMPTY'];

function SpotifyError(message, code, status) {
    const e = new Error(message);
    e.code = code; e.status = status;
    return e;
}

class Spotify {
    constructor(dataDir, log) {
        this.dataDir = dataDir;
        this.log = log;
        this.authFile = path.join(dataDir, 'spotify-auth.json');
        this.auth = null;           // { client_id, refresh_token, ... } from authFile
        this.authMtime = 0;
        this.token = null;          // access token (1 h)
        this.tokenExp = 0;
        this.retryAt = 0;           // after a 429: no calls before (ms epoch)
        this.dead = null;           // the token endpoint refused this sign-in (SpotifyError)
        this.ca = null;
        this.lastDevice = '';       // the id of the device last seen in /me/player (start() prefers it)
        this._resolver = null; this._dnsKey = '';
    }

    /** (Re)read spotify-auth.json when it changed. Returns true when usable. */
    loadAuth() {
        let st;
        try { st = fs.statSync(this.authFile); } catch (e) { this.auth = null; return false; }
        if (this.auth && st.mtime.getTime() === this.authMtime) return true;
        try {
            const a = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
            if (!a || typeof a.client_id !== 'string' || typeof a.refresh_token !== 'string' || !a.client_id || !a.refresh_token) {
                throw new Error('needs "client_id" and "refresh_token"');
            }
            this.auth = a; this.authMtime = st.mtime.getTime();
            this.token = null; this.tokenExp = 0;
            this.authError = null;
            this.dead = null;       // a new file: try it
            this.log.info('spotify: sign-in file loaded (client ' + a.client_id.slice(0, 6) + '...)');
        } catch (e) {
            this.auth = null;
            this.authError = 'spotify-auth.json: ' + e.message;
            this.log.warn(this.authError);
            return false;
        }
        // optional: PEM roots to trust instead of Node's bundled ones, root-owned only (trustedCa)
        this.ca = trustedCa(this.dataDir);
        return true;
    }

    _saveAuth() {
        // a fresh temp file, created 600 (O_EXCL: never an old .tmp or a link someone left there,
        // whose mode writeFileSync would keep), chmod 600 against the umask, then renamed in place
        const tmp = this.authFile + '.tmp';
        try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
        const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        try {
            fs.writeSync(fd, JSON.stringify(this.auth, null, 2) + '\n');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, this.authFile);
        try { this.authMtime = fs.statSync(this.authFile).mtime.getTime(); } catch (e) { /* ignore */ }
    }

    /**
     * A new sign-in (the phone's QR sign-in, signin.js): written as spotify-auth.json (temp file + rename,
     * mode 600) and used at once; tok, Spotify's token answer, gives the first access token.
     */
    saveSignIn(auth, tok) {
        this.auth = auth;
        this._saveAuth();
        try { fs.chmodSync(this.authFile, 0o600); } catch (e) { /* the rename kept the temp file's mode */ }
        this.authError = null; this.dead = null; this.retryAt = 0;
        this.token = tok && tok.access_token ? tok.access_token : null;
        this.tokenExp = this.token ? Date.now() + (Number(tok.expires_in) || 3600) * 1000 : 0;
        this.ca = trustedCa(this.dataDir);
    }

    /** The uplink lease (mgu-uplink), or null while offline. */
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
        if (!servers.length) return undefined;            // system resolver (e.g. a PC)
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

    /** One HTTPS request: resolves { status, headers, body (Buffer) }. */
    request(method, host, pathname, headers, body) {
        return new Promise((resolve, reject) => {
            const opts = { method: method, host: host, port: 443, path: pathname, headers: headers || {}, timeout: 10000 };
            const lookup = this._lookup();
            if (lookup) opts.lookup = lookup;
            if (this.ca) opts.ca = this.ca;
            if (body != null) opts.headers['Content-Length'] = Buffer.byteLength(body);
            const req = https.request(opts, (res) => {
                const chunks = []; let n = 0;
                res.on('data', (c) => {
                    n += c.length;
                    if (n > MAX_BODY) { req.abort(); reject(SpotifyError('response too large', 'TOOBIG')); return; }
                    chunks.push(c);
                });
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
                res.on('error', reject);
            });
            req.on('timeout', () => { req.abort(); reject(SpotifyError('timed out', 'ETIMEDOUT')); });
            req.on('error', reject);
            if (body != null) req.write(body);
            req.end();
        });
    }

    async _refresh() {
        if (!this.auth && !this.loadAuth()) throw SpotifyError('not signed in', 'NOAUTH');
        // refused once: not asked again until spotify-auth.json changes (loadAuth clears it)
        if (this.dead) throw this.dead;
        const body = querystring.stringify({ grant_type: 'refresh_token', refresh_token: this.auth.refresh_token, client_id: this.auth.client_id });
        const r = await this.request('POST', ACCOUNTS, '/api/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
        let j = null;
        try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { /* not JSON */ }
        if (r.status !== 200 || !j || !j.access_token) {
            const err = j && j.error;
            // invalid_grant: the refresh token was revoked or expired (Spotify: 6 months after sign-in)
            if (err === 'invalid_grant') throw (this.dead = SpotifyError('sign-in expired or revoked (invalid_grant)', 'REAUTH', r.status));
            if (err === 'invalid_client') throw (this.dead = SpotifyError('Spotify does not accept the client_id in spotify-auth.json (invalid_client)', 'REAUTH', r.status));
            throw SpotifyError('token refresh failed: HTTP ' + r.status + (err ? ' ' + err : ''), 'TOKEN', r.status);
        }
        this.token = j.access_token;
        this.tokenExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
        if (j.refresh_token && j.refresh_token !== this.auth.refresh_token) {
            this.auth.refresh_token = j.refresh_token;
            this.auth.rotated = new Date().toISOString();
            try { this._saveAuth(); this.log.info('spotify: new refresh token saved'); } catch (e) { this.log.warn('spotify: could not save the new refresh token: ' + e.message); }
        }
        if (j.scope) this.scope = j.scope;
    }

    /** A Web API call: resolves { status, json }; body: an object sent as JSON. Throws SpotifyError for HTTP errors. */
    async api(method, pathname, query, body, again) {
        if (Date.now() < this.retryAt) throw SpotifyError('rate limited', 'RATE', 429);
        if (!this.token || Date.now() > this.tokenExp - 60000) await this._refresh();
        const qs = query ? '?' + querystring.stringify(query) : '';
        const hasBody = method === 'PUT' || method === 'POST';
        const headers = { Authorization: 'Bearer ' + this.token };
        if (body != null) headers['Content-Type'] = 'application/json';
        const r = await this.request(method, API, '/v1' + pathname + qs, headers, body != null ? JSON.stringify(body) : hasBody ? '' : null);
        let j = null;
        if (r.body.length) { try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { /* not JSON */ } }
        if (r.status === 401 && !again) { this.token = null; return this.api(method, pathname, query, body, true); }
        if (r.status === 429) {
            const s = Math.max(1, Math.min(600, Number(r.headers['retry-after']) || 10));
            this.retryAt = Date.now() + s * 1000;
            throw SpotifyError('rate limited for ' + s + ' s', 'RATE', 429);
        }
        if (r.status >= 400) {
            const e = j && j.error;
            const msg = (e && (e.message || e)) || ('HTTP ' + r.status);
            throw SpotifyError(String(msg), r.status === 403 ? 'FORBIDDEN' : r.status === 404 ? 'NODEVICE' : 'HTTP', r.status);
        }
        return { status: r.status, json: j };
    }

    /** Playback state, or null when nothing is playing (204). */
    async player() {
        const r = await this.api('GET', '/me/player', { additional_types: 'track,episode' });
        const j = r.status === 204 || !r.json ? null : r.json;
        if (j && j.device && j.device.id) this.lastDevice = j.device.id;
        return j;
    }

    /** The scopes this sign-in has (the token answer's list, else the one saved at sign-in), or null when unknown. */
    scopes() {
        const s = this.scope || (this.auth && typeof this.auth.scope === 'string' ? this.auth.scope : '');
        return s ? s.split(/\s+/).filter(Boolean) : null;
    }
    /** Does this sign-in surely lack scope (known list without it)? Unknown: false, the call tells. */
    lacks(scope) { const s = this.scopes(); return !!s && s.indexOf(scope) < 0; }
    /** A GET that needs scope: 'SCOPE' when the sign-in lacks it (known, or Spotify's 403). */
    async _scoped(scope, pathname, query) {
        if (this.lacks(scope)) throw SpotifyError('Sign in again to enable this', 'SCOPE', 403);
        try { return await this.api('GET', pathname, query); } catch (e) {
            if (e.status === 403) throw SpotifyError('Sign in again to enable this', 'SCOPE', 403);
            throw e;
        }
    }
    async devices() {
        const r = await this.api('GET', '/me/player/devices');
        return r.json && Array.isArray(r.json.devices) ? r.json.devices : [];
    }
    /** The device to play on when none is active: the last one seen, else a phone (likely the car's), else the first. */
    static pickDevice(list, lastId) {
        const ok = (list || []).filter((d) => d && d.id && !d.is_restricted);
        const act = ok.find((d) => d.is_active);
        return act || ok.find((d) => lastId && d.id === lastId) || ok.find((d) => /smartphone/i.test(d.type || '')) || ok[0] || null;
    }
    static isStartError(e) { return !!e && START_CODES.indexOf(e.code) >= 0; }
    /**
     * The Play button with nothing playing (see the top): resume, else the last track played, else the
     * Liked Songs shuffled. -> { how: 'resume' | 'recent' | 'liked', device, missing: [scope...] }
     * (missing: what a new sign-in would add, e.g. resume skipped for want of user-read-recently-played).
     * Throws 'NOPLAYER' (no device at all), 'SCOPE', 'EMPTY' with a message for the screen.
     */
    async start() {
        const st = await this.player();
        let dev = st && st.device && st.device.id && st.device.is_active ? st.device : null;
        if (!dev) {
            dev = Spotify.pickDevice(await this.devices(), (st && st.device && st.device.id) || this.lastDevice);
            if (!dev) throw SpotifyError('Open Spotify on your phone', 'NOPLAYER', 404);
        }
        const q = dev.is_active ? undefined : { device_id: dev.id };
        const out = { how: '', device: dev.name || '', missing: [] };
        // 1. Spotify still has it (paused): just play
        if (st && (st.item || st.context)) {
            await this.api('PUT', '/me/player/play', q, {});
            out.how = 'resume'; return out;
        }
        // 2. the last track played, in its album / playlist when it was played from one
        let last = null;
        try {
            const r = await this._scoped(SCOPE_RECENT, '/me/player/recently-played', { limit: 1 });
            last = r.json && Array.isArray(r.json.items) && r.json.items[0];
        } catch (e) {
            if (e.code !== 'SCOPE') throw e;
            out.missing.push(SCOPE_RECENT);
        }
        const tr = last && last.track && last.track.uri;
        if (tr) {
            const ctx = last.context && last.context.uri;
            if (ctx && /^spotify:(album|playlist):/.test(ctx)) {
                try { await this.api('PUT', '/me/player/play', q, { context_uri: ctx, offset: { uri: tr } }); out.how = 'recent'; return out; } catch (e) {
                    // gone, or the track no longer in it: the track alone
                    if (e.code === 'RATE' || e.status === 401 || e.status === 403 || !(e.status >= 400)) throw e;
                    this.log.warn('spotify: last context: ' + e.message + ', the track alone');
                }
            }
            await this.api('PUT', '/me/player/play', q, { uris: [tr] });
            out.how = 'recent'; return out;
        }
        // 3. the Liked Songs, shuffled
        let uris = [];
        try {
            for (let off = 0; off < LIKED_CAP; off += 50) {
                const r = await this._scoped(SCOPE_LIBRARY, '/me/tracks', { limit: 50, offset: off });
                const items = (r.json && Array.isArray(r.json.items)) ? r.json.items : [];
                items.forEach((it) => { const t = it && it.track; if (t && t.uri && !t.is_local && /^spotify:track:/.test(t.uri)) uris.push(t.uri); });
                if (items.length < 50 || !(r.json && r.json.next)) break;
            }
        } catch (e) {
            if (e.code !== 'SCOPE') throw e;
            out.missing.push(SCOPE_LIBRARY);
            throw SpotifyError('Sign in again to enable this', 'SCOPE', 403);
        }
        if (!uris.length) throw SpotifyError(out.missing.length ? 'Sign in again to enable this' : 'Nothing to resume and no Liked Songs', out.missing.length ? 'SCOPE' : 'EMPTY', 404);
        for (let i = uris.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const x = uris[i]; uris[i] = uris[j]; uris[j] = x; }
        uris = uris.slice(0, LIKED_PLAY);
        await this.api('PUT', '/me/player/play', q, { uris: uris });
        // shuffle on for the device now playing (a refusal here is not worth an error: the list is shuffled already)
        try { await this.api('PUT', '/me/player/shuffle', { state: 'true', device_id: dev.id }); } catch (e) { this.log.warn('spotify: shuffle on: ' + e.message); }
        out.how = 'liked'; return out;
    }
    play() { return this.api('PUT', '/me/player/play'); }
    pause() { return this.api('PUT', '/me/player/pause'); }
    next() { return this.api('POST', '/me/player/next'); }
    previous() { return this.api('POST', '/me/player/previous'); }
    /** Is the Previous button a restart at positionMs (the known / interpolated position)? */
    static restarts(positionMs) { return positionMs > RESTART_MS; }
    /** The Previous button: the track's start when past RESTART_MS (seek 0), else the track before. -> 'restart' | 'previous' */
    async back(positionMs) {
        if (Spotify.restarts(positionMs)) { await this.seek(0); return 'restart'; }
        await this.previous();
        return 'previous';
    }
    seek(ms) { return this.api('PUT', '/me/player/seek', { position_ms: Math.max(0, Math.round(ms)) }); }
    shuffle(on) { return this.api('PUT', '/me/player/shuffle', { state: on ? 'true' : 'false' }); }
    /** state: 'track' | 'context' | 'off' (PUT /v1/me/player/repeat?state=) */
    repeat(state) { return this.api('PUT', '/me/player/repeat', { state: state }); }
    async isSaved(uri) {
        const r = await this.api('GET', '/me/library/contains', { uris: uri });
        return Array.isArray(r.json) ? !!r.json[0] : null;
    }
    save(uri) { return this.api('PUT', '/me/library', { uris: uri }); }
    unsave(uri) { return this.api('DELETE', '/me/library', { uris: uri }); }

    /** Download an image (album art, https://i.scdn.co/...). */
    async image(href) {
        const m = /^https:\/\/([^/]+)(\/.*)$/.exec(href || '');
        if (!m) throw SpotifyError('bad image url', 'URL');
        const r = await this.request('GET', m[1], m[2], {}, null);
        if (r.status !== 200) throw SpotifyError('image: HTTP ' + r.status, 'HTTP', r.status);
        return r.body;
    }
}

module.exports = { Spotify, RESTART_MS, LIKED_CAP, LIKED_PLAY, SCOPE_RECENT, SCOPE_LIBRARY };
