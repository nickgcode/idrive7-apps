'use strict';
/**
 * Flight - a glass cockpit's primary flight display: a speed tape, an attitude indicator whose
 * horizon banks with lateral g and pitches with acceleration and braking, an rpm tape with a
 * barber pole at the redline, annunciators across the top and EICAS-style temperature dials.
 * B612 (open font, designed for aircraft cockpit displays).
 */
const G = require('./kit/gauges');
const L = require('./lib');

const { withAlpha, clamp, isNum } = L;
const TXT = 'gs_f_txt', NUM = 'gs_f_num';
const GRN = '#3ee07a', MAG = '#ff5ad9', CYN = '#45d4ff', AMB = '#ffb21a', WHT = '#ffffff', GRY = '#8f979f';
const SKY = '#2163b0', GND = '#6c431d', TAPE = '#262b31';

const palette = Object.assign({}, require('./kit/themes').theme('m_tricolour'), {
    name: 'Flight',
    bg: '#000000', panelTop: '#101317', panelBottom: '#000000', panelEdge: '#3a4048',
    track: '#1b1f24', tick: '#59616a', text: WHT, dim: GRY,
    accent: GRN, accent2: CYN, ok: GRN, warn: AMB, crit: '#ff3b30', cold: CYN,
    stripes: [CYN], sel: CYN, selText: '#000000', marker: MAG,
});

/** Liang-Barsky: the part of segment a-b inside the rect, or null. */
function clipSeg(a, b, x, y, w, h) {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy], q = [a[0] - x, x + w - a[0], a[1] - y, y + h - a[1]];
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return null; continue; }
        const r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

/** A vertical tape: value v at its middle, `ppu` px per unit, ticks every `minor`, labels every `major`. */
function tape(cv, x, y, w, h, v, ppu, minor, major, fmt, side, bands) {
    cv.fillRect(x, y, w, h, TAPE);
    const mid = y + h / 2, span = h / 2 / ppu, vv = isNum(v) ? v : 0;
    (bands || []).forEach((b) => {
        const ya = clamp(mid - (b.to - vv) * ppu, y, y + h), yb = clamp(mid - (b.from - vv) * ppu, y, y + h);
        if (yb <= ya) return;
        const bx = side === 'right' ? x + w - 10 : x;
        if (b.pole) {
            for (let s = Math.floor((ya - y) / 14) * 14 + y; s < yb; s += 14) {
                const s0 = Math.max(s, ya), s1 = Math.min(s + 7, yb);
                if (s1 > s0) cv.fillRect(bx, s0, 10, s1 - s0, '#ff3b30');
                const s2 = Math.max(s + 7, ya), s3 = Math.min(s + 14, yb);
                if (s3 > s2) cv.fillRect(bx, s2, 10, s3 - s2, WHT);
            }
        } else cv.fillRect(bx, ya, 10, yb - ya, b.color);
    });
    const lo = Math.ceil((vv - span) / minor) * minor;
    for (let k = lo; k <= vv + span; k += minor) {
        if (k < 0) continue;
        const ty = mid - (k - vv) * ppu, isMaj = Math.abs(k / major - Math.round(k / major)) < 1e-6;
        if (ty < y + 2 || ty > y + h - 2) continue;
        const len = isMaj ? 20 : 12;
        if (side === 'right') cv.fillRect(x + w - 10 - len, ty - 1, len, 2, WHT); else cv.fillRect(x + w - len, ty - 1, len, 2, WHT);
        if (isMaj && ty > y + 16 && ty < y + h - 8) cv.text(fmt(k), side === 'right' ? x + 12 : x + w - 28, ty + 8, 22, WHT, { align: side === 'right' ? 'left' : 'right', font: NUM, literal: true });
    }
}

/** The readout box on a tape: black, white border, pointing at the tape (dir +1 right, -1 left). */
function readout(cv, x, y, w, h, text, dir, col) {
    const tip = 14, ax = dir > 0 ? x + w : x;
    cv.fillRect(x, y, w, h, '#000000');
    cv.quad([[ax, y + h / 2 - tip], [ax + dir * tip, y + h / 2], [ax + dir * tip, y + h / 2], [ax, y + h / 2 + tip]], '#000000');
    cv.strokeRoundRect(x, y, w, h, 0, 2, WHT);
    cv.line(ax, y + h / 2 - tip, ax + dir * tip, y + h / 2, 2, WHT);
    cv.line(ax + dir * tip, y + h / 2, ax, y + h / 2 + tip, 2, WHT);
    cv.fillRect(ax - (dir > 0 ? 2 : 0), y + h / 2 - tip + 2, 2, 2 * tip - 4, '#000000');
    cv.text(text, x + w / 2, y + h / 2 + 15, 40, col || WHT, { align: 'center', font: NUM, literal: true });
}

