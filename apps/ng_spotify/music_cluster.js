'use strict';
/**
 * music_cluster.js - G's Music in the instrument cluster's centre map area (0.6.0), through the
 * Cluster renderer tool (cluster-render 0.2.2, PROTOCOL.md): while a track plays, its synced lyrics
 * (LRCLIB, lyrics.js: the line playing large, the next one dim) or a visualizer (the head unit's own,
 * viz.js: the same bars, colours and motion; the title and the artist above it) between the dials.
 *
 * Two opaque image layers on the "map" target, class "content", never exclusive, never "alert":
 *   text  z 60  TEXT_W x TEXT_H (half the map's 1088 x 480), drawn over the whole map, bilinear:
 *               the black background, the words, the progress line. Written only when what it shows
 *               changes, and then only the changed bands (dirty rects); fps TEXT_FPS at most.
 *   bars  z 61  BARS_W x BARS_H shown BARS_SC times (BARS_SHOW_W x BARS_SHOW_H), bilinear: the visualizer only,
 *               at BARS_FPS at most, and then only the bars' changed columns (dirty rects); on Pause
 *               the bars settle to rest (as on the screen, ~2 s) and then nothing is sent.
 * z 60/61: over Waze's map (z 0) and G's Dash's logo (z 50), under G's TV (z 100). Like the logo,
 * the layers hide while G's TV draws on the map and while route guidance runs (debounced
 * GUIDE_ON_MS / GUIDE_OFF_MS), and come back HOLD_MS after G's TV stops.
 * Both go (dropped, the connection closed) when: the setting is Off, G's Dash's Cluster source pick is
 * not Auto or Music (0.6.1, s.source), no track, paused for more than
 * PAUSE_DROP_MS, the app closes, or the renderer keeps failing them (ERR_RETRIES).
 *
 * The client is the tool's own, loaded at run time from /var/opt/cluster-render/current (root-owned
 * only); NG_CR_CLIENT / NG_CR_SOCK point the tests at a stand-in.
 *
 * Node 8: no optional chaining, no ??, no object spread.
 */
const fs = require('fs');
const path = require('path');
const VIZ = require('./viz');

const CLIENT = process.env.NG_CR_CLIENT || '/var/opt/cluster-render/current/cluster_render_client.js';
const SOCK = process.env.NG_CR_SOCK || '/dev/shm/cluster-render/render.sock';
const TESTING = !!(process.env.NG_CR_CLIENT || process.env.NG_CR_SOCK);

const TARGET = 'map', MAP_W = 1088, MAP_H = 480;
const KLASS = 'content', Z_TEXT = 60, Z_BARS = 61;
const TEXT_W = 544, TEXT_H = 240, TEXT_FPS = 4;
// the bars: drawn at a third of the shown size (bilinear smooths them up), the head unit's stage shape
const BARS_SC = 3, BARS_W = 288, BARS_H = 54, BARS_FPS = 12;
const BARS_SHOW_W = BARS_W * BARS_SC, BARS_SHOW_H = BARS_H * BARS_SC;     // 864 x 162 (the screen's stage: ~5.4 : 1)
const BARS_X = Math.round((MAP_W - BARS_SHOW_W) / 2), BARS_Y = 185;
const BARS_COLS = 13;                                // dirty-rect column groups (3 bars each; the client merges at 16)
const BAND = 16;                                     // rows per dirty-rect band of the text image
const POLL_MS = 1000, HOLD_MS = 3000, FRESH_MS = 2000, LOAD_RETRY_MS = 30000, RECONNECT_MS = 8000;
const GUIDE_ON_MS = 1000, GUIDE_OFF_MS = 3000;
const ERR_RETRY_MS = 5000, ERR_RETRIES = 3;
const PAUSE_DROP_MS = 30000;
const PROGRESS_MS = 3000;                            // the progress line is redrawn no more often
const LEAD_MS = 250;                                 // a lyric line a moment early, as on the screen

/* ----- the client (as G's Dash's cluster_logo.js) ----- */

function trusted(file) {
    try {
        const real = fs.realpathSync(file);
        const st = fs.statSync(real), dir = fs.statSync(path.dirname(real));
        return st.isFile() && st.uid === 0 && !(st.mode & 0o022) && dir.uid === 0 && !(dir.mode & 0o022);
    } catch (e) { return false; }
}
const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };

