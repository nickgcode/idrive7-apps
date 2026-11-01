'use strict';
/**
 * skin_assets.js - cut a decoded skin_<look>.png / skin_field.png (kit/png.js) into the textures the
 * cluster's skin layers sample (where each part sits: skin_looks.js, made by tools/bake_gsdash_skins.js).
 * Node 8.
 */
const SK = require('./skin_core');

/** a w x h rgba copy of (x, y) in a decoded image */
function crop(img, x, y, w, h) {
    const out = new Uint8Array(w * h * 4);
    for (let r = 0; r < h; r++) {
        const s = ((y + r) * img.w + x) * 4;
        out.set(img.data.subarray(s, s + w * 4), r * w * 4);
    }
    return { w, h, data: out };
}
/** -> { art: { L, R }, band: { L, R }, glyph: { L, R } }, each { w, h, data } */
function slice(meta, img) {
    if (img.w !== meta.size[0] || img.h !== meta.size[1]) throw new Error(meta.file + ': ' + img.w + 'x' + img.h + ', not ' + meta.size.join('x'));
    const RW = SK.REGION_W, RH = SK.REGION_H, out = { art: {}, band: {}, glyph: {} };
    ['L', 'R'].forEach((side, i) => {
        out.art[side] = crop(img, meta.art[0] + i * RW, meta.art[1], RW, RH);
        out.band[side] = crop(img, meta.band[side][0], meta.band[side][1], SK.BAND_W, SK.BAND_ROWS);
        const c = meta.cells[side];
        out.glyph[side] = crop(img, c.at[0], c.at[1], c.atlas[0], c.atlas[1]);
    });
    return out;
}
/** 0.8.4: the field at half resolution (FIELD_K): the Cluster renderer (0.2.2) keeps 16 MiB for every
 * client's pixels together, an asset counted twice, and the full field (2 x 860x636 rgba) with the look's
 * art came to about 20 MB: refused ("the service's pixel memory is full"). Each 2x2 block keeps its top-left
 * pixel, so the Pixel look's every-4th-pixel samples are unchanged. */
function half(t, k) {
    const w = Math.ceil(t.w / k), h = Math.ceil(t.h / k), out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = ((y * k) * t.w + x * k) * 4, d = (y * w + x) * 4;
        out[d] = t.data[s]; out[d + 1] = t.data[s + 1]; out[d + 2] = t.data[s + 2]; out[d + 3] = t.data[s + 3];
    }
    return { w, h, data: out };
}
function sliceField(img) {
    const k = SK.FIELD_K;
    return { L: half(crop(img, 0, 0, SK.REGION_W, SK.REGION_H), k), R: half(crop(img, SK.REGION_W, 0, SK.REGION_W, SK.REGION_H), k) };
}
/**
 * 0.11.2: a w x h texture -> its atlas (skin_core.js TILE, ATLAS_W, atlasLayout): the tile grid in the first
 * rows (texel tx, ty: the tile's slot k, r = k & 255, g = k >> 8), then each distinct TILE x TILE tile once,
 * slot k at column k % (ATLAS_W / TILE), row k / (ATLAS_W / TILE) after the grid's rows. A tile past the
 * picture's edge is padded with 0 (never sampled: the shader clamps to the picture, as the GPU's edge does).
 * -> { w, h, data, src: [w, h], tiles, hdr, dims: [w, h, hdr] (the shader's) }
 */
function pack(t) {
    const T = SK.TILE, nx = Math.ceil(t.w / T), ny = Math.ceil(t.h / T);
    const slots = new Map(), order = [], grid = new Array(nx * ny);
    const tile = new Uint8Array(T * T * 4);
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
        tile.fill(0);
        const w = Math.min(T, t.w - tx * T), h = Math.min(T, t.h - ty * T);
        for (let r = 0; r < h; r++) {
            const s = ((ty * T + r) * t.w + tx * T) * 4;
            tile.set(t.data.subarray(s, s + w * 4), r * T * 4);
        }
        const key = Buffer.from(tile.buffer, tile.byteOffset, tile.length).toString('latin1');
        let k = slots.get(key);
        if (k === undefined) { k = order.length; slots.set(key, k); order.push(tile.slice()); }
        grid[ty * nx + tx] = k;
    }
    if (order.length > 65536) throw new Error('atlas: ' + order.length + ' tiles');
    const L = SK.atlasLayout(t.w, t.h, order.length), W = L.w, C = W / T;
    const out = new Uint8Array(W * L.h * 4);
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
        const k = grid[ty * nx + tx], d = (ty * W + tx) * 4;
        out[d] = k & 255; out[d + 1] = k >> 8; out[d + 3] = 255;
    }
    order.forEach((px, k) => {
        const ox = (k % C) * T, oy = L.hdr + Math.floor(k / C) * T;
        for (let r = 0; r < T; r++) out.set(px.subarray(r * T * 4, (r + 1) * T * 4), ((oy + r) * W + ox) * 4);
    });
    return { w: W, h: L.h, data: out, src: [t.w, t.h], tiles: order.length, hdr: L.hdr, dims: [W, L.h, L.hdr] };
}
/** the CPU mirror of the shader's tiled(): texel (x, y) of the picture an atlas holds -> [r, g, b, a] */
function texelOf(a, x, y) {
    const T = SK.TILE, C = a.w / T;
    x = Math.max(0, Math.min(a.src[0] - 1, Math.floor(x))); y = Math.max(0, Math.min(a.src[1] - 1, Math.floor(y)));
    const tx = Math.floor(x / T), ty = Math.floor(y / T), i = (ty * a.w + tx) * 4;
    const k = a.data[i] + a.data[i + 1] * 256;
    const ox = (k % C) * T + x - tx * T, oy = a.hdr + Math.floor(k / C) * T + y - ty * T, j = (oy * a.w + ox) * 4;
    return [a.data[j], a.data[j + 1], a.data[j + 2], a.data[j + 3]];
}
/** a look's textures as sent: art and band tiled, the glyph cells whole (they share few tiles) */
function packLook(tex) {
    const out = { art: {}, band: {}, glyph: tex.glyph };
    ['L', 'R'].forEach((s) => { out.art[s] = pack(tex.art[s]); out.band[s] = pack(tex.band[s]); });
    return out;
}
function packField(f) { return { L: pack(f.L), R: pack(f.R) }; }
/** the shader's atlas constants for a side (skin_core.js fragment) */
function dimsOf(look, field, side) { return { art: look.art[side].dims, band: look.band[side].dims, field: field[side].dims }; }
/** the renderer's count for textures (cluster-render 0.2.2: w x h x 4, twice) */
function rendererBytes(list) { return list.reduce((n, t) => n + t.w * t.h * 4 * 2, 0); }
module.exports = { crop, slice, sliceField, half, pack, texelOf, packLook, packField, dimsOf, rendererBytes };
