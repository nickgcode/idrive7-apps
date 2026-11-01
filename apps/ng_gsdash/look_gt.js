'use strict';
/**
 * GT - a GT3-style race display (the MoTeC / AiM / Cosworth school): black, a grid of hard-edged
 * cells, an LED shift strip, a bar tach, a huge gear, a session clock, values that invert into
 * solid colour when they need you (cold oil / coolant, the shift point). Chakra Petch (open font).
 */
const G = require('./kit/gauges');
const L = require('./lib');

const { withAlpha, clamp, isNum } = L;
const NUM = 'gs_gt_num', TXT = 'gs_gt_txt', GEAR = 'gs_gt_gear';
const Y = '#ffd400', LINE = '#2e2e2e', CELL = '#0b0b0b', COLD = '#1e6fe0';
const ZONES_GT = { cold: COLD, ok: '#25e05a', hot: '#e8231c' };

const palette = Object.assign({}, require('./kit/themes').theme('m_tricolour'), {
    name: 'GT',
    bg: '#000000', panelTop: '#0b0b0b', panelBottom: '#000000', panelEdge: LINE,
    track: '#161616', tick: '#4a4a4a', text: '#ffffff', dim: '#8a8a8a',
    accent: Y, accent2: Y, ok: '#25e05a', warn: '#ffb000', crit: '#ff2020', cold: COLD,
    stripes: [Y], sel: Y, selText: '#000000', marker: Y,
});

/** A cell: black, 2 px rule; label top-left in yellow-grey. fill: solid colour (alarm). */
function cell(cv, x, y, w, h, label, fill) {
    cv.fillRect(x, y, w, h, fill || CELL);
    cv.strokeRoundRect(x + 1, y + 1, w - 2, h - 2, 0, 2, fill ? fill : LINE);
    if (label) cv.text(label, x + 14, y + 26, 17, fill ? '#000000' : '#9a9a9a', { font: TXT, spacing: 1.5, literal: true });
}

function leds(cv, S, cx, y) {
    const n = 15, r = 13, step = 50, x0 = cx - (n - 1) * step / 2;
    const st = L.lights(S, n, Y);
    for (let i = 0; i < n; i++) {
        const x = x0 + i * step, c = st.cols[i], p = st.part[i];
        cv.circle(x, y, r + 3, '#141414');
        cv.circle(x, y, r, withAlpha(c, 0.13));
        if (st.strobe) { if (st.flash) { cv.circle(x, y, r + 7, withAlpha(st.flash, 0.22)); cv.circle(x, y, r, st.flash); } }
        else if (p > 0) { cv.circle(x, y, r + 7, withAlpha(c, 0.18 * p)); cv.circle(x, y, r, withAlpha(c, p)); cv.circle(x - 4, y - 4, 4, withAlpha('#ffffff', 0.35 * p)); }
    }
}

function rpmBar(cv, t, S, x, y, w, h) {
    const f = isNum(S.rpm) ? clamp(S.rpm / S.maxRpm, 0, 1) : 0, lo = (S.shift - S.range) / S.maxRpm, sh = S.shift / S.maxRpm;
    cv.blit(G.layer(['gs-gt-bar', w, h, S.maxRpm, S.shift].join('|'), w, h + 30, (c) => {
        c.fillRect(0, 0, w, h, '#121212');
        c.fillRect(w * sh, 0, w * (1 - sh), h, '#2a0606');
        for (let k = 0; k <= S.maxRpm; k += 500) {
            const x1 = Math.round(w * k / S.maxRpm), major = k % 1000 === 0;
            c.fillRect(Math.min(w - 2, x1), major ? 0 : h * 0.55, 2, major ? h : h * 0.45, '#000000');
            if (major && k > 0 && k < S.maxRpm) c.text(String(k / 1000), x1, h + 26, 20, '#8a8a8a', { align: 'center', font: NUM, literal: true });
        }
    }, cv.textScale), x, y);
    const c = S.strobe ? (S.blink ? '#ff2020' : '#ffffff') : f >= lo ? Y : '#ffffff';
    const fw = w * f;
    // fill between the tick slots so the scale stays readable
    for (let k = 0; k < S.maxRpm; k += 500) {
        const a = w * k / S.maxRpm + 2, b = Math.min(fw, w * (k + 500) / S.maxRpm);
        if (b > a) cv.fillRect(x + a, y + 3, b - a, h - 6, c);
    }
}

