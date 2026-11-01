'use strict';
/**
 * tv_player.js - plays a channel's video: byte ranges of the MP4 over HTTPS (tv_net.js), the video
 * track's samples (tv_mp4.js) decoded in WebAssembly (tv_h264.js), each picture handed to sink(frame)
 * when its time comes. Picture only: the audio track is not read (no verified way to play sound from an
 * app without root yet).
 *
 * One thread (Node 8 has no workers): decoding runs in slices of at most SLICE_MS between other work, so
 * the screen, touch and the car's signals keep their turn.
 *
 * CPU: every sample is decoded (later pictures need the earlier ones), but at most cap() pictures a second
 * go to the sink. mode() 'light' also skips the pictures no other picture needs (B-frames: about 10 a
 * second on these recordings) and the deblocking filter: roughly a third of the work. 'auto' starts full
 * and turns light when the decoder can't keep up.
 *
 * state: idle | tuning | buffering | playing | paused | offline | error  (text: what to show)
 */
const EventEmitter = require('events');
const mp4 = require('./tv_mp4');
const H264 = require('./tv_h264');

const CHUNK_S = 4;                  // seconds of video per range request
const CHUNK_MAX = 6 * 1024 * 1024;  // bytes per range request at most
const AHEAD_S = 14;                 // keep this much fetched ahead of the decoder
const SLICE_MS = 24;                // decode at most this long in one go
const LATE_S = 0.25;                // a picture this late is decoded but not shown
const RESYNC_S = 3;                 // this far behind: the clock jumps (the picture would never catch up)
const FUTURE_S = 10;                // a picture timed this far ahead of the clock is a broken index entry: skipped
const FUTURE_RUN = 30;              // ...unless this many in a row are: the programme's time jumped, the clock follows
const NET_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED'];

class Player extends EventEmitter {
    constructor(opts) {
        super();
        this.net = opts.net; this.log = opts.log; this.dir = opts.dir; this.sink = opts.sink;
        this.cap = opts.cap || (() => 15); this.mode = opts.mode || (() => 'auto');
        this.state = 'idle'; this.text = '';
        this.dec = null; this.v = null; this.src = null;
        this.chunks = []; this.fetching = false; this.fetchIdx = 0; this.decIdx = 0;
        this.pending = null; this.pendBuf = null;
        this.timer = null; this.gen = 0; this.light = false;
        this.stats = { decMs: 0, decN: 0, shown: 0, shownT: Date.now(), fps: 0, late: 0, bytes0: 0, kbps: 0, decAvg: 0 };
        this.retryAt = 0; this.fails = 0;
        this.futureRun = 0; this.futureLogged = false;
        this.cache = new Map();        // href -> parsed index (the last few)
    }

    _set(state, text) {
        if (state === this.state && text === this.text) return;
        this.state = state; this.text = text || '';
        this.log.info('player: ' + state + (text ? ' (' + text + ')' : ''));
        this.emit('state', state, this.text);
    }

    /** media time now, s (the clock runs while playing) */
    now() { return this.clockRun ? this.mediaAt + (Date.now() - this.wallAt) / 1000 : this.mediaAt; }
    _hold() { this.mediaAt = this.now(); this.clockRun = false; }
    _run() { if (!this.clockRun) { this.wallAt = Date.now(); this.clockRun = true; } }

