'use strict';
/**
 * Lumen - the showpiece: a cinematic night-blue dash built round one glowing rpm ring. Light dust
 * drifts past in two depths (faster as the car goes faster), the ring's lit arc carries a comet head
 * and a light sweep that orbits quicker with rpm, the shift beads glow over the ring, and at the
 * shift point the ring breathes; at redline it flashes and sends out a shock ring. The dash leans a
 * little against lateral g (parallax: the dust moves most, the ring a little, the readouts least).
 * Static parts (ring track, ticks, numerals, glass plates) are cached layers; per frame only a few
 * arcs, ~60 dots and the text are drawn. Titillium Web numerals, Jost labels (open fonts).
 * Node 8: no ?., no ??, no object spread.
 */
const G = require('./kit/gauges');
const L = require('./lib');

const { withAlpha, clamp, isNum } = L;
const NUM = 'gs_s_num', GEAR = 'gs_s_gear', TXT = 'gs_h_txt';
const BG0 = '#03050b', BG1 = '#0a1226', ICE = '#7fe3ff', BLUE = '#2f8bff', DEEP = '#1b3fd8', WHITE = '#f2f6ff',
    DIM = '#7d8aa6', AMBER = '#ffb340', RED = '#ff3448', EDGE = '#1c2742';
const A0 = -135, SPAN = 270;

const palette = Object.assign({}, require('./kit/themes').theme('m_tricolour'), {
    name: 'Lumen',
    bg: BG0, panelTop: '#0d1630', panelBottom: '#070b18', panelEdge: EDGE,
    track: '#141c33', tick: '#2a3656', text: WHITE, dim: DIM,
    accent: ICE, accent2: ICE, ok: '#43e6a0', warn: AMBER, crit: RED, cold: BLUE,
    sel: ICE, selText: BG0, marker: RED, stripes: [ICE, BLUE, RED],
});
const MODE = { 'sport+': RED, track: RED, sport: AMBER, eco: '#43e6a0' };

/* the dust: fixed seeds, two depths; offsets integrated from speed between frames */
const DUST = [];
(function () { let s = 7; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 54; i++) DUST.push({ x: r() * 1600, y: r(), z: i < 36 ? 0 : 1, ph: r() * 6.28, sz: 0.6 + r() * 0.8 }); })();
const ST = { off: [0, 0], at: 0, shock: [] };

function geo(S) {
    const ex = Math.max(0, S.h - 456), bottom = S.y + S.h;
    const R = Math.round(Math.min(226 + ex * 0.4, (S.h - 40) / 2));
    return { ex, bottom, cx: S.x + 650, cy: S.y + Math.round(S.h / 2) + 6, R, rx: S.x + 1050 };
}
const ang = (S, v) => A0 + SPAN * clamp(v / S.maxRpm, 0, 1);

function background(cv, t, reach) {
    cv.blit(G.layer('gs-lu-bg|' + reach, 1600, reach, (c) => {
        c.gradientRect(0, 0, 1600, reach, [[0, BG1], [0.55, '#060a17'], [1, BG0]]);
        // a soft pool of light behind the ring, the edges darker (the screen's own vignette)
        for (let i = 9; i >= 1; i--) c.circle(662, reach / 2 + 20, 60 + i * 52, withAlpha('#1d3a8a', 0.018));
        c.gradientRect(0, 0, 90, reach, [[0, withAlpha('#000000', 0.55)], [1, withAlpha('#000000', 0)]]);
        c.gradientRect(0, reach - 70, 1600, 70, [[0, withAlpha('#000000', 0)], [1, withAlpha('#000000', 0.45)]]);
        // a fine horizon line through the ring's centre
        c.gradientRect(0, reach / 2 + 26, 1600, 1, [[0, withAlpha(ICE, 0)], [0.4, withAlpha(ICE, 0.10)], [0.6, withAlpha(ICE, 0.10)], [1, withAlpha(ICE, 0)]]);
    }), 0, 0);
}

