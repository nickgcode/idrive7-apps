'use strict';
/**
 * tv_mp4.js - reads the video track of a progressive MP4 (ISO BMFF) over byte ranges: where moov is,
 * then its sample table (stsz, stco/co64, stsc, stts, ctts, stss) and the H.264 set-up (avcC).
 * Nothing is decoded here; the audio track is skipped (G's TV plays no sound yet).
 *
 *   const v = await mp4.open(net, href, moovHint)
 *   v -> { w, h, timescale, avcC (Buffer), profile, n, off, size, dts, cts, key (typed arrays), keys [index],
 *          duration (s), total (file bytes), codec }
 */

const HEAD = 65536;

function box(b, p) {
    if (p + 8 > b.length) return null;
    let size = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) {
        if (p + 16 > b.length) return null;
        size = b.readUInt32BE(p + 8) * 4294967296 + b.readUInt32BE(p + 12); hdr = 16;
    } else if (size === 0) size = b.length - p;
    return { type, start: p, size, body: p + hdr, end: p + size };
}

function children(b, from, to) {
    const out = [];
    let p = from;
    while (p + 8 <= to) {
        const x = box(b, p);
        if (!x || x.size < 8 || x.end > to) break;
        out.push(x); p = x.end;
    }
    return out;
}
const find = (b, from, to, type) => children(b, from, to).filter((x) => x.type === type)[0] || null;
const path = (b, x, types) => { for (let i = 0; i < types.length && x; i++) x = find(b, x.body, x.end, types[i]); return x; };

/** Top-level boxes from the file's start until moov is found or mdat is reached: { moov: [start, size] }. */
async function locateMoov(net, href, moovHint) {
    const first = await net.range(href, 0, HEAD - 1);
    const total = first.total;
    let p = 0;
    let b = first.body;
    let base = 0;
    for (let guard = 0; guard < 64; guard++) {
        if (p - base + 16 > b.length) {
            b = (await net.range(href, p, p + 63)).body; base = p;
        }
        const x = box(b, p - base);
        if (!x) break;
        const size = x.size === b.length - (p - base) && b.readUInt32BE(p - base) === 0 ? (total - p) : x.size;
        if (x.type === 'moov') return { start: p, size, total };
        if (size < 8) break;
        p += size;
        if (total && p >= total) break;
    }
    // moov wasn't before mdat (and mdat's size made us jump to it) - or a hint: the moov box at the end
    if (moovHint && total) return { start: total - moovHint, size: moovHint, total, guess: true };
    throw new Error('no moov box found');
}

