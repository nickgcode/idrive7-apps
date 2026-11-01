'use strict';
/**
 * tv_sources.js - the viewer's own sources (tiles on the home screen) and what the app remembers.
 *
 * A source is a DIRECT link to one video file: MP4 with H.264 video, served with byte ranges, over
 * https or http. Nothing else is accepted: no web pages, no players, no playlists, no site-specific
 * extraction. The link comes from the viewer's phone (tv_handoff.js); the car checks it itself before
 * anything is saved (check()), and checks the text again here (the phone's checks don't count).
 *
 * <data>/tv-sources.json (mode 600):
 *   { v: 1, last: 'spelunkr' | '<source id>', channel: '<spelunkr channel id>',
 *     sources: [{ id, name, url, posS, durS, w, h, added, used }] }
 * posS: where the viewer left off (custom sources resume there).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const URL = require('url').URL;
const mp4 = require('./tv_mp4');

const MAX_NAME = 32;
const MAX_URL = 2048;
const MAX_SOURCES = 12;
const MAX_MOOV = 24 * 1024 * 1024;     // the index box the player would hold in memory

/** Name as typed on the phone -> one clean line, or '' (nothing usable). */
function cleanName(s) {
    if (typeof s !== 'string') return '';
    s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.slice(0, MAX_NAME).trim();
}

const BLOCKED_HOSTS = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$/i;
/** A literal address the car must not be pointed at: loopback, this host, link-local, multicast. */
function blockedIp(h) {
    h = h.replace(/^\[|\]$/g, '').toLowerCase();
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    if (m) {
        const a = Number(m[1]), b = Number(m[2]);
        return a === 127 || a === 0 || (a === 169 && b === 254) || a >= 224;
    }
    if (h.indexOf(':') >= 0) return h === '::1' || h === '::' || /^fe[89ab]/.test(h) || /^ff/.test(h) || /^::ffff:/.test(h);
    return false;
}

/**
 * The link as sent -> { ok: true, url } (normalised) or { ok: false, why }. http(s) only, a host, no
 * user name or password in it, at most MAX_URL characters, not the car itself.
 */
