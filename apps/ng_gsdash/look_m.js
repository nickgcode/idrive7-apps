'use strict';
/**
 * M Style - after a modern M car's curved display in its sport view: graphite, wide italic numerals
 * (Saira Expanded, open font), slanted rpm segments, carbon cards with the tricolour, a fine-line
 * g-meter. Tricolour = light blue / dark blue / red (no logos).
 * 0.11.0 "Carbon Grid": one column grid for every row (gear | speed | panel). The tach spans the grid
 * edge to edge with its numerals on true 1000-rpm marks; the gear card and the speed card share a top
 * and bottom, the speed centred in its card, and the oil / coolant plates sit exactly under them (same x,
 * same width). Upright chamfered carbon cards, a tricolour cap on each card, a glowing redline.
 */
const G = require('./kit/gauges');
const L = require('./lib');

const { withAlpha, clamp, isNum } = L;
const LB = '#5fb4e8', DB = '#1d4f91', RD = '#e2231a';
const NUM = 'gs_m_num', TXT = 'gs_m_txt', LT = 'gs_m_lt', GEAR = 'gs_m_gear';
const K = 0.36;                 // the lean of every slanted shape (x per px of height)

const palette = Object.assign({}, require('./kit/themes').theme('m_tricolour'), {
    name: 'M Style',
    bg: '#060709', panelTop: '#121419', panelBottom: '#0b0c0f', panelEdge: '#252931',
    track: '#191c22', tick: '#3a404a', text: '#eef1f5', dim: '#7c8492',
    accent: '#eef1f5', accent2: LB, ok: '#eef1f5', warn: '#ff9f1a', crit: RD, cold: LB,
    stripes: [LB, DB, RD], sel: LB, selText: '#060709', marker: RD,
});

/** Three slanted stripes (light blue, dark blue, red), h tall, from x (bottom-left). */
function tricolour(cv, x, y, h, w, gap) {
    [LB, DB, RD].forEach((c, i) => L.slant(cv, x + i * (w + gap), y, w, h, K, c));
}

/** Carbon twill: small offset tiles in two near-blacks (a layer, drawn once). */
function carbon(cv, x, y, w, h) {
    const s = 6;
    cv.fillRect(x, y, w, h, '#0b0c0f');
    for (let j = 0; j * s < h; j++) {
        for (let i = 0; i * s < w; i++) {
            if (((i + (j >> 1)) & 1) === 0) continue;
            cv.fillRect(x + i * s, y + j * s, Math.min(s, w - i * s), Math.min(s, h - j * s), '#131519');
        }
    }
}

/** The grid (page px): one place for every column edge and row edge. */
function grid(S) {
    const ex = Math.max(0, S.h - 456), L0 = S.x + 40, R0 = S.x + S.w, gut = 32, pw = 576;
    const c3 = { x: R0 - pw, w: pw };
    const cw = Math.round((c3.x - gut - L0 - gut) / 2);
    const c1 = { x: L0, w: cw }, c2 = { x: L0 + cw + gut, w: c3.x - gut - (L0 + cw + gut) };
    const bottom = S.y + S.h, tachBase = S.y + 64 + Math.round(ex * 0.1);
    const top = S.y + 132 + Math.round(ex * 0.15), plateH = 64 + Math.round(ex * 0.1), rowGap = 18;
    const heroB = bottom - plateH - rowGap;
    return { ex, L0, R0, gut, c1, c2, c3, top, heroB, plateTop: heroB + rowGap, plateH, bottom, tachBase };
}

/** A card: carbon (or graphite), top-right chamfer, a hairline edge, the tricolour cap on the top edge. */
function cardLayer(cv, key, w, h, ch, kind) {
    return G.layer('gs-ma-' + key + '|' + w + '|' + h + '|' + kind, w, h, (c) => {
        if (kind !== 'graphite' && kind !== 'plainG') carbon(c, 0, 0, w, h); else c.fillRect(0, 0, w, h, '#0d0f13');
        c.gradientRect(0, 0, w, h, [[0, withAlpha('#ffffff', kind === 'carbon' ? 0.05 : 0.035)], [0.55, withAlpha('#000000', 0.15)], [1, withAlpha('#000000', 0.55)]]);
        c.quad([[w - ch, 0], [w, 0], [w, ch], [w, ch]], '#07080a');
        const e = '#2a2f38';
        c.line(w - ch, 0, w, ch, 1.5, e);
        c.fillRect(0, 0, w - ch, 1.5, e); c.fillRect(0, 0, 1.5, h, e);
        c.fillRect(w - 1.5, ch, 1.5, h - ch, e); c.fillRect(0, h - 1.5, w, 1.5, e);
        // the tricolour cap: three bars along the top edge, from the left
        if (kind !== 'plain' && kind !== 'plainG') { const bw = Math.min(54, (w - ch) / 6); [LB, DB, RD].forEach((col, i) => c.fillRect(i * bw, 0, bw, 4, col)); }
    }, cv.textScale);
}

