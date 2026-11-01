'use strict';
/**
 * Digital '84 - an eighties digital dash: a vacuum-fluorescent display behind smoked glass.
 * Seven- and fourteen-segment numerals (DSEG, open font) with their unlit segments faintly
 * visible, a bar-graph tachometer that sweeps up and to the right, a dot-matrix g plot, segment
 * bar graphs for oil and coolant. Aqua, with amber and red where it matters.
 */
const G = require('./kit/gauges');
const L = require('./lib');

const { withAlpha, clamp, isNum } = L;
const SEG = 'gs_d_seg', TXT = 'gs_d_txt';
const VFD = '#41f2cf', AMB = '#ffa63a', RED = '#ff4130';
const GHOST = withAlpha(VFD, 0.07), DIMV = withAlpha(VFD, 0.42);

const palette = Object.assign({}, require('./kit/themes').theme('m_tricolour'), {
    name: "Digital '84",
    bg: '#010303', panelTop: '#071010', panelBottom: '#020505', panelEdge: '#0f2a26',
    track: '#0a1a18', tick: '#174a42', text: VFD, dim: DIMV,
    accent: VFD, accent2: AMB, ok: VFD, warn: AMB, crit: RED, cold: '#5aa8ff',
    stripes: [VFD], sel: VFD, selText: '#010303', marker: AMB,
});

/** Segment text with its unlit segments behind it (ghost = the same count of '8's / '~'s). */
function seg(cv, s, x, y, size, c, font, align, ghostCh) {
    const g = new Array(s.length + 1).join(ghostCh || '8');
    cv.text(g, x, y, size, GHOST, { font: font || SEG, align: align || 'right', literal: true });
    cv.text(s, x, y, size, c, { font: font || SEG, align: align || 'right', literal: true });
}
const pad = (s, n) => (new Array(n + 1).join('!') + s).slice(-n);   // '!' is a blank in DSEG

function bargraph(cv, S, x, base, w, k) {
    const n = Math.round(S.maxRpm / 100), gap = 5, bw = (w - gap * (n - 1)) / n;
    const lo = S.shift - S.range;   // a VFD has three colours: the shift band is amber, past the shift point red
    for (let i = 0; i < n; i++) {
        const r0 = i * 100, f = i / (n - 1), h = (18 + 112 * Math.pow(f, 1.6)) * (k || 1), bx = x + i * (bw + gap);
        let c = GHOST;
        if (isNum(S.rpm) && S.rpm > r0) {
            c = r0 >= S.shift ? RED : r0 >= lo ? AMB : VFD;
            if (S.strobe) c = S.blink ? RED : withAlpha(RED, 0.25);
        } else if (r0 >= S.redline) c = withAlpha(RED, 0.12);
        cv.fillRect(bx, base - h, bw, h, c);
    }
    for (let k = 0; k * 1000 <= S.maxRpm; k++) {
        const bx = x + Math.min(n - 1, k * 10) * (bw + gap) + bw / 2;
        cv.text(String(k), bx, base + 30, 20, k * 1000 >= S.redline ? RED : DIMV, { align: 'center', font: TXT, literal: true });
    }
}

/** 13 x 13 dot matrix: the g vector lit, its last seconds fading. */
function dots(cv, S, cx, cy, step) {
    const n = 13, h = (n - 1) / 2, max = S.gMax;
    const cell = (lat, lon) => [clamp(Math.round(lat / max * h), -h, h), clamp(Math.round(-lon / max * h), -h, h)];
    const lit = {};
    S.trail.forEach((p, i) => { if (isNum(p[0]) && isNum(p[1])) { const c = cell(p[0], p[1]); lit[c[0] + ',' + c[1]] = Math.max(lit[c[0] + ',' + c[1]] || 0, 0.15 + 0.5 * i / S.trail.length); } });
    const now = isNum(S.gLat) && isNum(S.gLong) ? cell(S.gLat, S.gLong) : null;
    for (let j = -h; j <= h; j++) {
        for (let i = -h; i <= h; i++) {
            const x = cx + i * step, y = cy + j * step, k = i + ',' + j;
            const axis = i === 0 || j === 0, ring = Math.abs(Math.hypot(i, j) - h) < 0.5;
            let c = axis || ring ? withAlpha(VFD, 0.16) : GHOST;
            if (lit[k]) c = withAlpha(VFD, lit[k]);
            if (now && now[0] === i && now[1] === j) c = VFD;
            cv.roundRect(x - 6, y - 6, 12, 12, 2, c);
        }
    }
}