/** The drifting dust (parallax): far = small and slow, near = larger, faster, with a halo. */
function dust(cv, S, reach) {
    const now = S.now, dt = ST.at ? clamp((now - ST.at) / 1000, 0, 0.1) : 0; ST.at = now;
    const v = isNum(S.speed) ? S.speed : 0;
    ST.off[0] += dt * (6 + v * 0.9); ST.off[1] += dt * (14 + v * 2.6);
    const lean = isNum(S.gLat) ? clamp(S.gLat, -1.2, 1.2) : 0;
    DUST.forEach((d) => {
        const x = ((d.x - ST.off[d.z] + lean * (d.z ? -46 : -20)) % 1600 + 1600) % 1600, y = 60 + d.y * (reach - 110) + Math.sin(now / 1900 + d.ph) * 6;
        const tw = 0.55 + 0.45 * Math.sin(now / 700 + d.ph * 3);
        if (d.z) { cv.circle(x, y, 7 * d.sz, withAlpha(ICE, 0.035 * tw)); cv.circle(x, y, 2.2 * d.sz, withAlpha('#cfefff', 0.32 * tw)); }
        else cv.circle(x, y, 1.3 * d.sz, withAlpha('#9fb6e8', 0.28 * tw));
    });
}

/** The ring's static parts: track, minor / major ticks, numerals, the redline sector (a layer). */
function ringBase(cv, S, cx, cy, R) {
    const key = ['gs-lu-ring', R, S.maxRpm, S.redline].join('|'), pad = 70, sz = 2 * (R + pad);
    cv.blit(G.layer(key, sz, sz, (c) => {
        const x = R + pad, y = R + pad;
        c.arc(x, y, R - 18, R + 2, A0, A0 + SPAN, '#0b1224', { round: true });
        c.arc(x, y, R - 19, R - 18, A0, A0 + SPAN, withAlpha('#ffffff', 0.07));
        c.arc(x, y, R + 2, R + 3, A0, A0 + SPAN, withAlpha('#ffffff', 0.10));
        c.arc(x, y, R - 18, R + 2, ang(S, S.redline), A0 + SPAN, withAlpha(RED, 0.22));
        for (let v = 0; v <= S.maxRpm; v += 250) {
            const a = ang(S, v), maj = v % 1000 === 0;
            L.tick(c, x, y, R + 10, R + (maj ? 26 : 16), a, maj ? 2.5 : 1.2, v >= S.redline ? RED : maj ? withAlpha(WHITE, 0.7) : withAlpha(WHITE, 0.22));
            if (maj) { const p = L.pt(x, y, R + 46, a); c.text(String(v / 1000), p[0], p[1] + 8, 22, v >= S.redline ? RED : DIM, { align: 'center', font: TXT, literal: true }); }
        }
        // glass disc inside, a faint inner rim
        for (let i = 0; i < 6; i++) c.circle(x, y, R - 30 - i * 4, withAlpha('#0f1a38', 0.10));
        c.arc(x, y, R - 31, R - 30, 0, 360, withAlpha('#ffffff', 0.05));
    }, cv.textScale), cx - R - pad, cy - R - pad);
}

