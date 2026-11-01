'use strict';
/**
 * Heritage - a classic sports car's instruments: three round dials with polished bezels,
 * cream numerals (Jost, open font), orange tapered needles, a gear window in the tachometer
 * like a watch's date, a shift lamp, warm-up tell-tales.
 */
const G = require('./kit/gauges');
const L = require('./lib');

const { withAlpha, clamp, isNum } = L;
const TXT = 'gs_h_txt', NUM = 'gs_h_num', BIG = 'gs_h_big';
const CREAM = '#efe8d8', DIMC = '#8d8578', NEEDLE = '#ff6418', FACE = '#0f0e0d', RED = '#d83a22';
const SWEEP = 120;              // dials run from -SWEEP to +SWEEP degrees

const palette = Object.assign({}, require('./kit/themes').theme('m_tricolour'), {
    name: 'Heritage',
    bg: '#0a0908', panelTop: '#171513', panelBottom: '#0d0c0b', panelEdge: '#3a352e',
    track: '#1d1b18', tick: '#5a544a', text: CREAM, dim: DIMC,
    accent: NEEDLE, accent2: CREAM, ok: '#9fd36b', warn: '#ffb020', crit: RED, cold: '#7db8e6',
    stripes: [NEEDLE], sel: NEEDLE, selText: '#0a0908', marker: NEEDLE,
});

const CHROME = ['#3b3936', '#8e8b85', '#e9e6df', '#7b7872', '#2e2d2a', '#6f6c66', '#d8d4cc', '#55524d', '#3b3936'];

/** The bezel and face (static, a layer). */
function dialFace(c, x, y, r) {
    c.arc(x, y, r, r + 12, 0, 360, '#000000', { ramp: CHROME, rampFrom: -20, rampTo: 340 });
    c.arc(x, y, r + 12, r + 14, 0, 360, '#000000');
    c.circle(x, y, r, FACE);
    c.arc(x, y, r - 2, r, 0, 360, '#000000');
    c.arc(x, y, r * 0.98, r * 0.985, 0, 360, withAlpha(CREAM, 0.08));
}

/** A dial's scale: ticks every `minor`, numerals every `major` (shown as value / div). */
function scale(c, x, y, r, max, minor, major, div, red, size) {
    for (let v = 0; v <= max + 1e-6; v += minor) {
        const a = -SWEEP + v / max * 2 * SWEEP, isMaj = Math.abs(v / major - Math.round(v / major)) < 1e-6;
        const col = red != null && v >= red ? RED : CREAM;
        L.tick(c, x, y, r * (isMaj ? 0.84 : 0.9), r * 0.955, a, isMaj ? 3.5 : 1.5, col);
        if (isMaj) {
            const p = L.pt(x, y, r * 0.7, a);
            c.text(String(Math.round(v / div)), p[0], p[1] + size * 0.36, size, col, { align: 'center', font: NUM, literal: true });
        }
    }
    if (red != null) c.arc(x, y, r * 0.955 - 5, r * 0.955, -SWEEP + red / max * 2 * SWEEP, SWEEP, RED);
}

function hand(cv, x, y, r, a) {
    L.needle(cv, x + 2, y + 3, a, r * 0.16, r * 0.9, 6, 1.5, withAlpha('#000000', 0.5));
    L.needle(cv, x, y, a, r * 0.16, r * 0.9, 6, 1.5, NEEDLE);
    cv.circle(x, y, r * 0.1, '#1b1a18');
    cv.arc(x, y, r * 0.1 - 1.5, r * 0.1, 0, 360, '#3e3b36');
    cv.circle(x, y, 5, '#2a2825');
}

const angle = (v, max) => -SWEEP + clamp((isNum(v) ? v : 0) / max, 0, 1.02) * 2 * SWEEP;

