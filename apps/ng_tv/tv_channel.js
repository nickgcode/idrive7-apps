'use strict';
/**
 * tv_channel.js - the Spelunkr lineup: its channels, and what each one plays when.
 *
 * spelunkr.tv (the default source): https://data.spelunkr.tv/lineup.json lists the channels; a channel's
 * newest version in effect names its manifest (manifests/<channel>/v<n>.json), whose items are videos on
 * the Internet Archive: https://archive.org/download/<id>/<file> (progressive H.264 MP4, no DRM, no
 * sign-in; "moov" is the size of the file's index box). The site's own schedule also interleaves text
 * "bumps" with music and seeded ad breaks; G's TV doesn't: it plays the items in order, back to back,
 * from the version's epoch and start item, so where it is in a programme is close to the site's, not
 * the same.
 *
 * 0.4.0: every channel of the lineup a viewer can tune (CH UP / CH DOWN, the guide): those with a dial
 * number and a schedule; the site's test channels (debugOnly, "coming soon", no dial) stay hidden. Up
 * and down go by dial number and wrap around. A channel's manifest is fetched the first time it is
 * tuned or the guide shows it, and kept for 6 hours.
 *
 * config (app.json "config", or <data>/tv.json overriding it):
 *   lineupUrl   the lineup (default https://data.spelunkr.tv/lineup.json)
 *   channel     the channel tuned first (default "toonertia")
 *   streamUrl   (development) one MP4 played at start instead of the home screen, looped
 */
const fs = require('fs');
const path = require('path');
const url = require('url');

const DEFAULTS = { lineupUrl: 'https://data.spelunkr.tv/lineup.json', channel: 'toonertia', streamUrl: '' };
const KEEP_MS = 6 * 3600e3;
const FAMILY = { rewind: 'Rewind', archive: 'Archive', 'tv-series': 'TV series', film: 'Film', educational: 'Educational' };

function config(spec, dataDir, log) {
    const c = Object.assign({}, DEFAULTS, (spec && spec.config) || {});
    try {
        const own = JSON.parse(fs.readFileSync(path.join(dataDir, 'tv.json'), 'utf8'));
        Object.keys(DEFAULTS).forEach((k) => { if (typeof own[k] === 'string') c[k] = own[k]; });
        if (log) log.info('channel config from tv.json');
    } catch (e) { /* none */ }
    return c;
}

/** Text from the lineup for the screen: no control or direction-override characters, one line, at most max. */
function clean(s, max) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max - 1).replace(/\s+$/, '') + '\u2026' : s;
}

/* ---- the site's logomark colours (32 x 32 letters; '.' clear) ---- */
function hsv(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : mx === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
    return [h * 360, mx ? d / mx * 100 : 0, mx * 100];
}
function hex(h, s, v) {
    s /= 100; v /= 100;
    const f = (n) => { const k = (n + h / 60) % 6; const x = Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); return (x < 16 ? '0' : '') + x.toString(16); };
    return '#' + f(5) + f(3) + f(1);
}
function toward(h, to, step) { const d = (to - h + 540) % 360 - 180; return (h + Math.sign(d) * Math.min(step, Math.abs(d)) + 360) % 360; }
function palette(color) {
    const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color.toLowerCase() : '#666666';
    const hs = hsv(c);
    return { k: '#0b0f26', n: '#2a3580', s: '#8899cc', p: '#e8eaf0', g: '#ffd740', o: '#d2500c', c,
        d: hex(toward(hs[0], 255, 14), Math.min(100, hs[1] * 1.1), hs[2] * 0.6),
        l: hex(toward(hs[0], 50, 10), hs[1] * 0.6, hs[2] + (100 - hs[2]) * 0.6) };
}
/** logomark -> runs [[x, y, len, colour]] (one rect each), or null. */
function logoRuns(lm, color) {
    const rows = lm && Array.isArray(lm.rows) ? lm.rows.slice(0, 64) : null;
    if (!rows || !rows.length) return null;
    const P = palette(color), runs = [];
    rows.forEach((row, y) => {
        row = String(row).slice(0, 64);
        let x = 0;
        while (x < row.length) {
            const ch = row[x];
            let n = 1;
            while (x + n < row.length && row[x + n] === ch) n++;
            if (ch !== '.' && ch !== ' ') runs.push([x, y, n, P[ch] || '#888888']);
            x += n;
        }
    });
    return { n: rows.length, runs };
}

function pickVersion(ch, now) {
    const vs = (ch.versions || []).filter((v) => v && typeof v.manifest === 'string').sort((a, b) => a.v - b.v);
    let ver = null;
    vs.forEach((v) => { if ((v.effectiveAtMs || v.epochMs) <= now) ver = v; });
    return ver || vs[0] || null;
}

