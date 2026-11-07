'use strict';
/**
 * tv_m4a.js - the sound of a stretch of a programme as a plain .m4a, for the car's media player (it plays a
 * complete local file: RideTube's notes, and ours). Node 8, no npm modules.
 *
 *   const W = require('./tv_m4a');
 *   const w = W.windowAt(audio, fromS, lengthS)   -> { i0, i1, t0, t1 } (samples [i0, i1), seconds of the programme)
 *   const runs = W.runs(audio, w)                 -> [[start, end] inclusive] byte ranges of those samples in the file
 *   const buf = W.build(audio, w, bodies)         -> the .m4a (ftyp, moov, mdat), bodies = the runs' bytes in order
 *
 * audio is tv_mp4.js's audio track (v.audio): its stsd box is copied as it is (AAC's decoder set-up stays the
 * file's own), the samples keep their sizes and durations, in chunks of CHUNK samples, moov before mdat.
 * Time 0 of the .m4a is the programme's time t0 (the first sample's).
 */

const CHUNK = 32;            // samples per chunk (about 0.7 s of AAC at 48 kHz)
const MERGE = 4096;          // byte ranges closer than this are fetched as one

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff, 0); return b; }
function boxOf(type, parts) {
    const body = Buffer.concat(parts);
    return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
}
const full = (type, version, flags, parts) => boxOf(type, [Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255])].concat(parts));
const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** The samples from the one at or before fromS for lengthS seconds (to the track's end at most). */
function windowAt(a, fromS, lengthS) {
    const ts = a.timescale, from = Math.max(0, fromS) * ts;
    let lo = 0, hi = a.n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a.dts[m] <= from) lo = m; else hi = m - 1; }
    const i0 = lo, until = a.dts[i0] + lengthS * ts;
    let i1 = i0;
    while (i1 < a.n && a.dts[i1] < until) i1++;
    if (i1 === i0 && i0 < a.n) i1 = i0 + 1;
    return { i0, i1, t0: a.dts[i0] / ts, t1: i1 < a.n ? a.dts[i1] / ts : (a.dts[a.n - 1] + a.dur[a.n - 1]) / ts };
}
/** The window after w (the same length, from where w ends), or null at the track's end. */
function after(a, w, lengthS) { return w.i1 >= a.n ? null : windowAt(a, a.dts[w.i1] / a.timescale, lengthS); }

/** Byte ranges [start, end] (inclusive) holding samples [i0, i1), neighbours closer than MERGE joined. */
function runs(a, w) {
    const out = [];
    for (let i = w.i0; i < w.i1; i++) {
        const s = a.off[i], e = a.off[i] + a.size[i] - 1, last = out[out.length - 1];
        if (last && s >= last[0] && s - last[1] - 1 <= MERGE) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
    }
    return out;
}

/** The .m4a for window w; bodies[k] = the bytes of runs(a, w)[k]. */
function build(a, w, bodies) {
    const rs = runs(a, w), n = w.i1 - w.i0;
    const samples = [];
    let k = 0;
    for (let i = w.i0; i < w.i1; i++) {
        while (k < rs.length && a.off[i] > rs[k][1]) k++;
        if (k >= rs.length || !bodies[k]) throw new Error('sample ' + i + ' was not fetched');
        const o = a.off[i] - rs[k][0];
        if (o < 0 || o + a.size[i] > bodies[k].length) throw new Error('sample ' + i + ' is outside its range');
        samples.push(bodies[k].slice(o, o + a.size[i]));
    }
    let duration = 0;
    const stts = [];
    for (let i = w.i0; i < w.i1; i++) {
        const d = a.dur[i];
        duration += d;
        const last = stts[stts.length - 1];
        if (last && last[1] === d) last[0]++; else stts.push([1, d]);
    }
    const chunks = Math.ceil(n / CHUNK), rest = n - (chunks - 1) * CHUNK;
    const stsc = rest === CHUNK || chunks === 1 ? [[1, chunks === 1 ? n : CHUNK]] : [[1, CHUNK], [chunks, rest]];
    const sizes = [];
    for (let i = w.i0; i < w.i1; i++) sizes.push(u32(a.size[i]));
    const ts = a.timescale;
    const lang = u16(((('u'.charCodeAt(0) - 0x60) << 10) | (('n'.charCodeAt(0) - 0x60) << 5) | ('d'.charCodeAt(0) - 0x60)));
    const moovFor = (stco) => boxOf('moov', [
        full('mvhd', 0, 0, [u32(0), u32(0), u32(ts), u32(duration), u32(0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2)]),
        boxOf('trak', [
            full('tkhd', 0, 7, [u32(0), u32(0), u32(1), u32(0), u32(duration), Buffer.alloc(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)]),
            boxOf('mdia', [
                full('mdhd', 0, 0, [u32(0), u32(0), u32(ts), u32(duration), lang, u16(0)]),
                full('hdlr', 0, 0, [u32(0), Buffer.from('soun', 'latin1'), Buffer.alloc(12), Buffer.from('SoundHandler\0', 'latin1')]),
                boxOf('minf', [
                    full('smhd', 0, 0, [u16(0), u16(0)]),
                    boxOf('dinf', [full('dref', 0, 0, [u32(1), full('url ', 0, 1, [])])]),
                    boxOf('stbl', [
                        a.stsd,
                        full('stts', 0, 0, [u32(stts.length)].concat(stts.map((x) => Buffer.concat([u32(x[0]), u32(x[1])])))),
                        full('stsc', 0, 0, [u32(stsc.length)].concat(stsc.map((x) => Buffer.concat([u32(x[0]), u32(x[1]), u32(1)])))),
                        full('stsz', 0, 0, [u32(0), u32(n)].concat(sizes)),
                        full('stco', 0, 0, [u32(chunks)].concat(stco.map(u32))),
                    ]),
                ]),
            ]),
        ]),
    ]);
    const ftyp = boxOf('ftyp', [Buffer.from('M4A ', 'latin1'), u32(0), Buffer.from('M4A mp42isom', 'latin1')]);
    // the moov's size doesn't depend on the offsets' values: measure it, then fill the offsets in
    const moovLen = moovFor(new Array(chunks).fill(0)).length;
    const data0 = ftyp.length + moovLen + 8;
    const stco = [];
    let o = data0;
    for (let c = 0; c < chunks; c++) {
        stco.push(o);
        for (let s = c * CHUNK; s < Math.min(n, (c + 1) * CHUNK); s++) o += samples[s].length;
    }
    const mdatLen = o - data0;
    return Buffer.concat([ftyp, moovFor(stco), u32(8 + mdatLen), Buffer.from('mdat', 'latin1')].concat(samples));
}

module.exports = { windowAt, after, runs, build, CHUNK, MERGE };