function lamp(cv, x, y, label, v) {
    const c = v.ok === true ? '#7ed957' : v.ok === false ? '#ffae1a' : '#3a362f';
    cv.circle(x, y, 13, '#000000');
    cv.circle(x, y, 11, v.ok == null ? '#1a1916' : c);
    if (v.ok != null) cv.circle(x - 3, y - 3, 3.5, withAlpha('#ffffff', 0.5));
    cv.text(label, x + 24, y - 1, 15, DIMC, { font: TXT, spacing: 2.5, literal: true });
    cv.text(isNum(v.f) ? Math.round(v.f) + '°F' : '--', x + 24, y + 19, 19, CREAM, { font: NUM, literal: true });
}

/** The fuel level (Bottom bars: Fuel): a tell-tale (amber at the car's low level), then an E-F strip with an orange pointer. */
function fuelGauge(cv, x, x1, y, F) {
    const ft = L.fuelText(F);
    const on = ft.has && ft.low;
    cv.circle(x, y, 13, '#000000');
    cv.circle(x, y, 11, on ? '#ffae1a' : '#1a1916');
    if (on) cv.circle(x - 3, y - 3, 3.5, withAlpha('#ffffff', 0.5));
    cv.text('FUEL', x + 24, y - 1, 15, DIMC, { font: TXT, spacing: 2.5, literal: true });
    cv.text(ft.value, x + 24, y + 19, 19, CREAM, { font: NUM, literal: true });
    const bx = x + 110, bw = x1 - bx - (ft.range ? 110 : 0), cy = y + 2;
    cv.fillRect(bx, cy - 1, bw, 2, withAlpha(CREAM, 0.5));
    for (let k = 0; k <= 4; k++) cv.fillRect(bx + bw * k / 4 - 1, cy - (k % 2 ? 5 : 9), 2, k % 2 ? 10 : 18, k === 0 ? RED : withAlpha(CREAM, 0.8));
    cv.text('E', bx - 14, cy + 6, 15, RED, { align: 'center', font: TXT, literal: true });
    cv.text('F', bx + bw + 14, cy + 6, 15, CREAM, { align: 'center', font: TXT, literal: true });
    if (ft.f !== null) { const px = bx + bw * ft.f; cv.quad([[px - 6, cy + 12], [px + 6, cy + 12], [px + 1.5, cy - 12], [px - 1.5, cy - 12]], NEEDLE); }
    if (ft.range) {
        // the number in the numerals, the unit in the label type (the numerals have no letters)
        cv.text('MI', x1, cy + 6, 14, DIMC, { align: 'right', font: TXT, spacing: 2, literal: true });
        cv.text(ft.range.replace(' MI', ''), x1 - cv.textWidth('MI', 14, { font: TXT, spacing: 2, literal: true }) - 8, cy + 7, 19, CREAM, { align: 'right', font: NUM, literal: true });
    }
}

