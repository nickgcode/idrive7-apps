'use strict';
/**
 * cluster_logo.js - G's Dash's logo in the instrument cluster's central map area while G's Dash is open
 * and nothing else uses that area ("Logo in cluster when map is empty"), through the separately
 * installed "Cluster renderer" tool (cluster-render, robertnisipeanu/idrive-apps, from the Store).
 * Written for G's Dash from the tool's PROTOCOL.md and README, the way G's TV talks to it; it contains
 * none of the tool's code. The tool's own Node client is loaded at run time from where the tool
 * installs it, and only when that file and its directory are owned by root and writable by nobody
 * else (NG_CR_CLIENT / NG_CR_SOCK: a test client and socket, which skip that check):
 *     /var/opt/cluster-render/current/cluster_render_client.js
 *
 * The layer: one "image" layer on the "map" target only (slot 0x100, 1088x480, between the dials),
 * class "ambient" at z -1000, the bottom of the whole stack: every other layer on the map (the CarPlay
 * map of Waze on cluster: content z 0; G's TV: content z 100) is drawn over it. Never exclusive, never
 * contend (it never takes the slot from the stock map: behind it the target only waits, invisible),
 * never "alert", never the panel or the HUD. The image is sent once: the regular logo (the badge's own
 * geometry, 448x240 on black, drawn 1:1 in the middle of the map area: 430 KB once), or with the Pixel
 * look the pixel-art emblem at its cell grid (27x15, 1.6 KB) drawn 16x by the cluster's GPU with
 * nearest sampling, so it stays crisp. A look change between the two sends the other image once (the
 * new layer first, then the old one goes). An image layer never stalls (stall_ms is for video only; an
 * image is drawn from its last pixels for as long as the layer exists), so nothing is sent to keep it
 * up: after the image, 0 bytes a second. The fade-in is the service's own (250 ms when the target is
 * shown). Only with the Pixel look and only while the car stands still: the emblem's stripes slide in
 * once and a shine crosses it every few seconds, as on the dash (whole 1.6 KB images, at most 12 a
 * second while a sweep runs: about 4 KB/s); moving, it is one still image and nothing more is sent.
 *
 * Whether the map area is in use (the service's own reports, nothing guessed):
 *   - other clients' layers on the map: the service's "status" text lists every client's layers
 *     ("layer N KIND of APP on TARGET, CLASS z Z: STATE[ - REASON]", then "  STATS": a video layer's
 *     "N sent, ...", an image layer's "N writes, ..."); asked for once a second over the local socket
 *     (nothing goes to the cluster). Only a layer that is actually drawing counts (drawing()):
 *       shown      the service draws it (visible, content within its own stall window, its target
 *                  shown): in use. A video layer that never sent a frame does not count.
 *       waiting /  visible but not drawn yet (target not shown or taken, under an alert): in use only
 *       suspended  while its frame counter is advancing (it moved within FRESH_MS), i.e. frames are
 *                  arriving and it draws as soon as the target is shown.
 *       stalled    visible but no content (no frame yet, or its frames stopped), hidden, error: idle.
 *     Waze on cluster makes its video layer as soon as it reaches the service and keeps it visible
 *     while CarPlay's cluster stream connection is up, frames or not: with CarPlay not streaming that
 *     layer is "stalled" (or "hidden"), registered but idle, and the logo shows. While any other app's
 *     layer is drawing, ours is hidden (visible 0: it does not want the slot), and it comes back
 *     HOLD_MS after the last one stopped. So when the CarPlay map ends, the slot is let go (the map
 *     target's linger is 0) and the stock map, if the HMI has one parked, comes back before the logo
 *     asks again.
 *   - the stock map (the HMI's own content in slot 0x100): our target's events say it ("parked" or
 *     "waiting", holder "stock"): the logo is then behind it, not drawn, and shows only once the
 *     stock map goes (the area really is empty).
 *   - after our slot was lost (a door-open warning or a phone reconnecting locks the slot and the
 *     KOMBI unmaps everything; the first to ask afterwards is shown) the logo waits YIELD_MS before
 *     asking again, so the HMI's map goes first.
 *   Not visible to a client: the stock map mapped AFTER the logo was shown (the user turns the cluster
 *   to Map view while G's Dash is open). The KOMBI never takes a slot from what it shows, so the stock
 *   map then waits behind the logo until G's Dash is closed or hidden (or the setting is turned off).
 *
 * Off at once: hidden, closed, the setting off -> the layer is dropped (the service removes it at
 * once, no fade) and the connection closed; when the app ends its socket closes and the service
 * removes its layers. Never throws, never blocks. Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const path = require('path');

const CLIENT = process.env.NG_CR_CLIENT || '/var/opt/cluster-render/current/cluster_render_client.js';
const SOCK = process.env.NG_CR_SOCK || '/dev/shm/cluster-render/render.sock';
const TESTING = !!(process.env.NG_CR_CLIENT || process.env.NG_CR_SOCK);

const TARGET = 'map', MAP_W = 1088, MAP_H = 480;      // the only target used
const KLASS = 'ambient', Z = -1000;                  // the bottom of the stack
const LOGO_W = 448, LOGO_H = 240, BADGE_H = 184;     // the regular logo, 1:1
const CELL = 16;                                     // the pixel emblem's cell on the cluster
const FPS_STILL = 1, FPS_ANIM = 12;                  // the image's write ceiling (fps: writes a second at most)
const POLL_MS = 1000, HOLD_MS = 3000, FRESH_MS = 2000, YIELD_MS = 3000, LOAD_RETRY_MS = 30000;
const ANIM_MS = 80;                                  // the parked animation's step
const SHINE_EVERY = 4200, SHINE_MS = 700, INTRO_MS = 1100;

/* ----- the client ----- */

