'use strict';
/**
 * Sim Racing - a sim-racing HUD (the iRacing / ACC / SimHub dash style): a full-width LED shift
 * strip in its housing across the top, a segmented rpm bar under it, a big boxed gear in the
 * middle, speed and coloured data blocks on the left, a centre-zero longitudinal g "delta" bar,
 * a friction circle with session bests in purple on the right. Titillium Web (open font, the
 * motorsport-timing typeface), white on near-black, saturated race colours.
 * Node 8: no ?., no ??, no object spread.
 */
const G = require('./kit/gauges');
const L = require('./lib');

const { withAlpha, clamp, isNum } = L;
const GEAR = 'gs_s_gear', NUM = 'gs_s_num', TXT = 'gs_s_txt';
const BG = '#060709', WHITE = '#f4f6f9', DIM = '#8b93a1', YEL = '#ffc21a', RED = '#ff2a2a', GRN = '#2fd27a',
    BLU = '#2a7dff', PUR = '#b45cff', CYAN = '#2fb8ff', OFF = '#15181d', EDGE = '#262b33';
const N_LED = 15;

const palette = Object.assign({}, require('./kit/themes').theme('m_tricolour'), {
    name: 'Sim Racing',
    bg: BG, panelTop: '#101217', panelBottom: '#0a0b0e', panelEdge: EDGE,
    track: '#1b1f26', tick: '#3a404a', text: WHITE, dim: DIM,
    accent: YEL, accent2: YEL, ok: GRN, warn: YEL, crit: RED, cold: BLU,
    sel: YEL, selText: BG, marker: RED, stripes: [GRN, YEL, RED],
});
const MODE_FILL = { 'sport+': RED, track: RED, sport: '#ff8a1a', eco: CYAN };

/** Geometry for a frame (also the Spotify panel's place). */
function geo(S) {
    const ex = Math.max(0, S.h - 456), bottom = S.y + S.h;
    const ledY = S.y + 2, ledH = 46 + Math.round(ex * 0.08);
    const barY = ledY + ledH + 12, barH = 30 + Math.round(ex * 0.06);
    const top = barY + barH + 34;          // under the 1000 rpm numbers
    return { ex, bottom, ledY, ledH, barY, barH, top, rx: 1112, cx: 796 };
}

/** The LED strip: housing, N round-ended LEDs with glow, colours from the "lights" setting. */
function leds(cv, S, x, y, w, h) {
    const st = L.lights(S, N_LED, YEL);
    cv.roundRect(x, y, w, h, 10, '#0b0d10');
    cv.strokeRoundRect(x, y, w, h, 10, 1.5, '#20242b');
    cv.fillRect(x + 14, y + 3, w - 28, 1, withAlpha('#ffffff', 0.06));
    const pad = 22, gap = 10, lw = (w - 2 * pad - gap * (N_LED - 1)) / N_LED, lh = h - 18, ly = y + 9;
    for (let i = 0; i < N_LED; i++) {
        const lx = x + pad + i * (lw + gap);
        let c = null, a = 0;
        if (st.strobe) { if (st.flash) { c = st.flash; a = 1; } }
        else if (st.part[i] > 0) { c = st.cols[i]; a = st.part[i]; }
        cv.roundRect(lx, ly, lw, lh, lh / 2, OFF);
        if (c) {
            cv.roundRect(lx - 5, ly - 5, lw + 10, lh + 10, (lh + 10) / 2, withAlpha(c, 0.22 * a));
            cv.roundRect(lx, ly, lw, lh, lh / 2, withAlpha(c, 0.35 + 0.65 * a));
            cv.roundRect(lx + 4, ly + 3, lw - 8, lh * 0.3, lh * 0.15, withAlpha('#ffffff', 0.28 * a));
        } else cv.roundRect(lx + 4, ly + 3, lw - 8, lh * 0.3, lh * 0.15, withAlpha('#ffffff', 0.03));
    }
    return st;
}

/** The segmented rpm bar: a segment per 250 rpm, white below the shift lights' range, yellow in it, red from the shift point. */
function rpmBar(cv, S, x, y, w, h) {
    const n = S.maxRpm / 250, gap = 4, sw = (w - gap * (n - 1)) / n, lo = S.shift - S.range;
    for (let i = 0; i < n; i++) {
        const r0 = i * 250, sx = x + i * (sw + gap), on = isNum(S.rpm) && S.rpm > r0;
        const hot = r0 >= S.shift ? RED : r0 >= lo ? YEL : WHITE;
        let c = r0 >= S.redline ? '#2a0c0e' : r0 >= S.shift ? '#24100f' : OFF;
        if (on) c = S.strobe && !S.blink ? withAlpha(hot, 0.45) : hot;
        cv.fillRect(sx, y, sw, h, c);
    }
    // redline marker: a red post through the bar
    const rx = x + (S.redline / 250) * (sw + gap) - gap / 2;
    cv.fillRect(rx - 2, y - 6, 4, h + 12, RED);
    for (let k = 0; k * 1000 <= S.maxRpm; k++) {
        const i = Math.min(n, k * 4), sx = x + i * (sw + gap) - (i ? gap / 2 : 0);
        cv.text(String(k), clamp(sx, x + 8, x + w - 8), y + h + 26, 22, k * 1000 >= S.redline ? RED : DIM, { align: 'center', font: NUM, literal: true });
    }
}

