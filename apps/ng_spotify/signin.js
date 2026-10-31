'use strict';
/**
 * signin.js - sign in to Spotify with the phone: the car shows a QR code, the phone signs in, the car
 * gets the authorization code back through an end-to-end encrypted mailbox and trades it for tokens
 * itself. Node 8, no npm modules. See docs/spotify.md "Sign-in with the phone".
 *
 *   car                               phone                                  Spotify / mailbox
 *   verifier (stays here), challenge
 *   topic + key (random)  --QR-->     relay page  #v=1&s=<state>&c=<challenge>[&id=<client id>]
 *                                     asks for the client ID once (kept on the phone)
 *                                     -> accounts.spotify.com/authorize (PKCE S256, state)
 *                                     <- relay page ?code=&state=  (redirect URI = the relay page)
 *                                     AES-256-GCM(key, {code, client_id, redirect_uri})
 *                                       --POST--> mailbox/<topic>  (ntfy)
 *   polls mailbox/<topic> (uplink) <-------------------------------------------
 *   POST accounts /api/token (code + verifier) -> spotify-auth.json (mode 600)
 *   AES-GCM {done} --POST--> mailbox/<topic>  ->  the phone shows "signed in"
 *
 * state = <topic>.<key b64url>[.<mailbox b64url>]: Spotify hands it back unchanged, so the page after
 * the redirect knows where to post and with which key. The code alone is useless (PKCE: the verifier
 * never leaves the car), and the mailbox only ever sees ciphertext.
 */
const crypto = require('crypto');
const querystring = require('querystring');
const URL = require('url').URL;      // WHATWG URL (Node 7+)

const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
    'user-library-read', 'user-library-modify'];
const AAD = Buffer.from('ng_spotify/1');
const LIFETIME = 10 * 60 * 1000;          // a QR code is good for 10 minutes, then a new one is made
const POLL_MS = 4000;                     // ntfy.sh's anonymous limit refills one request per 5 s after a burst of 60
const CLIENT_ID = /^[0-9a-zA-Z]{16,64}$/;
const TOPIC = /^[A-Za-z0-9_-]{16,64}$/;

