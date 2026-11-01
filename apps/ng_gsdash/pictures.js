'use strict';
/**
 * pictures.js - Nick's Showcase pictures (showcase_car.png, showcase_logo.png) shown as they are
 * (0.11.0): the files are never changed, only their pixels are prepared at run time for the size and
 * the renderer path they are shown on.
 *
 *  - smooth scaling: a premultiplied area average to the device pixels it covers (downscale), or a
 *    premultiplied bilinear (upscale), so edges stay clean whatever the renderer's own filtering
 *  - no fringes: colour bled into fully transparent pixels (a filtering renderer never mixes in black)
 *  - per renderer path (Recorder.pictures, kit display.js):
 *      'premultiplied' (mgu-render/1)  straight RGBA, the kit premultiplies it, the renderer blends
 *      'blend' (software frames)       straight RGBA, blended
 *      'opaque' (an upstream renderer) RGBA is shown opaque: the picture is composited here over what is
 *                                      under it (bg(x, y): the waves), so no box ever shows
 *  - an optional soft floor shadow under the picture (the car), in the same pixels
 * Node 8: no ?., no ??, no object spread.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** src { w, h, data } straight RGBA -> premultiplied float RGBA dw x dh (area average / bilinear). */
function resample(src, dw, dh) {
    const sw = src.w, sh = src.h, s = src.data, out = new Float32Array(dw * dh * 4);
    const fx = sw / dw, fy = sh / dh;
    if (fx >= 1 && fy >= 1) {
        // area average: each output pixel covers fx x fy source pixels, partial ones weighted
        for (let y = 0; y < dh; y++) {
            const y0 = y * fy, y1 = y0 + fy;
            for (let x = 0; x < dw; x++) {
                const x0 = x * fx, x1 = x0 + fx;
                let r = 0, g = 0, b = 0, a = 0, n = 0;
                for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
                    const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
                    for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
                        const wgt = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx)), o = (sy * sw + sx) * 4, al = s[o + 3] / 255 * wgt;
                        r += s[o] * al; g += s[o + 1] * al; b += s[o + 2] * al; a += al; n += wgt;
                    }
                }
                const o = (y * dw + x) * 4;
                if (n > 0) { out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n; }
            }
        }
        return out;
    }
    // bilinear on premultiplied pixels (pixel centres)
    const at = (x, y, c) => { const o = (clamp(y, 0, sh - 1) * sw + clamp(x, 0, sw - 1)) * 4; return c === 3 ? s[o + 3] / 255 : s[o + c] * s[o + 3] / 255; };
    for (let y = 0; y < dh; y++) {
        const v = (y + 0.5) * fy - 0.5, y0 = Math.floor(v), ty = v - y0;
        for (let x = 0; x < dw; x++) {
            const u = (x + 0.5) * fx - 0.5, x0 = Math.floor(u), tx = u - x0, o = (y * dw + x) * 4;
            for (let c = 0; c < 4; c++) {
                out[o + c] = (at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx) * (1 - ty) + (at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx) * ty;
            }
        }
    }
    return out;
}

/** A soft floor shadow (premultiplied black, alpha only) under p (dw x dh): an ellipse near the foot. */
function shadowUnder(p, dw, dh, o) {
    const cx = dw * 0.5, cy = dh * (o.y || 0.93), rx = dw * (o.rx || 0.47), ry = dh * (o.ry || 0.06), k = o.alpha || 0.55;
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry, d = Math.sqrt(dx * dx + dy * dy);
        if (d >= 1) continue;
        const sa = k * (1 - d) * (1 - d), i = (y * dw + x) * 4, a = p[i + 3];
        // the picture over its shadow (premultiplied: the shadow adds alpha only, under what is there)
        p[i + 3] = a + sa * (1 - a);
    }
}

/**
 * The prepared pixels: dw x dh straight RGBA (Uint8Array) for 'premultiplied' / 'blend', or opaque RGBA
 * over bg for 'opaque' (bg(x, y) -> [r, g, b] for the picture's own pixel x, y; none: black).
 */
function prepare(src, dw, dh, mode, o) {
    o = o || {};
    dw = Math.max(1, Math.round(dw)); dh = Math.max(1, Math.round(dh));
    const p = resample(src, dw, dh);
    if (o.shadow) shadowUnder(p, dw, dh, o.shadow);
    const out = new Uint8Array(dw * dh * 4);
    if (mode === 'opaque') {
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
            const i = (y * dw + x) * 4, a = p[i + 3], b = o.bg ? o.bg(x, y) : null;
            for (let c = 0; c < 3; c++) out[i + c] = clamp(Math.round(p[i + c] + (b ? b[c] : 0) * (1 - a)), 0, 255);
            out[i + 3] = 255;
        }
        return out;
    }
    // straight colour; the fully transparent pixels take their neighbours' colour (bleed), so a
    // filtering renderer has no dark fringe at the edges
    const known = new Uint8Array(dw * dh);
    for (let j = 0, i = 0; j < dw * dh; j++, i += 4) {
        const a = p[i + 3];
        if (a > 0.5 / 255) {
            for (let c = 0; c < 3; c++) out[i + c] = clamp(Math.round(p[i + c] / a), 0, 255);
            out[i + 3] = clamp(Math.round(a * 255), 0, 255);
            known[j] = 1;
        }
    }
    for (let pass = 0; pass < 3; pass++) {
        const add = [];
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
            const j = y * dw + x;
            if (known[j]) continue;
            let r = 0, g = 0, b = 0, n = 0;
            for (let yy = Math.max(0, y - 1); yy <= Math.min(dh - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(dw - 1, x + 1); xx++) {
                const q = yy * dw + xx;
                if (known[q] === 1) { r += out[q * 4]; g += out[q * 4 + 1]; b += out[q * 4 + 2]; n++; }
            }
            if (n) add.push(j, r / n, g / n, b / n);
        }
        if (!add.length) break;
        for (let k = 0; k < add.length; k += 4) { const j = add[k], i = j * 4; out[i] = Math.round(add[k + 1]); out[i + 1] = Math.round(add[k + 2]); out[i + 2] = Math.round(add[k + 3]); out[i + 3] = 0; known[j] = 2; }
        for (let j = 0; j < known.length; j++) if (known[j] === 2) known[j] = 1;
    }
    return out;
}

/**
 * A picture on the page: keeps one prepared copy per id and sends it (upload(id, w, h, data)) only
 * when its size, path or background changed. show() returns the { id, w, h } to draw.
 */
class Pictures {
    constructor(upload) { this.upload = upload; this.keys = {}; }
    show(id, src, dw, dh, mode, o) {
        o = o || {};
        dw = Math.max(1, Math.min(1024, Math.round(dw))); dh = Math.max(1, Math.min(1024, Math.round(dh)));
        const key = [dw, dh, mode, mode === 'opaque' ? o.bgKey || '' : '', o.shadow ? 1 : 0].join('|');
        if (this.keys[id] !== key) {
            this.keys[id] = key;
            this.upload(id, dw, dh, prepare(src, dw, dh, mode, o));
        }
        return { id, w: dw, h: dh };
    }
}

module.exports = { prepare, resample, Pictures };
