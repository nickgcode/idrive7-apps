'use strict';
/**
 * Pixel - a retro 8/16-bit game dash, all original pixel art (px.js): a block font, the G's Dash logo
 * redrawn in pixels (the emblem: a shine sweeps it every few seconds, its stripes slide in when the
 * look opens, it hops on an upshift and flashes at redline), the rev lights as a POWER BAR of 20
 * blocks with a heart (empty at rest, filling with the revs to full at the shift point: green, then
 * red in the last 2000 rpm, then "SHIFT!" flashing blue / red from the shift point), a peak trail, an
 * item-box gear, a hi-score style top speed, two stat bars for oil and coolant, a pixel radar for g.
 * Behind: a night sky with twinkling pixel stars and two rows of pixel hills scrolling with the car's
 * speed (parallax). Every pixel is a rect on a 4 px grid; the static art is in cached layers.
 * Node 8: no ?., no ??, no object spread.
 */
const G = require('./kit/gauges');
const L = require('./lib');
const P = require('./px');

const { withAlpha, clamp, isNum } = L;
const FONT = 'gs_p_px';
const SKY0 = '#0c0a24', SKY1 = '#231a4e', INK = '#05060c', WHITE = '#f4f4ff', DIM = '#8f8cc0', GRN = '#3ee07a', GRN2 = '#1f9e50',
    RED = '#ff3a4a', RED2 = '#a8162a', BLU = '#3a8bff', YEL = '#ffd23a', CYAN = '#58e1ff', FRAME = '#e8e6ff', BOX = '#141236';
const N_HP = 20;

const palette = Object.assign({}, require('./kit/themes').theme('m_tricolour'), {
    name: 'Pixel',
    bg: SKY0, panelTop: BOX, panelBottom: '#0d0b28', panelEdge: FRAME,
    track: '#24204e', tick: '#4a4590', text: WHITE, dim: DIM,
    accent: YEL, accent2: CYAN, ok: GRN, warn: YEL, crit: RED, cold: BLU,
    sel: YEL, selText: INK, marker: RED, stripes: [CYAN, BLU, RED],
});
const MODE = { 'sport+': RED, track: RED, sport: YEL, eco: GRN };
const ST = { scroll: [0, 0], at: 0, intro: 0, lastDraw: 0, hop: 0, gear: null, ghost: 0, gAt: 0 };

/** The cell size for a number of font size `size` drawn as rects (cap height ~0.72 of the size). */
function numCell(size) { return Math.max(2, Math.round(size * 0.72 / 7)); }

/** A pixel frame: a 4 px light border with notched corners on a dark box (the game "window"). */
function frame(cv, x, y, w, h, c, fill) {
    const u = 4; x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    cv.fillRect(x + u, y + u, w - 2 * u, h - 2 * u, fill || BOX);
    cv.fillRect(x + u, y, w - 2 * u, u, c); cv.fillRect(x + u, y + h - u, w - 2 * u, u, c);
    cv.fillRect(x, y + u, u, h - 2 * u, c); cv.fillRect(x + w - u, y + u, u, h - 2 * u, c);
    cv.fillRect(x + 2 * u, y + 2 * u, w - 4 * u, u, withAlpha('#ffffff', 0.08));          // the inner light line
    cv.fillRect(x + u, y + h, w - 2 * u, u, withAlpha(INK, 0.6)); cv.fillRect(x + w, y + 2 * u, u, h - 2 * u, withAlpha(INK, 0.6));   // drop shadow
}
const ptxt = (cv, s, x, y, u, c, o) => P.text(cv, s, x, y, u, c, Object.assign({ shadow: INK }, o || {}));