function trusted(file) {
    try {
        const real = fs.realpathSync(file);
        const st = fs.statSync(real), dir = fs.statSync(path.dirname(real));
        return st.isFile() && st.uid === 0 && !(st.mode & 0o022) && dir.uid === 0 && !(dir.mode & 0o022);
    } catch (e) { return false; }
}
const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };

/** The tool's client { ClusterRender, sock }, or { error, text }: missing, noclient, untrusted, load. */
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

/* ----- the images ----- */

function hex(c) {
    if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0, c.length > 3 ? c[3] | 0 : 255];
    const s = String(c).replace('#', '');
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 255];
}
/** A tiny pixel-exact raster (cell edges rounded, no smoothing) for the emblem at 1 px a cell. */
function cellRaster(w, h) {
    const d = Buffer.alloc(w * h * 4);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;           // black, opaque
    return {
        w, h, d,
        fillRect(x, y, rw, rh, c) {
            const v = hex(c), a = v[3] / 255;
            const x0 = Math.max(0, Math.round(x)), x1 = Math.min(w, Math.round(x + rw));
            const y0 = Math.max(0, Math.round(y)), y1 = Math.min(h, Math.round(y + rh));
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
                const o = (yy * w + xx) * 4;
                for (let k = 0; k < 3; k++) d[o + k] = Math.round(d[o + k] * (1 - a) + v[k] * a);
                d[o + 3] = 255;
            }
        },
    };
}
/** The Pixel look's emblem (px.js), one image per motion state: { w, h, d }. o: px.emblem's options. */
function pixelImage(P, o) {
    const r = cellRaster(P.EMB.w, P.EMB.h);
    P.emblem(r, 0, 0, 1, o || {});
    return r;
}
/** The regular logo: the badge (lib.js) centred on black, LOGO_W x LOGO_H. */
function regularImage(Canvas, badge, badgeWidth) {
    const cv = new Canvas(LOGO_W, LOGO_H);
    cv.clear('#000000');
    const bw = badgeWidth(BADGE_H);
    badge(cv, Math.round((LOGO_W - bw) / 2), Math.round((LOGO_H + BADGE_H) / 2), BADGE_H);
    const d = Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    return { w: LOGO_W, h: LOGO_H, d };
}
/** Where an image goes on the map: the logo 1:1, the emblem CELL x, both centred. */
function placement(kind, img) {
    const s = kind === 'pixel' ? CELL : 1, w = img.w * s, h = img.h * s;
    return { x: Math.round((MAP_W - w) / 2), y: Math.round((MAP_H - h) / 2), w, h };
}

/**
 * The other apps' layers on the map in a status text: [{ id, kind, app, klass, z, state, frames }].
 * frames: the layer's own counter from its stats line (video "N sent", image "N writes"), -1 if none.
 */
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

/**
 * Whether a layer from mapLayers is drawing (see the header): shown (a video one with a frame sent),
 * or waiting / suspended with its frame counter advancing. seen: { key -> { frames, at } } from earlier
 * polls, updated here; now: ms.
 */
