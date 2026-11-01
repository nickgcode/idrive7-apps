'use strict';
/**
 * tv_handoff.js - a source's name and link from the viewer's phone to the car (Add source, and Rename /
 * new link), end-to-end encrypted through a mailbox, as G's Music's phone sign-in (ng_spotify/signin.js).
 * Node 8, no npm modules.
 *
 *   car                                     phone (static page, web/tv-source/)          mailbox (ntfy.sh)
 *   topic + key (random) ---QR--->          <page>#v=1&s=<topic>.<key>[&m=e&n=<name>]
 *   or a 6-digit code ---typed--->          <page> (no fragment): the code -> topic + key
 *                                           Name + Stream URL + "I have the right..." -> Send
 *                                           AES-256-GCM(key, {t:'source', s, name, url}) --POST--> <topic>
 *   polls both topics (one request) <-------------------------------------------------------------
 *   {t:'got'} --> phone: "check the car"; the car checks the link, the viewer taps Save or Cancel
 *   {t:'done', ok} --> phone: "Saved" / "Not saved"
 *
 * The QR code carries a random 256-bit key (the fragment never reaches a server). The 6-digit code is
 * the fallback for a phone that can't scan: topic and key come from the code through PBKDF2-SHA256
 * (100 000 rounds, salt "ng_tv/code/1"), so they are only as strong as a 6-digit number for the 10
 * minutes a code lives. What it protects is a link the viewer sends on purpose, and nothing is saved
 * without the viewer reading it on the car's screen and tapping Save; the phone page holds no secrets.
 */
const crypto = require('crypto');
const URL = require('url').URL;

const AAD = Buffer.from('ng_tv/1');
const LIFETIME = 10 * 60 * 1000;
const POLL_MS = 4000;                    // both topics in one request; ntfy.sh's anonymous limit refills one per 5 s after 60
const CODE_SALT = 'ng_tv/code/1';
const CODE_ROUNDS = 100000;
const TOPIC = /^[A-Za-z0-9_-]{16,64}$/;

function b64u(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64u(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}
function mailboxOf(m) {
    let u;
    try { u = new URL(String(m || '')); } catch (e) { return null; }
    if (u.protocol !== 'https:' || !u.hostname || u.port || u.search || u.hash || u.username) return null;
    return 'https://' + u.hostname + (u.pathname || '/').replace(/\/+$/, '');
}
/** Six random digits (no modulo bias). */
function newCode(rand) {
    rand = rand || crypto.randomBytes;
    for (;;) {
        const n = rand(4).readUInt32BE(0);
        if (n < 4294000000) return String(n % 1000000 + 1000000).slice(1);
    }
}
/** code -> { topic, key } (what the phone page does with WebCrypto). */
function fromCode(code, cb) {
    crypto.pbkdf2(String(code), CODE_SALT, CODE_ROUNDS, 48, 'sha256', (err, b) => {
        if (err) { cb(err); return; }
        cb(null, { topic: 'ngtvc_' + b64u(b.slice(0, 16)), key: b.slice(16, 48) });
    });
}
function parseState(state) {
    const p = String(state || '').split('.');
    if (p.length !== 2 || !TOPIC.test(p[0])) return null;
    const key = fromB64u(p[1]);
    return key.length === 32 ? { topic: p[0], key } : null;
}
function seal(key, obj, iv) {
    iv = iv || crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
    return b64u(Buffer.concat([iv, ct, c.getAuthTag()]));
}
function open(key, s) {
    const b = fromB64u(String(s || '').trim());
    if (b.length < 12 + 16 + 2 || b.length > 8192) throw new Error('size');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.slice(0, 12));
    d.setAAD(AAD);
    d.setAuthTag(b.slice(b.length - 16));
    return JSON.parse(Buffer.concat([d.update(b.slice(12, b.length - 16)), d.final()]).toString('utf8'));
}
function messages(text) {
    const out = [];
    String(text || '').split('\n').forEach((line) => {
        line = line.trim();
        if (!line) return;
        try { const m = JSON.parse(line); if (m && m.event === 'message' && typeof m.message === 'string' && typeof m.id === 'string') out.push(m); } catch (e) { /* skip */ }
    });
    return out;
}

/**
 * The car's side. net: tv_net.js (request()); cfg: { relay (the phone page, https), mailbox }.
 * phase: off | waiting | got | error.  got: { name, url, topic } once the phone sent something.
 */