function checkUrl(s) {
    if (typeof s !== 'string') return { ok: false, why: 'No link' };
    s = s.trim();
    if (!s) return { ok: false, why: 'No link' };
    if (s.length > MAX_URL) return { ok: false, why: 'Link too long (at most ' + MAX_URL + ' characters)' };
    if (/[\u0000-\u0020\u007f-\u009f]/.test(s)) return { ok: false, why: 'Link has spaces or control characters' };
    let u;
    try { u = new URL(s); } catch (e) { return { ok: false, why: 'Not a web link' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, why: 'Only https:// or http:// links' };
    if (!u.hostname) return { ok: false, why: 'Link has no server' };
    if (u.username || u.password) return { ok: false, why: 'Links with a user name or password are not accepted' };
    if (BLOCKED_HOSTS.test(u.hostname) || blockedIp(u.hostname)) return { ok: false, why: 'That address is not on the internet' };
    u.hash = '';
    const out = u.toString();
    if (out.length > MAX_URL) return { ok: false, why: 'Link too long' };
    return { ok: true, url: out };
}

/** Host shown on a tile ("example.com"), never the whole link. */
function hostOf(s) { try { return new URL(s).hostname.replace(/^www\./, '').slice(0, 64); } catch (e) { return ''; } }

/**
 * Is this a video the player can play? Fetches the start of the file and its index, like the player.
 * Resolves { ok, checks: [{ name, ok, text }], info: { w, h, durS, codec } , why }.
 */
async function check(net, href) {
    const checks = [];
    const add = (name, ok, text) => { checks.push({ name, ok, text }); return ok; };
    const fail = (why) => ({ ok: false, why, checks });
    let r;
    try {
        r = await net.get(href, { Range: 'bytes=0-4095', Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.1' }, 70000);
    } catch (e) {
        if (e && e.code === 'TOOBIG') { add('Reachable', true, 'The server answered'); add('Video file', false, 'The server sends the whole file at once (no byte ranges)'); return fail('The server does not support seeking (byte ranges)'); }
        const off = e && /ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|ECONNRESET|NOLEASE/.test(e.code || '');
        add('Reachable', false, off ? 'Could not reach the server (' + (e.code || 'offline') + ')' : String(e && e.message || e).slice(0, 80));
        return fail(off ? 'Could not reach the server' : 'The server refused the link');
    }
    if (r.status >= 400 || (r.status !== 200 && r.status !== 206)) { add('Reachable', false, 'The server said HTTP ' + r.status); return fail('The server said HTTP ' + r.status); }
    add('Reachable', true, 'The server answered');
    const b = r.body || Buffer.alloc(0);
    const type = String(r.headers && r.headers['content-type'] || '').toLowerCase();
    const head = b.slice(0, 512).toString('latin1').replace(/^\ufeff/, '').trim().toLowerCase();
    const hls = /^#extm3u/.test(head) || /mpegurl/.test(type);
    if (hls || /text\/html|xhtml|json|javascript/.test(type) || /^</.test(head) || head.indexOf('<html') >= 0 || /^\{/.test(head)) {
        add('Video file', false, hls ? 'A playlist (HLS), not one video file' : 'A web page, not a video file');
        return fail(hls ? 'HLS playlists are not supported yet: send a direct MP4 link' : 'That is a web page, not a video file: send the direct link to the MP4');
    }
    if (r.status !== 206) { add('Video file', false, 'The server sends the whole file at once (no byte ranges)'); return fail('The server does not support seeking (byte ranges)'); }
    const top = mp4.box(b, 0);
    if (!top || top.type !== 'ftyp') { add('Video file', false, 'Not an MP4 file'); return fail('Not an MP4 file'); }
    add('Video file', true, 'MP4 (' + b.toString('latin1', 8, 12).replace(/[^\x20-\x7e]/g, '?') + ')');
    let v;
    try {
        v = await mp4.open(sizeGuard(net), href, 0);
    } catch (e) {
        add('H.264 video', false, e && e.code === 'TOOBIG' ? 'Its index is too large for the car' : 'Could not read the file\'s index (' + String(e && e.message || e).slice(0, 60) + ')');
        return fail('Could not read the video\'s index');
    }
    if (!v.avcC) { add('H.264 video', false, 'Video is ' + String(v.codec).replace(/[^\x20-\x7e]/g, '?') + ', not H.264'); return fail('The video is not H.264'); }
    add('H.264 video', true, 'H.264 ' + v.w + 'x' + v.h + (v.n && v.duration ? ', ' + (v.n / v.duration).toFixed(0) + ' fps' : ''));
    const durS = v.duration || 0;
    if (!(durS > 0)) { add('Length', false, 'No length in the file'); return fail('The file has no length'); }
    add('Length', true, clockText(durS));
    return { ok: true, checks, info: { w: v.w, h: v.h, durS, codec: v.codec } };
}
/** Refuse an index too big to hold (net.range asked for more than MAX_MOOV bytes). */
function sizeGuard(net) {
    return { range: (href, s, e) => (e - s + 1 > MAX_MOOV ? Promise.reject(Object.assign(new Error('index too large'), { code: 'TOOBIG' })) : net.range(href, s, e)) };
}
function clockText(s) {
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return h ? h + ' h ' + m + ' min' : m ? m + ' min' : s + ' s';
}

/** The remembered state, written atomically (temp file, rename), mode 600. */
/** A saved Spelunkr place, checked (the file is ours, but read it as if it were not). */
function cleanResume(r) {
    if (!r || typeof r !== 'object') return null;
    const num = (x) => (typeof x === 'number' && isFinite(x) && x >= 0 && x < 1e13 ? x : 0);
    if (typeof r.ch !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.ch)) return null;
    if (typeof r.href !== 'string' || r.href.length > 1000 || !/^https:\/\/[^\s]+$/.test(r.href)) return null;
    const title = typeof r.title === 'string' ? r.title.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) : '';
    return { ch: r.ch, href: r.href, title, inS: num(r.inS), dur: num(r.dur), posS: num(r.posS), at: num(r.at) };
}

class Store {
    constructor(dataDir, log) {
        this.file = path.join(dataDir || '.', 'tv-sources.json'); this.log = log;
        this.data = { v: 1, last: '', channel: '', sources: [], resume: null };
        this.load();
    }
    load() {
        let j = null;
        try { j = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return; }
        if (!j || typeof j !== 'object') return;
        const seen = {};
        const sources = (Array.isArray(j.sources) ? j.sources : []).map((s) => {
            if (!s || typeof s.id !== 'string' || !/^[a-z0-9]{6,24}$/.test(s.id) || seen[s.id]) return null;
            const name = cleanName(s.name), u = checkUrl(s.url);
            if (!name || !u.ok) return null;
            seen[s.id] = 1;
            const num = (x) => (typeof x === 'number' && isFinite(x) && x >= 0 ? x : 0);
            return { id: s.id, name, url: u.url, posS: num(s.posS), durS: num(s.durS), w: num(s.w), h: num(s.h), added: num(s.added), used: num(s.used) };
        }).filter(Boolean).slice(0, MAX_SOURCES);
        this.data = {
            v: 1, sources,
            last: typeof j.last === 'string' && (j.last === 'spelunkr' || seen[j.last]) ? j.last : '',
            channel: typeof j.channel === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(j.channel) ? j.channel : '',
            resume: cleanResume(j.resume),
        };
    }
    save() {
        const tmp = this.file + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
            fs.renameSync(tmp, this.file);
        } catch (e) { if (this.log) this.log.warn('sources: could not save (' + e.message + ')'); }
    }
    list() { return this.data.sources; }
    get(id) { return this.data.sources.filter((s) => s.id === id)[0] || null; }
    full() { return this.data.sources.length >= MAX_SOURCES; }
    /** Add { name, url, durS, w, h } (checked again here): the new source, or throws. */
    add(o) {
        const name = cleanName(o.name), u = checkUrl(o.url);
        if (!name) throw new Error('No name');
        if (!u.ok) throw new Error(u.why);
        if (this.full()) throw new Error('At most ' + MAX_SOURCES + ' sources: remove one first');
        const s = { id: crypto.randomBytes(6).toString('hex'), name, url: u.url, posS: 0, durS: o.durS || 0, w: o.w || 0, h: o.h || 0, added: Date.now(), used: 0 };
        this.data.sources.push(s);
        this.save();
        return s;
    }
    /** Change a source's name and / or link (a new link starts from the beginning). */
    update(id, o) {
        const s = this.get(id);
        if (!s) throw new Error('That source is gone');
        if (o.name != null) { const n = cleanName(o.name); if (!n) throw new Error('No name'); s.name = n; }
        if (o.url) {
            const u = checkUrl(o.url);
            if (!u.ok) throw new Error(u.why);
            if (u.url !== s.url) { s.url = u.url; s.posS = 0; s.durS = o.durS || 0; s.w = o.w || 0; s.h = o.h || 0; }
        }
        this.save();
        return s;
    }
    remove(id) {
        const n = this.data.sources.length;
        this.data.sources = this.data.sources.filter((s) => s.id !== id);
        if (this.data.last === id) this.data.last = '';
        if (this.data.sources.length !== n) this.save();
    }
    /** Where the viewer is in a source (saved at most every few seconds by the caller). */
    position(id, posS, durS) {
        const s = this.get(id);
        if (!s) return;
        s.posS = durS > 0 && posS > durS - 20 ? 0 : Math.max(0, posS);   // watched to the end: next time from the start
        if (durS > 0) s.durS = durS;
        this.save();
    }
    /**
     * 0.4.1: where the viewer stopped in a Spelunkr channel ({ ch, href, title, inS, dur, posS }: the
     * programme, not just the channel), so "Resume where I stopped" survives a restart. null: forget it.
     */
    setResume(r) {
        const c = r ? cleanResume(Object.assign({}, r, { at: Date.now() })) : null;
        const same = (x) => (x ? JSON.stringify(Object.assign({}, x, { at: 0 })) : 'null');
        if (same(c) === same(this.data.resume)) return;          // the same place: not written again
        this.data.resume = c;
        this.save();
    }
    setLast(key, channel) {
        let ch = false;
        if (key && this.data.last !== key) { this.data.last = key; ch = true; }
        if (channel && this.data.channel !== channel) { this.data.channel = channel; ch = true; }
        if (key && key !== 'spelunkr') { const s = this.get(key); if (s) { s.used = Date.now(); ch = true; } }
        if (ch) this.save();
    }
}

module.exports = { Store, cleanResume, check, checkUrl, cleanName, hostOf, clockText, MAX_NAME, MAX_URL, MAX_SOURCES };