module.exports = {
    id: 'gt',
    name: 'GT',
    blurb: 'Race-car data display: LED shift strip, bar tach, huge gear, session clock',
    palette,
    ui: { txt: TXT, num: NUM, size: 21, spacing: 1.5, upper: true, radius: 0, nameFont: TXT, nameSize: 30, nameAlign: 'center' },
    card(cv, t, x, y, w, h) { cell(cv, x, y, w, h); },
    cardBg(cv, t, x, y, w, h) { cv.fillRect(x, y, w, h, '#000000'); },

    swatch(cv, t, x, y, w, h) {
        const n = 9, step = (w - 60) / (n - 1);
        for (let i = 0; i < n; i++) {
            const c = i < 4 ? '#25e05a' : i < 7 ? '#ff2020' : '#2a7dff';
            cv.circle(x + 30 + i * step, y + 30, 9, i < 7 ? c : withAlpha(c, 0.18));
        }
        // the gear's box under the lights, the digit centred in it (by its ink, both ways)
        const by = y + 50, bh = h - 54;
        cv.fillRect(x + 24, by, w - 48, bh, CELL);
        cv.strokeRoundRect(x + 25, by + 1, w - 50, bh - 2, 0, 2, LINE);
        L.inkCentred(cv, '3', x + w / 2, by + bh / 2, Math.round(bh * 1.05), '#ffffff', { font: GEAR });
    },

    /** The G button: the last cell of the peaks row (the same grid as draw's). */
    gRect(S) {
        const ex = Math.max(0, S.h - 456), top = S.y + 128 + Math.round(ex * 0.35), gap = 14, rw = 478;
        const py = top + 128 + gap + 104 + Math.round(ex * 0.2) + gap, pw = (rw - 3 * gap) / 4;
        return { x: S.x + 1576 - pw, y: py, w: pw, h: S.y + S.h - py };
    },
    gButton(cv, t, r, lit, down) {
        const on = lit || down;
        cell(cv, r.x, r.y, r.w, r.h, null, down ? Y : on ? '#2a2600' : null);
        if (lit && !down) cv.strokeRoundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 0, 2, Y);
        const h = 28, bw = L.badgeWidth(h);
        L.badge(cv, r.x + (r.w - bw) / 2, r.y + (r.h + h) / 2, h, down ? '#000000' : undefined);
    },

    /** Where the Spotify panel goes (setting "panel"): the right column (session, g, peaks; the G stays). */
    panelRect(S) {
        const ex = Math.max(0, S.h - 456), top = S.y + 128 + Math.round(ex * 0.35), x = S.x + 478 + 592 + 28;
        return { x: x, y: top, w: 478, h: S.y + S.h - top };
    },

    draw(cv, S) {
        // laid out for a 456 px box; a taller one (full screen) goes mostly to the cells
        const t = S.t, x0 = S.x, y0 = S.y, W = 1576, ex = Math.max(0, S.h - 456);
        leds(cv, S, x0 + W / 2, y0 + 18 + ex * 0.1);
        rpmBar(cv, t, S, x0, y0 + 46 + Math.round(ex * 0.15), W, 40 + Math.round(ex * 0.15));

        const top = y0 + 128 + Math.round(ex * 0.35), H = S.y + S.h - top, gap = 14, sh = 186 + Math.round(ex * 0.25);
        const cw = [478, 592, 478], cx = [x0, x0 + cw[0] + gap, x0 + cw[0] + cw[1] + 2 * gap];

        // left: speed, then oil and coolant (they turn solid blue until warm)
        cell(cv, cx[0], top, cw[0], sh, 'SPEED');
        cv.text(S.unit, cx[0] + cw[0] - 14, top + 26, 17, '#9a9a9a', { align: 'right', font: TXT, spacing: 1.5, literal: true });
        cv.text(isNum(S.speed) ? String(Math.round(S.speed)) : '---', cx[0] + cw[0] - 22, top + sh - 18, 132 + ex * 0.3, '#ffffff', { align: 'right', font: NUM, literal: true });
        const hw = (cw[0] - gap) / 2, ty = top + sh + gap, th = H - sh - gap;
        // 0.11.0: temperature zones (lib.js TEMP_ZONES): the cell solid blue when cold, solid red when too hot,
        // a green dot when normal; a zone strip along its foot, lit to the value
        [['OIL °F', S.oil], ['WATER °F', S.cool]].forEach((p, i) => {
            const v = p[1], x = cx[0] + i * (hw + gap), zg = L.tempGauge(v, ZONES_GT, '#1a1a1a', 0.35), fill = zg.zone === 'cold' || zg.zone === 'hot' ? zg.on : null;
            cell(cv, x, ty, hw, th, p[0], fill);
            cv.text(isNum(v.f) ? String(Math.round(v.f)) : '--', x + hw - 16, ty + th - 24, 62, zg.zone ? '#ffffff' : '#8a8a8a', { align: 'right', font: NUM, literal: true });
            if (zg.zone === 'ok') cv.circle(x + 22, ty + th - 42, 7, zg.on);
            if (fill) cv.text(zg.zone === 'cold' ? 'COLD' : 'HOT', x + 14, ty + th - 28, 17, '#ffffff', { font: TXT, spacing: 1.5, literal: true });
            const sx = x + 10, sw = hw - 20, sy = ty + th - 12, n = 16, g2 = 2, bw = (sw - g2 * (n - 1)) / n;
            cv.fillRect(sx - 2, sy - 2, sw + 4, 9, '#000000');
            for (let k = 0; k < n; k++) cv.fillRect(sx + k * (bw + g2), sy, bw, 5, zg.seg((k + 0.5) / n));
            if (zg.zone) cv.fillRect(sx + zg.pos * sw - 1.5, sy - 3, 3, 11, '#ffffff');
        });

        // centre: the gear (the whole cell flashes at the shift point), rpm under it
        const flash = S.strobe && S.blink;
        cell(cv, cx[1], top, cw[1], H, 'GEAR', flash ? (S.lightStyle === 'f1' ? '#2a7dff' : '#ff2020') : null);
        let estX = cx[1] + cw[1] - 14;
        if (S.mode) {
            // the drive mode: an inverted tag in the cell's corner, red for SPORT+, yellow for SPORT
            const fill = { 'sport+': '#ff2020', track: '#ff2020', sport: Y }[S.modeTone] || '#d8d8d8';
            const tw = cv.textWidth(S.mode, 17, { font: TXT, spacing: 1.5, literal: true }), w = tw + 20;
            const tx = cx[1] + cw[1] - 8 - w;
            cv.fillRect(tx, top + 8, w, 26, flash ? '#000000' : fill);
            cv.text(S.mode, tx + 10, top + 27, 17, flash ? fill : '#000000', { font: TXT, spacing: 1.5, literal: true });
            estX = tx - 12;
        }
        if (S.guessed) cv.text('EST', estX, top + 26, 17, flash ? '#000000' : '#9a9a9a', { align: 'right', font: TXT, spacing: 1.5, literal: true });
        cv.text(S.gearText, cx[1] + cw[1] / 2, top + H - 64 - ex * 0.05, 250 + ex * 0.45, flash ? '#000000' : '#ffffff', { align: 'center', font: GEAR, literal: true });
        cv.fillRect(cx[1] + 14, top + H - 52, cw[1] - 28, 2, flash ? '#000000' : LINE);
        cv.text('RPM', cx[1] + 14, top + H - 16, 17, flash ? '#000000' : '#9a9a9a', { font: TXT, spacing: 1.5, literal: true });
        cv.text(isNum(S.rpm) ? String(Math.round(S.rpm / 10) * 10) : '----', cx[1] + cw[1] - 16, top + H - 12, 34, flash ? '#000000' : S.strobe ? '#ff2020' : '#ffffff', { align: 'right', font: NUM, literal: true });

        // the favourite looks' tap zones (main.js): the speed cell, and the gear cell above its rpm line
        const uw = cv.textWidth(S.unit, 17, { font: TXT, spacing: 1.5, literal: true });
        S.zones = {
            gear: { x: cx[1], y: top, w: cw[1], h: H - 56 }, speed: { x: cx[0], y: top, w: cw[0], h: sh },
            toast: { x: cx[0] + cw[0] / 2, y: top + sh + 8 }, chip: { x: cx[1] + cw[1] - 26, y: top + H - 78 },
            star: { x: cx[0] + cw[0] - 14 - uw - 18, y: top + 20 },
        };

        // right: session clock, live g, peaks (or the Spotify panel there)
        if (S.panel === 'spotify') return;
        const rx = cx[2], rw = cw[2];
        cell(cv, rx, top, rw, 128, 'SESSION');
        cv.text('TOP ' + (isNum(S.peak.speed) ? Math.round(S.peak.speed) : 0), rx + rw - 14, top + 26, 17, Y, { align: 'right', font: TXT, spacing: 1.5, literal: true });
        cv.text(L.clock(S.session), rx + rw - 18, top + 108, 70, Y, { align: 'right', font: NUM, literal: true });
        L.sessionTap(cv, S, rx, top, rw, 128, Y);          // a tap on the cell: the clock back to 0
        const gy = top + 128 + gap, gh = 104 + Math.round(ex * 0.2);
        cell(cv, rx, gy, rw, gh, 'G');
        // a small friction circle in the cell
        const fx = rx + 70, fy = gy + gh / 2 + 6, fr = 38;
        cv.arc(fx, fy, fr - 1, fr + 1, 0, 360, '#3a3a3a'); cv.line(fx - fr, fy, fx + fr, fy, 1, '#2a2a2a'); cv.line(fx, fy - fr, fx, fy + fr, 1, '#2a2a2a');
        if (isNum(S.gLat) && isNum(S.gLong)) cv.circle(fx + clamp(S.gLat / S.gMax, -1, 1) * fr, fy - clamp(S.gLong / S.gMax, -1, 1) * fr, 7, Y);
        [['LAT', S.gLat], ['LONG', S.gLong]].forEach((p, i) => {
            const x = rx + 150 + i * 160;
            cv.text(p[0], x, gy + gh - 52, 17, '#9a9a9a', { font: TXT, spacing: 1.5, literal: true });
            cv.text(isNum(p[1]) ? (p[1] < 0 ? '-' : '') + Math.abs(p[1]).toFixed(2) : '-.--', x, gy + gh - 14, 40, '#ffffff', { font: NUM, literal: true });
        });
        // peaks: three cells, the fourth is the G (the settings button: gRect, gButton)
        const py = gy + gh + gap, ph = top + H - py, pw = (rw - 3 * gap) / 4;
        [['PK ACC', S.peak.acc], ['PK BRK', S.peak.brk], ['PK LAT', S.peak.lat]].forEach((p, i) => {
            const x = rx + i * (pw + gap);
            cell(cv, x, py, pw, ph, p[0]);
            cv.text(p[1].toFixed(2), x + pw - 12, py + ph - 14, 34, '#ffffff', { align: 'right', font: NUM, literal: true });
        });
    },
};