function drawing(l, seen, now) {
    const key = l.app + '#' + l.id, was = seen[key];
    let at = was ? was.at : -1e15;
    if (l.frames > 0 && (!was || l.frames !== was.frames)) at = now;   // first seen with frames, or moved
    seen[key] = { frames: l.frames, at };
    if (l.state === 'shown') return !(l.kind === 'video' && l.frames === 0);
    if (l.state === 'waiting' || l.state === 'suspended') return now - at < FRESH_MS;
    return false;                                                        // stalled, hidden, error
}

/** A short name for an app id in the Options line. */
function appName(app) {
    const a = String(app || '');
    if (/waze/i.test(a)) return 'Waze';
    if (a === 'ng_tv') return 'G\'s TV';
    return a.length > 14 ? a.slice(0, 13) + '.' : a;
}

/* ----- the logo ----- */

class ClusterLogo {
    /**
     * opts: log, app ('ng_gsdash'), images: { regular() -> {w,h,d}, pixel(o) -> {w,h,d} }, client /
     * sock / testing (tests), now(), timers ({ setInterval, clearInterval, setTimeout, clearTimeout }).
     */
    constructor(opts) {
        const o = opts || {};
        this.o = o;
        this.log = o.log || { info() {}, warn() {} };
        this.app = o.app || 'ng_gsdash';
        this.now = o.now || Date.now;
        this.T = o.timers || { setInterval, clearInterval };
        this.images = o.images;
        this.want = false; this.pixel = false; this.parked = false; this.enabled = true;
        this._reset();
        this.err = null; this.errAt = -1e15;
        this.stats = { layers: 0, sends: 0, bytes: 0, drops: 0, polls: 0 };
    }
    _reset() {
        this.cr = null; this.ready = false; this.ref = 0; this.kind = ''; this.visible = null;
        this.polled = false; this.others = []; this.idle = []; this.seen = {}; this.lastBusy = ''; this.busyAt = -1e15; this.yieldUntil = -1e15;
        this.target = { state: '', holder: '', reason: '', rendering: '' };
        this.layerState = ''; this.refused = '';
        this.frameKey = ''; this.animAt = 0; this.shownAt = 0;
        this.poll = null; this.anim = null;
    }

    /**
     * What G's Dash wants, from its loop and its visibility and setting handlers (idempotent):
     * on: G's Dash open and the setting on; pixel: the Pixel look; parked: the car stands still.
     */
    update(s) {
        const on = !!(s && s.on);
        this.enabled = !(s && s.enabled === false);
        this.pixel = !!(s && s.pixel);
        this.parked = !!(s && s.parked);
        if (!on) { if (this.want || this.cr) this._off(); this.want = false; return; }
        this.want = true;
        if (!this.cr) this._connect();
        this._apply();
    }