/** The lit arc with its glow, the comet head, the orbiting sweep; the breathing / flash at the shift point. */
function ringLive(cv, S, cx, cy, R) {
    if (!isNum(S.rpm)) return;
    const rpm = G.smooth('gs-lu-rpm', S.rpm, 14), a1 = ang(S, rpm), now = S.now;
    const lo = S.shift - S.range, hot = rpm >= lo, over = S.strobe, red = rpm >= S.redline;
    const ramp = over ? [RED, RED] : hot ? [DEEP, BLUE, ICE, AMBER] : [DEEP, BLUE, ICE, '#ffffff'];
    // breathing at the shift point (4 Hz), flashing at redline
    const pulse = over ? (red ? (S.blink ? 1 : 0.25) : 0.6 + 0.4 * Math.sin(now / 40)) : 1;
    const core = over ? (red && !S.blink ? withAlpha(RED, 0.4) : RED) : null;
    const glowC = over ? RED : hot ? AMBER : BLUE;
    // glow: three wide faint arcs under the bright one
    [[26, 0.05], [16, 0.09], [8, 0.16]].forEach((g) => cv.arc(cx, cy, R - 16 - g[0], R + g[0], A0, a1, withAlpha(glowC, g[1] * pulse), { round: true }));
    cv.arc(cx, cy, R - 16, R, A0, a1, core || BLUE, core ? { round: true } : { round: true, ramp, rampFrom: A0, rampTo: Math.max(A0 + 60, a1) });
    // the sweep: a short bright highlight orbiting along the lit arc; a lap takes 2.6 s at idle, 0.5 s near the shift point
    const f = clamp(rpm / S.shift, 0, 1), period = 2600 - 2100 * f * f;
    ST.sw = (ST.sw || 0) + (ST.swAt ? (now - ST.swAt) / period : 0); ST.swAt = now; ST.sw %= 1;
    const span = a1 - A0;
    if (span > 30 && !over) {
        const sa = A0 + span * ST.sw;
        cv.arc(cx, cy, R - 15, R - 1, Math.max(A0, sa - 22), Math.min(a1, sa + 4), withAlpha('#ffffff', 0), { ramp: [withAlpha('#ffffff', 0), withAlpha('#ffffff', 0.55)], rampFrom: sa - 22, rampTo: sa + 4 });
    }
    // the comet head
    const p = L.pt(cx, cy, R - 8, a1);
    cv.circle(p[0], p[1], 26, withAlpha(glowC, 0.10 * pulse));
    cv.circle(p[0], p[1], 14, withAlpha(over ? RED : ICE, 0.28 * pulse));
    cv.circle(p[0], p[1], 6, '#ffffff');
    // the shock ring at redline: one every 300 ms, out 70 px and fading
    if (red) { if (!ST.shock.length || now - ST.shock[ST.shock.length - 1] > 300) ST.shock.push(now); }
    ST.shock = ST.shock.filter((t0) => now - t0 < 600);
    ST.shock.forEach((t0) => { const k = (now - t0) / 600, rr = R + 8 + 70 * k; cv.arc(cx, cy, rr, rr + 3, 0, 360, withAlpha(RED, 0.5 * (1 - k))); });
}

/** The shift beads: 12 over the top of the ring (the last 2000 rpm before the shift point), Race colours. */
function beads(cv, S, cx, cy, R) {
    const n = 12, st = L.lights(S, n, ICE), rr = R - 50;
    for (let i = 0; i < n; i++) {
        const a = -48 + 96 * i / (n - 1), p = L.pt(cx, cy, rr, a);
        let c = null, k = 0;
        if (st.strobe) { if (st.flash) { c = st.flash; k = 1; } } else if (st.part[i] > 0) { c = st.cols[i]; k = st.part[i]; }
        cv.circle(p[0], p[1], 6, '#0c1428');
        cv.arc(p[0], p[1], 6, 7.5, 0, 360, withAlpha('#ffffff', 0.12));
        if (c) { cv.circle(p[0], p[1], 16, withAlpha(c, 0.18 * k)); cv.circle(p[0], p[1], 6.5, withAlpha(c, 0.4 + 0.6 * k)); cv.circle(p[0] - 1.5, p[1] - 1.5, 2.2, withAlpha('#ffffff', 0.55 * k)); }
    }
}

/** A glass plate: graded fill, a fine bright top edge, a faint rim. */
function glass(cv, x, y, w, h, r, lit) {
    cv.card(x, y, w, h, r, [[0, withAlpha('#1a2852', 0.55)], [1, withAlpha('#070c1c', 0.75)]]);
    cv.strokeRoundRect(x, y, w, h, r, 1, withAlpha(lit || '#ffffff', lit ? 0.6 : 0.10));
    cv.gradientRect(x + r, y, w - 2 * r, 1, [[0, withAlpha('#ffffff', 0)], [0.5, withAlpha('#ffffff', 0.35)], [1, withAlpha('#ffffff', 0)]]);
}

function tempLine(cv, S, x, y, w, label, v) {
    const ok = v.ok === true, f = isNum(v.f) ? clamp((v.f - 100) / Math.max(1, v.thr - 100), 0, 1) : 0, c = ok ? '#43e6a0' : BLUE;
    cv.text(label, x, y, 15, DIM, { font: TXT, spacing: 4, literal: true });
    cv.text(isNum(v.f) ? Math.round(v.f) + '°F' : '--', x + w, y + 2, 24, ok ? WHITE : v.ok === false ? ICE : DIM, { align: 'right', font: NUM, literal: true });
    cv.roundRect(x, y + 14, w, 4, 2, '#141c33');
    if (f > 0) { cv.roundRect(x, y + 11, w * f, 10, 5, withAlpha(c, 0.18)); cv.roundRect(x, y + 14, w * f, 4, 2, c); }
}

