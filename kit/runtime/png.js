'use strict';
/**
 * png.js - read a PNG into RGBA pixels (straight alpha), for pictures an app ships and draws itself
 * (record.setImage / Recorder.image). 8-bit truecolour (with or without alpha), greyscale (with or
 * without alpha) and palette images (with tRNS), not interlaced: what Pillow / oxipng write.
 *
 *   const { w, h, data } = require('./kit/png').decode(fs.readFileSync(file));
 *
 * Node 8: no ?., no ??, no object spread.
 */
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decode(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.slice(0, 8).equals(SIG)) throw new Error('not a PNG');
    let o = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, pal = null, trns = null;
    const idat = [];
    while (o + 8 <= buf.length) {
        const len = buf.readUInt32BE(o), kind = buf.toString('latin1', o + 4, o + 8), body = buf.slice(o + 8, o + 8 + len);
        o += 12 + len;
        if (kind === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
        else if (kind === 'PLTE') pal = body;
        else if (kind === 'tRNS') trns = body;
        else if (kind === 'IDAT') idat.push(body);
        else if (kind === 'IEND') break;
    }
    const ch = CHANNELS[type];
    if (!w || !h || w > 4096 || h > 4096) throw new Error('PNG: bad size ' + w + 'x' + h);
    if (depth !== 8 || !ch || interlace) throw new Error('PNG: only 8-bit, non-interlaced images (type ' + type + ', depth ' + depth + ')');
    if (type === 3 && !pal) throw new Error('PNG: palette missing');
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch;
    if (raw.length < h * (stride + 1)) throw new Error('PNG: short image data');
    const px = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)], si = y * (stride + 1) + 1, di = y * stride, up = di - stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= ch ? px[di + x - ch] : 0, b = y ? px[up + x] : 0, c = x >= ch && y ? px[up + x - ch] : 0;
            const r = raw[si + x];
            px[di + x] = (f === 0 ? r : f === 1 ? r + a : f === 2 ? r + b : f === 3 ? r + ((a + b) >> 1) : f === 4 ? r + paeth(a, b, c) : r) & 255;
        }
    }
    const out = new Uint8Array(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
        const s = i * ch;
        if (type === 6) { out[j] = px[s]; out[j + 1] = px[s + 1]; out[j + 2] = px[s + 2]; out[j + 3] = px[s + 3]; }
        else if (type === 2) { out[j] = px[s]; out[j + 1] = px[s + 1]; out[j + 2] = px[s + 2]; out[j + 3] = 255; }
        else if (type === 3) { const k = px[s]; out[j] = pal[k * 3] || 0; out[j + 1] = pal[k * 3 + 1] || 0; out[j + 2] = pal[k * 3 + 2] || 0; out[j + 3] = trns && k < trns.length ? trns[k] : 255; }
        else if (type === 4) { out[j] = out[j + 1] = out[j + 2] = px[s]; out[j + 3] = px[s + 1]; }
        else { out[j] = out[j + 1] = out[j + 2] = px[s]; out[j + 3] = 255; }
    }
    return { w, h, data: out };
}

module.exports = { decode };