    _connect() {
        const now = this.now();
        if (this.err && now - this.errAt < LOAD_RETRY_MS) return;
        const c = loadClient(this.o);
        if (c.error) {
            if (!this.err || this.err.error !== c.error) this.log.warn('cluster logo: ' + c.text + (c.detail ? ' (' + c.detail + ')' : ''));
            this.err = c; this.errAt = now;
            return;
        }
        this.err = null;
        const cr = this.cr = new c.ClusterRender(this.app, c.sock);
        cr.on('ready', () => { if (this.cr !== cr) return; this.ready = true; this.log.info('cluster logo: connected'); this._ask(); });
        cr.on('disconnected', () => { if (this.cr === cr) { this.ready = false; this.polled = false; } });
        cr.on('layer', (ref, state, reason) => {
            if (this.cr !== cr || ref !== this.ref) return;
            if (state === 'shown' && this.layerState !== 'shown') this.shownAt = this.now();
            this.layerState = state || '';
            if (state === 'error') this.log.warn('cluster logo: layer error' + (reason ? ' (' + reason + ')' : ''));
        });
        // the target event's "rendering" (service 0.2.2), which the client's 'target' event leaves out
        let rendering = '';
        const handle = cr._event;
        if (typeof handle === 'function') {
            cr._event = function (ev) {
                try { if (ev && ev.ev === 'target' && ev.target === TARGET) rendering = typeof ev.rendering === 'string' ? ev.rendering : ''; } catch (e) { /* older service */ }
                return handle.apply(this, arguments);
            };
        }
        cr.on('target', (name, state, holder, reason) => {
            if (this.cr !== cr || name !== TARGET) return;
            const was = this.target.state;
            this.target = { state: state || '', holder: holder || '', reason: reason || '', rendering };
            rendering = '';
            // the slot lost under a shown logo, not to the stock map (a lock): let the HMI ask first
            if (was === 'shown' && this.visible && !holder && (state === 'waiting' || state === 'unavailable' || state === 'acquiring')) {
                this.yieldUntil = this.now() + YIELD_MS;
                this.log.info('cluster logo: slot lost (' + state + ') - asking again in ' + (YIELD_MS / 1000) + ' s');
                this._apply();
            }
            if (state !== was) this.log.info('cluster logo: map ' + state + (holder ? ' behind ' + holder : '') + (reason ? ' (' + reason + ')' : ''));
        });
        cr.on('refused', (op, ref, reason) => { if (this.cr === cr) { this.refused = (op || '?') + ': ' + (reason || '?'); this.log.warn('cluster logo: refused ' + this.refused); } });
        cr.on('status', (text) => {
            if (this.cr !== cr) return;
            const now = this.now(), seen = {}, others = [], idle = [];
            mapLayers(text, this.app).forEach((l) => {
                (drawing(l, this.seen, now) ? others : idle).push(l);
                seen[l.app + '#' + l.id] = this.seen[l.app + '#' + l.id];
            });
            this.seen = seen;                                   // layers that went are forgotten
            if (others.length) { this.busyAt = now; this.lastBusy = others[0].app; }
            const was = this.others.map((l) => l.app).join(','), is = others.map((l) => l.app).join(',');
            if (was !== is) this.log.info('cluster logo: map ' + (is ? 'in use by ' + is : 'free of other apps') +
                (idle.length ? ' (idle: ' + idle.map((l) => l.app + ' ' + l.state).join(', ') + ')' : ''));
            this.others = others; this.idle = idle;
            this.polled = true;
            this._apply();
        });
        this.poll = this.T.setInterval(() => this._ask(), POLL_MS);
        try { cr.connect(); } catch (e) { this.log.warn('cluster logo: connect ' + e.message); }
    }
    _ask() { if (this.cr && this.ready) { this.stats.polls++; try { this.cr.status(); } catch (e) { /* next poll */ } } }

    /** Shown or not, the image for the look, the parked animation. */
    _apply() {
        if (!this.want || !this.cr || !this.ready || !this.polled) return;
        const now = this.now();
        const vis = !this.others.length && now - this.busyAt >= HOLD_MS && now >= this.yieldUntil;
        const kind = this.pixel ? 'pixel' : 'regular';
        if (!this.ref || this.kind !== kind) {
            if (!this.ref && !vis) return;                 // nothing made until it may show
            this._make(kind, vis);
        } else if (vis !== this.visible) {
            this.visible = vis;
            this.cr.set(this.ref, { visible: vis });
            if (!vis) this.layerState = 'hidden';
            this.log.info('cluster logo: ' + (vis ? 'shown again' : 'hidden (map in use)'));
        }
        this._animate();
    }

    _make(kind, vis) {
        const img = kind === 'pixel' ? this.images.pixel({}) : this.images.regular();
        const at = placement(kind, img);
        const ref = this.cr.image({ target: TARGET, klass: KLASS, z: Z, exclusive: false, contend: false,
            visible: vis, x: at.x, y: at.y, w: at.w, h: at.h, iw: img.w, ih: img.h,
            sampling: kind === 'pixel' ? 'nearest' : 'bilinear', fps: kind === 'pixel' ? FPS_ANIM : FPS_STILL });
        if (!ref) { this.log.warn('cluster logo: image layer refused by the client'); return; }
        this._send(ref, img);
        const old = this.ref;
        this.ref = ref; this.kind = kind; this.visible = vis; this.frameKey = 'still'; this.animAt = this.now();
        this.layerState = vis ? 'new' : 'hidden';
        this.stats.layers++;
        if (old) { this.cr.drop(old); this.stats.drops++; }
        this.log.info('cluster logo: ' + kind + ' image ' + img.w + 'x' + img.h + ' (' + Math.round(img.d.length / 1024) + ' KB, once) at ' + at.x + ',' + at.y + ' ' + at.w + 'x' + at.h + ', ambient z ' + Z + (vis ? '' : ', hidden'));
    }
    _send(ref, img) {
        if (this.cr.pixels(ref, null, img.d) !== false) { this.stats.sends++; this.stats.bytes += img.d.length; }
    }