/* ---------------- the sky: stars, two rows of hills (layers), scrolled with speed ---------------- */
function hills(c, w, h, seed, col, top, amp) {
    let s = seed; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const u = 8; let y = top + amp / 2;
    for (let x = 0; x < w; x += u) {
        y = clamp(y + (r() - 0.5) * u * 2.2, top, top + amp);
        const yy = Math.round(y / u) * u;
        c.fillRect(x, yy, u, h - yy, col);
        c.fillRect(x, yy, u, u, withAlpha('#ffffff', 0.06));
    }
}
function background(cv, t, reach) {
    cv.blit(G.layer('gs-px-sky|' + reach, 1600, reach, (c) => {
        // banded sky (hard steps, no smooth gradient: the 16-bit way)
        const bands = [SKY0, '#100d2e', '#151137', '#1a1441', '#20184b', '#271c54'];
        bands.forEach((b, i) => c.fillRect(0, Math.round(reach * i / bands.length), 1600, Math.ceil(reach / bands.length) + 1, b));
        // the screen's edges: a stepped dark border (BMW's vignette)
        [[0, 0.5], [12, 0.3], [24, 0.15]].forEach((v) => c.fillRect(v[0], 0, 12, reach, withAlpha('#000000', v[1])));
    }), 0, 0);
}
const STARS = [];
(function () { let s = 11; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 46; i++) STARS.push({ x: Math.round(r() * 400) * 4, y: Math.round(r() * 70) * 4 + 40, ph: r() * 6.28, big: r() < 0.25 }); })();
function moon(cv) {
    // a big pixel moon (the drive page only: it would peek between the cards elsewhere)
    const mx = 935, my = 232, mr = 9;
    cv.blit(G.layer('gs-px-moon', 1600, 320, (c) => {
        for (let yy = -mr; yy <= mr; yy++) for (let xx = -mr; xx <= mr; xx++) if (xx * xx + yy * yy <= mr * mr) c.fillRect(mx + xx * 4, my + yy * 4, 4, 4, xx + yy < -6 ? '#fff6c8' : '#d8cf9a');
        c.fillRect(mx - 12, my - 8, 8, 8, '#bdb37e'); c.fillRect(mx + 12, my + 8, 12, 8, '#bdb37e'); c.fillRect(mx - 4, my + 16, 8, 4, '#bdb37e');
    }), 0, 0);
}
function sky(cv, S, reach) {
    const now = S.now, dt = ST.at ? clamp((now - ST.at) / 1000, 0, 0.1) : 0; ST.at = now;
    const v = isNum(S.speed) ? S.speed : 0;
    ST.scroll[0] += dt * (4 + v * 0.6); ST.scroll[1] += dt * (10 + v * 2.2);
    // stars: a blink every so often (on / dim / off in 4 px steps)
    STARS.forEach((s) => {
        const k = Math.sin(now / 520 + s.ph * 5);
        if (k < -0.7) return;
        const c = k > 0.6 ? '#ffffff' : '#8d88c8', x = (s.x - Math.floor(ST.scroll[0] * 0.3 / 4) * 4 + 1600 * 4) % 1600;
        cv.fillRect(x, s.y, 4, 4, c);
        if (s.big && k > 0.6) { cv.fillRect(x - 4, s.y, 4, 4, withAlpha(c, 0.5)); cv.fillRect(x + 4, s.y, 4, 4, withAlpha(c, 0.5)); cv.fillRect(x, s.y - 4, 4, 4, withAlpha(c, 0.5)); cv.fillRect(x, s.y + 4, 4, 4, withAlpha(c, 0.5)); }
    });
    // hills: far (slow) and near (faster), each a 1600 px wide layer blitted twice to wrap
    const far = G.layer('gs-px-far|' + reach, 1600, reach, (c) => hills(c, 1600, reach, 5, '#2b2163', reach - 230, 90));
    const near = G.layer('gs-px-near|' + reach, 1600, reach, (c) => hills(c, 1600, reach, 9, '#171338', reach - 150, 70));
    [[far, ST.scroll[0]], [near, ST.scroll[1]]].forEach((l) => {
        const ox = -(Math.floor(l[1] / 4) * 4 % 1600);
        cv.blit(l[0], ox, 0); cv.blit(l[0], ox + 1600, 0);
    });
}