function parseTrak(b, trak) {
    const hdlr = path(b, trak, ['mdia', 'hdlr']);
    if (!hdlr || b.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'vide') return null;
    const mdhd = path(b, trak, ['mdia', 'mdhd']);
    const v = b[mdhd.body];
    const timescale = v === 1 ? b.readUInt32BE(mdhd.body + 20) : b.readUInt32BE(mdhd.body + 12);
    const stbl = path(b, trak, ['mdia', 'minf', 'stbl']);
    const stsd = find(b, stbl.body, stbl.end, 'stsd');
    const entry = box(b, stsd.body + 8);
    const codec = entry.type;
    const w = b.readUInt16BE(entry.body + 24), h = b.readUInt16BE(entry.body + 26);
    let avcC = null;
    if (codec === 'avc1' || codec === 'avc3') {
        const c = find(b, entry.body + 78, entry.end, 'avcC');
        if (c) avcC = Buffer.from(b.slice(c.body, c.end));
    }
    const tbl = {};
    children(b, stbl.body, stbl.end).forEach((x) => { tbl[x.type] = x; });
    // sizes
    const stsz = tbl.stsz;
    const fixed = b.readUInt32BE(stsz.body + 4), n = b.readUInt32BE(stsz.body + 8);
    const size = new Uint32Array(n);
    for (let i = 0; i < n; i++) size[i] = fixed || b.readUInt32BE(stsz.body + 12 + i * 4);
    // chunk offsets
    let chunks;
    if (tbl.stco) {
        const m = b.readUInt32BE(tbl.stco.body + 4); chunks = new Float64Array(m);
        for (let i = 0; i < m; i++) chunks[i] = b.readUInt32BE(tbl.stco.body + 8 + i * 4);
    } else {
        const m = b.readUInt32BE(tbl.co64.body + 4); chunks = new Float64Array(m);
        for (let i = 0; i < m; i++) chunks[i] = b.readUInt32BE(tbl.co64.body + 8 + i * 8) * 4294967296 + b.readUInt32BE(tbl.co64.body + 12 + i * 8);
    }
    // samples per chunk -> each sample's offset
    const off = new Float64Array(n);
    const sc = tbl.stsc, ne = b.readUInt32BE(sc.body + 4);
    let s = 0;
    for (let e = 0; e < ne; e++) {
        const first = b.readUInt32BE(sc.body + 8 + e * 12) - 1, per = b.readUInt32BE(sc.body + 12 + e * 12);
        const last = e + 1 < ne ? b.readUInt32BE(sc.body + 8 + (e + 1) * 12) - 1 : chunks.length;
        for (let c = first; c < last && s < n; c++) {
            let o = chunks[c];
            for (let k = 0; k < per && s < n; k++) { off[s] = o; o += size[s]; s++; }
        }
    }
    // decode times
    const dts = new Float64Array(n);
    const st = tbl.stts, nt = b.readUInt32BE(st.body + 4);
    let t = 0; s = 0;
    for (let e = 0; e < nt; e++) {
        const cnt = b.readUInt32BE(st.body + 8 + e * 8), d = b.readUInt32BE(st.body + 12 + e * 8);
        for (let k = 0; k < cnt && s < n; k++) { dts[s++] = t; t += d; }
    }
    const cts = new Float64Array(n);
    cts.set(dts);
    if (tbl.ctts) {
        const ver = b[tbl.ctts.body], nc = b.readUInt32BE(tbl.ctts.body + 4);
        s = 0;
        for (let e = 0; e < nc; e++) {
            const cnt = b.readUInt32BE(tbl.ctts.body + 8 + e * 8);
            const o = ver === 1 ? b.readInt32BE(tbl.ctts.body + 12 + e * 8) : b.readUInt32BE(tbl.ctts.body + 12 + e * 8);
            for (let k = 0; k < cnt && s < n; k++) { cts[s] += o; s++; }
        }
    }
    const key = new Uint8Array(n);
    const keys = [];
    if (tbl.stss) {
        const nk = b.readUInt32BE(tbl.stss.body + 4);
        for (let i = 0; i < nk; i++) { const k = b.readUInt32BE(tbl.stss.body + 8 + i * 4) - 1; if (k < n) { key[k] = 1; keys.push(k); } }
    } else { for (let i = 0; i < n; i++) { key[i] = 1; keys.push(i); } }
    const profile = avcC && avcC.length > 3 ? avcC[1] : null;
    return { w, h, timescale, codec, avcC, profile, n, off, size, dts, cts, key, keys, duration: t / timescale };
}

/** Open href's video track. */
async function open(net, href, moovHint) {
    const loc = await locateMoov(net, href, moovHint);
    const b = (await net.range(href, loc.start, loc.start + loc.size - 1)).body;
    const moov = box(b, 0);
    if (!moov || moov.type !== 'moov') throw new Error('moov not where expected');
    const traks = children(b, moov.body, moov.end).filter((x) => x.type === 'trak');
    for (let i = 0; i < traks.length; i++) {
        const v = parseTrak(b, traks[i]);
        if (v) { v.total = loc.total; v.moovBytes = loc.size; return v; }
    }
    throw new Error('no video track');
}

/** The last key frame at or before t seconds (presentation time). */
function keyBefore(v, t) {
    const tt = t * v.timescale;
    let best = v.keys[0] || 0;
    for (let i = 0; i < v.keys.length; i++) { if (v.cts[v.keys[i]] <= tt) best = v.keys[i]; else break; }
    return best;
}

module.exports = { open, keyBefore, box, children };
