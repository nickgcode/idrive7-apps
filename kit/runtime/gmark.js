'use strict';
/**
 * gmark.js - the "G" badge of Nick's apps (G's Dash, G's Music), drawn as vectors: three slanted
 * stripes (light blue, dark blue, red) and a blocky italic G, as tools/make_g_icon.py draws the icon.
 * opts.levels (e.g. [0.66, 1, 0.8]) turns the stripes into an equaliser (G's Music,
 * tools/make_gsmusic_icon.py): bottom-aligned bars of blocks, each that share of the G's height.
 *
 *   const M = require('./kit/gmark');
 *   M.badge(cv, x, y, h);                    // bottom-left at (x, y), h tall; returns its width
 *   M.badgeWidth(h);
 *
 * (G's Dash keeps its own copy in apps/ng_gsdash/lib.js.)
 */
const LIGHT_BLUE = '#2fa8e8', DARK_BLUE = '#1e4ca0', RED = '#e4212b', LETTER = '#f5f7fa';
const K = 0.27;                       // italic shear (x shift per px of height)

function badgeWidth(h) { return 3 * h * 0.19 + 2 * h * 0.05 + h * 0.1 + h * 0.93 + K * h; }

function badge(cv, x, y, h, opts) {
    const o = typeof opts === 'string' ? { letter: opts } : (opts || {});
    const sw = h * 0.19, sg = h * 0.05, gw = h * 0.93, t = h * 0.245, mid = h * 0.47, L = o.letter || LETTER;
    const box = (bx, by, w, hh, c) => {
        const P = (px, py) => [x + px + K * (h - py), y - h + py];
        cv.quad([P(bx, by), P(bx + w, by), P(bx + w, by + hh), P(bx, by + hh)], c);
    };
    const cols = o.colors || [LIGHT_BLUE, DARK_BLUE, RED];
    if (o.levels) {
        // the equaliser: n blocks for a full bar, gaps between them
        const n = o.blocks || 6, gap = h * 0.045, bh = (h - (n - 1) * gap) / n;
        cols.forEach((c, i) => {
            const m = Math.max(1, Math.round((o.levels[i] == null ? 1 : o.levels[i]) * n));
            for (let b = 0; b < m; b++) box(i * (sw + sg), h - (b + 1) * bh - b * gap, sw, bh, c);
        });
    } else cols.forEach((c, i) => box(i * (sw + sg), 0, sw, h, c));
    const g0 = 3 * sw + 2 * sg + h * 0.1;
    box(g0, 0, gw, t, L); box(g0, 0, t, h, L); box(g0, h - t, gw, t, L);
    box(g0 + gw - t, mid, t, h - mid, L); box(g0 + gw * 0.5, mid, gw * 0.5, t * 0.86, L);
    return g0 + gw + K * h;
}

/** G's Music's levels (the icon's). */
const MUSIC = [0.66, 1, 0.8];

module.exports = { badge, badgeWidth, LIGHT_BLUE, DARK_BLUE, RED, LETTER, K, MUSIC };