function loadClient(opts) {
    const o = opts || {};
    const file = o.client || CLIENT, sock = o.sock || SOCK, testing = o.testing !== undefined ? o.testing : TESTING;
    if (!exists(file)) {
        return exists(sock) ? { error: 'noclient', text: 'Cluster renderer client missing - update the tool' }
            : { error: 'missing', text: 'Cluster renderer not installed (Store)' };
    }
    if (!testing && !trusted(file)) return { error: 'untrusted', text: 'Cluster renderer client not trusted' };
    try {
        const m = require(file);
        if (!m || typeof m.ClusterRender !== 'function') return { error: 'load', text: 'Cluster renderer client not recognised' };
        return { ClusterRender: m.ClusterRender, sock: o.sock || process.env.NG_CR_SOCK || m.DEFAULT_PATH || SOCK };
    } catch (e) {
        return { error: 'load', text: 'Cluster renderer client failed to load', detail: e.message };
    }
}

/* ----- the map's other layers, from the status text ----- */

/** Other apps' layers on the map: [{ id, kind, app, klass, z, state, frames }]. */
function mapLayers(text, ownApp) {
    const out = [];
    let last = null;
    String(text || '').split('\n').forEach((line) => {
        if (last && /^\s/.test(line)) {
            const f = /^\s+(\d+) (sent|writes)\b/.exec(line);
            if (f) last.frames = +f[1];
            return;
        }
        last = null;
        const m = /^layer (\d+) (\w+) of (\S+) on (\w+), (\w+) z (-?\d+): (\w+)/.exec(line);
        if (!m || m[4] !== TARGET || m[3] === ownApp) return;
        last = { id: +m[1], kind: m[2], app: m[3], klass: m[5], z: +m[6], state: m[7], frames: -1 };
        out.push(last);
    });
    return out;
}
/** Our own layers on the map in the status text: [{ id, state }]. */
function ownLayers(text, ownApp) {
    const out = [];
    String(text || '').split('\n').forEach((line) => {
        const m = /^layer (\d+) \w+ of (\S+) on (\w+), \w+ z -?\d+: (\w+)/.exec(line);
        if (m && m[3] === TARGET && m[2] === ownApp) out.push({ id: +m[1], state: m[4] });
    });
    return out;
}
/** Whether a listed layer is really drawing (shown, or waiting with frames still moving). */
function drawing(l, seen, now) {
    const key = l.app + '#' + l.id, was = seen[key];
    let at = was ? was.at : -1e15;
    if (l.frames > 0 && (!was || l.frames !== was.frames)) at = now;
    seen[key] = { frames: l.frames, at };
    if (l.state === 'shown') return !(l.kind === 'video' && l.frames === 0);
    if (l.state === 'waiting' || l.state === 'suspended') return now - at < FRESH_MS;
    return false;
}
/** A guidance signal's value: true (guiding), false, null (not understood). nav: guidingState 2 / ACTIVE. */
function guideValue(src, v) {
    if (v && typeof v === 'object') {
        const k = Object.keys(v).find((x) => typeof v[x] === 'number' || typeof v[x] === 'boolean' || typeof v[x] === 'string');
        return k === undefined ? null : guideValue(src, v[k]);
    }
    if (src === 'nav') {
        if (typeof v === 'number') return v === 2;
        if (typeof v === 'string') return /^(\d+|[A-Z_]+)$/i.test(v) ? (v === '2' || /^active$/i.test(v)) : null;
        return null;
    }
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return /^(true|1)$/i.test(v) ? true : /^(false|0)$/i.test(v) ? false : null;
    return null;
}

/* ----- colours ----- */

function rgb(c) {
    if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0];
    const s = String(c || '#ffffff').replace('#', '');
    return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
}
const hexOf = (v) => '#' + v.map((x) => ('0' + Math.max(0, Math.min(255, Math.round(x))).toString(16)).slice(-2)).join('');
/** A colour made bright enough to read on the cluster's black: lightness lifted to at least min. */
function lift(c, min) {
    const v = rgb(c), mx = Math.max(v[0], v[1], v[2]), lo = min || 150;
    if (mx >= lo) return hexOf(v);
    if (mx < 8) return hexOf([lo, lo, lo]);
    const k = lo / mx;
    return hexOf(v.map((x) => x * k));
}
const mixc = (a, b, f) => { const x = rgb(a), y = rgb(b); return hexOf(x.map((v, i) => v + (y[i] - v) * f)); };
const DEFAULT_PAL = ['#3ad0ff', '#7a6cff', '#ff4fa3'];
/** Three colours from the artwork's palette (lifted for the black), else G's Music's own: the text's accent. */
function barColours(pal) {
    const p = (pal || []).filter(Boolean);
    if (p.length < 2) return DEFAULT_PAL.slice();
    return [lift(p[0], 170), lift(p[1], 170), lift(p[2] || mixc(p[0], '#ffffff', 0.5), 190)];
}