/* ---------------- the emblem's motion ---------------- */
function emblemNow(S) {
    const now = S.now;
    if (now - ST.lastDraw > 1500) ST.intro = now;            // the look (re)opened: the stripes slide in
    ST.lastDraw = now;
    const gi = parseInt(S.gearText, 10);
    if (isNum(gi) && isNum(ST.gear) && gi > ST.gear) ST.hop = now;      // an upshift: a hop
    if (isNum(gi)) ST.gear = gi;
    const k = (now - ST.intro) / 700;
    const slide = [0, 1, 2].map((i) => clamp(k * 1.6 - i * 0.3, 0, 1)).map((x) => 1 - Math.pow(1 - x, 3));
    const cyc = (now % 4200) / 700;                         // the shine: 0.7 s of every 4.2 s
    const shine = cyc <= 1 ? -4 + cyc * (P.EMB.w + 6) : null;
    const red = isNum(S.rpm) && S.rpm >= S.redline;
    const hopT = (now - ST.hop) / 360, hop = S.strobe ? (Math.floor(now / 120) % 2 ? 1 : 0) : hopT < 1 ? Math.round(Math.sin(hopT * Math.PI) * 3) : 0;
    return { slide, shine, flash: red && S.blink ? '#ffffff' : null, hop };
}

/* ---------------- the health bar (the rev lights) ---------------- */
function hpBar(cv, S, x, y, w, h) {
    const lo = S.shift - S.range, rpm = isNum(S.rpm) ? S.rpm : 0;
    // a power bar: empty at rest, filling with the revs, full at the shift point
    const pw = isNum(S.rpm) ? clamp(rpm / S.shift, 0, 1) : 0;
    // the trail: a light peak hold that falls back to the bar (a lag of ~0.4 s) when the revs drop
    const dt = ST.gAt ? clamp((S.now - ST.gAt) / 1000, 0, 0.5) : 0; ST.gAt = S.now;
    ST.ghost = pw > ST.ghost ? pw : ST.ghost + (pw - ST.ghost) * (1 - Math.exp(-dt / 0.15));
    const lit = Math.ceil(pw * N_HP - 1e-6), ghost = Math.ceil(ST.ghost * N_HP - 1e-6);
    const danger = isNum(S.rpm) && rpm >= lo, ko = S.strobe;
    frame(cv, x, y, w, h, ko && S.blink ? RED : FRAME, INK);
    const pad = 10, gap = 4, bw = (w - 2 * pad - gap * (N_HP - 1)) / N_HP, by = y + pad, bh = h - 2 * pad;
    for (let i = 0; i < N_HP; i++) {
        const bx = Math.round(x + pad + i * (bw + gap)), ww = Math.round(bw);
        let c = '#1d1a40', top = null;
        if (ko) { c = S.blink ? BLU : '#1d1a40'; if (S.blink) top = '#a8ccff'; }
        else if (i < lit) { c = danger ? RED : GRN; top = danger ? '#ff9aa2' : '#b6ffcf'; }
        else if (i < ghost) c = '#ffe9b0';
        cv.fillRect(bx, by, ww, bh, c);
        if (top) { cv.fillRect(bx, by, ww, 4, top); cv.fillRect(bx, by + bh - 4, ww, 4, ko ? '#1f4aa0' : danger ? RED2 : GRN2); }
    }
    if (ko) ptxt(cv, 'SHIFT!', x + w / 2, by + (bh - 28) / 2, 4, S.blink ? WHITE : YEL, { align: 'center' });
    return { pw, danger, ko };
}

