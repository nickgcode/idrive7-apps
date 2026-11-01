'use strict';
/**
 * tv_cluster.js - G's TV's picture in the instrument cluster's central map area ("Play in cluster"),
 * through the separately installed "Cluster renderer" tool (cluster-render, robertnisipeanu/idrive-apps,
 * from the Store). Written for G's TV from the tool's PROTOCOL.md and README; it contains none of the
 * tool's code. The tool's own Node client (MPL-2.0) is loaded at run time from where the tool installs it,
 * nothing of it is copied here:
 *     /var/opt/cluster-render/current/cluster_render_client.js
 *
 * What goes there: one "video" layer on the "map" target only (slot 0x100, 1088x480, the area between the
 * dials), class "content" at z 100 (above the CarPlay map of waze-on-cluster, content at z 0, however
 * old either layer is; dropped, the map shows again), never "alert", never "exclusive", never the "panel" or "hud" targets. The
 * picture is fitted into a 640x480 area centred in the map (x 224). Each frame is the decoder's I420
 * picture scaled to fit 320x240 and repacked into the service's 4:2:0 atlas (Y rows, then U and V side by
 * side in h/2 rows), its levels stretched from limited to full range (the service's shader is full-range
 * BT.601). At most 15 a second: about 1.7 MB/s worst case, well under the service's shared 6000 KB/s
 * ceiling; fewer a second when the service reports a lower upload cap.
 *
 * Safety (main.js decides when; this file makes it immediate): stop() drops the layer, which the service
 * removes at once (no fade). stall_ms 1000 (the service's minimum) as a backstop: if frames stop without a
 * drop, the last one stops being drawn within about a second. When the app ends its socket closes and
 * the service removes its layers at once.
 *
 * Trust: the client file is code that runs in G's TV, so it is used only when it is a regular file owned
 * by root and not writable by group or others (the Store installs tools as root), in a directory with the
 * same properties. NG_CR_CLIENT / NG_CR_SOCK point at a test client and socket (the emulator, tests) and
 * skip that check.
 *
 * Service 0.2.2 adds "rendering" to its target events (verified: the cluster's renderer draws our scene;
 * checking: not yet, and after 1.5 s shown the service asks for the slot again by itself; unobservable;
 * none). The tool's client (unchanged) does not pass it on, so it is read from the event before the client
 * handles it, and shown in the status line. 0.2.1 sends none: the status is as before. Nothing here acts
 * on it: the service does the asking again, and the layer, its class, z and stall_ms stay as they are.
 *
 * Never throws into the player, never blocks. Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const path = require('path');

const CLIENT = process.env.NG_CR_CLIENT || '/var/opt/cluster-render/current/cluster_render_client.js';
const SOCK = process.env.NG_CR_SOCK || '/dev/shm/cluster-render/render.sock';
const TESTING = !!(process.env.NG_CR_CLIENT || process.env.NG_CR_SOCK);

const TARGET = 'map';                     // the only target G's TV uses
const MAP_W = 1088, MAP_H = 480;          // the map target's size
const AREA = { x: 224, y: 0, w: 640, h: 480 };   // the picture's area, centred in the map
const MAX_VW = 320, MAX_VH = 240;         // the atlas at most (scaled up on the cluster's GPU)
const FPS = 15;                           // at most, while the upload cap is at its ceiling
const Z = 100;                            // above other "content" layers on the map whatever their age (the
                                          // service orders by class, then z, then newest; the CarPlay map of
                                          // waze-on-cluster is content at z 0), so no "exclusive" or "alert"
const STALL_MS = 1000;                    // the service's minimum
const READY_MS = 5000;                    // no hello within this: "not answering"

/* ----- the picture ----- */

/** Levels: limited range (16-235 / 16-240) -> full range, as two lookup tables. */
const LUT_Y = new Uint8Array(256), LUT_C = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    LUT_Y[i] = Math.max(0, Math.min(255, Math.round((i - 16) * 255 / 219)));
    LUT_C[i] = Math.max(0, Math.min(255, Math.round((i - 128) * 255 / 224 + 128)));
}

/** The atlas size and where it is drawn, for a w x h picture: fitted into AREA and MAX_VW x MAX_VH. */
function geometry(w, h) {
    const asp = w / h;
    let rw = AREA.w, rh = Math.round(AREA.w / asp);
    if (rh > AREA.h) { rh = AREA.h; rw = Math.round(AREA.h * asp); }
    rw += rw & 1; rh += rh & 1;
    const s = Math.min(1, MAX_VW / w, MAX_VH / h);
    const vw = Math.max(64, Math.round(w * s) & ~3), vh = Math.max(32, Math.round(h * s) & ~1);
    return { vw, vh, x: AREA.x + Math.round((AREA.w - rw) / 2), y: AREA.y + Math.round((AREA.h - rh) / 2), w: rw, h: rh };
}

