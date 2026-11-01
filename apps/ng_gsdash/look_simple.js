'use strict';
/**
 * Simple - G's Dash's original look (0.2): the kit's gauges in the "Colours" theme's M Tricolour.
 * rpm dial, speed over a big gear, friction circle, warm-up chips.
 */
const G = require('./kit/gauges');
const themes = require('./kit/themes');
const L = require('./lib');

const { withAlpha, isNum } = L;
const READY = '#2fd27a', NOT_READY = '#ff2a2a';

/** Small warm-up chip: dot, label, temperature in F. measure: only return its width. */
function chip(cv, t, x, y, label, f, state, measure) {
    const color = state === true ? READY : state === false ? NOT_READY : t.dim;
    const v = isNum(f) ? String(Math.round(f)) : '--';
    const lw = cv.textWidth(label, 16, { font: 'bold', spacing: 1.5 });
    const vw = cv.textWidth(v, 22, { font: 'num', literal: true }), uw = cv.textWidth('°F', 14, { literal: true });
    const w = 12 + 12 + 8 + lw + 8 + vw + 2 + uw + 12, h = 30;
    if (measure) return w;
    cv.roundRect(x, y, w, h, 15, withAlpha(color, state == null ? 0.08 : 0.14));
    cv.circle(x + 18, y + h / 2, 6, color);
    cv.text(label, x + 32, y + 21, 16, t.dim, { font: 'bold', spacing: 1.5 });
    const vx = x + 32 + lw + 8;
    cv.text(v, vx, y + 23, 22, state == null ? t.dim : t.text, { font: 'num', literal: true });
    cv.text('°F', vx + vw + 2, y + 22, 14, t.dim, { literal: true });
    return w;
}

/** The fuel level as one chip (the Bottom bars: Fuel choice): dot, FUEL, a small bar, %, range. Centred on cx. */
function fuelChip(cv, t, cx, y, F) {
    const ft = L.fuelText(F), color = !ft.has ? t.dim : ft.low ? NOT_READY : READY, bw = 120, h = 30;
    const lw = cv.textWidth('FUEL', 16, { font: 'bold', spacing: 1.5 }), vw = cv.textWidth(ft.value, 22, { font: 'num', literal: true });
    const rw = ft.range ? cv.textWidth(ft.range, 16, { font: 'bold', spacing: 1, literal: true }) + 14 : 0;
    const w = 32 + lw + 12 + bw + 12 + vw + rw + 14, x = Math.round(cx - w / 2);
    cv.roundRect(x, y, w, h, 15, withAlpha(color, ft.has ? 0.14 : 0.08));
    cv.circle(x + 18, y + h / 2, 6, color);
    cv.text('FUEL', x + 32, y + 21, 16, t.dim, { font: 'bold', spacing: 1.5 });
    const bx = x + 32 + lw + 12;
    cv.roundRect(bx, y + 11, bw, 8, 4, withAlpha('#ffffff', 0.12));
    if (ft.f) cv.roundRect(bx, y + 11, Math.max(8, bw * ft.f), 8, 4, color);
    cv.text(ft.value, bx + bw + 12, y + 23, 22, ft.has ? t.text : t.dim, { font: 'num', literal: true });
    if (ft.range) cv.text(ft.range, bx + bw + 12 + vw + 14, y + 21, 16, t.dim, { font: 'bold', spacing: 1, literal: true });
}

const DIAL_X = 330, CHIP_GAP = 12;
const FILL_YELLOW = '#ffc21a';   // the shift lights' own yellow (G.shiftLights): the gear while they fill

/** The drive mode as a chip like the warm-up ones (dot + label), centred on x. */
const MODE_DOT = { 'sport+': '#ff2a2a', sport: '#ff8a1a', eco: '#2fb8ff', track: '#ff2a2a', plain: '#c9ced6' };
function modeChip(cv, t, cx, y, S) {
    if (!S.mode) return;
    const c = MODE_DOT[S.modeTone] || t.dim, hot = S.modeTone === 'sport' || S.modeTone === 'sport+' || S.modeTone === 'track';
    const lw = cv.textWidth(S.mode, 18, { font: 'bold', spacing: 1.5, literal: true }), w = 12 + 12 + 10 + lw + 14, h = 30, x = Math.round(cx - w / 2);
    cv.roundRect(x, y, w, h, 15, withAlpha(c, hot ? 0.2 : 0.1));
    cv.circle(x + 18, y + h / 2, 6, c);
    cv.text(S.mode, x + 34, y + 22, 18, hot ? c : t.text, { font: 'bold', spacing: 1.5, literal: true });
}

