'use strict';
/**
 * lib.js - shared parts of G's Dash's looks (look_*.js): fonts, shift-light state, gear text,
 * number formats, the G badge, small geometry helpers. Node 8: no ?., no ??, no object spread.
 */
const path = require('path');
const G = require('./kit/gauges');
const fonts = require('./kit/fonts');
const pack = require('./kit/pack');

const { withAlpha, mix, clamp, isNum } = G;
const RAD = Math.PI / 180;

/* ---------------- fonts: apps/ng_gsdash/fonts (fonts.pack in a build), tools/bake_gsdash_fonts.py ---------------- */
const FAMILIES = ['gs_m_num', 'gs_m_gear', 'gs_m_txt', 'gs_m_lt', 'gs_gt_num', 'gs_gt_gear', 'gs_gt_txt',
    'gs_h_txt', 'gs_h_num', 'gs_h_big', 'gs_f_txt', 'gs_f_num', 'gs_d_seg', 'gs_d_txt', 'gs_s_gear', 'gs_s_num', 'gs_s_txt', 'gs_p_px'];
let fontsLoaded = null;
/** Registers the looks' fonts with the kit once; returns the families that loaded. */
function loadFonts(log) {
    if (fontsLoaded) return fontsLoaded;
    fontsLoaded = [];
    const src = pack.open(path.join(__dirname, 'fonts'));
    FAMILIES.forEach((f) => {
        try { if (fonts.register(f, src.json(f + '.json'))) fontsLoaded.push(f); } catch (e) { if (log) log.warn('font ' + f + ': ' + e); }
    });
    if (log) log.info('look fonts: ' + fontsLoaded.length + '/' + FAMILIES.length);
    return fontsLoaded;
}

/* ---------------- values ---------------- */
/** The gear as shown: 1..9, R, N, P, D, or '-' (as kit gauges.gear). */
function gearText(gr, st) {
    return st === 'P' || st === 'R' || st === 'N' ? st : gr === -1 ? 'R' : isNum(gr) && gr > 0 ? String(gr) : st === 'D' ? 'D' : gr === 0 ? 'N' : '-';
}
const num0 = (v) => (isNum(v) ? String(Math.round(v)) : '--');
const num1 = (v) => (isNum(v) ? v.toFixed(1) : '-.-');
const num2 = (v) => (isNum(v) ? v.toFixed(2) : '-.--');
/** 4424 -> "4 424" style thousands for rpm (thin space). */
function rpmText(v) { if (!isNum(v)) return '----'; const r = Math.round(v / 10) * 10; return r >= 1000 ? Math.floor(r / 1000) + ',' + String(r % 1000 + 1000).slice(1) : String(r); }
/** session clock m:ss.t */
function clock(ms) {
    const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60);
    return m + ':' + ('0' + Math.floor(s % 60)).slice(-2) + '.' + Math.floor((s * 10) % 10);
}

/* ---------------- shift lights ---------------- */
const LIGHTS = {
    m: ['#2fd27a', '#2fd27a', '#2fd27a', '#ffc21a', '#ffc21a', '#ff2a2a'],
    f1: ['#2fd27a', '#2fd27a', '#ff2a2a', '#ff2a2a', '#2a7dff', '#2a7dff'],
};
/**
 * The shift lights' state for n lights over the last `range` rpm to the shift point (the style: main.js LIGHT_STYLE, Race since 0.6.0):
 * { cols[i], part[i] 0..1 (a light fades in as rpm crosses it), strobe, flash (strobe colour or null this frame) }.
 */
function lights(S, n, mono) {
    const style = S.lightStyle, cols = [];
    for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 1;
        if (style === 'mono') cols.push(mono);
        else if (style === 'f1') cols.push(f < 0.42 ? '#2fd27a' : f < 0.84 ? '#ff2a2a' : '#2a7dff');
        else cols.push(f < 0.42 ? '#2fd27a' : f < 0.75 ? '#ffc21a' : '#ff2a2a');
    }
    const start = S.shift - S.range, lit = isNum(S.rpm) ? clamp((S.rpm - start) / S.range, 0, 1) * n : 0;
    const part = cols.map((c, i) => clamp(lit - i, 0, 1));
    const flash = S.strobe ? (S.blink ? (style === 'f1' ? '#2a7dff' : style === 'mono' ? mono : '#ff2a2a') : null) : null;
    return { cols, part, strobe: S.strobe, flash };
}