    /** The Pixel emblem's slide-in and shine: only while parked and shown, else one still image. */
    _animate() {
        const run = this.kind === 'pixel' && this.parked && this.visible && this.want;
        if (!run) {
            if (this.anim) { this.T.clearInterval(this.anim); this.anim = null; }
            if (this.ref && this.kind === 'pixel' && this.frameKey !== 'still') { this._send(this.ref, this.images.pixel({})); this.frameKey = 'still'; }
            return;
        }
        if (!this.anim) { this.animAt = this.now(); this.anim = this.T.setInterval(() => this._frame(), ANIM_MS); }
    }
    _frame() {
        if (!(this.kind === 'pixel' && this.parked && this.visible && this.want && this.cr)) { this._animate(); return; }
        const o = motion(this.now() - this.animAt, this.o.emblemW || 27);
        const key = o ? o.key : 'still';
        if (key === this.frameKey) return;
        this.frameKey = key;
        this._send(this.ref, this.images.pixel(o ? o.opts : {}));
    }

    _off() {
        const cr = this.cr;
        if (this.poll) this.T.clearInterval(this.poll);
        if (this.anim) this.T.clearInterval(this.anim);
        if (cr) {
            try { if (this.ref) { cr.drop(this.ref); this.stats.drops++; } } catch (e) { /* closing anyway */ }
            try { cr.close(); } catch (e) { /* gone */ }
            this.log.info('cluster logo: off');
        }
        this._reset();
    }
    close() { this._off(); this.want = false; }

    /** The Options line, short enough for its row: { kind: 'on' | 'wait' | 'off' | 'none' | 'error', text }. */
    view() {
        if (!this.enabled) return { kind: 'off', text: 'Off' };
        if (this.err) return { kind: 'none', text: SHORT_ERR[this.err.error] || this.err.text };
        if (!this.want) return { kind: 'off', text: 'On - while G\'s Dash is open' };
        if (!this.cr || !this.ready || !this.polled) return { kind: 'wait', text: 'Connecting to renderer' };
        if (this.layerState === 'error') return { kind: 'error', text: 'Renderer refused the logo' };
        if (this.others.length) return { kind: 'wait', text: 'Waiting - ' + appName(this.others[0].app) + ' is drawing' };
        if (!this.visible) {
            const stopped = this.lastBusy && this.now() - this.busyAt < HOLD_MS;
            return { kind: 'wait', text: (stopped ? appName(this.lastBusy) + ' stopped - logo soon' : 'Logo in a moment') };
        }
        const T = this.target;
        if ((T.state === 'parked' || T.state === 'waiting') && T.holder === 'stock') return { kind: 'wait', text: 'Behind the stock map' };
        if (T.state === 'parked' || T.state === 'waiting') return { kind: 'wait', text: 'Map area taken - waiting' };
        if (T.state === 'shown') {
            if (this.idle.length) return { kind: 'on', text: appName(this.idle[0].app) + ' idle - logo shown' };
            return { kind: 'on', text: 'Shown' + (T.rendering === 'verified' ? ' (verified)' : '') };
        }
        if (T.state === 'unavailable') return { kind: 'error', text: 'Map area unavailable' };
        return { kind: 'wait', text: 'Asking for the map area' };
    }
}
const SHORT_ERR = { missing: 'Needs Cluster renderer', noclient: 'Update Cluster renderer', untrusted: 'Renderer not trusted', load: 'Renderer failed to load' };

/**
 * The parked emblem's motion at t ms after it started: the stripes slide in (INTRO_MS), then a shine
 * of SHINE_MS every SHINE_EVERY; null between (the still image). key: the frame's identity.
 */
function motion(t, ew) {
    if (t < INTRO_MS) {
        const k = t / 700;
        const slide = [0, 1, 2].map((i) => Math.max(0, Math.min(1, k * 1.6 - i * 0.3))).map((x) => 1 - Math.pow(1 - x, 3));
        const q = slide.map((s) => Math.round(s * 20) / 20);
        if (q[0] >= 1 && q[1] >= 1 && q[2] >= 1) return null;
        return { key: 's' + q.join(','), opts: { slide: q } };
    }
    const c = (t - INTRO_MS) % SHINE_EVERY;
    if (c >= SHINE_MS) return null;
    const shine = Math.round(-4 + (c / SHINE_MS) * (ew + 6));
    return { key: 'h' + shine, opts: { shine } };
}

module.exports = { ClusterLogo, loadClient, trusted, mapLayers, drawing, appName, pixelImage, regularImage, placement, motion, cellRaster,
    TARGET, KLASS, Z, MAP_W, MAP_H, CELL, LOGO_W, LOGO_H, FPS_STILL, FPS_ANIM, POLL_MS, HOLD_MS, YIELD_MS, FRESH_MS };