function adi(cv, S, cx, cy, s) {
    const x = cx - s / 2, y = cy - s / 2, PPG = 110;
    const bank = clamp(G.smooth('gs-f-bank', isNum(S.gLat) ? S.gLat * 32 : 0, 8), -60, 60);
    const off = clamp(G.smooth('gs-f-pitch', isNum(S.gLong) ? S.gLong * PPG : 0, 8), -s * 0.45, s * 0.45);
    const nx = -Math.sin(bank * L.RAD), ny = Math.cos(bank * L.RAD), dx = Math.cos(bank * L.RAD), dy = Math.sin(bank * L.RAD);
    const hx = cx + nx * off, hy = cy + ny * off;
    cv.fillRect(x, y, s, s, SKY);
    L.halfSquare(cv, x, y, s, s, hx, hy, bank, GND);
    const hl = clipSeg([hx - dx * s, hy - dy * s], [hx + dx * s, hy + dy * s], x, y, s, s);
    if (hl) cv.line(hl[0][0], hl[0][1], hl[1][0], hl[1][1], 2.5, WHT);
    // pitch ladder (0.25 g steps; numbered every 0.5)
    for (let k = -1; k <= 1.001; k += 0.25) {
        if (Math.abs(k) < 0.01) continue;
        const px = hx - nx * k * PPG, py = hy - ny * k * PPG;
        if (Math.hypot(px - cx, py - cy) > s * 0.36) continue;
        const half = Math.abs(k * 2 - Math.round(k * 2)) < 0.01 ? 50 : 24;
        cv.line(px - dx * half, py - dy * half, px + dx * half, py + dy * half, 2, WHT);
        if (half === 50) {
            cv.text(Math.abs(k).toFixed(1), px - dx * (half + 28), py - dy * (half + 28) + 7, 18, WHT, { align: 'center', font: TXT, literal: true });
            cv.text(Math.abs(k).toFixed(1), px + dx * (half + 28), py + dy * (half + 28) + 7, 18, WHT, { align: 'center', font: TXT, literal: true });
        }
    }
    // bank scale: fixed ticks, the pointer turns with the horizon
    const R = s * 0.44;
    [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60].forEach((a) => L.tick(cv, cx, cy, R, R + (Math.abs(a) % 30 === 0 ? 18 : 10), a, 2, WHT));
    cv.quad([[cx - 10, cy - R - 16], [cx + 10, cy - R - 16], [cx, cy - R - 2], [cx, cy - R - 2]], WHT);
    const p0 = L.pt(cx, cy, R - 2, bank), pl = L.pt(cx, cy, R - 18, bank - 3.2), pr = L.pt(cx, cy, R - 18, bank + 3.2);
    cv.quad([p0, pr, pl, pl], WHT);
    // the car: the fixed symbol
    const wing = (sx) => {
        cv.fillRect(cx + sx * 64 - (sx > 0 ? 0 : 74), cy - 5, 74, 10, '#000000');
        cv.fillRect(cx + sx * 64 + (sx > 0 ? 0 : -10), cy - 5, 10, 30, '#000000');
        cv.strokeRoundRect(cx + sx * 64 - (sx > 0 ? 0 : 74), cy - 5, 74, 10, 0, 2, '#ffd21a');
        cv.strokeRoundRect(cx + sx * 64 + (sx > 0 ? 0 : -10), cy - 5, 10, 30, 0, 2, '#ffd21a');
    };
    wing(-1); wing(1);
    cv.fillRect(cx - 6, cy - 6, 12, 12, '#000000'); cv.strokeRoundRect(cx - 6, cy - 6, 12, 12, 0, 2, '#ffd21a');
    cv.strokeRoundRect(x, y, s, s, 0, 2, '#000000');
}