/** A data block: label (small, caps), value; tone: a coloured left bar and a tint. */
function block(cv, x, y, w, h, label, value, tone, size) {
    cv.fillRect(x, y, w, h, tone ? withAlpha(tone, 0.16) : '#0e1014');
    cv.fillRect(x, y, 5, h, tone || '#2a2f38');
    cv.text(label, x + 16, y + 22, 16, tone || DIM, { font: TXT, spacing: 2, literal: true });
    cv.text(value, x + w - 12, y + h - 12, size || 30, WHITE, { align: 'right', font: NUM, literal: true });
}
function tempBlock(cv, x, y, w, h, label, v) {
    const tone = v.ok === true ? GRN : v.ok === false ? BLU : null;
    block(cv, x, y, w, h, label + (v.ok === false ? '  COLD' : v.ok === true ? '  OK' : ''), isNum(v.f) ? Math.round(v.f) + '°F' : '--', tone);
}

/** Centre-zero bar for the longitudinal g: green to the right (accelerating), red to the left (braking). */
function deltaBar(cv, S, cx, y, w) {
    const h = 26, lon = G.smooth('gs-s-lon', S.gLong, 10), f = isNum(lon) ? clamp(lon / S.gMax, -1, 1) : 0;
    cv.fillRect(cx - w / 2, y, w, h, '#0e1014');
    cv.strokeRoundRect(cx - w / 2, y, w, h, 2, 1, EDGE);
    for (let k = 1; k < 4; k++) { cv.fillRect(cx + (w / 2) * k / 4, y + h - 6, 1, 6, '#3a404a'); cv.fillRect(cx - (w / 2) * k / 4, y + h - 6, 1, 6, '#3a404a'); }
    if (f > 0) cv.fillRect(cx, y + 3, (w / 2 - 3) * f, h - 6, GRN);
    if (f < 0) cv.fillRect(cx + (w / 2 - 3) * f, y + 3, -(w / 2 - 3) * f, h - 6, RED);
    cv.fillRect(cx - 1.5, y - 6, 3, h + 12, WHITE);
    cv.text('LONG G', cx - w / 2, y - 10, 16, DIM, { font: TXT, spacing: 2, literal: true });
    const txt = isNum(lon) ? (lon >= 0 ? '+' : '') + lon.toFixed(2) : '-.--';
    cv.text(txt, cx + w / 2, y - 8, 30, !isNum(lon) ? DIM : lon > 0.02 ? GRN : lon < -0.02 ? RED : WHITE, { align: 'right', font: NUM, literal: true });
}

/** Friction circle with the last seconds' trail. */
function circle(cv, S, cx, cy, r) {
    const max = S.gMax;
    cv.blit(G.layer(['gs-s-gm', Math.round(r), max].join('|'), 2 * r + 20, 2 * r + 20, (c) => {
        const x = r + 10, y = r + 10;
        c.circle(x, y, r, '#0c0e12');
        for (let q = 0.5; q <= max + 1e-6; q += 0.5) {
            const rr = q / max * r;
            c.arc(x, y, rr - 1, rr + 1, 0, 360, q % 1 === 0 ? '#323843' : '#1e232a');
        }
        c.line(x - r, y, x + r, y, 1, '#323843');
        c.line(x, y - r, x, y + r, 1, '#323843');
    }, cv.textScale), cx - r - 10, cy - r - 10);
    const P = (lat, lon) => [cx + clamp(lat / max, -1.05, 1.05) * r, cy - clamp(lon / max, -1.05, 1.05) * r];
    S.trail.forEach((p, i) => { if (isNum(p[0]) && isNum(p[1])) { const q = P(p[0], p[1]); cv.circle(q[0], q[1], 3.5, withAlpha(YEL, 0.08 + 0.5 * i / S.trail.length)); } });
    const lat = G.smooth('gs-s-lat', S.gLat, 12), lon = G.smooth('gs-s-lon2', S.gLong, 12);
    if (isNum(lat) && isNum(lon)) {
        const q = P(lat, lon);
        cv.circle(q[0], q[1], 13, BG);
        cv.circle(q[0], q[1], 10, WHITE);
    }
}