function fluid(cv, x, y, w, label, v) {
    const n = 20, gap = 4, bw = (w - gap * (n - 1)) / n;
    const f = isNum(v.f) ? clamp((v.f - 60) / Math.max(1, v.thr + 40 - 60), 0, 1) : 0, at = (v.thr - 60) / Math.max(1, v.thr + 40 - 60);
    cv.text(label, x, y - 16, 20, DIMV, { font: TXT, literal: true });
    seg(cv, isNum(v.f) ? pad(String(Math.round(v.f)), 3) : '!--', x + w, y - 12, 38, v.ok === false ? AMB : VFD);
    for (let i = 0; i < n; i++) {
        const on = isNum(v.f) && (i + 0.5) / n <= f;
        cv.fillRect(x + i * (bw + gap), y, bw, 18, on ? ((i + 0.5) / n < at ? AMB : VFD) : GHOST);
    }
}

module.exports = {
    id: 'digital',
    name: "Digital '84",
    blurb: 'Eighties VFD: segment numerals, bar-graph tach, dot-matrix g',
    palette,
    ui: { txt: TXT, lbl: 'gs_gt_txt', num: SEG, size: 18, spacing: 0, upper: true, radius: 0, nameFont: TXT, nameSize: 22 },

    background(cv, t, reach) {
        cv.gradientRect(0, 0, 1600, reach, [[0, '#030807'], [0.5, '#010303'], [1, '#020404']]);
    },
    card(cv, t, x, y, w, h) {
        cv.fillRect(x, y, w, h, '#041010');
        cv.strokeRoundRect(x, y, w, h, 0, 1.5, withAlpha(VFD, 0.18));
    },
    cardBg(cv, t, x, y, w, h) { cv.fillRect(x, y, w, h, '#010303'); },

    swatch(cv, t, x, y, w, h) {
        // the segmented rev bar alone (no digits), a little wider and taller, centred in the picture
        const n = 24, gap = 4, side = 18, bw = (w - 2 * side - gap * (n - 1)) / n, top = 10, tall = 74;
        const base = Math.round(y + (h + tall) / 2);
        for (let i = 0; i < n; i++) {
            const f = i / (n - 1), hh = top + (tall - top) * Math.pow(f, 1.6);
            cv.fillRect(x + side + i * (bw + gap), base - hh, bw, hh, i < 16 ? VFD : i < 20 ? AMB : withAlpha(RED, 0.15));
        }
    },

    /** Where the Spotify panel goes (setting "panel"): the dot-matrix g and the peaks, above the rpm digits. */
    panelRect(S) {
        const ex = Math.max(0, S.h - 456), y0 = S.y + Math.round(ex * 0.1), y = Math.round(y0 + 182 + ex * 0.25), x = S.x + 948;
        return { x: x, y: y, w: S.x + S.w - x, h: S.y + S.h - 28 - 52 - y };
    },

    draw(cv, S) {
        // laid out for a 456 px box; a taller one (full screen): taller bars, bigger digits
        const x0 = S.x, ex = Math.max(0, S.h - 456), y0 = S.y + Math.round(ex * 0.1), m = Math.round(ex * 0.6), sz = 150 + ex * 0.3;
        bargraph(cv, S, x0 + 40, y0 + 138 + ex * 0.25, 1496, 1 + ex / 456);

        if (S.mode) {
            // the drive mode in 14 segments (ghosts behind), amber for SPORT, red for SPORT+
            const c = { 'sport+': RED, track: RED, sport: AMB }[S.modeTone] || VFD;
            const txt = S.mode.replace(/ /g, '!');
            cv.text('MODE', x0 + 40, y0 + 22, 18, DIMV, { font: TXT, literal: true });
            seg(cv, txt, x0 + 40, y0 + 68, 34, c, TXT, 'left', '~');
        }
        // speed, gear
        const sy = y0 + 334 + m * 0.75;
        cv.text(S.unit, x0 + 574, sy, 22, DIMV, { font: TXT, literal: true });
        seg(cv, isNum(S.speed) ? pad(String(Math.round(S.speed)), 3) : '!--', x0 + 560, sy, sz, VFD);
        const gx = x0 + 830;
        cv.text('GEAR', gx + 16, sy, 22, DIMV, { font: TXT, literal: true });
        const gd = /^[0-9]$/.test(S.gearText);   // digits in 7 segments, N / R / P / D in 14
        seg(cv, S.gearText, gx, sy, sz, S.strobe && S.blink ? RED : AMB, gd ? SEG : TXT, 'right', gd ? '8' : '~');
        if (S.guessed) cv.text('EST', gx + 16, sy - 30, 22, DIMV, { font: TXT, literal: true });
        // the favourite looks' tap zones (main.js): the speed digits with their unit, the gear digit with its label
        const uw = cv.textWidth(S.unit, 22, { font: TXT, literal: true }), lw = cv.textWidth('GEAR', 22, { font: TXT, literal: true });
        const zt = Math.round(sy - sz * 0.8 - 12), zh = Math.round(sz * 0.8 + 24);
        S.zones = {
            speed: { x: x0 + 230, y: zt, w: 574 + uw + 10 - 230, h: zh }, gear: { x: gx - 130, y: zt, w: 130 + 16 + lw + 50, h: zh },
            toast: { x: x0 + 400, y: sy + 12 }, chip: { x: gx + 16 + lw + 22, y: sy - 8 }, star: { x: x0 + 574 + uw + 18, y: sy - 8 },
        };

        // dot-matrix g, peaks (or the Spotify panel there)
        if (S.panel !== 'spotify') this.gPart(cv, S, x0, y0, ex, m);
        this.bottom(cv, S, x0, y0, ex);
    },
    gPart(cv, S, x0, y0, ex, m) {
        const dy = y0 + 292 + m * 0.6, ds = 19, dx = x0 + 1100;
        dots(cv, S, dx, dy, ds);
        cv.text('G', dx - 6 * ds - 22, dy - 6 * ds + 14, 20, DIMV, { align: 'right', font: TXT, literal: true });
        [['ACC', S.peak.acc], ['BRK', S.peak.brk], ['LAT', S.peak.lat]].forEach((p, i) => {
            const y = y0 + 236 + m * 0.5 + i * (64 + ex * 0.15);
            cv.text(p[0], x0 + 1300, y - 30, 18, DIMV, { font: TXT, literal: true });
            seg(cv, p[1].toFixed(2), x0 + 1536, y + 10, 40, i === 1 ? AMB : VFD);
        });
    },
    bottom(cv, S, x0, y0, ex) {
        // rpm as digits, oil, coolant
        // (the bottom-right corner is the G's: rpm sits beside the fluids)
        const by = S.y + S.h - 28;
        fluid(cv, x0 + 40, by, 380, 'OIL F', S.oil); fluid(cv, x0 + 40 + 400 + 20, by, 380, 'H2O F', S.cool);
        cv.text('RPM', x0 + 900, by - 16, 20, DIMV, { font: TXT, literal: true });
        seg(cv, isNum(S.rpm) ? pad(String(Math.round(S.rpm / 10) * 10), 4) : '!---', x0 + 1210, by + 18, 44, S.strobe ? RED : VFD);
        cv.fillRect(x0 + 40, y0 + 168 + ex * 0.25, 1496, 1, withAlpha(VFD, 0.12));
    },
};