/** An EICAS-style dial: a 210 degree arc, a filled sector to the value, a boxed readout. */
function eicas(cv, cx, cy, r, v, lo, hi, label) {
    const a0 = -120, a1 = 90, f = isNum(v.f) ? clamp((v.f - lo) / (hi - lo), 0, 1) : 0, a = a0 + f * (a1 - a0);
    const at = a0 + clamp((v.thr - lo) / (hi - lo), 0, 1) * (a1 - a0);
    if (isNum(v.f)) cv.arc(cx, cy, 0, r - 4, a0, a, withAlpha(WHT, 0.16));
    cv.arc(cx, cy, r - 3, r, a0, at, AMB);
    cv.arc(cx, cy, r - 3, r, at, a1, WHT);
    L.tick(cv, cx, cy, r - 12, r + 2, at, 3, GRN);
    if (isNum(v.f)) { const p = L.pt(cx, cy, r - 6, a); cv.line(cx, cy, p[0], p[1], 3, WHT); }
    const col = v.ok === true ? GRN : v.ok === false ? AMB : GRY;
    cv.fillRect(cx + 6, cy - r + 6, 92, 40, '#000000');
    cv.strokeRoundRect(cx + 6, cy - r + 6, 92, 40, 0, 2, withAlpha(WHT, 0.9));
    cv.text(isNum(v.f) ? String(Math.round(v.f)) : '--', cx + 90, cy - r + 38, 30, col, { align: 'right', font: NUM, literal: true });
    cv.text(label, cx, cy + r * 0.62, 18, CYN, { align: 'center', font: TXT, spacing: 1, literal: true });
}

/** The fuel level as an EICAS dial (Bottom bars: Fuel): 0-100 %, amber below the low mark, the box amber when low. */
function eicasFuel(cv, cx, cy, r, F) {
    const ft = L.fuelText(F), a0 = -120, a1 = 90, a = a0 + (ft.f || 0) * (a1 - a0), at = a0 + 0.15 * (a1 - a0);
    if (ft.f !== null) cv.arc(cx, cy, 0, r - 4, a0, a, withAlpha(ft.low ? AMB : WHT, 0.16));
    cv.arc(cx, cy, r - 3, r, a0, at, AMB);
    cv.arc(cx, cy, r - 3, r, at, a1, WHT);
    if (ft.f !== null) { const p = L.pt(cx, cy, r - 6, a); cv.line(cx, cy, p[0], p[1], 3, WHT); }
    const col = !ft.has ? GRY : ft.low ? AMB : GRN;
    cv.fillRect(cx + 6, cy - r + 6, 92, 40, '#000000');
    cv.strokeRoundRect(cx + 6, cy - r + 6, 92, 40, 0, 2, ft.low && ft.has ? AMB : withAlpha(WHT, 0.9));
    cv.text(ft.f !== null ? String(Math.round(ft.f * 100)) : '--', cx + 90, cy - r + 38, 30, col, { align: 'right', font: NUM, literal: true });
    cv.text('FUEL %', cx, cy + r * 0.62, 18, CYN, { align: 'center', font: TXT, spacing: 1, literal: true });
}
/** The range as a boxed readout beside the fuel dial. */
function rangeBox(cv, cx, cy, r, F) {
    const ft = L.fuelText(F), v = ft.range ? ft.range.replace(' MI', '') : '--';
    cv.fillRect(cx - 70, cy - 34, 140, 52, '#000000');
    cv.strokeRoundRect(cx - 70, cy - 34, 140, 52, 0, 2, withAlpha(WHT, 0.9));
    cv.text(v, cx + 60, cy + 8, 36, ft.range ? GRN : GRY, { align: 'right', font: NUM, literal: true });
    cv.text('RANGE MI', cx, cy + r * 0.62, 18, CYN, { align: 'center', font: TXT, spacing: 1, literal: true });
    if (ft.low && ft.has) cv.text('FUEL LOW', cx, cy - 48, 18, AMB, { align: 'center', font: TXT, spacing: 1, literal: true });
}

