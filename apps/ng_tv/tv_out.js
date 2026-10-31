'use strict';
/**
 * tv_out.js - where decoded pictures go.
 *
 * ShmOut: the renderer's video path (mgu-render/1 with caps bit 16, kit renderd.js video()): I420 frames in
 *   /dev/shm/mgu-video-<name>, a 64-byte MGVF header and 3 slots; the renderer draws the newest one where
 *   the frame's video op is, scaled on the GPU. Written as the protocol says: the slot after the newest,
 *   then the header's slot, then its seq. Opened without following links, owned by the app.
 * ImageOut: anywhere else (the emulator, the PC preview, a renderer without video): the picture at half
 *   size as RGBA, a kit pixel image (record.setImage), at a few frames a second.
 */
const fs = require('fs');
const record = require('./kit/record');

const MAGIC = 0x4656474d, SLOTS = 3, HDR = 64;

class ShmOut {
    constructor(name, log) {
        this.file = '/dev/shm/mgu-video-' + name; this.log = log;
        this.fd = null; this.w = 0; this.h = 0; this.seq = 0; this.slot = 0;
        this.gen = 0;                 // counts (re)creations of the file: the renderer must be told each one
        this.hdr = Buffer.alloc(HDR); this.word = Buffer.alloc(4);
    }
    _open(w, h) {
        this.close();
        try { fs.unlinkSync(this.file); } catch (e) { /* none */ }
        const C = fs.constants;
        this.fd = fs.openSync(this.file, C.O_RDWR | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW || 0), 0o644);
        const fsz = w * h * 3 / 2;
        fs.ftruncateSync(this.fd, HDR + SLOTS * fsz);
        this.w = w; this.h = h; this.seq = 0; this.slot = 0; this.gen++;
        const b = this.hdr; b.fill(0);
        b.writeUInt32LE(MAGIC, 0); b.writeUInt32LE(1, 4); b.writeUInt32LE(w, 8); b.writeUInt32LE(h, 12);
        b.writeUInt32LE(0, 16); b.writeUInt32LE(0, 20); b.writeUInt32LE(SLOTS, 24);
        b.writeUInt32LE(0, 28);     // BT.601: SD broadcast recordings
        b.writeUInt32LE(0, 32);     // limited range
        fs.writeSync(this.fd, b, 0, HDR, 0);
    }
    /** frame: { w, h, yuv } (I420, w and h even). */
    write(f) {
        if (f.w & 1 || f.h & 1 || f.w < 16 || f.h < 16 || f.w > 2048 || f.h > 2048) return false;
        if (this.fd === null || f.w !== this.w || f.h !== this.h) this._open(f.w, f.h);
        const fsz = f.w * f.h * 3 / 2, next = (this.slot + 1) % SLOTS;
        const src = Buffer.from(f.yuv.buffer, f.yuv.byteOffset, fsz);
        fs.writeSync(this.fd, src, 0, fsz, HDR + next * fsz);
        this.slot = next; this.word.writeUInt32LE(next, 0); fs.writeSync(this.fd, this.word, 0, 4, 20);
        this.seq = (this.seq + 1) >>> 0; this.word.writeUInt32LE(this.seq, 0); fs.writeSync(this.fd, this.word, 0, 4, 16);
        return true;
    }
    close() {
        if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (e) { /* gone */ } this.fd = null; }
    }
    remove() { this.close(); try { fs.unlinkSync(this.file); } catch (e) { /* none */ } }
}

/** I420 (limited range, BT.601) -> RGBA at half size (each 2x2 block: one pixel). */
function halfRgba(f, out) {
    const w = f.w, h = f.h, ow = w >> 1, oh = h >> 1, y = f.yuv, uo = w * h, vo = uo + ow * oh;
    const o = out && out.length === ow * oh * 4 ? out : new Uint8Array(ow * oh * 4);
    let p = 0;
    for (let j = 0; j < oh; j++) {
        const yr = j * 2 * w, cr = j * ow;
        for (let i = 0; i < ow; i++) {
            const Y = ((y[yr + i * 2] + y[yr + i * 2 + 1] + y[yr + w + i * 2] + y[yr + w + i * 2 + 1]) >> 2) - 16;
            const U = y[uo + cr + i] - 128, V = y[vo + cr + i] - 128;
            const c = 1.164 * Y;
            let r = c + 1.596 * V, g = c - 0.392 * U - 0.813 * V, b = c + 2.017 * U;
            o[p++] = r < 0 ? 0 : r > 255 ? 255 : r;
            o[p++] = g < 0 ? 0 : g > 255 ? 255 : g;
            o[p++] = b < 0 ? 0 : b > 255 ? 255 : b;
            o[p++] = 255;
        }
    }
    return { w: ow, h: oh, px: o };
}

class ImageOut {
    constructor(id) { this.id = id; this.px = null; this.w = 0; this.h = 0; this.has = false; }
    write(f) {
        const r = halfRgba(f, this.px);
        this.px = r.px; this.w = r.w; this.h = r.h; this.has = true;
        record.setImage(this.id, r.w, r.h, r.px);
        return true;
    }
    clear() { this.has = false; }
}

module.exports = { ShmOut, ImageOut, halfRgba };