class Handoff {
    constructor(net, log, cfg) {
        this.net = net; this.log = log; this.cfg = cfg || {};
        this.mailbox = mailboxOf(this.cfg.mailbox || 'https://ntfy.sh');
        this.s = null; this.phase = 'off'; this.message = ''; this.got = null;
        this._next = 0; this._busy = false;
    }
    configured() { return /^https:\/\/[^/#?]+/.test(this.cfg.relay || '') && !!this.mailbox && !!(this.net && this.net.request); }
    active() { return this.phase === 'waiting'; }
    /** A new QR code and 6-digit code. mode: { kind: 'add' | 'edit', id, name }. */
    start(mode, rand) {
        rand = rand || crypto.randomBytes;
        const topic = 'ngtv_' + b64u(rand(16)), key = rand(32), code = newCode(rand);
        const q = ['v=1', 's=' + topic + '.' + b64u(key)];
        const m = mode || { kind: 'add' };
        if (m.kind === 'edit') { q.push('m=e'); if (m.name) q.push('n=' + b64u(Buffer.from(String(m.name).slice(0, 32), 'utf8'))); }
        const s = { topic, key, code, mode: m, url: this.cfg.relay + '#' + q.join('&'), started: Date.now(), since: 'all', seen: {}, codeTopic: '', codeKey: null };
        this.s = s; this.phase = 'waiting'; this.message = ''; this.got = null; this._next = 0;
        fromCode(code, (err, d) => { if (!err && this.s === s) { s.codeTopic = d.topic; s.codeKey = d.key; } });
        this.log.info('handoff: started (' + m.kind + ')');
        return s;
    }
    cancel() { this.s = null; this.phase = 'off'; this.message = ''; this.got = null; }
    expired() { return !!this.s && this.phase === 'waiting' && Date.now() - this.s.started > LIFETIME; }
    left() { return this.s ? Math.max(0, LIFETIME - (Date.now() - this.s.started)) : 0; }
    codeText() { return this.s ? this.s.code.slice(0, 3) + ' ' + this.s.code.slice(3) : ''; }

    /** Call often: polls every POLL_MS while waiting; resolves the phone's message ({ name, url, ... }) once. */
    async tick() {
        if (this.phase !== 'waiting' || this._busy || Date.now() < this._next || !this.s) return null;
        this._busy = true; this._next = Date.now() + POLL_MS;
        const s = this.s;
        try {
            const topics = s.topic + (s.codeTopic ? ',' + s.codeTopic : '');
            const r = await this.net.request('GET', this.mailbox + '/' + topics + '/json?poll=1&since=' + encodeURIComponent(s.since), {}, null, 256 * 1024);
            if (s !== this.s) return null;
            if (r.status === 429) { this._next = Date.now() + 30000; this.message = 'Mailbox busy, waiting'; return null; }
            if (r.status !== 200) { this.message = 'Mailbox: HTTP ' + r.status; return null; }
            this.message = '';
            const list = messages(r.body.toString('utf8'));
            for (let i = 0; i < list.length; i++) {
                const m = list[i];
                if (s.seen[m.id]) continue;
                s.seen[m.id] = 1; s.since = m.id;
                const viaCode = m.topic === s.codeTopic && !!s.codeKey;
                const key = viaCode ? s.codeKey : s.key, topic = viaCode ? s.codeTopic : s.topic;
                let p;
                try { p = open(key, m.message); } catch (e) { continue; }          // not ours, or tampered: ignored
                if (!p || p.s !== topic || p.t !== 'source' || p.from === 'car') continue;
                this.got = { name: typeof p.name === 'string' ? p.name.slice(0, 200) : '', url: typeof p.url === 'string' ? p.url.slice(0, 4096) : '', topic, key, viaCode };
                this.phase = 'got';
                this.log.info('handoff: got a source from the phone' + (viaCode ? ' (code)' : ' (QR)'));
                this.ack({ t: 'got' });
                return this.got;
            }
        } catch (e) {
            if (s === this.s) this.message = 'No connection to the mailbox (' + (e.code || e.message) + ')';
        } finally { this._busy = false; }
        return null;
    }
    /** Tell the phone ({ t: 'got' } or { t: 'done', ok, error }). */
    ack(obj) {
        const g = this.got;
        if (!g || !this.net.request) return;
        obj.s = g.topic; obj.from = 'car';
        this.net.request('POST', this.mailbox + '/' + g.topic, { 'Content-Type': 'text/plain' }, seal(g.key, obj), 65536)
            .then(() => {}, (e) => this.log.warn('handoff: could not tell the phone (' + (e.code || e.message) + ')'));
    }
}

module.exports = { Handoff, seal, open, parseState, fromCode, newCode, messages, b64u, fromB64u, AAD, LIFETIME, CODE_SALT, CODE_ROUNDS };
