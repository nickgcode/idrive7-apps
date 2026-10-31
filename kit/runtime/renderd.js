'use strict';
/**
 * renderd.js - connection from an app to mgu-renderd (kit/renderd), the GPU renderer.
 *
 *   const gpu = new RenderClient('car_vitals', log);
 *   gpu.on('ready', () => gpu.place({ x, y, w, h, scale, ox, oy }));
 *   gpu.on('tick', () => { ...record a frame...; gpu.frame(recorder); });
 *   gpu.show(true);
 *
 * Fonts, colour ramps and cached layers a frame uses are uploaded once per connection
 * (again after a reconnect or a resize). With `file` instead of a socket path the messages
 * are written to that file (for `mgu-renderd --replay`).
 *
 * opts.native: ask for mgu-render's own dialect (mgu-render/1, the Store's renderer). There touch
 * claims and the controller grab work on one connection, and X_STATE says when the renderer has
 * the app on screen. A renderer that does not speak it answers READY alone and the connection
 * stays in the upstream dialect. Pixel images (op 18): the upstream dialect takes them as they are
 * recorded (Doom connects without opts.native); on mgu-render/1 they go as the native picture
 * (message 10, premultiplied RGBA, sides 1..1024) and each frame's op 18 is rewritten to the native
 * layout `x y w h r id` (mgu-store native/mgu-render/PROTOCOL.md, "Where the dialects differ").
 */
const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');
const rec = require('./record');

// the Store's renderer (mgu-render) first, then the community socket (an older renderer, or mgu-render's
// link): an older renderer still installed beside mgu-render never gets the apps
const SOCKETS = process.env.MGU_RENDERD_SOCKET ? [process.env.MGU_RENDERD_SOCKET] : ['/run/mgu-renderd/renderd.sock', '/run/mgu-render/render.sock'];
const SOCKET = SOCKETS[0];
const isSocket = (p) => { try { return fs.statSync(p).isSocket(); } catch (e) { return false; } };
const M = { HELLO: 1, PLACE: 2, SHOW: 3, ATLAS: 4, RAMP: 5, LAYER: 6, FRAME: 7, DROP_LAYER: 8, IMAGE: 9, GRAB: 10 };
const E = { READY: 101, TICK: 102, ERROR: 103, STATS: 104, CCU: 105 };
// an atlas the renderer hasn't refused this long after it was sent is taken (renderd.c answers before the
// frame's TICK; the emulator's page reports errors once a second)
const ATLAS_OK_MS = 1500;
// touch (mgu-render, IterioDev's mgu-renderd): message 9 is CLAIM there; 105 and 106 come back as TOUCH and CLOSED
const CLAIM = 9, TOUCH = 105, CLOSED = 106;
// mgu-render/1 (mgu-store native/mgu-render/PROTOCOL.md)
const X = { MODE: 0x4d520001, GRAB: 0x4d520002, READY: 0x4d520101, STATE: 0x4d520102, CCU: 0x4d520103 };
const X_MODE_LAYER = 1;

// mgu-render/1 (iterio numbering): message 10 is IMAGE, op 18 is `x y w h r id`
const NATIVE_IMAGE = 10;
// mgu-render/1 video (IterioDev protocol 4): VIDEO u32 id + path (NUL padded), DROP_VIDEO u32 id
const VIDEO_MSG = { VIDEO: 13, DROP: 14 };

/** RGBA -> premultiplied RGBA (a copy; opaque pixels are unchanged). */
function premultiply(px) {
    const out = Buffer.from(px);
    for (let i = 0; i < out.length; i += 4) {
        const a = out[i + 3];
        if (a === 255) continue;
        out[i] = (out[i] * a + 127) / 255 | 0; out[i + 1] = (out[i + 1] * a + 127) / 255 | 0; out[i + 2] = (out[i + 2] * a + 127) / 255 | 0;
    }
    return out;
}

/**
 * A copy of recorded draw words with every op 18 (record.js: `id ver x y w h`) rewritten to
 * mgu-render/1's `x y w h r id` (r = 0). Op lengths as record.js play(); an op it does not know
 * stops the walk (the rest is left as it is, as the renderer stops there too).
 */