/** The drive mode pill, centred on cx, its middle at y. */
function modePill(cv, cx, y, S) {
    if (!S.mode) return;
    const fill = MODE_FILL[S.modeTone], tw = cv.textWidth(S.mode, 22, { font: TXT, spacing: 3, literal: true }), w = tw + 44, h = 34;
    const x = Math.round(cx - w / 2);
    cv.roundRect(x, y - h / 2, w, h, h / 2, fill || '#2a2f38');
    if (!fill) cv.roundRect(x + 2, y - h / 2 + 2, w - 4, h - 4, h / 2 - 2, '#14171c');
    cv.text(S.mode, cx, y + 8, 22, fill && S.modeTone !== 'eco' ? '#ffffff' : fill ? BG : WHITE, { align: 'center', font: TXT, spacing: 3, literal: true });
}

module.exports = {
    id: 'simracing',
    name: 'Sim Racing',
    blurb: 'A sim-racing HUD: LED shift strip, segmented rpm, big boxed gear, data blocks',
    palette,
    dotsAbove: true,            // the hub's page dots sit above the G (the LAT / LONG readout is left of it)
    ui: { txt: TXT, num: NUM, size: 20, spacing: 1.5, upper: true, radius: 4, nameFont: TXT, nameSize: 30 },
    badgeLetter: WHITE,

    background(cv, t, reach) {
        cv.gradientRect(0, 0, 1600, reach, [[0, '#0a0c10'], [1, '#040506']]);
    },
    card(cv, t, x, y, w, h, on) {
        cv.fillRect(x, y, w, h, on ? '#1d1a0c' : '#0e1014');
        cv.strokeRoundRect(x, y, w, h, 3, on ? 2 : 1, on ? YEL : EDGE);
    },
    cardBg(cv, t, x, y, w, h) { cv.gradientRect(x, y, w, h, [[0, '#0d0f13'], [1, '#050607']]); },
    panelPlate(cv, t, x, y, w, h) {
        cv.fillRect(x, y, w, h, '#0b0d10');
        cv.strokeRoundRect(x, y, w, h, 3, 1, EDGE);
        cv.fillRect(x, y, w, 3, GRN);
    },

    /** The settings gallery card: a lit LED strip, a segment bar, a yellow gear in its box. */
    swatch(cv, t, x, y, w, h) {
        const n = 10, pad = 16, gap = 5, lw = (w - 2 * pad - gap * (n - 1)) / n, ly = y + 10;
        for (let i = 0; i < n; i++) {
            const c = i < 4 ? GRN : i < 7 ? YEL : i < 8 ? RED : OFF;
            if (c !== OFF) cv.roundRect(x + pad + i * (lw + gap) - 2, ly - 2, lw + 4, 18, 9, withAlpha(c, 0.25));
            cv.roundRect(x + pad + i * (lw + gap), ly, lw, 14, 7, c);
        }
        const m = 24, sw2 = (w - 2 * pad - 3 * (m - 1)) / m;
        for (let i = 0; i < m; i++) cv.fillRect(x + pad + i * (sw2 + 3), ly + 26, sw2, 8, i < 14 ? WHITE : i < 18 ? YEL : OFF);
        const bw = Math.min(w * 0.36, h - 56), bx = x + w / 2 - bw / 2, by = ly + 46;
        cv.fillRect(bx, by, bw, h - 56, '#0e1014');
        cv.strokeRoundRect(bx, by, bw, h - 56, 3, 2, YEL);
        cv.text('4', x + w / 2, by + (h - 56) * 0.86, (h - 56) * 0.92, YEL, { align: 'center', font: GEAR, literal: true });
    },

    /** Where the Spotify panel goes (setting "panel"): the right column (friction circle, bests). */
    panelRect(S) { const g = geo(S); return { x: g.rx, y: g.top + 10, w: S.x + S.w - g.rx, h: g.bottom - g.top - 10 }; },

    draw(cv, S) {
        const g = geo(S), ex = g.ex, x0 = S.x, x1 = S.x + S.w;
        // LED strip across the top, rpm bar under it
        const st = leds(cv, S, x0, g.ledY, S.w, g.ledH);
        rpmBar(cv, S, x0 + 6, g.barY, S.w - 12, g.barH);

        // ---- left: speed and data blocks
        const lx = x0 + 6, lw = 446, top = g.top, bottom = g.bottom;
        cv.text('SPEED', lx, top + 14, 16, DIM, { font: TXT, spacing: 2, literal: true });
        cv.text(S.unit, lx + lw, top + 14, 16, DIM, { align: 'right', font: TXT, spacing: 2, literal: true });
        const sp = isNum(S.speed) ? String(Math.round(S.speed)) : '--';
        const ss = 128 + ex * 0.25;
        cv.text(sp, lx + lw, top + 20 + ss * 0.74, ss, WHITE, { align: 'right', font: NUM, literal: true });
        const bh = 64 + Math.round(ex * 0.08), bgap = 10, bw = (lw - bgap) / 2, by0 = bottom - 2 * bh - bgap;
        block(cv, lx, by0, bw, bh, 'TOP', isNum(S.peak.speed) && S.peak.speed > 0 ? String(Math.round(S.peak.speed)) : '--', null);
        block(cv, lx + bw + bgap, by0, bw, bh, 'SESSION', L.clock(S.session), null);
        tempBlock(cv, lx, by0 + bh + bgap, bw, bh, 'OIL', S.oil);
        tempBlock(cv, lx + bw + bgap, by0 + bh + bgap, bw, bh, 'WATER', S.cool);

        // ---- centre: the gear in its box; white, yellow while the lights fill, red while they flash
        const filling = !st.strobe && isNum(S.rpm) && S.rpm > S.shift - (S.range || 2000);
        const gcol = st.strobe ? RED : filling ? YEL : WHITE;
        const gw = 330, gx = g.cx - gw / 2, gy = top + 10, gh = bottom - gy - 112;
        cv.fillRect(gx, gy, gw, gh, '#0b0d10');
        cv.gradientRect(gx, gy, gw, gh, [[0, withAlpha('#ffffff', 0.04)], [1, withAlpha('#000000', 0.3)]]);
        const edge = st.strobe ? (S.blink ? RED : withAlpha(RED, 0.35)) : filling ? YEL : EDGE;
        cv.strokeRoundRect(gx, gy, gw, gh, 4, st.strobe || filling ? 4 : 1.5, edge);
        if (st.strobe && S.blink) cv.roundRect(gx - 8, gy - 8, gw + 16, gh + 16, 8, withAlpha(RED, 0.12));
        cv.text('GEAR', gx + 14, gy + 26, 16, DIM, { font: TXT, spacing: 3, literal: true });
        if (S.guessed) cv.text('EST', gx + gw - 14, gy + 26, 16, DIM, { align: 'right', font: TXT, spacing: 3, literal: true });
        const gs = Math.min(gh * 1.02, 300);
        cv.text(S.gearText, g.cx, gy + gh / 2 + gs * 0.36, gs, gcol, { align: 'center', font: GEAR, literal: true });
        modePill(cv, g.cx, gy, S);                 // on the box's top edge
        // digital rpm, then the longitudinal g as a centre-zero delta bar
        const ry = gy + gh + 52;
        const rv = isNum(S.rpm) ? String(Math.round(S.rpm / 10) * 10) : '----';
        cv.text(rv, g.cx + 10, ry, 44, st.strobe ? RED : filling ? YEL : WHITE, { align: 'right', font: NUM, literal: true });
        cv.text('RPM', g.cx + 22, ry, 18, DIM, { font: TXT, spacing: 3, literal: true });
        deltaBar(cv, S, g.cx, ry + 34, 560);

        // ---- right: friction circle and session bests (purple), the Spotify panel's place
        if (S.panel === 'spotify') return;
        const rx = g.rx, avail = bottom - top;
        const r = Math.round(clamp(avail / 2 - 34, 90, 150 + ex * 0.15)), ccx = rx + 22 + r, ccy = top + 8 + r;
        circle(cv, S, ccx, ccy, r);
        const lat = G.smooth('gs-s-lat', S.gLat, 12), lon = G.smooth('gs-s-lon2', S.gLong, 12);
        cv.text('LAT', ccx - r, ccy + r + 40, 16, DIM, { font: TXT, spacing: 2, literal: true });
        cv.text(isNum(lat) ? Math.abs(lat).toFixed(2) : '-.--', ccx - 4, ccy + r + 42, 30, WHITE, { align: 'right', font: NUM, literal: true });
        cv.text('LONG', ccx + 14, ccy + r + 40, 16, DIM, { font: TXT, spacing: 2, literal: true });
        cv.text(isNum(lon) ? Math.abs(lon).toFixed(2) : '-.--', ccx + r, ccy + r + 42, 30, WHITE, { align: 'right', font: NUM, literal: true });
        const px = ccx + r + 26, pw = x1 - px, ph = 60, pg = 10;
        cv.text('BEST', px, top + 14, 16, PUR, { font: TXT, spacing: 3, literal: true });
        [['ACCEL', S.peak.acc], ['BRAKE', S.peak.brk], ['LATERAL', S.peak.lat]].forEach((p, i) => {
            const y = top + 26 + i * (ph + pg);
            cv.fillRect(px, y, pw, ph, withAlpha(PUR, 0.16));
            cv.fillRect(px, y, 5, ph, PUR);
            cv.text(p[0], px + 14, y + 22, 15, PUR, { font: TXT, spacing: 2, literal: true });
            cv.text(p[1].toFixed(2), px + pw - 10, y + ph - 10, 30, WHITE, { align: 'right', font: NUM, literal: true });
        });
    },
};