module.exports = {
    id: 'simple',
    name: 'Simple',
    blurb: 'The original: clean dials in M Tricolour',
    // M Tricolour, fixed since 0.6.0 (the "Simple look colours" setting went)
    palette: themes.theme('m_tricolour'),
    ui: { txt: 'bold', num: 'num', size: 20, spacing: 1.5, upper: true, radius: 12 },

    /** The settings gallery card's picture. */
    swatch(cv, t, x, y, w, h) {
        const cx = x + w / 2, cy = y + h * 0.62, r = h * 0.38;
        cv.arc(cx, cy, r - 6, r, -135, 135, t.track, { round: true });
        cv.arc(cx, cy, r - 6, r, -135, 60, t.accent, { round: true, ramp: t.hotRamp, rampFrom: -135, rampTo: 135 });
        cv.text('4', cx, cy + 18, 52, t.text, { align: 'center', font: 'gear', literal: true });
    },

    /** Where the Spotify panel goes (setting "panel"): the g-meter and the peaks, below the shift lights. */
    panelRect(S) {
        const dy = S.y + 10 - 62, ex = Math.max(0, S.h - 456), y = Math.round(62 + dy + ex * 0.15 + 30 + 24);
        return { x: 1000, y: y, w: S.x + S.w - 1000, h: S.y + S.h - y };
    },

    draw(cv, S) {
        // laid out for a 456 px box; a taller one (full screen) gives the dial, gear and g-meter the room
        const t = S.t, dy = S.y + 10 - 62, ex = Math.max(0, S.h - 456), my = dy + ex * 0.5;
        const strobe = G.shiftLights(cv, t, 120, 62 + dy + ex * 0.15, 1360, 30,
            { rpm: S.rpm, shift: S.shift, range: S.range, n: 14, style: S.lightStyle, blink: S.blink });
        // the dial: about 28 px clear of the shift lights above and the warm-up chips below
        G.radial(cv, t, DIAL_X, 300 + my - ex * 0.15, 180 + ex * 0.2, {
            value: S.rpm, min: 0, max: S.maxRpm, ticks: S.maxRpm / 500, majorEvery: 2, tickDiv: 1000,
            label: 'RPM x1000', peak: S.peak.rpm, showPeak: false, limit: S.shift,
            zones: [{ from: S.shift, to: S.maxRpm, color: 'crit' }],
        });
        G.readout(cv, t, 800, 110 + my - ex * 0.2, { align: 'center', label: S.unit, value: S.speed, size: 84 + ex * 0.15 });
        // the gear: the theme's text colour (white) with no shift light lit; the lights' yellow while the
        // lights fill (the first one lights above shift - range, as in G.shiftLights); solid red while they flash
        const filling = !strobe && L.isNum(S.rpm) && S.rpm > S.shift - (S.range || 2000);
        G.gear(cv, t, 800, 452 + my + ex * 0.25, { gear: S.gear, stage: S.stage, size: 270 + ex * 0.5, guessed: S.guessed,
            color: strobe ? 'crit' : filling ? FILL_YELLOW : undefined });
        if (S.panel !== 'spotify') G.gmeter(cv, t, 1250, 290 + my - ex * 0.1, 156 + ex * 0.3, { lat: S.gLat, long: S.gLong, max: S.gMax, trail: S.trail });
        if (S.panel !== 'spotify') [['ACC', S.peak.acc], ['BRK', S.peak.brk], ['LAT', S.peak.lat]].forEach((p, i) => {
            const y = 196 + my - ex * 0.1 + i * (72 + ex * 0.1);
            cv.text(p[0], 1576, y, 16, t.dim, { align: 'right', font: 'bold', spacing: 2 });
            cv.text(p[1].toFixed(2), 1576, y + 34, 30, t.accent2 || t.text, { align: 'right', font: 'num', literal: true });
        });
        const cy = S.y + S.h - 32;
        if (S.bars === 'fuel') fuelChip(cv, t, DIAL_X, cy, S.fuel);
        else {
            const w1 = chip(cv, t, 0, 0, 'OIL', S.oil.f, S.oil.ok, true), w2 = chip(cv, t, 0, 0, 'COOLANT', S.cool.f, S.cool.ok, true);
            const cx0 = Math.round(DIAL_X - (w1 + CHIP_GAP + w2) / 2);
            chip(cv, t, cx0, cy, 'OIL', S.oil.f, S.oil.ok);
            chip(cv, t, cx0 + w1 + CHIP_GAP, cy, 'COOLANT', S.cool.f, S.cool.ok);
        }
        modeChip(cv, t, 800, cy, S);            // in the chips' row, under the gear
    },
};