/** The fuel level (Bottom bars: Fuel): a light line like the temperatures', red at the car's low level; range under it. */
function fuelLine(cv, S, x, y, w, F) {
    const ft = L.fuelText(F), c = ft.low ? RED : ICE;
    cv.text('FUEL', x, y, 15, DIM, { font: TXT, spacing: 4, literal: true });
    cv.text(ft.value, x + w, y + 2, 24, !ft.has ? DIM : ft.low ? RED : WHITE, { align: 'right', font: NUM, literal: true });
    cv.roundRect(x, y + 14, w, 4, 2, '#141c33');
    if (ft.f) { cv.roundRect(x, y + 11, w * ft.f, 10, 5, withAlpha(c, 0.18)); cv.roundRect(x, y + 14, w * ft.f, 4, 2, c); }
    cv.text('RANGE', x, y + 56, 15, DIM, { font: TXT, spacing: 4, literal: true });
    // the number in the numerals, the unit in the label type (the numerals have no letters)
    const rn = ft.range ? ft.range.replace(' MI', '') : '--', rw = cv.textWidth(rn, 24, { font: NUM, literal: true });
    cv.text(rn, x + w, y + 58, 24, ft.range ? WHITE : DIM, { align: 'right', font: NUM, literal: true });
    if (ft.range) cv.text('MI', x + w - rw - 8, y + 56, 15, DIM, { align: 'right', font: TXT, spacing: 3, literal: true });
}

function gmeter(cv, S, cx, cy, r) {
    const max = S.gMax;
    cv.blit(G.layer(['gs-lu-gm', r, max].join('|'), 2 * r + 20, 2 * r + 20, (c) => {
        const x = r + 10, y = r + 10;
        c.circle(x, y, r, withAlpha('#0a1430', 0.7));
        for (let q = 0.5; q <= max + 1e-6; q += 0.5) { const rr = q / max * r; c.arc(x, y, rr - 0.6, rr + 0.6, 0, 360, withAlpha(ICE, q % 1 === 0 ? 0.22 : 0.10)); }
        c.line(x - r, y, x + r, y, 1, withAlpha(ICE, 0.12)); c.line(x, y - r, x, y + r, 1, withAlpha(ICE, 0.12));
    }, cv.textScale), cx - r - 10, cy - r - 10);
    const P = (lat, lon) => [cx + clamp(lat / max, -1.05, 1.05) * r, cy - clamp(lon / max, -1.05, 1.05) * r];
    S.trail.forEach((p, i) => { if (isNum(p[0]) && isNum(p[1])) { const q = P(p[0], p[1]); cv.circle(q[0], q[1], 3, withAlpha(ICE, 0.06 + 0.4 * i / S.trail.length)); } });
    const lat = G.smooth('gs-lu-lat', S.gLat, 12), lon = G.smooth('gs-lu-lon', S.gLong, 12);
    if (isNum(lat) && isNum(lon)) { const q = P(lat, lon); cv.circle(q[0], q[1], 22, withAlpha(ICE, 0.12)); cv.circle(q[0], q[1], 9, '#ffffff'); }
}