/* ----- the visualizer: viz.js, as on the head unit's screen ----- */

/** The bars' colours: the screen's own (main.js's stage colours), else from the artwork's palette. */
function vizColours(s) {
    const v = (s && s.vizPalette || []).filter(Boolean);
    return v.length >= 3 ? v.slice(0, 3) : barColours(s && s.palette);
}
/** The bars' image (BARS_W x BARS_H RGBA, opaque on black) at viz clock c ({ t, e }). Canvas: kit/canvas's. */
function barsImage(Canvas, c, pal) {
    const cv = new Canvas(BARS_W, BARS_H);
    cv.clear('#000000');
    VIZ.draw(cv, { x: 0, y: 0, w: BARS_W, h: BARS_H }, c, pal);
    const d = Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    return { w: BARS_W, h: BARS_H, d: Buffer.from(d) };
}
/**
 * The bars' changed parts of b against a (w x h): per group of columns (cols groups), the changed
 * rows' span, as dirty() does: { rects, px } or null.
 */
function colDirty(a, b, w, h, cols) {
    const rects = [];
    for (let g = 0; g < cols; g++) {
        const x0 = Math.round(g * w / cols), x1 = Math.round((g + 1) * w / cols);
        let y0 = h, y1 = -1;
        for (let y = 0; y < h; y++) {
            const row = y * w * 4;
            for (let x = x0; x < x1; x++) {
                const o = row + x * 4;
                if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) { if (y < y0) y0 = y; y1 = y; break; }
            }
        }
        if (y1 >= 0) rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 + 1 });
    }
    if (!rects.length) return null;
    const parts = rects.map((r) => {
        const out = Buffer.alloc(r.w * r.h * 4);
        for (let y = 0; y < r.h; y++) b.copy(out, y * r.w * 4, ((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4);
        return out;
    });
    return { rects, px: Buffer.concat(parts) };
}

/* ----- the text image ----- */

/** The lyric line playing at pos and the next one: { i, cur, next } (cur '' = an instrumental gap). */
function lyricAt(lines, pos) {
    const p = pos + LEAD_MS;
    let lo = 0, hi = lines.length - 1, i = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= p) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    let n = i + 1;
    while (n < lines.length && !lines[n].text) n++;                 // the next line with words
    return { i, cur: i >= 0 ? lines[i].text : '', next: n < lines.length ? lines[n].text : '' };
}
function fitText(cv, s, size, w, opts) {
    s = String(s || '');
    if (cv.textWidth(s, size, opts) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, opts) > w) s = s.slice(0, -1);
    return s.replace(/\s+$/, '') + '...';
}
/** Words wrapped into at most max lines of width w (the last cut with ...). */
function wrapText(cv, s, size, w, max, opts) {
    const words = String(s || '').split(/\s+/).filter(Boolean), out = [];
    let line = '';
    for (let k = 0; k < words.length; k++) {
        const t = line ? line + ' ' + words[k] : words[k];
        if (cv.textWidth(t, size, opts) <= w || !line) { line = t; continue; }
        out.push(line); line = words[k];
        if (out.length === max - 1) { line = words.slice(k).join(' '); break; }
    }
    if (line) out.push(line);
    return out.slice(0, max).map((l, k) => k === max - 1 ? fitText(cv, l, size, w, opts) : l);
}
/**
 * What the text image shows, as a key (equal keys: the same picture): v = { mode 'lyrics' | 'viz',
 * title, artist, paused, cur, next, gap, prog (0..1, quantised), accent }.
 */