/* ---------------- the G badge (as tools/make_g_icon.py) ---------------- */
const LIGHT_BLUE = '#2fa8e8', DARK_BLUE = '#1e4ca0', RED = '#e4212b', LETTER = '#f5f7fa';
function badgeWidth(h) { return 3 * h * 0.19 + 2 * h * 0.05 + h * 0.1 + h * 0.93 + 0.27 * h; }
/** Three slanted stripes and a blocky italic G, h tall, bottom-left at (x, y). letter: the G's colour. */
function badge(cv, x, y, h, letter) {
    const k = 0.27, sw = h * 0.19, sg = h * 0.05, gw = h * 0.93, t = h * 0.245, mid = h * 0.47, L = letter || LETTER;
    const box = (bx, by, w, hh, c) => {
        const P = (px, py) => [x + px + k * (h - py), y - h + py];
        cv.quad([P(bx, by), P(bx + w, by), P(bx + w, by + hh), P(bx, by + hh)], c);
    };
    [LIGHT_BLUE, DARK_BLUE, RED].forEach((c, i) => box(i * (sw + sg), 0, sw, h, c));
    const g0 = 3 * sw + 2 * sg + h * 0.1;
    box(g0, 0, gw, t, L); box(g0, 0, t, h, L); box(g0, h - t, gw, t, L);
    box(g0 + gw - t, mid, t, h - mid, L); box(g0 + gw * 0.5, mid, gw * 0.5, t * 0.86, L);
    return g0 + gw + k * h;
}

/* ---------------- geometry ---------------- */
const pt = (cx, cy, r, a) => [cx + Math.sin(a * RAD) * r, cy - Math.cos(a * RAD) * r];
/** A tick on a dial: angle a (deg, clockwise from 12), from radius r0 to r1. */
function tick(cv, cx, cy, r0, r1, a, w, c) { const p = pt(cx, cy, r0, a), q = pt(cx, cy, r1, a); cv.line(p[0], p[1], q[0], q[1], w, c); }
/** A tapered needle as a quad: tail radius rt (behind the centre), tip radius r, base half-width w0, tip half-width w1. */
function needle(cv, cx, cy, a, rt, r, w0, w1, c) {
    const s = Math.sin(a * RAD), co = Math.cos(a * RAD), nx = co, ny = s;     // normal
    const b = [cx - s * rt, cy + co * rt], e = [cx + s * r, cy - co * r];
    cv.quad([[b[0] - nx * w0, b[1] - ny * w0], [e[0] - nx * w1, e[1] - ny * w1], [e[0] + nx * w1, e[1] + ny * w1], [b[0] + nx * w0, b[1] + ny * w0]], c);
}
/** Parallelogram leaning by k (x shift per px of height): top-left at (x, y). */
function slant(cv, x, y, w, h, k, c) { cv.quad([[x + k * h, y], [x + w + k * h, y], [x + w, y + h], [x, y + h]], c); }
/** A rectangle with its top-right corner cut by c px, as two quads. */
function chamfer(cv, x, y, w, h, c, col) {
    cv.quad([[x, y], [x + w - c, y], [x + w - c, y + h], [x, y + h]], col);
    cv.quad([[x + w - c, y], [x + w, y + c], [x + w, y + h], [x + w - c, y + h]], col);
}
/** Outline of a chamfered rect (top-right corner cut). */
function chamferStroke(cv, x, y, w, h, c, lw, col) {
    const p = [[x, y], [x + w - c, y], [x + w, y + c], [x + w, y + h], [x, y + h], [x, y]];
    cv.polyline(p, lw, col);
}
/**
 * The part of the square (x, y, s) on the side of the line through (px, py) with direction angle
 * `a` (deg) where nx*dx + ny*dy > 0; drawn as quads (a convex polygon of up to 5 corners).
 */