    /** Play src: { href, moov, title, startS, endS (0: to the end), next() -> the following src }. */
    async tune(src) {
        const gen = ++this.gen;
        this._stopTimer();
        this.src = src; this.chunks = []; this.pending = null; this.fetching = false;
        this.v = null; this.clockRun = false; this.mediaAt = 0;
        this._set('tuning', src.title);
        try {
            if (!this.dec) this.dec = await H264.load(this.dir);
            let v = this.cache.get(src.href);
            if (!v) {
                v = await mp4.open(this.net, src.href, src.moov);
                this.cache.set(src.href, v);
                if (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
            }
            if (gen !== this.gen) return;
            if (!v.avcC) throw Object.assign(new Error('not H.264 (' + v.codec + ')'), { code: 'CODEC' });
            this.v = v;
            this.dec.open(v.avcC);
            this._applyMode(true);
            const k = mp4.keyBefore(v, src.startS || 0);
            this.decIdx = this.fetchIdx = k;
            this.endT = src.endS > 0 ? Math.min(src.endS, v.duration) : v.duration;
            this.mediaAt = v.cts[k] / v.timescale;
            this.fails = 0;
            this.log.info('tuned: ' + v.codec + ' ' + v.w + 'x' + v.h + ' profile ' + v.profile + ', ' + v.n + ' samples, ' +
                (v.n / v.duration).toFixed(2) + ' fps, from ' + this.mediaAt.toFixed(1) + ' s');
            this._set(this.paused ? 'paused' : 'buffering', '');
            this._fetch();
            this._kick(0);
        } catch (e) {
            if (gen !== this.gen) return;
            this._failed(e, () => this.tune(src));
        }
    }

    _failed(e, again) {
        const offline = e && NET_CODES.indexOf(e.code) >= 0;
        this.fails++;
        const wait = Math.min(30, 2 * Math.pow(2, Math.min(this.fails - 1, 4)));
        this.log.warn('player: ' + (e && e.message) + ' (' + (e && e.code) + '); again in ' + wait + ' s');
        this._set(offline ? 'offline' : 'error', offline ? 'No connection' : String(e && e.message || e));
        this.retryAt = Date.now() + wait * 1000;
        const gen = this.gen;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            if (gen !== this.gen || this.paused) return;
            // the same thing up to 3 times; then a broken programme is skipped
            if (!offline && this.fails >= 3 && this.src && this.src.next) { this.fails = 0; this.tune(this.src.next()); } else again();
        }, wait * 1000);
    }

    pause() { this.paused = true; this._hold(); this._stopTimer(); if (this.v) this._set('paused', ''); }
    resume() {
        if (!this.paused) return;
        this.paused = false;
        if (this.state === 'paused') { this._set('buffering', ''); this._fetch(); this._kick(0); }
        else if (this.src && (this.state === 'offline' || this.state === 'error')) this.tune(this.src);
    }
    stop() { this.gen++; this._stopTimer(); clearTimeout(this.retryTimer); this.chunks = []; this.pending = null; this.v = null; this._set('idle', ''); }

    _applyMode(force) {
        const m = this.mode();
        const light = m === 'light' || (m === 'auto' && this.light);
        if (force || light !== this.appliedLight) { this.dec.options(light, light); this.appliedLight = light; }
    }

    /* ----- network: ranges of samples, ahead of the decoder ----- */
    _aheadS() {
        const v = this.v;
        if (!v || this.fetchIdx <= this.decIdx) return 0;
        return (v.dts[Math.min(this.fetchIdx, v.n) - 1] - v.dts[Math.min(this.decIdx, v.n - 1)]) / v.timescale;
    }
    async _fetch() {
        const v = this.v, gen = this.gen;
        if (!v || this.fetching || this.paused || this.fetchIdx >= v.n || Date.now() < this.retryAt) return;
        if (v.dts[this.fetchIdx] / v.timescale > this.endT + 1) return;      // past the programme's end
        if (this._aheadS() > AHEAD_S) return;
        const a = this.fetchIdx;
        let b = a + 1;
        const t0 = v.dts[a];
        while (b < v.n && (v.dts[b] - t0) / v.timescale < CHUNK_S && v.off[b] + v.size[b] - v.off[a] < CHUNK_MAX) b++;
        const start = v.off[a];
        let end = 0;
        for (let i = a; i < b; i++) end = Math.max(end, v.off[i] + v.size[i]);
        this.fetching = true;
        try {
            const r = await this.net.range(this.src.href, start, end - 1);
            if (gen !== this.gen) return;
            this.chunks.push({ a, b, base: start, body: r.body });
            this.fetchIdx = b; this.fails = 0;
        } catch (e) {
            if (gen !== this.gen) return;
            this.fetching = false;
            this._failed(e, () => { this.retryAt = 0; this._set('buffering', ''); this._fetch(); this._kick(0); });
            return;
        }
        this.fetching = false;
        if (this.state === 'offline' || this.state === 'error') this._set('buffering', '');
        this._kick(0);
        this._fetch();
    }
    _sample(i) {
        for (let c = 0; c < this.chunks.length; c++) {
            const ch = this.chunks[c];
            if (i >= ch.a && i < ch.b) {
                const o = this.v.off[i] - ch.base;
                return ch.body.slice(o, o + this.v.size[i]);
            }
        }
        return null;
    }

    /* ----- decode and show ----- */
    _stopTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
    _kick(ms) {
        if (this.paused) return;
        this._stopTimer();
        this.timer = setTimeout(() => { this.timer = null; this._pump(); }, Math.max(0, ms | 0));
    }
    _show(p) {
        const now = Date.now(), cap = Math.max(1, this.cap());
        if (now - (this.lastShow || 0) < 1000 / cap - 4) return;
        this.lastShow = now;
        try { this.sink(p); } catch (e) { this.log.warn('player: sink ' + e.message); }
        const s = this.stats;
        s.shown++;
        if (now - s.shownT >= 2000) {
            const dt = (now - s.shownT) / 1000;
            s.fps = s.shown / dt; s.kbps = (this.net.bytes - s.bytes0) * 8 / dt / 1000;
            s.shown = 0; s.shownT = now; s.bytes0 = this.net.bytes;
        }
    }
    _pump() {
        const v = this.v;
        if (!v || this.paused) return;
        const t0 = Date.now();
        while (Date.now() - t0 < SLICE_MS) {
            if (!this.clockRun && this.pending) {
                // (re)start once a picture is out and a few seconds are fetched; the clock starts at it
                if (this._aheadS() > 2 || this.fetchIdx >= v.n) {
                    this.mediaAt = this.pending.t; this._run(); this._set('playing', '');
                } else { this._fetch(); this._kick(50); return; }
            }
            if (this.pending) {
                const now = this.now(), pt = this.pending.t;
                if (pt <= now) {
                    this.futureRun = 0;
                    if (now - pt < LATE_S) this._show(this.pending);
                    else this.stats.late++;
                    this.pending = null;
                    continue;
                }
                if (pt - now > FUTURE_S && ++this.futureRun < FUTURE_RUN) {
                    // waiting for it would stop the picture for good (one picture, then none)
                    if (this.futureRun === 1 && !this.futureLogged) { this.futureLogged = true; this.log.warn('player: a picture timed ' + (pt - now).toFixed(0) + ' s ahead - skipped'); }
                    this.stats.late++; this.pending = null;
                    continue;
                }
                if (pt - now > FUTURE_S) { this.log.warn('player: ' + (pt - now).toFixed(1) + ' s ahead - clock moved'); this.mediaAt = pt; this.wallAt = Date.now(); this.futureRun = 0; continue; }
                this.futureRun = 0;
                this._kick(Math.min(40, (pt - now) * 1000));
                return;
            }
            const t = this.decIdx < v.n ? v.cts[this.decIdx] / v.timescale : Infinity;
            if (this.decIdx >= v.n || (t > this.endT + 0.5 && v.key[this.decIdx])) { this._ended(); return; }
            const buf = this._sample(this.decIdx);
            if (!buf) {
                // nothing fetched for the next picture: buffering (the clock waits)
                if (this.state === 'playing') { this._hold(); this._set('buffering', ''); }
                this._fetch();
                return;
            }
            const d0 = process.hrtime();
            let f = null;
            try { f = this.dec.decode(buf, this.decIdx); } catch (e) { this.log.warn('decode ' + this.decIdx + ': ' + e.message); }
            const dd = process.hrtime(d0), ms = dd[0] * 1e3 + dd[1] / 1e6;
            const s = this.stats; s.decMs += ms; s.decN++;
            if (s.decN >= 60) { s.decAvg = s.decMs / s.decN; s.decMs = 0; s.decN = 0; this._adapt(); }
            this.decIdx++;
            // fetched data the decoder is past is dropped
            while (this.chunks.length && this.chunks[0].b <= this.decIdx) this.chunks.shift();
            this._fetch();
            if (f) this._take(f);
        }
        this._kick(0);
    }
    _take(f) {
        const v = this.v, t = v.cts[f.pts] / v.timescale;
        if (this.clockRun && this.now() - t > RESYNC_S) {
            this.log.warn('player: ' + (this.now() - t).toFixed(1) + ' s behind - clock moved');
            this.mediaAt = t; this.wallAt = Date.now();
        }
        const len = f.w * f.h * 3 / 2;
        if (!this.pendBuf || this.pendBuf.length !== len) this.pendBuf = new Uint8Array(len);
        this.pendBuf.set(f.yuv);
        this.pending = { w: f.w, h: f.h, t, yuv: this.pendBuf };
    }
    /** auto: light decoding when a sample's decoding costs over 70 % of its frame time */
    _adapt() {
        const v = this.v, fps = v.n / v.duration, budget = 1000 / fps;
        if (this.mode() === 'auto' && !this.light && this.stats.decAvg > budget * 0.7) {
            this.light = true; this.log.info('player: decoding ' + this.stats.decAvg.toFixed(1) + ' ms a picture - light mode');
        }
        this._applyMode(false);
    }
    _ended() {
        this.log.info('player: end of ' + (this.src && this.src.title));
        if (this.src && this.src.next) this.tune(this.src.next());
        else this.stop();
    }

    info() {
        const v = this.v, s = this.stats;
        return {
            state: this.state, text: this.text, title: this.src ? this.src.title : '',
            pos: v ? this.now() : 0, start: this.src ? this.src.startS || 0 : 0, end: this.endT || 0,
            w: v ? v.w : 0, h: v ? v.h : 0, codec: v ? v.codec : '', profile: v ? v.profile : 0,
            srcFps: v ? v.n / v.duration : 0, fps: s.fps, decMs: s.decAvg, late: s.late, kbps: s.kbps,
            light: this.appliedLight, ahead: this._aheadS(),
        };
    }
}

module.exports = Player;