function textKey(v) {
    return [v.mode, v.title, v.artist, v.paused ? 1 : 0, v.cur, v.next, v.gap ? 1 : 0, Math.round((v.prog || 0) * 200), v.accent].join('\u0001');
}
/** The text image (TEXT_W x TEXT_H, opaque) for v (textKey()). Canvas: kit/canvas's. */
function textImage(Canvas, v) {
    const W = TEXT_W, H = TEXT_H, cv = new Canvas(W, H);
    cv.clear('#000000');
    const acc = lift(v.accent || '#3ad0ff', 170), dim = '#8a8f99', lit = '#ffffff', L = { literal: true }, B = { font: 'bold', literal: true };
    const cx = W / 2, TW = 470;
    if (v.mode === 'lyrics') {
        const head = (v.paused ? 'PAUSED  \u00b7  ' : '') + v.title + (v.artist ? '  \u00b7  ' + v.artist : '');
        cv.text(fitText(cv, head, 13, TW, L), cx, 30, 13, v.paused ? acc : dim, { literal: true, align: 'center' });
        if (v.gap || !v.cur) {
            cv.text('\u00b7   \u00b7   \u00b7', cx, 112, 34, acc, { font: 'bold', literal: true, align: 'center' });
        } else {
            let size = 30, ls = wrapText(cv, v.cur, size, TW, 2, B);
            if (ls.length > 1) { size = 27; ls = wrapText(cv, v.cur, size, TW, 2, B); }
            const lh = size + 6, y0 = ls.length > 1 ? 96 : 116;
            ls.forEach((l, k) => cv.text(l, cx, y0 + k * lh, size, lit, { font: 'bold', literal: true, align: 'center' }));
        }
        if (v.next) cv.text(fitText(cv, v.next, 18, TW, L), cx, 176, 18, '#6b7079', { literal: true, align: 'center' });
    } else {
        cv.text(v.paused ? 'PAUSED' : 'NOW PLAYING', cx, 28, 11, acc, { font: 'bold', literal: true, align: 'center', spacing: 2 });
        cv.text(fitText(cv, v.title, 22, TW, B), cx, 54, 22, lit, { font: 'bold', literal: true, align: 'center' });
        if (v.artist) cv.text(fitText(cv, v.artist, 15, TW, L), cx, 74, 15, dim, { literal: true, align: 'center' });
    }
    // the progress line
    const px = 92, pw = W - 2 * px, py = 210;
    cv.fillRect(px, py, pw, 2, '#26292e');
    cv.fillRect(px, py, Math.max(0, Math.min(1, v.prog || 0)) * pw, 2, acc);
    const d = Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    return { w: W, h: H, d: Buffer.from(d) };
}
/**
 * The changed parts of b against a (same size): per BAND rows, the changed columns' span, as
 * { rects: [{x,y,w,h}], px } (px: the rects' pixels one after another), or null: nothing changed.
 */