function b64u(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64u(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

/** PKCE (RFC 7636): a 64-byte verifier (86 chars) and its S256 challenge. */
function pkce(rand) {
    const verifier = b64u((rand || crypto.randomBytes)(64));
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    return { verifier: verifier, challenge: challenge };
}

/** https mailbox URL -> { host, base path } or null. */
function mailboxOf(m) {
    let u;
    try { u = new URL(String(m || '')); } catch (e) { return null; }
    if (u.protocol !== 'https:' || !u.hostname || u.port || u.search || u.hash || u.username) return null;
    return { host: u.hostname, base: (u.pathname || '/').replace(/\/+$/, ''), href: 'https://' + u.hostname + (u.pathname || '/').replace(/\/+$/, '') };
}

/**
 * A new sign-in: { verifier, challenge, topic, key, state, url (for the QR), clientId, mailbox, started }.
 * o = { relay, mailbox, defaultMailbox, clientId, rand (tests) }.
 */
function newSession(o) {
    const rand = o.rand || crypto.randomBytes;
    const p = pkce(rand);
    const topic = 'ngsp_' + b64u(rand(16));
    const key = rand(32);
    const mb = mailboxOf(o.mailbox);
    if (!mb) throw new Error('mailbox must be an https address');
    const other = o.defaultMailbox && mailboxOf(o.defaultMailbox) && mailboxOf(o.defaultMailbox).href === mb.href ? '' : '.' + b64u(Buffer.from(mb.href));
    const state = topic + '.' + b64u(key) + other;
    const q = ['v=1', 's=' + state, 'c=' + p.challenge];
    if (o.clientId && CLIENT_ID.test(o.clientId)) q.push('id=' + o.clientId);
    return {
        verifier: p.verifier, challenge: p.challenge, topic: topic, key: key, state: state,
        url: o.relay + '#' + q.join('&'), clientId: o.clientId || '', mailbox: mb, started: Date.now(),
    };
}

/** state -> { topic, key, mailbox } (what the relay page does in JavaScript; here for the tests). */
function parseState(state) {
    const p = String(state || '').split('.');
    if (p.length < 2 || p.length > 3 || !TOPIC.test(p[0])) return null;
    const key = fromB64u(p[1]);
    if (key.length !== 32) return null;
    return { topic: p[0], key: key, mailbox: p[2] ? fromB64u(p[2]).toString('utf8') : '' };
}

/** AES-256-GCM: b64url(iv 12 | ciphertext | tag 16), the layout WebCrypto's encrypt() gives (ct | tag). */
function seal(key, obj, iv) {
    iv = iv || crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
    return b64u(Buffer.concat([iv, ct, c.getAuthTag()]));
}
function open(key, s) {
    const b = fromB64u(String(s || '').trim());
    if (b.length < 12 + 16 + 2) throw new Error('short');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.slice(0, 12));
    d.setAAD(AAD);
    d.setAuthTag(b.slice(b.length - 16));
    return JSON.parse(Buffer.concat([d.update(b.slice(12, b.length - 16)), d.final()]).toString('utf8'));
}

/** ntfy's /json?poll=1 answer (one JSON object per line) -> its "message" events. */
function messages(text) {
    const out = [];
    String(text || '').split('\n').forEach((line) => {
        line = line.trim();
        if (!line) return;
        try { const m = JSON.parse(line); if (m && m.event === 'message' && typeof m.message === 'string') out.push(m); } catch (e) { /* skip */ }
    });
    return out;
}

/**
 * The car's side. sp: the Spotify client (its request() uses the uplink's DNS; saveSignIn() writes
 * spotify-auth.json). cfg: signin_config.js. phase: off | waiting | exchanging | done | error.
 */
class QrSignIn {
    constructor(sp, log, cfg) {
        this.sp = sp; this.log = log; this.cfg = cfg || {};
        this.s = null; this.phase = 'off'; this.message = ''; this.doneAt = 0;
        this._next = 0; this._busy = false; this._since = 'all'; this._seen = {};
    }
    configured() { return /^https:\/\/[^/#?]+/.test(this.cfg.relay || '') && !!mailboxOf(this.cfg.mailbox); }
    active() { return this.phase === 'waiting' || this.phase === 'exchanging'; }
    /** A new QR code (and a new verifier, topic and key). clientId: the one the car knows, if any. */
    start(clientId) {
        this.s = newSession({ relay: this.cfg.relay, mailbox: this.cfg.mailbox, defaultMailbox: 'https://ntfy.sh', clientId: clientId });
        this.phase = 'waiting'; this.message = ''; this._next = 0; this._since = 'all'; this._seen = {};
        this.log.info('spotify: phone sign-in started (QR for ' + this.cfg.relay + ')');
        return this.s;
    }
    cancel() { this.s = null; this.phase = 'off'; this.message = ''; }
    expired() { return !!this.s && Date.now() - this.s.started > LIFETIME; }
    left() { return this.s ? Math.max(0, LIFETIME - (Date.now() - this.s.started)) : 0; }

    /** Call often (every 0.5 s is fine): polls the mailbox every POLL_MS while waiting. Resolves true when signed in. */
    async tick() {
        if (this.phase !== 'waiting' || this._busy || Date.now() < this._next) return false;
        this._busy = true; this._next = Date.now() + POLL_MS;
        const s = this.s;
        try {
            const r = await this.sp.request('GET', s.mailbox.host, s.mailbox.base + '/' + s.topic + '/json?poll=1&since=' + encodeURIComponent(this._since), {}, null);
            if (s !== this.s) return false;
            if (r.status === 429) { this._next = Date.now() + 30000; this.message = 'mailbox busy, waiting'; return false; }
            if (r.status !== 200) { this.message = 'mailbox: HTTP ' + r.status; return false; }
            this.message = '';
            const list = messages(r.body.toString('utf8'));
            for (let i = 0; i < list.length; i++) {
                const m = list[i];
                if (this._seen[m.id]) continue;
                this._seen[m.id] = 1; this._since = m.id;
                let p;
                try { p = open(s.key, m.message); } catch (e) { continue; }     // not ours (or tampered): ignore
                if (!p || p.s !== s.topic) continue;
                if (p.t === 'error') { this.phase = 'error'; this.message = p.error === 'access_denied' ? 'Sign-in was cancelled on the phone' : 'Spotify said: ' + String(p.error).slice(0, 80); return false; }
                if (p.t === 'code' && typeof p.code === 'string') return await this._exchange(s, p);
            }
        } catch (e) {
            if (s === this.s) this.message = 'no connection to the mailbox (' + (e.code || e.message) + ')';
        } finally { this._busy = false; }
        return false;
    }

    async _exchange(s, p) {
        this.phase = 'exchanging';
        const clientId = CLIENT_ID.test(p.client_id || '') ? p.client_id : s.clientId;
        const redirect = typeof p.redirect_uri === 'string' && /^https:\/\//.test(p.redirect_uri) ? p.redirect_uri : this.cfg.relay;
        const fail = (msg) => {
            this.phase = 'error'; this.message = msg;
            this._ack(s, { t: 'done', ok: false, error: msg });
            return false;
        };
        if (!clientId) return fail('the phone sent no Client ID: scan the code again');
        let r, j = null;
        try {
            r = await this.sp.request('POST', 'accounts.spotify.com', '/api/token', { 'Content-Type': 'application/x-www-form-urlencoded' },
                querystring.stringify({ grant_type: 'authorization_code', code: p.code, redirect_uri: redirect, client_id: clientId, code_verifier: s.verifier }));
            try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { /* not JSON */ }
        } catch (e) { return fail('could not reach Spotify (' + (e.code || e.message) + ')'); }
        if (s !== this.s) return false;
        if (r.status !== 200 || !j || !j.refresh_token) {
            const err = (j && (j.error_description || j.error)) || 'HTTP ' + r.status;
            this.log.warn('spotify: phone sign-in: token exchange refused: ' + err);
            return fail('Spotify refused the sign-in: ' + err);
        }
        try {
            this.sp.saveSignIn({ client_id: clientId, refresh_token: j.refresh_token, scope: j.scope || '', created: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), via: 'phone' }, j);
        } catch (e) { return fail('could not save the sign-in: ' + e.message); }
        this.phase = 'done'; this.message = ''; this.doneAt = Date.now();
        this.log.info('spotify: signed in with the phone (client ' + clientId.slice(0, 6) + '...)');
        this._ack(s, { t: 'done', ok: true });
        return true;
    }

    _ack(s, obj) {
        obj.s = s.topic; obj.from = 'car';
        this.sp.request('POST', s.mailbox.host, s.mailbox.base + '/' + s.topic, { 'Content-Type': 'text/plain' }, seal(s.key, obj))
            .then(() => {}, (e) => this.log.warn('spotify: phone sign-in: could not tell the phone: ' + (e.code || e.message)));
    }
}

module.exports = { QrSignIn, newSession, parseState, seal, open, messages, pkce, mailboxOf, b64u, fromB64u, SCOPES, LIFETIME };