/**
 * I420 (f.w x f.h, limited range) -> the service's atlas (vw x vh, full range) in out (a Buffer of
 * vw*vh*3/2). Luma: the average of the 2x2 source pixels at each output pixel's place (an exact 2x2 box
 * for a 2x reduction); chroma: the nearest source sample.
 */
function toAtlas(f, vw, vh, out, maps) {
    const sw = f.w, sh = f.h, src = f.yuv, cw = sw >> 1, ch = sh >> 1, us = sw * sh, vs = us + cw * ch;
    const m = maps && maps.key === sw + 'x' + sh + '>' + vw + 'x' + vh ? maps : mapsFor(sw, sh, vw, vh);
    const xm = m.xm, ym = m.ym, cxm = m.cxm, cym = m.cym;
    for (let j = 0; j < vh; j++) {
        const r0 = ym[j] * sw, r1 = (ym[j] + 1 < sh ? ym[j] + 1 : ym[j]) * sw, o = j * vw;
        for (let i = 0; i < vw; i++) {
            const x0 = xm[i], x1 = x0 + 1 < sw ? x0 + 1 : x0;
            out[o + i] = LUT_Y[(src[r0 + x0] + src[r0 + x1] + src[r1 + x0] + src[r1 + x1] + 2) >> 2];
        }
    }
    const hw = vw >> 1, hh = vh >> 1, ys = vw * vh;
    for (let j = 0; j < hh; j++) {
        const o = ys + j * vw, ur = us + cym[j] * cw, vr = vs + cym[j] * cw;
        for (let i = 0; i < hw; i++) { const x = cxm[i]; out[o + i] = LUT_C[src[ur + x]]; out[o + hw + i] = LUT_C[src[vr + x]]; }
    }
    return m;
}
function mapsFor(sw, sh, vw, vh) {
    const xm = new Uint16Array(vw), ym = new Uint16Array(vh), cxm = new Uint16Array(vw >> 1), cym = new Uint16Array(vh >> 1);
    for (let i = 0; i < vw; i++) xm[i] = Math.min(sw - 1, Math.floor((i + 0.5) * sw / vw - 0.5) < 0 ? 0 : Math.floor((i + 0.5) * sw / vw - 0.5));
    for (let j = 0; j < vh; j++) ym[j] = Math.min(sh - 1, Math.floor((j + 0.5) * sh / vh - 0.5) < 0 ? 0 : Math.floor((j + 0.5) * sh / vh - 0.5));
    for (let i = 0; i < vw >> 1; i++) cxm[i] = Math.min((sw >> 1) - 1, Math.floor((i + 0.5) * sw / vw));
    for (let j = 0; j < vh >> 1; j++) cym[j] = Math.min((sh >> 1) - 1, Math.floor((j + 0.5) * sh / vh));
    return { key: sw + 'x' + sh + '>' + vw + 'x' + vh, xm, ym, cxm, cym };
}

/** The frame rate for an upload cap (KB/s) against its ceiling: 15 at the ceiling, then 10, then 5. */
function fpsForBudget(cap, max) {
    if (!(cap > 0) || !(max > 0) || cap >= max) return FPS;
    return cap >= 4000 ? 10 : 5;
}

/* ----- the client ----- */

/** A root-owned file nobody else may write, in a directory with the same properties. */
function trusted(file) {
    try {
        const real = fs.realpathSync(file);
        const st = fs.statSync(real), dir = fs.statSync(path.dirname(real));
        return st.isFile() && st.uid === 0 && !(st.mode & 0o022) && dir.uid === 0 && !(dir.mode & 0o022);
    } catch (e) { return false; }
}

const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };

/**
 * The tool's client, or { error, text } why not:
 *   missing: neither the client nor the socket (the tool isn't installed)
 *   noclient: the socket but no client file (an old or broken install)
 *   untrusted: not a root-owned file only root can write
 *   load: it threw or isn't the expected module
 */
function loadClient(opts) {
    const o = opts || {};
    const file = o.client || CLIENT, sock = o.sock || SOCK, testing = o.testing !== undefined ? o.testing : TESTING;
    if (!exists(file)) {
        return exists(sock) ? { error: 'noclient', text: 'Cluster renderer client missing - update the Cluster renderer tool' }
            : { error: 'missing', text: 'Cluster renderer not installed - get "Cluster renderer" in the Store' };
    }
    if (!testing && !trusted(file)) return { error: 'untrusted', text: 'Cluster renderer client not trusted (not owned by root)' };
    try {
        const m = require(file);
        if (!m || typeof m.ClusterRender !== 'function') return { error: 'load', text: 'Cluster renderer client not recognised' };
        return { ClusterRender: m.ClusterRender, sock: o.sock || process.env.NG_CR_SOCK || m.DEFAULT_PATH || SOCK };
    } catch (e) {
        return { error: 'load', text: 'Cluster renderer client failed to load', detail: e.message };
    }
}