function halfSquare(cv, x, y, w, h, px, py, a, col) {
    const nx = -Math.sin(a * RAD), ny = Math.cos(a * RAD);
    const sq = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const side = (p) => (p[0] - px) * nx + (p[1] - py) * ny;
    const out = [];
    for (let i = 0; i < 4; i++) {
        const A = sq[i], B = sq[(i + 1) % 4], sa = side(A), sb = side(B);
        if (sa >= 0) out.push(A);
        if ((sa >= 0) !== (sb >= 0)) { const t = sa / (sa - sb); out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]); }
    }
    for (let i = 1; i + 1 < out.length; i += 2) {
        // a triangle at the end: its fourth corner halfway along its closing edge (no zero-length edge)
        const c = out[i + 2] || [(out[i + 1][0] + out[0][0]) / 2, (out[i + 1][1] + out[0][1]) / 2];
        cv.quad([out[0], out[i], out[i + 1], c], col);
    }
}

/**
 * The drive mode's tone for the looks' badges: 'sport+' / 'sport' (accent colour), 'eco', 'track',
 * 'plain' (comfort, individual, adaptive), or null when there is no mode to show.
 */
function modeTone(label) {
    if (!label) return null;
    if (label === 'SPORT+') return 'sport+';
    if (label === 'SPORT') return 'sport';
    if (/^ECO/.test(label)) return 'eco';
    if (label === 'RACE' || label === 'TRACK') return 'track';
    return 'plain';
}

/**
 * A session clock's tap target: a tap resets the clock to zero (S.sessionTap, set on the full-screen
 * page only), then a short flash over the rect (S.sessionFlash, 1 down to 0). x, y, w, h: page px,
 * the clock's whole cell (a generous target); col: the flash's colour; r: corner radius.
 */
function sessionTap(cv, S, x, y, w, h, col, r) {
    if (S.sessionFlash > 0) cv.roundRect(x, y, w, h, r || 0, withAlpha(col || '#ffffff', 0.4 * S.sessionFlash));
    if (S.sessionTap && cv.target) cv.target(x, y, w, h, S.sessionTap, 'session', r || 0);
}

/**
 * The Drive page's fuel bar, as text (S.fuel from fuel.js): { f: 0..1 or null (no %), value: '62%' /
 * '11.9 GAL' (litres only, no %) / '--', range: '240 MI' or '' (not sent), low, has }. Car data only.
 */
function fuelText(F) {
    F = F || {};
    const f = isNum(F.pct) ? clamp(F.pct / 100, 0, 1) : null;
    const value = f !== null ? Math.round(F.pct) + '%' : isNum(F.gal) ? F.gal.toFixed(1) + ' GAL' : '--';
    return { f, value, range: isNum(F.mi) ? Math.round(F.mi) + ' MI' : '', low: !!F.low, has: !!F.has };
}

/**
 * Text with its ink (the glyphs' drawn boxes, not the advance and the baseline) centred on (cx, cy):
 * the gallery cards' gear digits sit in the middle of their box or ring whatever the font's bearings.
 * Returns the ink's height.
 */
function inkCentred(cv, s, cx, cy, size, c, o) {
    s = String(s);
    const opt = Object.assign({ literal: true }, o || {}, { align: 'left' });
    const f = fonts.get(opt.font || 'label', size * (cv.textScale || 1), s);
    if (!f) { cv.text(s, cx, cy, size, c, Object.assign({}, opt, { align: 'center' })); return 0; }
    const k = size / f.size, sp = opt.spacing || 0;
    let pen = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const ch of s) {
        const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63];
        if (!g) continue;
        if (g[2] && g[3]) {
            x0 = Math.min(x0, pen + g[4] * k); x1 = Math.max(x1, pen + (g[4] + g[2]) * k);
            y0 = Math.min(y0, g[5] * k); y1 = Math.max(y1, (g[5] + g[3]) * k);
        }
        pen += g[6] * k + sp;
    }
    if (!(x1 > x0)) return 0;
    cv.text(s, cx - (x0 + x1) / 2, cy - (y0 + y1) / 2, size, c, opt);
    return y1 - y0;
}

module.exports = {
    modeTone, sessionTap, fuelText, inkCentred,
    loadFonts, FAMILIES, gearText, num0, num1, num2, rpmText, clock, lights, LIGHTS, badge, badgeWidth,
    pt, tick, needle, slant, chamfer, chamferStroke, halfSquare, RAD, withAlpha, mix, clamp, isNum,
    LIGHT_BLUE, DARK_BLUE, RED, LETTER,
};
