'use strict';
/**
 * waves.js - the Showcase background (0.11.0): flowing satin folds drawn procedurally per look, no
 * picture files. M red, GT gunmetal with a gold edge light, Digital '84 green lines, Sim Racing
 * carbon / amber, Lumen blue, Pixel stepped purple / pink.
 *
 * One picture for the current look only (W x H, W = 1024: the native renderer's longest side),
 * drawn a few rows per frame (step()) so a look change never stalls the loop; the page scales it up.
 * sample() reads the same pixels back, for pictures composited over it (pictures.js, opaque path).
 * Node 8: no ?., no ??, no object spread.
 */

const W = 1024;
const PAL = {
    m:         { c0: [30, 1, 8],   c1: [118, 5, 24],  c2: [196, 16, 40],  hi: [240, 74, 96],   crest: 0.11, amt: 0.32, N: 2.6 },
    gt:        { c0: [3, 4, 7],    c1: [22, 30, 44],  c2: [52, 66, 88],   hi: [190, 205, 225], crest: 0.05, amt: 0.22, N: 2.6, edge: [255, 200, 0], edgeAmt: 0.25 },
    digital:   { c0: [1, 4, 4],    c1: [4, 26, 24],   c2: [8, 46, 42],    hi: [70, 255, 210],  crest: 0.012, amt: 0.85, N: 5.0 },
    simracing: { c0: [6, 7, 9],    c1: [26, 28, 33],  c2: [46, 48, 55],   hi: [255, 196, 30],  crest: 0.018, amt: 0.55, N: 3.2 },
    lumen:     { c0: [4, 6, 18],   c1: [18, 34, 84],  c2: [36, 64, 140],  hi: [140, 224, 255], crest: 0.10, amt: 0.30, N: 2.4 },
    pixel:     { c0: [12, 10, 36], c1: [44, 30, 104], c2: [84, 50, 160],  hi: [255, 110, 200], crest: 0.08, amt: 0.45, N: 2.8, px: 8, levels: 5 },
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hex = (c) => '#' + c.map((v) => (v < 16 ? '0' : '') + v.toString(16)).join('');

/** The fold field: big sweeping S-curves from top left to bottom right. u, v in 0..1. */
function field(u, v) {
    return v * 1.25 - u * 0.55 + 0.30 * Math.sin(6.2832 * (0.62 * u + 0.08)) + 0.10 * Math.sin(6.2832 * (1.35 * u + 0.5 * v) + 1.3)
        + 0.04 * Math.sin(6.2832 * (2.7 * u - 0.9 * v));
}

/** One row of the picture (y of H) into d (RGBA, opaque). */
function row(P, d, y, H) {
    const px = P.px || 1;
    for (let x = 0; x < W; x++) {
        const sx = px > 1 ? Math.floor(x / px) * px + px / 2 : x, sy = px > 1 ? Math.floor(y / px) * px + px / 2 : y;
        const u = sx / W, v = sy / H, f = field(u, v) * P.N + 10, t = f - Math.floor(f);
        // a fold: dark just after its edge, rising to a lit crest, then the next fold's shadow
        const rise = Math.pow(t, 1.7) * smooth(0, 0.05, t), hl = Math.exp(-Math.pow((1 - t) / P.crest, 2)) * smooth(0, 0.05, t);
        const band = Math.floor(f) % 2 ? 1 : 0.82;
        // lit from the upper middle, the corners falling off
        const vig = clamp(1.05 - 0.55 * Math.pow(Math.abs(u - 0.55) * 1.4, 2) - 0.35 * v * v, 0.25, 1);
        let k = clamp(rise * band * vig, 0, 1), h = clamp(hl * vig * P.amt, 0, 1);
        if (P.levels) { k = Math.round(k * P.levels) / P.levels; h = h > 0.18 ? 0.7 : 0; }
        const o = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
            const base = P.c0[c] + (P.c1[c] - P.c0[c]) * Math.min(1, k * 1.4) + (P.c2[c] - P.c1[c]) * Math.max(0, k * 1.4 - 1) / 0.4;
            let val = base + (P.hi[c] - base) * h;
            if (P.edge) val += (P.edge[c] - val) * hl * P.edgeAmt * smooth(0.5, 0.9, u) * vig;
            d[o + c] = clamp(Math.round(val), 0, 255);
        }
        d[o + 3] = 255;
    }
}

/**
 * The current look's picture, drawn in steps. upload(w, h, data) sends it (record.setImage) when
 * done. Only one look is kept: another look (or height) starts over and drops the old pixels.
 */
class Waves {
    constructor(upload) { this.upload = upload; this.key = ''; this.d = null; this.y = 0; this.H = 0; this.P = null; this.ready = false; this.ver = 0; }
    /** Draw on for about budget ms. Returns true once the picture for (id, H) is ready (and sent). */
    step(id, H, budget) {
        H = Math.max(8, Math.min(1024, Math.round(H)));
        const key = id + '|' + H;
        if (key !== this.key) { this.key = key; this.P = PAL[id] || PAL.m; this.H = H; this.d = new Uint8Array(W * H * 4); this.y = 0; this.ready = false; }
        if (this.ready) return true;
        const t0 = Date.now(), b = budget == null ? 30 : budget;
        while (this.y < this.H) { row(this.P, this.d, this.y++, this.H); if (b > 0 && Date.now() - t0 >= b) break; }
        if (this.y < this.H) return false;
        this.ready = true; this.ver++;
        if (this.upload) this.upload(W, this.H, this.d);
        return true;
    }
    /** The finished picture's pixel at page px (x, y) of a page pw x ph, nearest (as the upstream renderer scales). */
    sample(x, y, pw, ph) {
        if (!this.ready) return null;
        const sx = clamp(Math.floor(x * W / pw), 0, W - 1), sy = clamp(Math.floor(y * this.H / ph), 0, this.H - 1), o = (sy * W + sx) * 4;
        return [this.d[o], this.d[o + 1], this.d[o + 2]];
    }
}

/** A look's flat colour while its picture is being drawn (its darkest). */
const base = (id) => hex((PAL[id] || PAL.m).c0);

module.exports = { Waves, PAL, W, field, base };