function fma(cv, S, x, y, w) {
    const cols = 4, cw = w / cols, h = 40;
    const oil = S.oil.ok === false, h2o = S.cool.ok === false;
    const ft = S.bars === 'fuel' ? L.fuelText(S.fuel) : null;
    const cells = [
        S.strobe ? ['SHIFT', AMB, true] : ['GEAR ' + S.gearText, GRN],
        ft ? (ft.low && ft.has ? ['FUEL LOW', AMB] : ['FUEL ' + ft.value, ft.has ? GRN : GRY])
            : oil ? ['OIL COLD', AMB] : ['OIL ' + (S.oil.ok ? 'NORM' : '--'), S.oil.ok ? GRN : GRY],
        ft ? ['RNG ' + (ft.range || '--'), ft.range ? GRN : GRY]
            : h2o ? ['H2O COLD', AMB] : ['H2O ' + (S.cool.ok ? 'NORM' : '--'), S.cool.ok ? GRN : GRY],
        ['T+' + L.clock(S.session).slice(0, -2), CYN],
    ];
    cells.forEach((c, i) => {
        const cx = x + i * cw;
        if (i) cv.fillRect(cx, y + 4, 2, h - 8, '#4a5058');
        if (c[2] && S.blink) cv.strokeRoundRect(cx + 30, y + 3, cw - 60, h - 6, 0, 2, WHT);
        cv.text(c[0], cx + cw / 2, y + h / 2 + 8, 22, c[1], { align: 'center', font: TXT, spacing: 1, literal: true });
    });
    // a tap on the T+ cell (down to just above the tapes, a bigger target): the clock back to 0
    L.sessionTap(cv, S, x + 3 * cw + 2, y, cw - 2, h + 18, CYN);
}