/* ---------------- the g radar ---------------- */
function radar(cv, S, x, y, s) {
    const max = S.gMax, u = 4;
    cv.blit(G.layer(['gs-px-radar', s, max].join('|'), s + 8, s + 8, (c) => {
        frame(c, 0, 0, s, s, FRAME, '#0d0b28');
        const cx = s / 2, cy = s / 2;
        for (let q = 0.5; q <= max + 1e-6; q += 0.5) {
            const r = Math.round(q / max * (s / 2 - 16) / u) * u;
            for (let a = 0; a < 360; a += 360 / Math.max(16, Math.round(r / 3))) {
                const px = Math.round((cx + Math.sin(a * Math.PI / 180) * r) / u) * u, py = Math.round((cy - Math.cos(a * Math.PI / 180) * r) / u) * u;
                c.fillRect(px, py, u, u, q % 1 === 0 ? '#4a4590' : '#2c2866');
            }
        }
        for (let k = 12; k < s - 12; k += 8) { c.fillRect(Math.round(cx / u) * u, k, u, u, '#2c2866'); c.fillRect(k, Math.round(cy / u) * u, u, u, '#2c2866'); }
    }), x, y);
    const R = s / 2 - 16, cx = x + s / 2, cy = y + s / 2, snap = (v) => Math.round(v / u) * u;
    const Pp = (lat, lon) => [snap(cx + clamp(lat / max, -1.05, 1.05) * R), snap(cy - clamp(lon / max, -1.05, 1.05) * R)];
    S.trail.forEach((p, i) => { if (i % 3 || !isNum(p[0]) || !isNum(p[1])) return; const q = Pp(p[0], p[1]); cv.fillRect(q[0] - 2, q[1] - 2, 4, 4, withAlpha(CYAN, 0.2 + 0.5 * i / S.trail.length)); });
    const lat = G.smooth('gs-px-lat', S.gLat, 12), lon = G.smooth('gs-px-lon', S.gLong, 12);
    if (isNum(lat) && isNum(lon)) {
        const q = Pp(lat, lon);
        cv.fillRect(q[0] - 8, q[1] - 4, 16, 8, INK); cv.fillRect(q[0] - 4, q[1] - 8, 8, 16, INK);
        cv.fillRect(q[0] - 4, q[1] - 4, 8, 8, YEL); cv.fillRect(q[0] - 4, q[1] - 4, 4, 4, '#ffffff');
    }
}

/** A stat bar (oil / coolant): label, 12 blocks filling to the ready point, the value and a tag. */
function stat(cv, S, x, y, w, label, v) {
    const n = 12, ok = v.ok === true, f = isNum(v.f) ? clamp((v.f - 100) / Math.max(1, v.thr - 100), 0, 1) : 0;
    ptxt(cv, label, x, y, 3, DIM);
    const val = isNum(v.f) ? Math.round(v.f) + '°F' : '--';
    ptxt(cv, val, x + w, y - 4, 4, ok ? WHITE : v.ok === false ? CYAN : DIM, { align: 'right' });
    const by = y + 34, gap = 4, bw = Math.floor((w - gap * (n - 1)) / n);
    for (let i = 0; i < n; i++) {
        const on = isNum(v.f) && (i + 0.5) / n <= f, bx = x + i * (bw + gap);
        cv.fillRect(bx, by, bw, 16, on ? (ok ? GRN : BLU) : '#1d1a40');
        if (on) cv.fillRect(bx, by, bw, 4, ok ? '#b6ffcf' : '#a8ccff');
    }
    if (v.ok === false || ok) ptxt(cv, ok ? 'OK' : 'COLD', x + w, by + 26, 3, ok ? GRN : CYAN, { align: 'right' });
}