function nativeOps(src) {
    const u = new Uint32Array(src), f = new Float32Array(u.buffer);
    const n = u.length;
    let i = 0;
    while (i < n) {
        const op = u[i++];
        switch (op) {
        case 1: i += 1; break;                      // CLEAR
        case 2: i += 5; break;                      // RECT
        case 3: i += 5 + u[i + 4] * 2; break;       // GRAD
        case 6: i += 6 + u[i + 5] * 2; break;       // CARD
        case 4: i += 6; break;                      // RRECT
        case 5: i += 7; break;                      // RSTROKE
        case 7: i += 8; break;                      // RAMPRECT
        case 8: i += 11; break;                     // ARC
        case 9: i += 6; break;                      // LINE
        case 10: i += 1 + u[i] * 9; break;          // TRIS
        case 11: i += 3 + u[i + 2] * 8; break;      // GLYPHS
        case 12: i += 3; break;                     // LAYER
        case 13: i += 4; break;                     // CLIP
        case 14: break;                             // NOCLIP
        case 15: i += 9; break;                     // QUAD
        case 16: i += 1; break;                     // ALPHA
        case 17: i += 3; break;                     // XF
        case 18: {                                  // IMAGE
            const id = u[i], x = f[i + 2], y = f[i + 3], w = f[i + 4], h = f[i + 5];
            f[i] = x; f[i + 1] = y; f[i + 2] = w; f[i + 3] = h; f[i + 4] = 0; u[i + 5] = id;
            i += 6; break;
        }
        case 19: i += 6; break;                     // VIDEO (recorded in the native layout already)
        default: return u;
        }
    }
    return u;
}