module.exports = {
    id: 'flight',
    name: 'Flight',
    blurb: 'Glass cockpit: speed and rpm tapes, a horizon that banks with g',
    palette,
    ui: { txt: TXT, num: NUM, size: 20, spacing: 1, upper: true, radius: 0, nameFont: TXT, nameSize: 28 },
    card(cv, t, x, y, w, h) {
        cv.fillRect(x, y, w, h, '#0c0f12');
        cv.strokeRoundRect(x, y, w, h, 0, 1.5, '#3a4048');
    },
    cardBg(cv, t, x, y, w, h) { cv.fillRect(x, y, w, h, '#000000'); },

    swatch(cv, t, x, y, w, h) {
        const s = Math.min(w - 60, h - 10), cx = x + w / 2, cy = y + h / 2 + 4, a = 14;
        cv.fillRect(cx - s / 2, cy - s / 2, s, s, SKY);
        L.halfSquare(cv, cx - s / 2, cy - s / 2, s, s, cx, cy + 8, a, GND);
        const hl = clipSeg([cx - Math.cos(a * L.RAD) * s, cy + 8 - Math.sin(a * L.RAD) * s], [cx + Math.cos(a * L.RAD) * s, cy + 8 + Math.sin(a * L.RAD) * s], cx - s / 2, cy - s / 2, s, s);
        if (hl) cv.line(hl[0][0], hl[0][1], hl[1][0], hl[1][1], 2, WHT);
        cv.fillRect(cx - 40, cy - 3, 26, 6, '#ffd21a'); cv.fillRect(cx + 14, cy - 3, 26, 6, '#ffd21a'); cv.fillRect(cx - 3, cy - 3, 6, 6, '#ffd21a');
        cv.fillRect(cx - s / 2 - 44, cy - s / 2, 34, s, TAPE); cv.fillRect(cx + s / 2 + 10, cy - s / 2, 34, s, TAPE);
    },

    /** Where the Spotify panel goes (setting "panel"): the EICAS g / peaks rows, under the gear and temperatures. */
    panelRect(S) { const x = S.x + 940, y = S.y + 292; return { x: x, y: y, w: S.x + S.w - x, h: S.y + S.h - y }; },

    draw(cv, S) {
        // laid out for a 456 px box; a taller one (full screen): longer tapes, a bigger attitude indicator
        const x0 = S.x, y0 = S.y, k = Math.max(0, S.h - 456);
        fma(cv, S, x0 + 40, y0, 900);
        cv.fillRect(x0 + 40, y0 + 44, 900, 2, '#2a2f36');
        // speed tape | attitude | rpm tape
        const ty = y0 + 64, th = 356 + Math.round(k * 0.8), mid = ty + th / 2;
        tape(cv, x0 + 40, ty, 120, th, S.speed, 3.2, 5, 20, (k) => String(k), 'left',
            [{ from: S.peak.speed - 0.6, to: S.peak.speed + 0.6, color: MAG }]);
        readout(cv, x0 + 30, mid - 30, 110, 60, isNum(S.speed) ? String(Math.round(S.speed)) : '--', 1);
        cv.text(S.unit, x0 + 100, ty + th + 26, 18, CYN, { align: 'center', font: TXT, literal: true });

        adi(cv, S, x0 + 425, mid, th);

        const rx = x0 + 690;
        tape(cv, rx, ty, 130, th, isNum(S.rpm) ? S.rpm / 100 : 0, 3.2, 2, 10, (k) => String(k / 10), 'right',
            [{ from: (S.shift - S.range) / 100, to: S.shift / 100, color: AMB }, { from: S.redline / 100, to: 200, pole: true }]);
        readout(cv, rx + 10, mid - 30, 130, 60, isNum(S.rpm) ? String(Math.round(S.rpm / 10) * 10) : '----', -1, S.strobe ? AMB : WHT);
        cv.text('RPM', rx + 65, ty + th + 26, 18, CYN, { align: 'center', font: TXT, literal: true });

        // EICAS side: gear, temperatures, g
        const ex = x0 + 900;
        cv.fillRect(ex, y0 + 4, 2, S.h - 8, '#2a2f36');
        cv.text('GEAR', ex + 120, y0 + 70 + k * 0.2, 18, CYN, { align: 'center', font: TXT, literal: true });
        if (S.mode) {
            // the drive mode as an annunciator: green, magenta for SPORT / SPORT+, white-boxed
            const c = S.modeTone === 'sport' || S.modeTone === 'sport+' || S.modeTone === 'track' ? MAG : GRN;
            const mx = ex + 455, my = y0 + 6 + k * 0.05;
            cv.text('MODE', mx - 18, my + 28, 18, CYN, { align: 'right', font: TXT, literal: true });
            cv.strokeRoundRect(mx, my, 210, 38, 0, 2, withAlpha(WHT, 0.9));
            cv.text(S.mode, mx + 105, my + 28, 24, c, { align: 'center', font: TXT, spacing: 1, literal: true });
        }
        cv.strokeRoundRect(ex + 50, y0 + 84 + k * 0.2, 140, 150 + k * 0.2, 0, 2, withAlpha(WHT, 0.9));
        cv.text(S.gearText, ex + 120, y0 + 202 + k * 0.3, 110 + k * 0.2, S.strobe && S.blink ? AMB : GRN, { align: 'center', font: NUM, literal: true });
        if (S.guessed) cv.text('EST', ex + 120, y0 + 258 + k * 0.4, 16, GRY, { align: 'center', font: TXT, literal: true });
        if (S.bars === 'fuel') { eicasFuel(cv, ex + 345, y0 + 162, 86, S.fuel); rangeBox(cv, ex + 560, y0 + 162, 86, S.fuel); }
        else {
            eicas(cv, ex + 345, y0 + 162, 86, S.oil, 100, 280, 'OIL T °F');
            eicas(cv, ex + 560, y0 + 162, 86, S.cool, 100, 260, 'H2O T °F');
        }
        cv.fillRect(ex + 40, y0 + 278, 630, 2, '#2a2f36');
        const row = (y, items) => items.forEach((it, i) => {
            const x = ex + 50 + i * 215;
            cv.text(it[0], x, y, 18, CYN, { font: TXT, literal: true });
            cv.text(it[1], x + 190, y, 30, it[2] || WHT, { align: 'right', font: TXT, literal: true });
        });
        if (S.panel === 'spotify') return;
        const sg = (v) => (isNum(v) ? (v < 0 ? '-' : '+') + Math.abs(v).toFixed(2) : '--');
        row(y0 + 330, [['LAT G', sg(S.gLat), GRN], ['LONG G', sg(S.gLong), GRN], ['TOP', isNum(S.peak.speed) ? String(Math.round(S.peak.speed)) : '--', MAG]]);
        row(y0 + 382, [['MAX ACC', S.peak.acc.toFixed(2), MAG], ['MAX BRK', S.peak.brk.toFixed(2), MAG], ['MAX LAT', S.peak.lat.toFixed(2), MAG]]);
    },
};