class ClusterOut {
    /** opts: log, app ('ng_tv'), client / sock / testing (tests), now() */
    constructor(opts) {
        const o = opts || {};
        this.log = o.log || { info() {}, warn() {} };
        this.app = o.app || 'ng_tv';
        this.opts = o;
        this.now = o.now || Date.now;
        this.on = false;          // the toggle
        this.cr = null; this.err = null;
        this.ready = false; this.connectAt = 0;
        this.ref = 0; this.geo = null; this.key = '';
        this.atlas = null; this.maps = null; this.id = 0;
        this.fps = FPS; this.lastAt = -1e15; this.sent = 0;
        this.layerState = ''; this.layerReason = '';
        this.target = { state: '', holder: '', reason: '', rendering: '' };
        this.budget = null;
        this.refused = '';
        this.sock = '';
    }

    /** The toggle: on connects to the service (so its state shows), off drops everything and disconnects. */
    enable(on) {
        on = !!on;
        if (on === this.on) return;
        this.on = on;
        if (on) this._connect(); else this.close();
    }

    _connect() {
        if (this.cr) return;
        const c = loadClient(this.opts);
        if (c.error) {
            this.err = c;
            this.log.warn('cluster: ' + c.text + (c.detail ? ' (' + c.detail + ')' : ''));
            return;
        }
        this.err = null;
        this.sock = c.sock;
        const cr = this.cr = new c.ClusterRender(this.app, this.sock);
        this.ready = false; this.connectAt = this.now();
        cr.on('ready', () => {
            if (this.cr !== cr) return;
            this.ready = true;
            this.log.info('cluster: connected (' + (cr.backend || '?') + ', targets ' + (cr.targets || '?') + ')');
        });
        cr.on('disconnected', () => { if (this.cr === cr) { this.ready = false; this.connectAt = this.now(); this.log.warn('cluster: renderer gone - reconnecting'); } });
        cr.on('layer', (ref, state, reason) => {
            if (this.cr !== cr || ref !== this.ref) return;
            if (state !== this.layerState || reason !== this.layerReason) this.log.info('cluster: layer ' + state + (reason ? ' (' + reason + ')' : ''));
            this.layerState = state || ''; this.layerReason = reason || '';
        });
        // the target event's "rendering" (service 0.2.2), which the client's 'target' event leaves out
        let rendering = '';
        const handle = cr._event;
        if (typeof handle === 'function') {
            cr._event = function (ev) {
                try { if (ev && ev.ev === 'target' && ev.target === TARGET) rendering = typeof ev.rendering === 'string' ? ev.rendering : ''; } catch (e) { /* as 0.2.1 */ }
                return handle.apply(this, arguments);
            };
        }
        cr.on('target', (name, state, holder, reason) => {
            if (this.cr !== cr || name !== TARGET) return;
            this.log.info('cluster: map ' + state + (holder ? ' holder ' + holder : '') + (reason ? ' (' + reason + ')' : '') + (rendering ? ', rendering ' + rendering : ''));
            this.target = { state: state || '', holder: holder || '', reason: reason || '', rendering: rendering };
            rendering = '';
        });
        cr.on('budget', (cap, max, reason) => {
            if (this.cr !== cr) return;
            this.budget = { cap, max, reason: reason || '' };
            const fps = fpsForBudget(cap, max);
            if (fps !== this.fps) this.log.info('cluster: upload cap ' + cap + ' of ' + max + ' KB/s - ' + fps + ' pictures a second');
            this.fps = fps;
        });
        cr.on('refused', (op, ref, reason) => {
            if (this.cr !== cr) return;
            this.refused = (op || '?') + ': ' + (reason || '?');
            this.log.warn('cluster: refused ' + this.refused);
        });
        try { cr.connect(); } catch (e) { this.log.warn('cluster: connect ' + e.message); }
    }