function dirty(a, b, w, h) {
    const rects = [];
    for (let y0 = 0; y0 < h; y0 += BAND) {
        const y1 = Math.min(h, y0 + BAND);
        let x0 = w, x1 = -1;
        for (let y = y0; y < y1; y++) {
            const row = y * w * 4;
            for (let x = 0; x < w; x++) {
                const o = row + x * 4;
                if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
            }
        }
        if (x1 < 0) continue;
        const last = rects[rects.length - 1];
        if (last && last.y + last.h === y0 && last.x === x0 && last.w === x1 - x0 + 1) last.h += y1 - y0;
        else rects.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 });
    }
    if (!rects.length) return null;
    const parts = rects.map((r) => {
        const out = Buffer.alloc(r.w * r.h * 4);
        for (let y = 0; y < r.h; y++) b.copy(out, y * r.w * 4, ((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4);
        return out;
    });
    return { rects, px: Buffer.concat(parts) };
}

/* ----- the cluster picture ----- */

class MusicCluster {
    /** opts: log, app ('ng_spotify'), Canvas, client / sock / testing (tests), now(), timers. */
    constructor(opts) {
        const o = opts || {};
        this.o = o;
        this.log = o.log || { info() {}, warn() {} };
        this.app = o.app || 'ng_spotify';
        this.Canvas = o.Canvas;
        this.now = o.now || Date.now;
        this.T = o.timers || { setInterval, clearInterval };
        this.err = null; this.errAt = -1e15;
        this.guide = { nav: null, carplay: null, aa: null };
        this.rawGuide = false; this.rawSince = this.now(); this.guiding = false;
        this.s = null; this.want = false; this.reason = 'off'; this.source = 'auto';
        this.pausedAt = 0; this.gaveUp = '';
        this.stats = { layers: 0, sends: 0, bytes: 0, textBytes: 0, barsBytes: 0, drops: 0, connects: 0 };
        this.clk = VIZ.clock();                      // the visualizer's clock (viz.js), as main.js's
        this._reset();
    }
    _reset() {
        this.cr = null; this.ready = false; this.polled = false;
        this.text = null; this.bars = null;          // { ref, state, img, key, visible, madeAt, errAt }
        this.others = []; this.seen = {}; this.tvAt = -1e15;
        this.poll = null; this.anim = null; this.downAt = this.now();
        this.errRetries = 0; this.textAt = 0; this.progAt = -1e15; this.prog = 0;
        this.visible = null; this.mode = '';
    }

    /**
     * What G's Music has, from its 250 ms tick (idempotent): s = { setting 'off' | 'lyrics' |
     * 'visualizer', ok (signed in, the player answered), track: { uri, title, artist, kind, duration,
     * ad } | null, playing, pos (ms), lyrics: lyrics.js's entry for the track | null, palette (the
     * artwork's), vizPalette (the screen's visualizer colours), source (0.6.1: G's Dash's Cluster source
     * pick, 'auto' when not given) }.
     */
    update(s) {
        const now = this.now();
        this.s = s || {};
        const t = this.s.track;
        const setting = this.s.setting === 'visualizer' || this.s.setting === 'lyrics' ? this.s.setting : 'off';
        if (t && this.s.playing) this.pausedAt = 0;
        else if (t && !this.pausedAt) this.pausedAt = now;
        let why = '';
        // the Cluster source pick (0.6.1, G's Dash's cluster_source.js): only Auto and Music let it draw
        const source = typeof this.s.source === 'string' ? this.s.source : 'auto';
        this.source = source;
        if (setting === 'off') why = 'off';
        else if (source !== 'auto' && source !== 'music') why = 'source';
        else if (!this.s.ok) why = 'nospotify';
        else if (!t || !t.title || t.ad) why = 'notrack';
        else if (!this.s.playing && now - this.pausedAt > PAUSE_DROP_MS) why = 'paused';
        else if (this.gaveUp && this.gaveUp === t.uri) why = 'failed';
        if (this.gaveUp && t && this.gaveUp !== t.uri) this.gaveUp = '';
        if (why !== this.reason && why) this.log.info('music cluster: ' + ({ off: 'off', nospotify: 'no Spotify', notrack: 'no track', paused: 'paused ' + (PAUSE_DROP_MS / 1000) + ' s - dropped', failed: 'given up for this track', source: 'G\'s Dash picked ' + source + ' - dropped' })[why]);
        this.reason = why;
        if (why) { if (this.cr) this._off(); this.want = false; return; }
        this.want = true;
        if (!this.cr) this._connect();
        this._apply();
    }

    _connect() {
        const now = this.now();
        if (this.err && now - this.errAt < LOAD_RETRY_MS) return;
        const c = loadClient(this.o);
        if (c.error) {
            if (!this.err || this.err.error !== c.error) this.log.warn('music cluster: ' + c.text + (c.detail ? ' (' + c.detail + ')' : ''));
            this.err = c; this.errAt = now;
            return;
        }
        this.err = null;
        this.stats.connects++;
        let cr;
        try { cr = this.cr = new c.ClusterRender(this.app, c.sock); } catch (e) { this.err = { error: 'load', text: e.message }; this.errAt = now; this.cr = null; return; }
        cr.on('ready', () => { if (this.cr !== cr) return; this.ready = true; this.log.info('music cluster: connected'); this._ask(); });
        cr.on('disconnected', () => { if (this.cr !== cr) return; this.ready = false; this.polled = false; this.downAt = this.now(); });
        cr.on('layer', (ref, state, reason) => {
            if (this.cr !== cr) return;
            const L = this.text && this.text.ref === ref ? this.text : this.bars && this.bars.ref === ref ? this.bars : null;
            if (!L) return;
            if (state === 'error' && L.state !== 'error') { L.errAt = this.now(); this.log.warn('music cluster: layer error' + (reason ? ' (' + reason + ')' : '')); }
            L.state = state || '';
        });
        cr.on('budget', (cap, max) => { if (this.cr === cr) this.budget = { cap, max }; });
        cr.on('refused', (op, ref, reason) => { if (this.cr === cr) this.log.warn('music cluster: refused ' + (op || '?') + ': ' + (reason || '?')); });
        cr.on('status', (text) => {
            if (this.cr !== cr) return;
            const now = this.now(), seen = {}, others = [];
            mapLayers(text, this.app).forEach((l) => {
                if (drawing(l, this.seen, now) && l.app === 'ng_tv') others.push(l);
                seen[l.app + '#' + l.id] = this.seen[l.app + '#' + l.id];
            });
            this.seen = seen;
            if (others.length) this.tvAt = now;
            if (!!others.length !== !!this.others.length) this.log.info('music cluster: G\'s TV ' + (others.length ? 'is drawing - hidden' : 'stopped'));
            this.others = others;
            ownLayers(text, this.app).forEach((l) => {
                [this.text, this.bars].forEach((L) => { if (L && L.ref === l.id && l.state === 'error' && L.state !== 'error') { L.state = 'error'; L.errAt = now; } });
            });
            this.polled = true;
            this._apply();
        });
        this.downAt = this.now();
        this.poll = this.T.setInterval(() => this._tick(), POLL_MS);
        try { cr.connect(); } catch (e) { this.log.warn('music cluster: connect ' + e.message); }
    }
    _ask() { if (this.cr && this.ready) { try { this.cr.status(); } catch (e) { /* next poll */ } } }
    _tick() {
        if (!this.want || !this.cr) return;
        const now = this.now();
        if (!this.ready) {
            if (now - this.downAt >= RECONNECT_MS) { this.log.info('music cluster: reconnecting'); this._off(); this._connect(); }
            return;
        }
        this._ask();
        const bad = [this.text, this.bars].filter((L) => L && L.state === 'error');
        if (bad.length && now - Math.max.apply(null, bad.map((L) => L.errAt)) >= ERR_RETRY_MS) {
            if (this.errRetries >= ERR_RETRIES) {
                this.log.warn('music cluster: the renderer keeps refusing the layers - off for this track');
                this.gaveUp = (this.s && this.s.track && this.s.track.uri) || '?';
                this._off();
                this.want = false; this.reason = 'failed';
                return;
            }
            this.errRetries++;
            this.log.info('music cluster: layer in error - making it again (' + this.errRetries + ' of ' + ERR_RETRIES + ')');
            this._dropLayers();
            this._apply();
        }
    }

    /** The route guidance signals (main.js): src 'nav' | 'carplay' | 'aa', v the raw value. */
    guidance(src, v) {
        if (!Object.prototype.hasOwnProperty.call(this.guide, src)) return;
        const g = guideValue(src, v);
        if (g === null) return;
        this.guide[src] = g;
        if (this.want) this._apply();
    }
    _guideTick(now) {
        const raw = this.guide.nav === true || this.guide.carplay === true || this.guide.aa === true;
        if (raw !== this.rawGuide) { this.rawGuide = raw; this.rawSince = now; }
        const was = this.guiding;
        if (raw && !this.guiding && now - this.rawSince >= GUIDE_ON_MS) this.guiding = true;
        if (!raw && this.guiding && now - this.rawSince >= GUIDE_OFF_MS) this.guiding = false;
        if (was !== this.guiding) this.log.info('music cluster: ' + (this.guiding ? 'route guidance - hidden' : 'route guidance ended'));
        return this.guiding;
    }

    /** What to show now: 'lyrics' (synced lines, setting Lyrics + visualizer) or 'viz'. */
    _mode() {
        const s = this.s, e = s.lyrics;
        if (s.setting === 'lyrics' && e && e.state === 'synced' && e.lines && e.lines.length && !(s.track && s.track.kind === 'episode')) return 'lyrics';
        return 'viz';
    }
    _view(mode, now) {
        const s = this.s, t = s.track, pal = barColours(s.palette);
        const v = { mode, title: t.title || '', artist: t.artist || '', paused: !s.playing, cur: '', next: '', gap: false, accent: pal[0] };
        if (mode === 'lyrics') {
            const L = lyricAt(s.lyrics.lines, s.pos || 0);
            v.cur = L.cur; v.next = L.next; v.gap = L.i < 0 || !L.cur;
        }
        // the progress line: moved at most every PROGRESS_MS (or at once on a jump), so it costs little
        const p = t.duration ? Math.max(0, Math.min(1, (s.pos || 0) / t.duration)) : 0;
        if (now - this.progAt >= PROGRESS_MS || Math.abs(p - this.prog) > 0.05 || !s.playing) { this.prog = p; this.progAt = now; }
        v.prog = this.prog;
        return v;
    }

    _apply() {
        if (!this.want || !this.cr || !this.ready || !this.polled) return;
        const now = this.now();
        const guiding = this._guideTick(now);
        const vis = !guiding && !this.others.length && now - this.tvAt >= HOLD_MS;
        const mode = this._mode();
        if (mode !== this.mode && this.mode) this.log.info('music cluster: ' + (mode === 'lyrics' ? 'synced lyrics' : 'visualizer'));
        this.mode = mode;
        if (!vis) {
            if (this.visible) {
                [this.text, this.bars].forEach((L) => { if (L) { try { this.cr.set(L.ref, { visible: false }); } catch (e) { /* gone */ } } });
                this.log.info('music cluster: hidden (' + (guiding ? 'route guidance' : 'G\'s TV') + ')');
            }
            this.visible = false;
            this._animate(false);
            return;
        }
        // the text layer: made once, then only its changes
        const v = this._view(mode, now), key = textKey(v);
        if (!this.text) {
            const img = textImage(this.Canvas, v);
            const ref = this._make(Z_TEXT, 0, 0, MAP_W, MAP_H, img, 'bilinear', TEXT_FPS);
            if (!ref) return;
            this.text = { ref, state: 'new', img, key, madeAt: now, errAt: 0 };
            this._send(ref, null, img.d, 'text');
        } else if (key !== this.text.key && now - this.textAt >= 1000 / TEXT_FPS) {
            const img = textImage(this.Canvas, v), dd = dirty(this.text.img.d, img.d, TEXT_W, TEXT_H);
            this.text.key = key; this.text.img = img; this.textAt = now;
            if (dd) {
                const whole = dd.px.length > img.d.length * 0.6;
                this._send(this.text.ref, whole ? null : dd.rects, whole ? img.d : dd.px, 'text');
            }
        }
        // the bars: only for the visualizer
        if (mode === 'viz') {
            if (!this.bars) {
                const img = this._barsFrame();
                const ref = this._make(Z_BARS, BARS_X, BARS_Y, BARS_SHOW_W, BARS_SHOW_H, img, 'bilinear', BARS_FPS);
                if (ref) { this.bars = { ref, state: 'new', img, madeAt: now, errAt: 0 }; this._send(ref, null, img.d, 'bars'); }
            }
        } else if (this.bars) {
            try { this.cr.drop(this.bars.ref); this.stats.drops++; } catch (e) { /* gone */ }
            this.bars = null;
        }
        if (this.visible === false) {
            [this.text, this.bars].forEach((L) => { if (L) { try { this.cr.set(L.ref, { visible: true }); } catch (e) { /* gone */ } } });
            this.log.info('music cluster: shown again');
        }
        this.visible = true;
        this._animate(mode === 'viz' && (!!this.s.playing || this.clk.e > 0));
    }
    _make(z, x, y, w, h, img, sampling, fps) {
        const ref = this.cr.image({ target: TARGET, klass: KLASS, z, exclusive: false, contend: true, visible: true,
            x, y, w, h, iw: img.w, ih: img.h, sampling, fps });
        if (!ref) { this.log.warn('music cluster: image layer refused by the client'); return 0; }
        this.stats.layers++;
        this.log.info('music cluster: layer z ' + z + ' ' + img.w + 'x' + img.h + ' at ' + x + ',' + y + ' ' + w + 'x' + h + ' ' + sampling + ', fps ' + fps);
        return ref;
    }
    _send(ref, rects, px, which) {
        let ok;
        try { ok = this.cr.pixels(ref, rects, px); } catch (e) { ok = false; }
        if (ok !== false) { this.stats.sends++; this.stats.bytes += px.length; this.stats[which + 'Bytes'] += px.length; }
    }

    /** The bars' frame at the viz clock. */
    _barsFrame() { return barsImage(this.Canvas, this.clk, vizColours(this.s)); }
    _animate(run) {
        if (!run) { if (this.anim) { this.T.clearInterval(this.anim); this.anim = null; } return; }
        if (!this.anim) { this.clk.last = 0; this.anim = this.T.setInterval(() => this._frame(), Math.round(1000 / this._barsFps())); }
    }
    /** BARS_FPS, less when the renderer's budget is cut (Waze busy): at worst 4. */
    _barsFps() {
        const b = this.budget;
        if (b && b.max > 0 && b.cap < b.max) return Math.max(4, Math.round(BARS_FPS * b.cap / b.max));
        return BARS_FPS;
    }
    /** One step of the visualizer: the clock moves (easing to rest on Pause), the changed columns go. */
    _frame() {
        if (!(this.bars && this.visible && this.want && this.cr && this.s)) { this._animate(false); return; }
        const moving = VIZ.step(this.clk, this.now(), this.s.playing ? 1 : 0);
        const img = this._barsFrame(), dd = colDirty(this.bars.img.d, img.d, BARS_W, BARS_H, BARS_COLS);
        this.bars.img = img;
        if (dd) {
            const whole = dd.px.length > img.d.length * 0.8;
            this._send(this.bars.ref, whole ? null : dd.rects, whole ? img.d : dd.px, 'bars');
        }
        if (!moving) this._animate(false);           // at rest (paused): the picture stays, nothing more is sent
    }

    _dropLayers() {
        [this.text, this.bars].forEach((L) => { if (L && this.cr) { try { this.cr.drop(L.ref); this.stats.drops++; } catch (e) { /* gone */ } } });
        this.text = null; this.bars = null; this.visible = null;
        this._animate(false);
    }
    _off() {
        const cr = this.cr;
        if (this.poll) this.T.clearInterval(this.poll);
        this._dropLayers();
        if (cr) { try { cr.close(); } catch (e) { /* gone */ } this.log.info('music cluster: layers dropped'); }
        this._reset();
    }
    close() { this._off(); this.want = false; }

    /** The settings page's line: { kind: 'on' | 'wait' | 'off' | 'none' | 'error', text }. */
    view() {
        const r = this.reason;
        const PICK = { auto: 'Auto', logo: 'Logo', music: 'Music', map: 'Map', stock: 'Stock' };
        if (r === 'off') return { kind: 'off', text: this.source === 'music' ? 'Off - G\'s Dash picked Music: turn on here' : 'Off' };
        if (r === 'source') return { kind: 'off', text: 'Set in G\'s Dash: ' + (PICK[this.source] || this.source) };
        if (this.err) return { kind: 'none', text: ({ missing: 'Needs Cluster renderer (Store)', noclient: 'Update Cluster renderer', untrusted: 'Renderer not trusted', load: 'Renderer failed to load' })[this.err.error] || this.err.text };
        if (r === 'nospotify' || r === 'notrack') return { kind: 'wait', text: 'Shows while a track plays' };
        if (r === 'paused') return { kind: 'wait', text: 'Paused - comes back on Play' };
        if (r === 'failed') return { kind: 'error', text: 'Renderer refused - next track' };
        if (!this.cr || !this.ready || !this.polled) return { kind: 'wait', text: 'Connecting to renderer' };
        if (this.guiding) return { kind: 'wait', text: 'Hidden - route guidance' };
        if (this.others.length || this.now() - this.tvAt < HOLD_MS) return { kind: 'wait', text: 'Hidden - G\'s TV in the cluster' };
        return { kind: 'on', text: this.mode === 'lyrics' ? 'Showing lyrics' : 'Showing the visualizer' };
    }
}

module.exports = { MusicCluster, loadClient, trusted, mapLayers, ownLayers, drawing, guideValue, barsImage, barColours, vizColours, colDirty,
    textImage, textKey, dirty, lyricAt, wrapText, fitText, lift,
    TARGET, MAP_W, MAP_H, KLASS, Z_TEXT, Z_BARS, TEXT_W, TEXT_H, TEXT_FPS, BARS_W, BARS_H, BARS_SC, BARS_SHOW_W, BARS_SHOW_H, BARS_X, BARS_Y, BARS_FPS, BARS_COLS,
    POLL_MS, HOLD_MS, GUIDE_ON_MS, GUIDE_OFF_MS, PAUSE_DROP_MS, ERR_RETRIES, ERR_RETRY_MS, PROGRESS_MS };