/** The tach: 28 slanted segments across the whole grid; numerals on true 1000-rpm ticks; a glowing redline. */
function tach(cv, t, S, x, base, w) {
    const n = Math.round(S.maxRpm / 250), gap = 6, hMin = 30, hMax = 66;
    const sw = (w - gap * (n - 1) - K * hMax) / n, step = sw + gap;
    const L8 = L.lights(S, 10, LB), lo = S.shift - S.range;
    const xAt = (r) => x + clamp(r / 250, 0, n) * step - (r >= S.maxRpm ? gap : r > 0 ? gap / 2 : 0);
    // redline: a red rail under the red segments with a soft glow
    const rx = xAt(S.redline), rw = x + n * step - gap - rx;
    for (let i = 4; i >= 1; i--) cv.roundRect(rx - i * 2, base + 4 - i * 2, rw + i * 4, 4 + i * 4, 4, withAlpha(RD, 0.07));
    cv.fillRect(rx, base + 4, rw, 4, RD);
    for (let i = 0; i < n; i++) {
        const r0 = i * 250, f = i / (n - 1), h = hMin + (hMax - hMin) * f * f;
        const sx = x + i * step, on = isNum(S.rpm) && S.rpm > r0, red = r0 >= S.redline;
        let c = red ? '#3d0d11' : '#1b1e25';
        if (on) {
            if (r0 >= lo) c = L8.cols[clamp(Math.floor((r0 - lo) / S.range * 10), 0, 9)];
            else c = '#eef1f5';
            if (S.strobe) c = L8.flash || '#3a0d10';
            if (r0 >= lo) L.slant(cv, sx - 3, base - h - 3, sw + 6, h + 6, K, withAlpha(c, 0.22));
        }
        L.slant(cv, sx, base - h, sw, h, K, c);
    }
    for (let k = 0; k * 1000 <= S.maxRpm; k++) {
        const px = xAt(k * 1000), red = k * 1000 >= S.redline;
        cv.fillRect(px - 1, base + 12, 2, 8, red ? RD : '#4a515d');
        cv.text(String(k), px, base + 46, 26, red ? '#ff4a40' : '#9aa3b1', { align: 'center', font: NUM, literal: true });
    }
    return { right: x + (n - 1) * step + sw + K * hMax };
}

/**
 * Oil / coolant on its plate (0.11.0): the value, and a row of slanted segments in temperature zones (lib.js
 * TEMP_ZONES) - faint blue / green / red along the track, lit up to the value in the current zone's colour,
 * a white marker at the value.
 */
const ZONES_M = { cold: LB, ok: '#35d07f', hot: '#ff3b30' };
function temp(cv, t, x, y, w, h, label, v) {
    const pad = 18, n = 20, gap = 4, bh = 12, by = y + h - 12 - bh;
    cv.blit(cardLayer(cv, 'plate', w, h, 14, 'plain'), x, y);
    const zg = L.tempGauge(v, ZONES_M, '#1c1f26', 0.32);
    cv.text(label, x + pad, y + 30, 16, '#9aa3b1', { font: TXT, spacing: 4, literal: true });
    cv.text(isNum(v.f) ? Math.round(v.f) + '°F' : '--', x + w - pad - 6, y + 34, 28, zg.zone === 'ok' || !zg.zone ? '#f4f6f9' : zg.on, { align: 'right', font: NUM, literal: true });
    const iw = w - 2 * pad, sw = (iw - gap * (n - 1) - K * bh) / n;
    for (let i = 0; i < n; i++) L.slant(cv, x + pad + i * (sw + gap), by, sw, bh, K, zg.seg((i + 0.5) / n));
    if (zg.zone) { const mx = x + pad + zg.pos * (iw - K * bh) + K * bh / 2; L.slant(cv, mx - 2, by - 4, 4, bh + 8, K, '#ffffff'); }
}