/** One channel's looped schedule (from its manifest). */
class Schedule {
    constructor(items, epochMs, startIndex, single) {
        this.items = items; this.epochMs = epochMs || 0; this.single = !!single;
        this.startIndex = Math.max(0, Math.min(startIndex || 0, items.length - 1));
        this.total = items.reduce((a, it) => a + it.duration, 0);
        this.loadedAt = Date.now();
    }
    /** What plays at time ms: { index, item, offset (s into the programme), startMs } (looped schedule). */
    at(ms) {
        if (this.single || !(this.total > 0)) return { index: 0, item: this.items[0], offset: 0, startMs: ms };
        let t = ((ms - this.epochMs) / 1000) % this.total;
        if (t < 0) t += this.total;
        let i = this.startIndex;
        for (let guard = 0; guard < this.items.length + 1; guard++) {
            const d = this.items[i].duration;
            if (t < d) return { index: i, item: this.items[i], offset: t, startMs: ms - t * 1000 };
            t -= d; i = (i + 1) % this.items.length;
        }
        return { index: this.startIndex, item: this.items[this.startIndex], offset: 0, startMs: ms };
    }
    next(index) { return this.single ? 0 : (index + 1) % this.items.length; }
    /** The programmes from the one before `from` through `to`: [{ index, item, startMs, endMs }]. */
    span(fromMs, toMs) {
        const out = [];
        if (this.single || !this.items.length) return out;
        const a = this.at(fromMs);
        let i = a.index, start = a.startMs;
        // the one before
        const pi = (i - 1 + this.items.length) % this.items.length;
        out.push({ index: pi, item: this.items[pi], startMs: start - this.items[pi].duration * 1000, endMs: start });
        for (let guard = 0; guard < 400 && start < toMs; guard++) {
            const it = this.items[i], end = start + it.duration * 1000;
            out.push({ index: i, item: it, startMs: start, endMs: end });
            start = end; i = (i + 1) % this.items.length;
        }
        return out;
    }
}

function itemsOf(man) {
    return (man && Array.isArray(man.items) ? man.items : []).filter((it) => it && typeof it.id === 'string' && (it.mp4 || it.file) && it.duration > 0).map((it) => ({
        href: 'https://archive.org/download/' + encodeURIComponent(it.id) + '/' + encodeURIComponent(String(it.mp4 || it.file)),
        title: clean(it.title || it.id, 120), year: clean(it.year || '', 12), duration: Number(it.duration),
        inS: Number(it.inS) || 0, moov: Number(it.moov) || 0,
    }));
}

/** The lineup: the channels a viewer can tune, sorted by dial; their schedules on demand. */
class Lineup {
    constructor(net, cfg, log) {
        this.net = net; this.cfg = cfg; this.log = log;
        this.channels = []; this.loadedAt = 0; this.scheds = new Map(); this.loading = new Map();
    }
    async load() {
        const j = await this.net.json(this.cfg.lineupUrl);
        const now = Date.now();
        const list = (j && Array.isArray(j.channels) ? j.channels : []).filter((c) => c && typeof c.id === 'string' &&
            !c.debugOnly && !c.comingSoon && c.dial != null && isFinite(Number(c.dial)) && pickVersion(c, now));
        this.channels = list.map((c) => ({
            id: c.id, dial: Number(c.dial), name: clean(c.name || c.id, 40), color: /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '#666666',
            family: typeof c.family === 'string' ? c.family : '', description: clean(c.description || '', 200),
            logo: logoRuns(c.logomark, c.color), ver: pickVersion(c, now),
        })).sort((a, b) => a.dial - b.dial || (a.id < b.id ? -1 : 1));
        this.loadedAt = now;
        this.log.info('lineup: ' + this.channels.length + ' channels');
        return this;
    }
    stale() { return !this.channels.length || Date.now() - this.loadedAt > KEEP_MS; }
    byId(id) { return this.channels.filter((c) => c.id === id)[0] || null; }
    /** The channel dir (+1 up, -1 down) steps away from id, by dial, wrapping around. */
    step(id, dir) { return step(this.channels, id, dir); }
    /** The families present, in the site's order: [{ id, name }]. */
    families() {
        const have = {};
        this.channels.forEach((c) => { if (c.family) have[c.family] = 1; });
        const known = Object.keys(FAMILY).filter((f) => have[f]);
        const other = Object.keys(have).filter((f) => !FAMILY[f]).sort();
        return known.concat(other).map((f) => ({ id: f, name: FAMILY[f] || clean(f.replace(/[-_]+/g, ' '), 16).replace(/^./, (x) => x.toUpperCase()) }));
    }
    peek(id) { const s = this.scheds.get(id); return s && Date.now() - s.loadedAt < KEEP_MS ? s : null; }
    /** The channel's schedule (fetched once, kept 6 h). */
    schedule(id) {
        const have = this.peek(id);
        if (have) return Promise.resolve(have);
        if (this.loading.has(id)) return this.loading.get(id);
        const ch = this.byId(id);
        if (!ch) return Promise.reject(new Error('channel "' + id + '" not in the lineup'));
        const p = this.net.json(url.resolve(this.cfg.lineupUrl, ch.ver.manifest)).then((man) => {
            const items = itemsOf(man);
            if (!items.length) throw new Error('channel has no playable items');
            const s = new Schedule(items, ch.ver.epochMs, ch.ver.startIndex);
            this.scheds.set(id, s);
            this.log.info('channel ' + id + ' v' + ch.ver.v + ': ' + items.length + ' items');
            return s;
        });
        this.loading.set(id, p);
        const done = () => this.loading.delete(id);
        p.then(done, done);
        return p;
    }
}

/** channels sorted by dial: the one dir steps from id, wrapping (an unknown id: the first / last). */
function step(channels, id, dir) {
    const n = channels.length;
    if (!n) return null;
    let i = -1;
    for (let k = 0; k < n; k++) if (channels[k].id === id) i = k;
    if (i < 0) return channels[dir > 0 ? 0 : n - 1].id;
    return channels[((i + (dir > 0 ? 1 : -1)) % n + n) % n].id;
}

module.exports = { Lineup, Schedule, config, clean, palette, logoRuns, step, itemsOf, pickVersion, DEFAULTS, FAMILY };