module.exports = {
    id: 'heritage',
    name: 'Heritage',
    blurb: 'Classic round dials: polished bezels, cream numerals, orange needles',
    palette,
    ui: { txt: TXT, num: NUM, size: 21, spacing: 2, upper: true, radius: 6, nameFont: TXT, nameSize: 28 },

    background(cv, t, reach) {
        cv.gradientRect(0, 0, 1600, reach, [[0, '#100e0c'], [1, '#060505']]);
    },
    card(cv, t, x, y, w, h) {
        cv.roundRect(x, y, w, h, 6, '#13110f');
        cv.strokeRoundRect(x, y, w, h, 6, 1, withAlpha(CREAM, 0.12));
    },
    cardBg(cv, t, x, y, w, h) { cv.roundRect(x, y, w, h, 10, '#0c0b0a'); },

    swatch(cv, t, x, y, w, h) {
        const r = h * 0.42, cx = x + w / 2, cy = y + h * 0.55;
        dialFace(cv, cx, cy, r);
        for (let k = 0; k <= 8; k++) L.tick(cv, cx, cy, r * 0.78, r * 0.94, -SWEEP + k / 8 * 2 * SWEEP, 2, k >= 7 ? RED : CREAM);
        L.needle(cv, cx, cy, 30, r * 0.16, r * 0.88, 3, 1, NEEDLE);
        cv.circle(cx, cy, 5, '#2a2825');
    },

    badgeLetter: CREAM,

    /** Where the Spotify panel goes (setting "panel"): the accelerometer dial's place, right of the tach. */
    panelRect(S) {
        const ex = Math.max(0, S.h - 456), ay = S.y + 246 + Math.round(ex * 0.36), ar = Math.round(170 + ex * 0.36);
        const x = S.x + 1108, y = Math.max(S.y, ay - ar - 6);
        return { x: x, y: y, w: S.x + S.w - x, h: S.y + S.h - y };
    },

    draw(cv, S) {
        // laid out for a 456 px box; a taller one (full screen): bigger dials
        const x0 = S.x, y0 = S.y, ex = Math.max(0, S.h - 456);
        const tr = Math.round(206 + ex * 0.42), sr = Math.round(170 + ex * 0.36);
        const T = { x: x0 + 788, y: y0 + 226 + Math.round(ex * 0.42), r: tr }, V = { x: x0 + 318 - Math.round(ex * 0.3), y: y0 + 246 + Math.round(ex * 0.36), r: sr },
            A = { x: x0 + 1258 + Math.round(ex * 0.3), y: y0 + 246 + Math.round(ex * 0.36), r: sr };
        const max = S.maxRpm, smax = S.speedMax;

        // tachometer
        cv.blit(G.layer(['gs-h-tach', T.r, max, S.shift].join('|'), 2 * T.r + 40, 2 * T.r + 40, (c) => {
            const x = T.r + 20, y = T.r + 20;
            dialFace(c, x, y, T.r);
            scale(c, x, y, T.r, max, 250, 1000, 1000, S.shift, 34);
            c.text('RPM × 1000', x, y - T.r * 0.36, 15, DIMC, { align: 'center', font: TXT, spacing: 3, literal: true });
            // gear window
            c.roundRect(x - 38, y + T.r * 0.44 - 34, 76, 70, 6, '#1d1b18');
            c.roundRect(x - 33, y + T.r * 0.44 - 29, 66, 60, 4, '#050505');
        }, cv.textScale), T.x - T.r - 20, T.y - T.r - 20);
        cv.text(S.gearText, T.x, T.y + T.r * 0.44 + 22, 54, CREAM, { align: 'center', font: BIG, literal: true });
        // shift lamp at 12 o'clock
        const L5 = L.lights(S, 5, NEEDLE), lit = L5.part.filter((p) => p > 0.5).length;
        const lc = S.strobe ? (L5.flash || '#2a0b06') : lit >= 4 ? '#ffae1a' : '#1d1b18';
        cv.circle(T.x, T.y - T.r * 0.6, 12, '#000000');
        cv.circle(T.x, T.y - T.r * 0.6, 10, lc);
        if (S.mode) {
            // the drive mode in the tach's lower face (no ticks there): cream, orange for SPORT / SPORT+
            const hot = S.modeTone === 'sport' || S.modeTone === 'sport+' || S.modeTone === 'track';
            const my = T.y + T.r * 0.44 + 36 + Math.max(26, T.r * 0.16);
            cv.text(S.mode, T.x, my, 17, hot ? NEEDLE : CREAM, { align: 'center', font: TXT, spacing: 4, literal: true });
            cv.fillRect(T.x - 22, my + 8, 44, 1.5, withAlpha(hot ? NEEDLE : DIMC, 0.7));
        }
        hand(cv, T.x, T.y, T.r, angle(G.smooth('gs-h-rpm', S.rpm, 12), max));

        // speedometer, with the speed also as a small counter
        const step = smax > 200 ? 20 : 10;
        cv.blit(G.layer(['gs-h-spd', V.r, smax].join('|'), 2 * V.r + 40, 2 * V.r + 40, (c) => {
            const x = V.r + 20, y = V.r + 20;
            dialFace(c, x, y, V.r);
            scale(c, x, y, V.r, smax, step / 2, step * 2, 1, null, 24);
            c.roundRect(x - 52, y + V.r * 0.42 - 26, 104, 44, 4, '#050505');
        }, cv.textScale), V.x - V.r - 20, V.y - V.r - 20);
        cv.text(S.unit, V.x, V.y - V.r * 0.34, 15, DIMC, { align: 'center', font: TXT, spacing: 3, literal: true });
        cv.text(isNum(S.speed) ? String(Math.round(S.speed)) : '--', V.x, V.y + V.r * 0.42 + 9, 32, CREAM, { align: 'center', font: NUM, literal: true });
        hand(cv, V.x, V.y, V.r, angle(G.smooth('gs-h-spd', S.speed, 12), smax));

        // accelerometer: a friction circle on a dial face (or the Spotify panel there)
        if (S.panel !== 'spotify') this.accel(cv, S, A);

        // warm-up tell-tales between the dials, the badge in the corner
        if (S.bars === 'fuel') fuelGauge(cv, x0 + 522 - ex * 0.3, x0 + 1060 + ex * 0.3, S.y + S.h - 34, S.fuel);
        else {
            lamp(cv, x0 + 522 - ex * 0.3, S.y + S.h - 34, 'OIL', S.oil);
            lamp(cv, x0 + 980 + ex * 0.3, S.y + S.h - 34, 'WATER', S.cool);
        }
    },
    accel(cv, S, A) {
        cv.blit(G.layer(['gs-h-g', A.r, S.gMax].join('|'), 2 * A.r + 40, 2 * A.r + 40, (c) => {
            const x = A.r + 20, y = A.r + 20, R = A.r * 0.78;
            dialFace(c, x, y, A.r);
            for (let a = 0; a < 360; a += 10) L.tick(c, x, y, A.r * (a % 90 === 0 ? 0.86 : 0.91), A.r * 0.955, a, a % 90 === 0 ? 3 : 1.2, CREAM);
            for (let q = 0.5; q <= S.gMax + 1e-6; q += 0.5) c.arc(x, y, q / S.gMax * R - 0.6, q / S.gMax * R + 0.6, 0, 360, withAlpha(CREAM, q % 1 === 0 ? 0.28 : 0.14));
            c.line(x - R, y, x + R, y, 1, withAlpha(CREAM, 0.18)); c.line(x, y - R, x, y + R, 1, withAlpha(CREAM, 0.18));
            c.text('G', x - R * 0.48, y - R * 0.48, 22, DIMC, { align: 'center', font: TXT, literal: true });
        }, cv.textScale), A.x - A.r - 20, A.y - A.r - 20);
        const R = A.r * 0.78, P = (la, lo) => [A.x + clamp(la / S.gMax, -1.05, 1.05) * R, A.y - clamp(lo / S.gMax, -1.05, 1.05) * R];
        S.trail.forEach((p, i) => { if (isNum(p[0]) && isNum(p[1])) { const q = P(p[0], p[1]); cv.circle(q[0], q[1], 2.5, withAlpha(NEEDLE, 0.1 + 0.4 * i / S.trail.length)); } });
        const la = G.smooth('gs-h-la', S.gLat, 12), lo = G.smooth('gs-h-lo', S.gLong, 12);
        if (isNum(la) && isNum(lo)) { const q = P(la, lo); cv.circle(q[0], q[1], 9, '#000000'); cv.circle(q[0], q[1], 7, NEEDLE); }
        [['ACC', S.peak.acc], ['BRK', S.peak.brk], ['LAT', S.peak.lat]].forEach((p, i) => {
            const x = A.x + (i - 1) * 64;
            cv.text(p[0], x, A.y + A.r * 0.5, 11, DIMC, { align: 'center', font: TXT, spacing: 2, literal: true });
            cv.text(p[1].toFixed(2), x, A.y + A.r * 0.5 + 21, 17, CREAM, { align: 'center', font: NUM, literal: true });
        });
    },
};