module.exports = {
    id: 'pixel',
    name: 'Pixel',
    blurb: 'Retro game dash: pixel font, an animated pixel G emblem, the rev lights as a health bar',
    palette,
    ui: {
        txt: FONT, num: FONT, size: 18, spacing: 1, upper: true, radius: 0, nameFont: FONT, nameSize: 24,
        // hub.js's numbers: the baked atlas up to 48 px; bigger ones drawn as rects (pixel-exact, no soft upscale)
        numText: (cv, s, x, y, size, c, o) => {
            o = o || {};
            if (size < 40) return cv.text(String(s), x, y, size, c, Object.assign({ font: FONT, literal: true }, o));
            const u = numCell(size);
            return P.text(cv, String(s), x, y - 7 * u, u, c, { align: o.align, shadow: INK });
        },
        numWidth: (cv, s, size) => (size < 40 ? cv.textWidth(String(s), size, { font: FONT, literal: true }) : P.width(String(s), numCell(size))),
    },
    badgeLetter: WHITE,
    emblemState: emblemNow,

    background(cv, t, reach) { background(cv, t, reach); },
    card(cv, t, x, y, w, h, on) { frame(cv, x, y, w, h, on ? YEL : '#5a55a0', on ? '#2a2210' : BOX); },
    cardBg(cv, t, x, y, w, h) {
        cv.fillRect(x, y, w, h, SKY0); cv.fillRect(x, y + h * 0.5, w, h * 0.5, '#150f38');
        hills(cv, w, h, 5, '#2b2163', h - 120, 40);
    },
    panelPlate(cv, t, x, y, w, h) { frame(cv, x, y, w, h, FRAME, BOX); },
    gButton(cv, t, r, lit, down) {
        frame(cv, r.x, r.y, r.w, r.h, lit || down ? YEL : FRAME, down ? '#3a2e10' : BOX);
        const u = 3, ew = P.EMB.w * u, eh = P.EMB.h * u;
        P.emblem(cv, Math.round(r.x + (r.w - ew) / 2), Math.round(r.y + (r.h - eh) / 2), u, {});
    },

    /** The gallery card: the emblem over a short health bar and a heart. */
    swatch(cv, t, x, y, w, h) {
        const u = 4, ew = P.EMB.w * u;
        P.emblem(cv, Math.round(x + (w - ew) / 2), y + 10, u, { shine: 9 });
        const by = y + 10 + P.EMB.h * u + 14;
        P.heart(cv, x + 18, by, 3, RED, '#ffc0c6');
        const n = 10, bw = Math.floor((w - 70 - 3 * (n - 1)) / n);
        for (let i = 0; i < n; i++) cv.fillRect(x + 52 + i * (bw + 3), by + 2, bw, 18, i < 6 ? GRN : '#1d1a40');
    },

    panelRect(S) { return { x: S.x + 1060, y: S.y + 104, w: S.w - 1060, h: S.h - 104 - 84 }; },

    draw(cv, S) {
        const x0 = S.x, top = S.y, bottom = S.y + S.h, reach = bottom + 6;
        sky(cv, S, reach);
        moon(cv);
        // ---- top row: the emblem (the "player"), the heart and the health bar, the hi-score
        const em = emblemNow(S), u = 4;
        frame(cv, x0 + 28, top + 4, P.EMB.w * u + 28, P.EMB.h * u + 28, FRAME, BOX);
        cv.clip(x0 + 32, top + 8, P.EMB.w * u + 20, P.EMB.h * u + 20);
        P.emblem(cv, x0 + 42, top + 18 - em.hop * u, u, em);
        cv.noclip();
        const hx = x0 + 200, hw = 960, hy = top + 18, hh = 52;
        const hb = hpBar(cv, S, hx + 52, hy, hw - 52, hh);
        const beat = hb.ko ? (S.blink ? 1 : 0) : hb.danger ? (Math.floor(S.now / 180) % 2) : 0;
        P.heart(cv, hx - 2 - beat * 2, hy + 8 - beat * 2, 4 + beat, hb.ko && S.blink ? WHITE : RED, '#ffc0c6', INK);
        ptxt(cv, 'REV', hx + 52, hy + hh + 14, 3, DIM);
        ptxt(cv, 'SHIFT ' + S.shift, hx + hw, hy + hh + 14, 3, DIM, { align: 'right' });
        // the hi-score corner: top speed and the session clock (a tap there: the clock back to 0)
        const rx = x0 + 1250;
        ptxt(cv, 'HI', rx, hy + 2, 3, YEL);
        ptxt(cv, isNum(S.peak.speed) && S.peak.speed > 0 ? ('00' + Math.round(S.peak.speed)).slice(-3) : '---', rx + 84, hy - 2, 4, WHITE);
        ptxt(cv, 'TIME', rx, hy + 40, 3, YEL);
        ptxt(cv, L.clock(S.session), rx + 84, hy + 36, 4, WHITE);
        L.sessionTap(cv, S, rx - 10, hy - 10, 320, 74, YEL, 0);

        // ---- the gear: an item box
        const gx = x0 + 40, gy = top + 130, gw = 248, gh = bottom - gy - 128;
        const fill = hb.danger && !hb.ko;
        frame(cv, gx, gy, gw, gh, hb.ko ? (S.blink ? RED : YEL) : fill ? YEL : FRAME, BOX);
        frame(cv, gx + 12, gy + 12, gw - 24, gh - 24, withAlpha(FRAME, 0.25), BOX);
        ptxt(cv, 'GEAR', gx + 24, gy + 24, 3, DIM);
        if (S.guessed) ptxt(cv, 'EST', gx + gw - 24, gy + 24, 3, DIM, { align: 'right' });
        const gu = Math.floor(Math.min((gh - 70) / 7, 26));
        ptxt(cv, S.gearText, gx + gw / 2, gy + 52 + (gh - 70 - 7 * gu) / 2, gu, hb.ko ? (S.blink ? RED : WHITE) : WHITE, { align: 'center' });

        // ---- the speed (the hero) and the rpm, the mode badge
        const cx = x0 + 670, su = 21;
        const sp = isNum(S.speed) ? String(Math.round(S.speed)) : '--';
        ptxt(cv, sp, cx, top + 124, su, WHITE, { align: 'center' });
        ptxt(cv, 'MPH', cx, top + 124 + 7 * su + 22, 5, CYAN, { align: 'center' });
        const ry = top + 124 + 7 * su + 80;
        const rt = isNum(S.rpm) ? String(Math.round(S.rpm / 10) * 10) : '----';
        const rw = P.width(rt, 6) + 20 + P.width('RPM', 4);
        ptxt(cv, rt, cx - rw / 2, ry, 6, hb.ko ? RED : hb.danger ? YEL : WHITE);
        ptxt(cv, 'RPM', cx + rw / 2, ry + 18, 4, DIM, { align: 'right' });
        if (S.mode) {
            const c = MODE[S.modeTone] || '#5a55a0', tw = P.width(S.mode, 4), w = tw + 40, mx = gx + gw / 2, x = Math.round(mx - w / 2), y = bottom - 96;
            frame(cv, x, y, w, 52, c, MODE[S.modeTone] ? withAlpha(c, 0.25) : BOX);
            ptxt(cv, S.mode, mx, y + 12, 4, WHITE, { align: 'center' });
        }

        // ---- bottom left: oil and coolant stat bars
        const by = bottom - 92;
        stat(cv, S, gx + 300, by, 300, 'OIL', S.oil); stat(cv, S, gx + 660, by, 300, 'COOLANT', S.cool);

        // ---- right: the g radar and the peaks (Spotify takes this place when chosen)
        if (S.panel === 'spotify') return;
        const px = x0 + 1060, py = top + 104, s = Math.min(bottom - py - 96, 300);
        radar(cv, S, px, py, s);
        const kx = x0 + S.w - 20;
        [['ACC', S.peak.acc, GRN], ['BRK', S.peak.brk, RED], ['LAT', S.peak.lat, CYAN]].forEach((p, i) => {
            const y = py + 8 + i * 84;
            ptxt(cv, p[0], kx, y, 3, p[2], { align: 'right' });
            ptxt(cv, p[1].toFixed(2), kx, y + 28, 5, WHITE, { align: 'right' });
        });
        const tot = isNum(S.gLat) && isNum(S.gLong) ? Math.sqrt(S.gLat * S.gLat + S.gLong * S.gLong) : null;
        ptxt(cv, (tot == null ? '-.--' : tot.toFixed(2)) + ' G', px + s / 2, py + s + 20, 4, WHITE, { align: 'center' });
    },
};
