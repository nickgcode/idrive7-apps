'use strict';
/**
 * tv_h264.js - H.264 decoding in WebAssembly (h264.wasm: FFmpeg's libavcodec H.264 decoder only, LGPL 2.1+,
 * built for plain WebAssembly 1.0 as Node 8 runs it: no SIMD, no threads; tools/gstv_decoder/ builds it).
 * Pure software on one core: no hardware decoder and no root.
 *
 *   const d = await H264.load(dir); d.open(avcC); d.decode(sampleBuffer, pts) -> frame or null
 *   frame = { w, h, pts, yuv (Uint8Array view of I420, valid until the next call) }
 */
const fs = require('fs');
const path = require('path');

class H264 {
    static load(dir) {
        const bytes = fs.readFileSync(path.join(dir, 'h264.wasm'));
        let mem = null;
        const nope = () => 52;      // WASI ENOSYS: the decoder never needs files or the clock
        const wasi = {
            clock_time_get: nope, fd_close: nope, fd_read: nope, fd_seek: nope, fd_fdstat_get: nope,
            environ_sizes_get: (a, b) => { const v = new Uint32Array(mem.buffer); v[a >> 2] = 0; v[b >> 2] = 0; return 0; },
            environ_get: () => 0,
            fd_write: (fd, iov, n, out) => { const v = new Uint32Array(mem.buffer); let s = 0; for (let i = 0; i < n; i++) s += v[(iov >> 2) + i * 2 + 1]; v[out >> 2] = s; return 0; },
            proc_exit: (c) => { throw new Error('h264.wasm exited ' + c); },
        };
        return WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi }).then((r) => {
            const x = r.instance.exports;
            mem = x.memory;
            if (x._initialize) x._initialize();
            return new H264(x);
        });
    }
    constructor(x) { this.x = x; this.inPtr = 0; this.inCap = 0; this.opened = false; }
    _in(buf) {
        const need = buf.length + 64;
        if (need > this.inCap) {
            if (this.inPtr) this.x.gt_free(this.inPtr);
            this.inCap = Math.max(need, 1 << 20);
            this.inPtr = this.x.gt_alloc(this.inCap);
            if (!this.inPtr) throw new Error('decoder out of memory');
        }
        const m = new Uint8Array(this.x.memory.buffer);
        m.set(buf, this.inPtr);
        m.fill(0, this.inPtr + buf.length, this.inPtr + buf.length + 64);   // FFmpeg's input padding
        return this.inPtr;
    }
    open(avcC) {
        const p = this._in(avcC);
        const r = this.x.gt_open(p, avcC.length);
        if (r < 0) throw new Error('decoder open failed (' + r + ')');
        this.opened = true;
    }
    options(skipLoopFilter, skipNonRef) { this.x.gt_options(skipLoopFilter ? 1 : 0, skipNonRef ? 1 : 0); }
    flush() { this.x.gt_flush(); }
    _frame() {
        const w = this.x.gt_width(), h = this.x.gt_height(), p = this.x.gt_frame();
        return { w, h, pts: this.x.gt_pts(), yuv: new Uint8Array(this.x.memory.buffer, p, w * h * 3 / 2) };
    }
    /** One access unit (MP4 sample, length-prefixed NALs). A picture when one is out, else null. */
    decode(buf, pts) {
        const r = this.x.gt_decode(this._in(buf), buf.length, pts | 0);
        if (r < 0) throw new Error('decode error (' + r + ')');
        return r === 1 ? this._frame() : null;
    }
    /** After decode(): another picture already waiting (rare), else null. */
    next() { return this.x.gt_next() === 1 ? this._frame() : null; }
}

module.exports = H264;