    /**
     * One decoded picture { w, h, yuv (I420) }. Only call while parked (main.js's gate); the layer is
     * made with the first picture after a stop(). False when nothing was sent.
     */
    write(f) {
        if (!this.on || !this.cr || !this.ready || !f || !f.yuv || f.w < 16 || f.h < 16 || (f.w & 1) || (f.h & 1)) return false;
        const now = this.now();
        if (now - this.lastAt < 1000 / this.fps - 4) return false;
        try {
            const key = f.w + 'x' + f.h;
            if (!this.ref || key !== this.key) {
                if (this.ref) this._drop();
                const g = geometry(f.w, f.h);
                const ref = this.cr.video({ target: TARGET, klass: 'content', z: Z, x: g.x, y: g.y, w: g.w, h: g.h,
                    vw: g.vw, vh: g.vh, fps: FPS, stall_ms: STALL_MS, contend: true });
                if (!ref) { this.log.warn('cluster: video layer refused by the client'); return false; }
                this.ref = ref; this.geo = g; this.key = key;
                this.atlas = Buffer.alloc(g.vw * g.vh * 3 / 2);
                this.layerState = 'new'; this.layerReason = '';
                this.log.info('cluster: video layer ' + g.vw + 'x' + g.vh + ' at ' + g.x + ',' + g.y + ' ' + g.w + 'x' + g.h + ' on the map');
            }
            this.maps = toAtlas(f, this.geo.vw, this.geo.vh, this.atlas, this.maps);
            if (!this.cr.frame(this.ref, this.atlas, ++this.id)) return false;
            this.lastAt = now; this.sent++;
            return true;
        } catch (e) {
            this.log.warn('cluster: frame ' + e.message);
            return false;
        }
    }

    _drop() {
        const ref = this.ref;
        this.ref = 0; this.key = ''; this.geo = null; this.layerState = ''; this.layerReason = ''; this.lastAt = -1e15;
        if (ref && this.cr) { try { this.cr.drop(ref); } catch (e) { /* gone */ } }
    }

    /** Off the cluster now: the layer is dropped (the service removes it at once, without a fade). */
    stop() {
        if (!this.ref) return;
        this._drop();
        this.log.info('cluster: picture off');
    }

    /** Toggle off, app end: drop and disconnect. */
    close() {
        this._drop();
        if (this.cr) { try { this.cr.close(); } catch (e) { /* gone */ } }
        this.cr = null; this.ready = false;
        this.target = { state: '', holder: '', reason: '', rendering: '' };
        this.budget = null; this.refused = ''; this.fps = FPS;
    }

    /** Whether the picture is in the cluster now. */
    showing() { return !!(this.ref && this.layerState === 'shown'); }

    /**
     * { level: 'off' | 'info' | 'ok' | 'warn' | 'bad', text } for the screen. parked: the gate is open,
     * playing: the player has pictures to send.
     */
    status(parked, playing) {
        if (!this.on) return { level: 'off', text: 'Off' };
        if (this.err) return { level: 'bad', text: this.err.text };
        if (!this.cr) return { level: 'bad', text: 'Cluster renderer unavailable' };
        if (!this.ready) {
            const sockThere = exists(this.sock || SOCK);
            if (!sockThere) return { level: 'bad', text: 'Cluster renderer not running (no socket)' };
            return this.now() - this.connectAt > READY_MS ? { level: 'bad', text: 'Cluster renderer not answering' }
                : { level: 'info', text: 'Connecting to the cluster renderer...' };
        }
        if (!parked) return { level: 'info', text: 'Ready - plays in the cluster when parked' };
        if (!this.ref) return { level: 'info', text: playing ? 'Starting...' : 'Ready - press Play' };
        const t = this.target, ls = this.layerState;
        if (this.refused && ls !== 'shown') return { level: 'bad', text: 'Refused (' + this.refused + ')' };
        if (ls === 'error') return { level: 'bad', text: 'Refused by the renderer' + (this.layerReason ? ' (' + this.layerReason + ')' : '') };
        if (ls === 'shown' || t.state === 'shown') {
            const g = this.geo;
            const low = this.budget && this.budget.cap < this.budget.max;
            const text = 'Playing in the map area' + (g ? ' - ' + g.vw + 'x' + g.vh : '') + ' ' + this.fps + ' fps' + (low ? ' (link busy)' : '');
            // service 0.2.2: whether the cluster's renderer is drawing it; it asks again by itself
            if (t.rendering === 'checking') return { level: 'warn', text: text + ' - cluster not drawing it yet, asking again' };
            return { level: low ? 'warn' : 'ok', text: text + (t.rendering === 'verified' ? ' (drawn)' : '') };
        }
        if (t.holder === 'stock') return { level: 'warn', text: 'Taking over the stock map (Central display area: Map view)' };
        if (t.holder === 'foreign') return { level: 'warn', text: 'Map area busy (warning or other content)' };
        if (t.state === 'unavailable') return { level: 'bad', text: 'Map area unavailable' };
        if (ls === 'suspended') return { level: 'warn', text: 'Hidden by other cluster content' };
        if (ls === 'stalled') return { level: 'info', text: 'Waiting for pictures...' };
        return { level: 'info', text: 'Asking for the map area...' };
    }
}

module.exports = { ClusterOut, loadClient, toAtlas, geometry, fpsForBudget, trusted, TARGET, AREA, FPS, STALL_MS, Z };