function msg(type, payload) {
    const len = payload ? payload.length : 0;
    const b = Buffer.allocUnsafe(8 + len + ((4 - (len & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4);
    if (len) payload.copy(b, 8);
    if (b.length > 8 + len) b.fill(0, 8 + len);
    return b;
}
function words(u32) { return Buffer.from(u32.buffer, u32.byteOffset, u32.byteLength); }

class RenderClient extends EventEmitter {
    constructor(appId, log, opts) {
        super();
        this.appId = appId;
        this.log = log || console;
        this.opts = opts || {};
        this.sock = null;
        this.connected = false;
        this.ready = false;
        this.screen = { w: 1920, h: 720 };
        this.placement = null;
        this.visible = false;
        this.inbuf = Buffer.alloc(0);
        this.sent = { atlas: new Set(), ramp: new Set(), layer: new Set(), image: new Map() };
        // atlases sent in the last ATLAS_OK_MS ([id, time]: an atlas ERROR is about one of them), and ones
        // held back to send one at a time, to find which of several the renderer refused (record.js markBadAtlas)
        this.pend = []; this.probe = [];
        this.stats = null;
        this.waiting = false;        // a frame was sent, no tick back yet
        this.retry = null;
        this.closed = false;
        this.fd = null;              // file sink
        this.claimed = null;         // the claims sent on this connection (JSON), null: none yet
        this.native = false;         // this connection speaks mgu-render/1 (X_READY came)
        this.info = null;            // X_READY: { touch, controller, frontGate, video }
        this.videos = new Map();     // video id -> its frame file (/dev/shm/mgu-video-*), sent again after PLACE
        this.onScreen = null;        // X_STATE: the renderer shows us (null: not told)
    }

    /** Socket exists (the renderer is installed and running)? */
    static available(path) { return path ? isSocket(path) : SOCKETS.some(isSocket); }

    connect() {
        if (this.opts.file) {
            this.fd = fs.openSync(this.opts.file, 'w');
            this.connected = this.ready = true;
            this._write(msg(M.HELLO, this._hello()));
            if (this.opts.native) { this.native = true; this._write(this._u32msg(X.MODE, [X_MODE_LAYER])); }
            setImmediate(() => this.emit('ready', this.screen));
            return this;
        }
        // the first socket there; one nobody listens on (a stopped renderer's) passes to the next
        const list = this.opts.socket ? [this.opts.socket] : SOCKETS.filter(isSocket);
        if (!list.length) list.push(SOCKET);
        const path = list[(this.at || 0) % list.length];
        if (path !== this.path) { this.path = path; this.log.info('renderd: socket ' + path); }
        const s = net.createConnection(path);
        this.sock = s;
        s.on('connect', () => {
            this.connected = true;
            this._reset();
            s.setNoDelay && s.setNoDelay(true);
            this.native = false; this.info = null; this.onScreen = null;
            this.claimed = null;
            this._write(msg(M.HELLO, this._hello()));
            // upstream renderers take these before READY; they are sent again once READY came
            if (this.placement) this._sendPlace();
            if (this.visible) this._write(this._u32msg(M.SHOW, [1]));
            if (this.grabbing && !this.opts.native) this._write(this._u32msg(M.GRAB, [1]));
        });
        s.on('data', (d) => this._data(d));
        s.on('error', (e) => {
            if (!this.connected) this.at = (this.at || 0) + 1;      // the next socket at the next try
            if (!this.errLogged) { this.errLogged = true; this.log.warn('renderd: ' + e.message); }
        });
        s.on('close', () => {
            const was = this.ready;
            this.connected = this.ready = this.native = false; this.sock = null; this.waiting = false; this.onScreen = null;
            if (was) { this.log.warn('renderd: connection closed'); this.emit('close'); }
            if (!this.closed) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 3000);
        });
        return this;
    }
    /**
     * Have the iDrive controller to ourselves (the HMI ignores the knob, press and tilt while it
     * holds; BACK / MENU and the touchscreen still work). Needs mgu-inputgate.so in the HMI.
     * Holds while we are shown and repeated here every 0.5 s; released at once with grab(false).
     */
    grab(on) {
        on = !!on;
        if (on === !!this.grabbing) return;
        this.grabbing = on;
        if (this.grabTimer) { clearInterval(this.grabTimer); this.grabTimer = null; }
        if (on) this.grabTimer = setInterval(() => { if (this.connected) this._sendGrab(1); }, 500);
        if (this.connected) this._sendGrab(on ? 1 : 0);
    }
    _sendGrab(on) {
        if (this.native) this._write(this._u32msg(X.GRAB, [on]));
        // mgu-render/1 asked for: wait for READY, which tells the dialect (upstream GRAB is IMAGE there)
        else if (!this.opts.native || this.ready) this._write(this._u32msg(M.GRAB, [on]));
    }
    /** HELLO: the app id; with opts.native also the dialect asked for */
    _hello() {
        const id = Buffer.from(this.appId);
        return this.opts.native ? Buffer.concat([id, Buffer.from([0]), Buffer.from('proto=mgu-render/1')]) : id;
    }
    /**
     * Touch in these rects ([{ x, y, w, h }] logical px) comes to this app as 'touch' (phase 1 down,
     * 2 move, 3 up, x, y) while it is shown; a touch elsewhere goes to the HMI and comes as 'closed'
     * (the renderer has hidden us). Only on a renderer that routes touch (READY's fourth word), and
     * only on a connection that never sends images or GRAB: CLAIM shares their message numbers
     * (not so in mgu-render/1: there claims and the grab go together).
     */
    claim(rects) {
        if (!this.ready || !this.touch || (!this.native && (this.grabbing || this.sent.image.size))) return;
        const key = JSON.stringify(rects);
        if (key === this.claimed || (this.claimed === null && !rects.length)) return;
        const b = Buffer.alloc(4 + rects.length * 16);
        b.writeUInt32LE(rects.length, 0);
        rects.forEach((r, i) => ['x', 'y', 'w', 'h'].forEach((k, j) => b.writeFloatLE(r[k], 4 + i * 16 + j * 4)));
        this._write(msg(CLAIM, b));
        this.claimed = key;
    }
    close() {
        this.grab(false);
        this.closed = true;
        if (this.retry) clearTimeout(this.retry);
        if (this.sock) this.sock.destroy();
        if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
    }
    _reset() { this.sent.atlas.clear(); this.sent.ramp.clear(); this.sent.layer.clear(); this.sent.image.clear(); this.waiting = false; this.pend = []; this.probe = []; }
    _write(b) {
        if (this.fd !== null) { fs.writeSync(this.fd, b); return true; }
        return this.sock && this.connected ? this.sock.write(b) : false;
    }
    _u32msg(type, arr) { const u = new Uint32Array(arr); return msg(type, words(u)); }

    _data(d) {
        this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, d]) : d;
        while (this.inbuf.length >= 8) {
            const type = this.inbuf.readUInt32LE(0), len = this.inbuf.readUInt32LE(4);
            if (this.inbuf.length < 8 + len) break;
            const p = this.inbuf.slice(8, 8 + len);
            this.inbuf = this.inbuf.slice(8 + len);
            if (type === X.READY && p.length >= 12) {
                const caps = p.readUInt32LE(8);
                this.native = true;
                this.info = { touch: !!(caps & 1), controller: !!(caps & 2), frontGate: !!(caps & 4), video: !!(caps & 16) };
            } else if (type === E.READY) {
                this.ready = true; this.errLogged = false;
                this.screen = { w: p.readUInt32LE(4), h: p.readUInt32LE(8) };
                this.touch = p.length >= 16 && p.readUInt32LE(12) !== 0;
                this.log.info('renderd: connected, screen ' + this.screen.w + 'x' + this.screen.h +
                    (this.native ? ', mgu-render/1 ' + JSON.stringify(this.info) : this.opts.native ? ', upstream dialect (no mgu-render/1)' : ''));
                if (this.native) this._write(this._u32msg(X.MODE, [X_MODE_LAYER]));
                else if (this.grabbing && this.opts.native) this._write(this._u32msg(M.GRAB, [1]));
                this.emit('ready', this.screen);
                // after the app's placement (sent in 'ready'): SHOW again. A SHOW sent before the renderer
                // knew where the app goes (or before X_MODE) left the first app opened after start blank.
                if (this.placement) this._sendPlace();
                if (this.visible) this._write(this._u32msg(M.SHOW, [1]));
                if (this.native && this.grabbing) this._sendGrab(1);
            } else if (this.native && type === X.STATE && p.length >= 12) {
                const on = !!p.readUInt32LE(4), front = !!p.readUInt32LE(8);
                if (on !== this.onScreen) this.log.info('renderd: ' + (on ? 'on screen' : 'not on screen') + (front ? '' : ' (not in front)'));
                this.onScreen = on;
                this.emit('state', { onScreen: on, front });
            } else if (this.native && type === X.CCU && p.length >= 5) {
                this.emit('ccu', {
                    frontSequenceNumberOperatingElement: p[0], frontRotaryEncoderOperation: p.readUInt16BE(1),
                    frontRotaryEncoderPushButton: p[3], frontRotaryEncoderDeflection: p[4],
                });
            } else if (type === E.TICK) {
                this.waiting = false;
                this.emit('tick', p.readUInt32LE(0), p.readUInt32LE(4));
            } else if ((this.claimed || this.native) && type === TOUCH && p.length >= 12) {
                this.emit('touch', p.readUInt32LE(0), p.readFloatLE(4), p.readFloatLE(8));
            } else if ((this.claimed || this.native) && type === CLOSED) {
                this.visible = false;
                this.emit('closed');
            } else if (!this.native && type === E.CCU && p.length >= 5) {
                // the controller event the HMI didn't get (we hold the grab): FrontCCU names
                this.emit('ccu', {
                    frontSequenceNumberOperatingElement: p[0], frontRotaryEncoderOperation: p.readUInt16BE(1),
                    frontRotaryEncoderPushButton: p[3], frontRotaryEncoderDeflection: p[4],
                });
            } else if (type === E.STATS) {
                this.stats = { fps: p.readUInt32LE(0), avgUs: p.readUInt32LE(4), maxUs: p.readUInt32LE(8) };
                this.emit('stats', this.stats);
            } else if (type === E.ERROR) {
                const text = p.toString();
                this.log.warn('renderd error: ' + text);
                if (/glyph atlas texture full|atlas \d+: too many/.test(text)) this._atlasRefused();
            }
        }
    }

    /**
     * Where the surface goes: x, y, w, h in screen pixels; logical content is drawn at
     * device = logical * scale + (ox, oy) inside it.
     */
    place(pl) {
        const resize = !this.placement || pl.w !== this.placement.w || pl.h !== this.placement.h;
        if (this.placement && !resize && ['x', 'y', 'scale', 'ox', 'oy'].every((k) => pl[k] === this.placement[k])) return;
        const scaleChanged = this.placement && this.placement.scale !== pl.scale;
        this.placement = Object.assign({}, pl);
        if (resize || scaleChanged) this._reset();     // the renderer dropped our resources
        if (this.ready) this._sendPlace();
    }
    _sendPlace() {
        const p = this.placement, b = Buffer.alloc(28);
        b.writeInt32LE(p.x | 0, 0); b.writeInt32LE(p.y | 0, 4); b.writeInt32LE(p.w | 0, 8); b.writeInt32LE(p.h | 0, 12);
        b.writeFloatLE(p.scale, 16); b.writeFloatLE(p.ox || 0, 20); b.writeFloatLE(p.oy || 0, 24);
        this._write(msg(M.PLACE, b));
        // a new size drops the app's videos with its other resources (PROTOCOL.md): name them again
        this.videos.forEach((file, id) => this._sendVideo(id, file));
    }

    /**
     * mgu-render/1 video (renderer caps bit 16, info.video): frames another writer puts in `file`
     * (/dev/shm/mgu-video-<name>, MGVF header + I420 slots, PROTOCOL.md "Video"), drawn where a frame's
     * Recorder.video(id, ...) op is. Kept and named again after a reconnect or a new size.
     * Returns false where the renderer has no video (then draw the picture some other way).
     */
    video(id, file) {
        this.videos.set(id >>> 0, file);
        return this._sendVideo(id >>> 0, file);
    }
    dropVideo(id) {
        if (!this.videos.delete(id >>> 0)) return;
        if (this.ready && this.native) this._write(this._u32msg(VIDEO_MSG.DROP, [id >>> 0]));
    }
    _sendVideo(id, file) {
        if (!this.ready || !this.native || !this.info || !this.info.video) return false;
        const head = Buffer.alloc(4); head.writeUInt32LE(id, 0);
        return this._write(msg(VIDEO_MSG.VIDEO, Buffer.concat([head, Buffer.from(file, 'utf8'), Buffer.from([0])])));
    }
    show(on) {
        on = !!on;
        if (on === this.visible) return;
        this.visible = on;
        if (this.ready) this._write(this._u32msg(M.SHOW, [on ? 1 : 0]));
    }

    /**
     * The renderer refused a glyph atlas (its shared texture is full, or this app has 64). The car's renderer
     * says so before the frame's TICK, the emulator up to a second later, so the atlases sent in the last
     * ATLAS_OK_MS are the suspects: one alone is marked bad (its text then uses another size: record.js);
     * several are sent again one at a time, each ATLAS_OK_MS apart, until the refused one is found.
     */
    _atlasRefused() {
        const p = this.pend;
        this.pend = [];
        if (p.length === 1) {
            const f = rec.atlasById(p[0][0]);
            rec.markBadAtlas(p[0][0]);
            this.sent.atlas.delete(p[0][0]);
            this.log.warn('renderd: glyph atlas ' + (f ? f.family + '@' + f.size + ' (' + f.atlasW + 'x' + f.atlasH + ')' : p[0][0]) + ' refused: '
                + 'that text is drawn with another size from now on (' + rec.badAtlas.size + ' refused, ' + this.sent.atlas.size + ' sent)');
        } else if (p.length) {
            p.slice().reverse().forEach((e) => { this.sent.atlas.delete(e[0]); if (this.probe.indexOf(e[0]) < 0) this.probe.unshift(e[0]); });
            this.log.info('renderd: finding the refused glyph atlas among ' + p.length + ' (one at a time)');
        } else this.log.info('renderd: no glyph atlas sent lately to match that error with');
    }
    _ensureAtlas(id, now) {
        const f = rec.atlasById(id);
        if (!f || this.sent.atlas.has(id) || rec.badAtlas.has(id)) {
            const q = this.probe.indexOf(id);
            if (q >= 0) this.probe.splice(q, 1);
            return;
        }
        if (this.probe.length && this.probe[0] !== id || this.pend.length && this.probe.length) {
            // finding a refused one: wait in line (the text is missing for that long)
            if (this.probe.indexOf(id) < 0) this.probe.push(id);
            return;
        }
        if (this.probe[0] === id) this.probe.shift();
        this.pend.push([id, now || Date.now()]);
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeUInt32LE(f.atlasW, 4); head.writeUInt32LE(f.atlasH, 8);
        this._write(msg(M.ATLAS, Buffer.concat([head, f.alpha])));
        this.sent.atlas.add(id);
    }
    _ensureRamp(id) {
        if (this.sent.ramp.has(id)) return;
        const stops = rec.rampList[id];
        if (!stops) return;
        const u = new Uint32Array(2 + stops.length);
        u[0] = id; u[1] = stops.length;
        stops.forEach((c, i) => { u[2 + i] = rec.pack(c); });
        this._write(msg(M.RAMP, words(u)));
        this.sent.ramp.add(id);
    }
    _ensureRes(r) {
        if (r.atlases) r.atlases.forEach((id) => this._ensureAtlas(id));
        if (r.ramps) r.ramps.forEach((id) => this._ensureRamp(id));
        if (r.layersUsed || r.sublayers) (r.layersUsed || r.sublayers).forEach((id) => this._ensureLayer(id));
        if (r.images) r.images.forEach((id) => this._ensureImage(id));
    }
    /** upload a pixel image when this connection hasn't got its current version */
    _ensureImage(id) {
        const im = rec.imageById.get(id);
        if (!im || !im.data) return;
        if (this.sent.image.get(id) === im.ver) return;
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeUInt32LE(im.w, 4); head.writeUInt32LE(im.h, 8);
        let px = Buffer.from(im.data.buffer, im.data.byteOffset, im.w * im.h * 4);
        if (this.native) {
            // native picture: message 10, sides 1..1024, premultiplied RGBA (PROTOCOL.md)
            if (!(im.w >= 1 && im.h >= 1 && im.w <= 1024 && im.h <= 1024)) {
                if (!this.imgWarned) { this.imgWarned = true; this.log.warn('renderd: image ' + id + ' over 1024 px is not sent on mgu-render/1'); }
                return;
            }
            px = premultiply(px);
            this._write(msg(NATIVE_IMAGE, Buffer.concat([head, px])));
        } else this._write(msg(M.IMAGE, Buffer.concat([head, px])));
        this.sent.image.set(id, im.ver);
    }
    _ensureLayer(id) {
        if (this.sent.layer.has(id)) return;
        const L = rec.layerById.get(id);
        if (!L) return;
        this._ensureRes(L);
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeFloatLE(L.w, 4); head.writeFloatLE(L.h, 8);
        this._write(msg(M.LAYER, Buffer.concat([head, words(this.native ? nativeOps(L.words) : L.words)])));
        this.sent.layer.add(id);
    }
    dropLayer(id) {
        if (this.sent.layer.delete(id) && this.ready) this._write(this._u32msg(M.DROP_LAYER, [id]));
    }

    /** Send a recorded frame (record.js Recorder). Returns false if not connected. */
    frame(r) {
        if (!this.ready || !this.placement) return false;
        const now = Date.now();
        this.pend = this.pend.filter((e) => now - e[1] < ATLAS_OK_MS);      // older ones: taken
        // while finding a refused atlas: the next in line once the last one sent was taken
        while (this.probe.length && !this.pend.length) {
            const n = this.probe.length;
            this._ensureAtlas(this.probe[0], now);
            if (this.probe.length === n) break;
        }
        this._ensureRes(r);
        this.waiting = true;
        const w = r.words();
        return this._write(msg(M.FRAME, words(this.native && r.images && r.images.size ? nativeOps(w) : w)));
    }
}

module.exports = { RenderClient, SOCKET, SOCKETS };