function modeTag(cv, t, cx, y, h, S) {
    if (!S.mode) return null;
    const size = 20, fill = { 'sport+': RD, track: RD, sport: DB }[S.modeTone];
    const tw = cv.textWidth(S.mode, size, { font: NUM, spacing: 2, literal: true }), w = tw + 44;
    const x = Math.round(cx - (w + K * h - 34) / 2);
    if (fill) { L.slant(cv, x - 3, y - h - 3, w + 6, h + 6, K, withAlpha(fill, 0.25)); L.slant(cv, x, y - h, w, h, K, fill); }
    else { L.slant(cv, x, y - h, w, h, K, '#343a45'); L.slant(cv, x + 2, y - h + 2, w - 4, h - 4, K, '#0b0c0f'); }
    [LB, DB, RD].forEach((c, i) => L.slant(cv, x - 34 + i * 9, y - h, 6, h, K, c));
    cv.text(S.mode, x + 22 + K * h / 2, y - Math.round(h * 0.25), size, fill ? '#ffffff' : '#eef1f5', { font: NUM, spacing: 2, literal: true });
    return { x: x - 34, w: w + 34 + K * h };
}

function gmeter(cv, t, S, cx, cy, r) {
    const max = S.gMax;
    cv.blit(G.layer(['gs-ma-gm', r, max].join('|'), 2 * r + 120, 2 * r + 20, (c) => {
        const x = r + 10, y = r + 10;
        c.circle(x, y, r + 2, withAlpha('#000000', 0.25));
        for (let q = 0.5; q <= max + 1e-6; q += 0.5) {
            const rr = q / max * r;
            c.arc(x, y, rr - 0.75, rr + 0.75, 0, 360, q % 1 === 0 ? '#3e4552' : '#252a32');
        }
        c.line(x - r - 8, y, x + r + 8, y, 1, '#3a404a');
        c.line(x, y - r - 8, x, y + r + 8, 1, '#3a404a');
        c.text(max.toFixed(1), x + r * 0.72 + 6, y - r * 0.72, 16, '#7c8492', { font: LT, literal: true });
    }, cv.textScale), cx - r - 10, cy - r - 10);
    const P = (lat, lon) => [cx + clamp(lat / max, -1.08, 1.08) * r, cy - clamp(lon / max, -1.08, 1.08) * r];
    S.trail.forEach((p, i) => { if (isNum(p[0]) && isNum(p[1])) { const q = P(p[0], p[1]); cv.circle(q[0], q[1], 3, withAlpha(LB, 0.08 + 0.45 * i / S.trail.length)); } });
    const lat = G.smooth('gs-ma-lat', S.gLat, 12), lon = G.smooth('gs-ma-lon', S.gLong, 12);
    if (isNum(lat) && isNum(lon)) { const q = P(lat, lon); cv.circle(q[0], q[1], 14, withAlpha(LB, 0.25)); cv.circle(q[0], q[1], 11, '#060709'); cv.circle(q[0], q[1], 8, '#ffffff'); }
}