module.exports = {
    id: 'lumen',
    name: 'Lumen',
    blurb: 'The showpiece: a glowing rpm ring with a light sweep, drifting light, glass plates',
    palette,
    ui: { txt: TXT, num: NUM, size: 20, spacing: 3, upper: true, radius: 14, nameFont: TXT, nameSize: 28 },
    badgeLetter: WHITE,

    background(cv, t, reach) { background(cv, t, reach); },
    card(cv, t, x, y, w, h, on) { glass(cv, x, y, w, h, 14, on ? ICE : null); },
    cardBg(cv, t, x, y, w, h) {
        cv.gradientRect(x, y, w, h, [[0, BG1], [1, BG0]]);
        for (let i = 6; i >= 1; i--) cv.circle(x + w / 2, y + h * 0.42, 14 + i * 14, withAlpha('#1d3a8a', 0.05));
    },
    panelPlate(cv, t, x, y, w, h) { glass(cv, x, y, w, h, 14, null); },
    gButton(cv, t, r, lit, down) {
        glass(cv, r.x, r.y, r.w, r.h, 14, lit || down ? ICE : null);
        if (down) cv.roundRect(r.x, r.y, r.w, r.h, 14, withAlpha(ICE, 0.2));
        const h = 28, bw = L.badgeWidth(h);
        L.badge(cv, r.x + (r.w - bw) / 2, r.y + (r.h + h) / 2, h, WHITE);
    },

    /** The gallery card: a lit ring arc with its comet head and glow. */
    swatch(cv, t, x, y, w, h) {
        const cx = x + w / 2, cy = y + h * 0.62, R = Math.min(w * 0.3, h * 0.56);
        cv.arc(cx, cy, R - 8, R, -120, 120, '#0e1730', { round: true });
        [[12, 0.06], [6, 0.12]].forEach((g) => cv.arc(cx, cy, R - 8 - g[0], R + g[0], -120, 60, withAlpha(BLUE, g[1]), { round: true }));
        cv.arc(cx, cy, R - 8, R, -120, 60, BLUE, { round: true, ramp: [DEEP, BLUE, ICE, '#ffffff'], rampFrom: -120, rampTo: 60 });
        const p = L.pt(cx, cy, R - 4, 60);
        cv.circle(p[0], p[1], 12, withAlpha(ICE, 0.25)); cv.circle(p[0], p[1], 4, '#ffffff');
        cv.text('88', cx, cy + 14, 36, WHITE, { align: 'center', font: NUM, literal: true });
        [[0.2, 0.3], [0.8, 0.22], [0.12, 0.7], [0.9, 0.62]].forEach((d) => cv.circle(x + w * d[0], y + h * d[1], 2, withAlpha('#cfefff', 0.5)));
    },

    panelRect(S) { const g = geo(S); return { x: g.rx + 20, y: S.y + 24, w: S.x + S.w - g.rx - 20, h: g.bottom - S.y - 24 - 84 }; },

    draw(cv, S) {
        const g = geo(S), reach = S.y + S.h + 6, lean = isNum(S.gLat) ? clamp(G.smooth('gs-lu-lean', S.gLat, 4), -1.2, 1.2) : 0;
        dust(cv, S, reach);
        const cx = g.cx - lean * 8, cy = g.cy, R = g.R;
        ringBase(cv, S, cx, cy, R);
        ringLive(cv, S, cx, cy, R);
        beads(cv, S, cx, cy, R);
        // inside: the speed (the hero), its unit, the rpm
        const sp = isNum(S.speed) ? String(Math.round(S.speed)) : '--', tx = cx - lean * 3;
        cv.text(sp, tx, cy + 44, 156, WHITE, { align: 'center', font: NUM, literal: true });
        cv.text('MPH', tx, cy + 82, 17, DIM, { align: 'center', font: TXT, spacing: 8, literal: true });
        cv.text(L.rpmText(S.rpm), tx, cy - 92, 30, S.strobe ? RED : S.rpm >= S.shift - S.range ? AMBER : ICE, { align: 'center', font: NUM, literal: true });
        cv.text('RPM', tx, cy - 70, 13, DIM, { align: 'center', font: TXT, spacing: 6, literal: true });
        // the drive mode: in the ring's open bottom
        if (S.mode) {
            const fill = MODE[S.modeTone], tw = cv.textWidth(S.mode, 17, { font: TXT, spacing: 4, literal: true }), w = tw + 46, h = 34, x = Math.round(tx - w / 2), y = cy + R - 34;
            if (fill) cv.roundRect(x - 6, y - 6, w + 12, h + 12, (h + 12) / 2, withAlpha(fill, 0.14));
            cv.roundRect(x, y, w, h, h / 2, fill ? withAlpha(fill, 0.22) : withAlpha('#ffffff', 0.05));
            cv.strokeRoundRect(x, y, w, h, h / 2, 1.5, fill || withAlpha('#ffffff', 0.3));
            cv.text(S.mode, tx + 2, y + 23, 17, fill ? '#ffffff' : WHITE, { align: 'center', font: TXT, spacing: 4, literal: true });
        }
        // left: the gear in a tall glass capsule, the warm-up lines under it
        const gx = S.x + 34, gy = S.y + 30, gw = 236, gh = g.bottom - gy - 150;
        const fill = !S.strobe && isNum(S.rpm) && S.rpm >= S.shift - S.range;
        glass(cv, gx, gy, gw, gh, 22, S.strobe ? RED : fill ? AMBER : null);
        if (S.strobe && S.blink) cv.roundRect(gx - 8, gy - 8, gw + 16, gh + 16, 28, withAlpha(RED, 0.12));
        const sh = ((S.now % 7000) / 7000) * 1.6 - 0.3;
        if (sh > -0.2 && sh < 1.2) { cv.clip(gx, gy, gw, gh); const sx = gx + gw * sh; cv.quad([[sx, gy], [sx + 60, gy], [sx - 40, gy + gh], [sx - 100, gy + gh]], withAlpha('#ffffff', 0.045)); cv.noclip(); }
        cv.text('GEAR', gx + 22, gy + 34, 14, DIM, { font: TXT, spacing: 5, literal: true });
        if (S.guessed) cv.text('EST', gx + gw - 22, gy + 34, 14, DIM, { align: 'right', font: TXT, spacing: 4, literal: true });
        const gs = Math.min(gh * 0.92, 250), gcol = S.strobe ? (S.blink ? RED : WHITE) : WHITE;
        cv.text(S.gearText, gx + gw / 2, gy + gh / 2 + gs * 0.40, gs, withAlpha(gcol, 0.10), { align: 'center', font: GEAR, literal: true });
        cv.text(S.gearText, gx + gw / 2, gy + gh / 2 + gs * 0.36, gs, gcol, { align: 'center', font: GEAR, literal: true });
        const ty = g.bottom - 104;
        if (S.bars === 'fuel') fuelLine(cv, S, gx + 4, ty, gw - 8, S.fuel);
        else { tempLine(cv, S, gx + 4, ty, gw - 8, 'OIL', S.oil); tempLine(cv, S, gx + 4, ty + 56, gw - 8, 'COOLANT', S.cool); }
        // right: peaks and the g-meter (or Spotify there)
        if (S.panel === 'spotify') return;
        const px = g.rx + 20, pw = S.x + S.w - px, ph = g.bottom - S.y - 24 - 84;
        glass(cv, px, S.y + 24, pw, ph, 22, null);
        const r = Math.min(122 + g.ex * 0.15, ph / 2 - 40), gcx = px + 30 + r, gcy = S.y + 24 + ph / 2;
        gmeter(cv, S, gcx, gcy, r);
        const tot = isNum(S.gLat) && isNum(S.gLong) ? Math.sqrt(S.gLat * S.gLat + S.gLong * S.gLong) : null;
        const kx = px + pw - 28;
        cv.text(tot == null ? '-.--' : tot.toFixed(2), kx, S.y + 24 + 70, 44, WHITE, { align: 'right', font: NUM, literal: true });
        cv.text('G NOW', kx, S.y + 24 + 94, 13, DIM, { align: 'right', font: TXT, spacing: 4, literal: true });
        [['ACCEL', S.peak.acc], ['BRAKE', S.peak.brk], ['LATERAL', S.peak.lat]].forEach((p, i) => {
            const y = S.y + 24 + 150 + i * 62;
            cv.text(p[0], kx, y, 13, DIM, { align: 'right', font: TXT, spacing: 4, literal: true });
            cv.text(p[1].toFixed(2), kx, y + 30, 28, i === 1 ? AMBER : ICE, { align: 'right', font: NUM, literal: true });
        });
        // session clock (a tap: back to 0), above the G button
        const sy = g.bottom - 72;
        cv.text('SESSION', px + 4, sy + 18, 13, DIM, { font: TXT, spacing: 4, literal: true });
        cv.text(L.clock(S.session), px + 4, sy + 52, 28, WHITE, { font: NUM, literal: true });
        L.sessionTap(cv, S, px - 6, sy - 4, 200, 66, ICE, 12);
    },
};
