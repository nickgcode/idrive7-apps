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
module.exports = { crop, slice, sliceField };