module.exports = {
    id: 'm',
    name: 'M Style',
    blurb: 'Graphite and tricolour on a carbon grid, wide italic numerals, a rising rpm wedge',
    palette,
    ui: { txt: TXT, num: NUM, size: 20, spacing: 2, upper: true, radius: 0, nameFont: NUM, nameSize: 30 },

    background(cv, t, reach) {
        cv.gradientRect(0, 0, 1600, reach, [[0, '#0a0b0e'], [1, '#040506']]);
    },

    card(cv, t, x, y, w, h, on) {
        L.chamfer(cv, x, y, w, h, 14, on ? '#1b2a3b' : '#101216');
        L.chamferStroke(cv, x, y, w, h, 14, 1, on ? LB : '#22262d');
    },
    cardBg(cv, t, x, y, w, h) { carbon(cv, x, y, w, h); cv.gradientRect(x, y, w, h, [[0, withAlpha('#060709', 0.2)], [1, withAlpha('#060709', 0.85)]]); },

    swatch(cv, t, x, y, w, h) {
        const n = 14, gap = 5, base = y + h * 0.62, sw = (w - 60 - gap * (n - 1)) / n;
        for (let i = 0; i < n; i++) {
            const f = i / (n - 1), hh = 14 + 30 * f * f;
            L.slant(cv, x + 24 + i * (sw + gap), base - hh, sw, hh, K, i < 9 ? '#e6eaef' : i < 12 ? '#ffc21a' : RD);
        }
        tricolour(cv, x + 24, base + 14, 12, 16, 5);
    },

    _grid: grid,   // (tests: the columns the gauges line up on)
    panelRect(S) { const g = grid(S); return { x: g.c3.x, y: g.top, w: g.c3.w, h: g.bottom - g.top }; },
    panelPlate(cv, t, x, y, w, h) { cv.blit(cardLayer(cv, 'panel', Math.round(w), Math.round(h), 24, 'graphite'), x, y); },

    draw(cv, S) {
        const t = S.t, g = grid(S), ex = g.ex;
        tach(cv, t, S, g.L0, g.tachBase, g.R0 - g.L0);

        // column 1: the gear card
        const gx = g.c1.x, gy = g.top, gw = g.c1.w, gh = g.heroB - g.top;
        cv.blit(cardLayer(cv, 'gear', gw, gh, 34, 'carbon'), gx, gy);
        cv.text('GEAR', gx + 22, gy + 38, 16, '#9aa3b1', { font: TXT, spacing: 5, literal: true });
        if (S.guessed) cv.text('EST', gx + gw - 46, gy + 70, 15, t.dim, { align: 'right', font: TXT, spacing: 3, literal: true });
        const gcol = S.strobe ? (S.blink ? RD : '#ffffff') : '#ffffff', gs = 200 + ex * 0.3;
        if (S.strobe) cv.roundRect(gx + 6, gy + 6, gw - 12, gh - 12, 4, withAlpha(RD, S.blink ? 0.16 : 0.06));
        cv.text(S.gearText, gx + gw / 2 + 8, gy + gh / 2 + gs * 0.36, gs, gcol, { align: 'center', font: GEAR, literal: true });

        // column 2: the speed card, everything centred on its axis
        const sx0 = g.c2.x, sw = g.c2.w, cx = sx0 + sw / 2;
        cv.blit(cardLayer(cv, 'speed', sw, gh, 34, 'plainG'), sx0, gy);
        cv.text(L.rpmText(S.rpm) + ' RPM', cx, gy + 38, 22, '#b4bcc8', { align: 'center', font: LT, spacing: 3, literal: true });
        const ss = 160 + ex * 0.2, sb = gy + 50 + ss * 0.74;
        cv.text(isNum(S.speed) ? String(Math.round(S.speed)) : '--', cx, sb, ss, '#ffffff', { align: 'center', font: NUM, literal: true });
        const unitY = sb + 30;
        cv.text(S.unit, cx, unitY, 18, '#9aa3b1', { align: 'center', font: TXT, spacing: 8, literal: true });
        const th = 30, tagB = g.heroB - 16;
        modeTag(cv, t, cx, tagB, th, S);

        // row 3: oil under the gear card, coolant under the speed card (same x, same width)
        temp(cv, t, g.c1.x, g.plateTop, g.c1.w, g.plateH, 'OIL', S.oil);
        temp(cv, t, g.c2.x, g.plateTop, g.c2.w, g.plateH, 'COOLANT', S.cool);

        const uw = cv.textWidth(S.unit, 18, { font: TXT, spacing: 8, literal: true });
        S.zones = {
            gear: { x: gx, y: gy, w: gw, h: gh },
            speed: { x: sx0, y: gy, w: sw, h: unitY + 14 - gy },
            toast: { x: cx, y: unitY + 12 }, chip: { x: gx + gw - 26, y: gy + gh - 24 }, star: { x: cx + uw / 2 + 20, y: unitY - 7 },
        };
        if (S.panel !== 'spotify') this.gPart(cv, S, t, g);
    },
    gPart(cv, S, t, g) {
        const R = this.panelRect(S);
        this.panelPlate(cv, t, R.x, R.y, R.w, R.h);
        cv.text('G-FORCE', R.x + 22, R.y + 38, 16, LB, { font: TXT, spacing: 4, literal: true });
        const px = R.x + 150, gr = Math.min(122 + g.ex * 0.15, (R.h - 150) / 2), gcx = R.x + R.w - 36 - gr - 6, gcy = R.y + 62 + gr;
        [['ACCEL', S.peak.acc], ['BRAKE', S.peak.brk], ['LATERAL', S.peak.lat]].forEach((p, i) => {
            const y = R.y + 92 + i * 74;
            cv.text(p[0], px, y, 14, '#9aa3b1', { align: 'right', font: TXT, spacing: 3, literal: true });
            cv.text(p[1].toFixed(2), px, y + 38, 36, '#f4f6f9', { align: 'right', font: NUM, literal: true });
        });
        cv.fillRect(px + 24, R.y + 70, 1, 220, '#262b33');
        gmeter(cv, t, S, gcx, gcy, gr);
        const tot = isNum(S.gLat) && isNum(S.gLong) ? Math.sqrt(S.gLat * S.gLat + S.gLong * S.gLong) : null;
        cv.text(tot == null ? '-.-- G' : tot.toFixed(2) + ' G', px - 60, R.y + R.h - 34, 30, '#ffffff', { align: 'center', font: NUM, literal: true });
    },
};
