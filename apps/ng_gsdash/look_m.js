'use strict';
/**
 * M Style - after a modern M car's curved display in its sport view: graphite, wide italic numerals
 * (Saira Expanded, open font), a rising wedge of slanted rpm segments, a carbon gear tile with
 * tricolour stripes, a fine-line g-meter. Tricolour = light blue / dark blue / red (no logos).
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
    cv.fillRect(x, y, w, h, '#0c0d10');
    for (let j = 0; j * s < h; j++) {
        for (let i = 0; i * s < w; i++) {
            if (((i + (j >> 1)) & 1) === 0) continue;
            cv.fillRect(x + i * s, y + j * s, Math.min(s, w - i * s), Math.min(s, h - j * s), '#121419');
        }
    }
}

/** The rpm wedge: one slanted segment per 250 rpm, rising in height to the right. */
function tach(cv, t, S, x, base, w) {
    const n = S.maxRpm / 250, gap = 7, sw = (w - gap * (n - 1) - K * 60) / n;
    const L8 = L.lights(S, 10, LB);
    const lo = S.shift - S.range;
    for (let i = 0; i < n; i++) {
        const r0 = i * 250, f = i / (n - 1), h = 26 + 34 * f * f;
        const sx = x + i * (sw + gap), on = isNum(S.rpm) && S.rpm > r0;
        let c = r0 >= S.redline ? '#2a0c0e' : t.track;
        if (on) {
            if (r0 >= lo) {
                const k = clamp(Math.floor((r0 - lo) / S.range * 10), 0, 9);
                c = L8.cols[k];
            } else c = '#e6eaef';
            if (S.strobe) c = L8.flash || '#3a0d10';
        }
        L.slant(cv, sx, base - h, sw, h, K, c);
    }
    // numbers under every 1000
    for (let k = 0; k * 1000 <= S.maxRpm; k++) {
        const i = Math.min(n - 1, k * 4), sx = x + i * (sw + gap);
        cv.text(String(k), sx + sw / 2 - 2, base + 34, 22, k * 1000 >= S.redline ? RD : t.dim, { align: 'center', font: NUM, literal: true });
    }
}

function gmeter(cv, t, S, cx, cy, r) {
    const max = S.gMax;
    cv.blit(G.layer(['gs-m-gm', r, max].join('|'), 2 * r + 120, 2 * r + 20, (c) => {
        const x = r + 10, y = r + 10;
        for (let q = 0.5; q <= max + 1e-6; q += 0.5) {
            const rr = q / max * r;
            c.arc(x, y, rr - 0.75, rr + 0.75, 0, 360, q % 1 === 0 ? '#3a404a' : '#23272e');
        }
        c.line(x - r - 8, y, x + r + 8, y, 1, '#3a404a');
        c.line(x, y - r - 8, x, y + r + 8, 1, '#3a404a');
        c.text(max.toFixed(1), x + r * 0.72 + 6, y - r * 0.72, 16, t.dim, { font: LT, literal: true });
    }, cv.textScale), cx - r - 10, cy - r - 10);
    const P = (lat, lon) => [cx + clamp(lat / max, -1.08, 1.08) * r, cy - clamp(lon / max, -1.08, 1.08) * r];
    S.trail.forEach((p, i) => { if (isNum(p[0]) && isNum(p[1])) { const q = P(p[0], p[1]); cv.circle(q[0], q[1], 3, withAlpha(LB, 0.08 + 0.45 * i / S.trail.length)); } });
    const lat = G.smooth('gs-m-lat', S.gLat, 12), lon = G.smooth('gs-m-lon', S.gLong, 12);
    if (isNum(lat) && isNum(lon)) {
        const q = P(lat, lon);
        cv.circle(q[0], q[1], 11, '#060709');
        cv.circle(q[0], q[1], 8, '#ffffff');
    }
}

/** A temperature as a row of small slanted segments filling up to the ready point. */
function temp(cv, t, x, y, w, label, v) {
    const n = 16, gap = 4, sw = (w - gap * (n - 1) - K * 14) / n;
    const f = isNum(v.f) ? clamp((v.f - 100) / Math.max(1, v.thr - 100), 0, 1) : 0;
    const c = v.ok === true ? '#eef1f5' : LB;
    cv.text(label, x, y - 14, 15, t.dim, { font: TXT, spacing: 3, literal: true });
    cv.text(isNum(v.f) ? Math.round(v.f) + '°F' : '--', x + w, y - 12, 26, v.ok === true ? t.text : v.ok === false ? LB : t.dim, { align: 'right', font: NUM, literal: true });
    for (let i = 0; i < n; i++) L.slant(cv, x + i * (sw + gap), y, sw, 14, K, isNum(v.f) && (i + 0.5) / n <= f ? c : t.track);
}

/** The fuel level (Bottom bars: Fuel): one slanted segment bar across both slots, red at the car's low level. */
function fuelBar(cv, t, x, y, w, F) {
    const ft = L.fuelText(F), n = 32, gap = 4, sw = (w - gap * (n - 1) - K * 14) / n, c = ft.low ? RD : '#eef1f5';
    cv.text('FUEL', x, y - 14, 15, t.dim, { font: TXT, spacing: 3, literal: true });
    const vx = x + w;
    cv.text(ft.value, vx, y - 12, 26, ft.low ? RD : ft.has ? t.text : t.dim, { align: 'right', font: NUM, literal: true });
    if (ft.range) {
        const vw = cv.textWidth(ft.value, 26, { font: NUM, literal: true });
        cv.text(ft.range, vx - vw - 22, y - 14, 15, t.dim, { align: 'right', font: TXT, spacing: 3, literal: true });
    }
    for (let i = 0; i < n; i++) L.slant(cv, x + i * (sw + gap), y, sw, 14, K, ft.f !== null && (i + 0.5) / n <= ft.f ? c : t.track);
}

/**
 * The drive mode as a slanted tag with the tricolour stripes in front: filled red / blue for SPORT+ /
 * SPORT. The whole group (stripes and tag) is centred on cx, its bottom at y; h: its height.
 */
function modeTag(cv, t, cx, y, h, S) {
    if (!S.mode) return;
    const size = h >= 30 ? 20 : 17, fill = { 'sport+': RD, track: RD, sport: DB }[S.modeTone];
    const tw = cv.textWidth(S.mode, size, { font: NUM, spacing: 2, literal: true }), w = tw + 40;
    // the stripes start 34 px left of the tag; the tag's slant reaches K * h right of its bottom
    const x = Math.round(cx - (w + K * h - 34) / 2);
    if (fill) L.slant(cv, x, y - h, w, h, K, fill);
    else { L.slant(cv, x, y - h, w, h, K, '#2c313a'); L.slant(cv, x + 2, y - h + 2, w - 4, h - 4, K, '#0b0c0f'); }
    tricolour(cv, x - 34, y - h, h, 6, 3);
    cv.text(S.mode, x + 20 + K * h / 2, y - Math.round(h * 0.23), size, fill ? '#ffffff' : t.text, { font: NUM, spacing: 2, literal: true });
}

module.exports = {
    id: 'm',
    name: 'M Style',
    blurb: 'Graphite and tricolour, wide italic numerals, a rising rpm wedge',
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

    /** Where the Spotify panel goes (setting "panel"): the peaks and the g-meter, right of the speed. */
    panelRect(S) {
        const ex = Math.max(0, S.h - 456), y0 = S.y + Math.round(ex * 0.12), y = y0 + 132 + Math.round(ex * 0.15), x = S.x + 1000;
        return { x: x, y: y, w: S.x + S.w - x, h: S.y + S.h - y };
    },

    draw(cv, S) {
        // laid out for a 456 px box; a taller one (full screen): the hero row moves down and grows
        const t = S.t, x0 = S.x, ex = Math.max(0, S.h - 456), y0 = S.y + Math.round(ex * 0.12), m = Math.round(ex * 0.4);
        // rpm wedge across the top
        tach(cv, t, S, x0 + 40, y0 + 66, 1496);

        // gear tile: carbon, chamfered, tricolour on top; flashes red at the shift point
        const gx = x0 + 40, gy = y0 + 132 + Math.round(ex * 0.15), gw = 300, gh = 228 + Math.round(ex * 0.3);
        cv.blit(G.layer('gs-m-tile|' + gw + '|' + gh, gw, gh, (c) => {
            carbon(c, 0, 0, gw, gh);
            c.gradientRect(0, 0, gw, gh, [[0, withAlpha('#ffffff', 0.04)], [1, withAlpha('#000000', 0.5)]]);
            // cut the top-right corner back to the background
            c.quad([[gw - 34, 0], [gw, 0], [gw, 34], [gw, 34]], '#08090c');
            c.line(gw - 34, 0, gw, 34, 1.5, '#2c313a');
            c.fillRect(0, 0, gw - 34, 1.5, '#2c313a'); c.fillRect(0, 0, 1.5, gh, '#2c313a');
            c.fillRect(gw - 1.5, 34, 1.5, gh - 34, '#2c313a'); c.fillRect(0, gh - 1.5, gw, 1.5, '#2c313a');
        }, cv.textScale), gx, gy);
        tricolour(cv, gx + 20, gy + 18, 14, 18, 5);
        cv.text('GEAR', gx + 104, gy + 31, 15, t.dim, { font: TXT, spacing: 4, literal: true });
        if (S.guessed) cv.text('EST', gx + gw - 52, gy + 64, 15, t.dim, { align: 'right', font: TXT, spacing: 3, literal: true });
        const gcol = S.strobe ? (S.blink ? RD : '#eef1f5') : '#eef1f5';
        cv.text(S.gearText, gx + gw / 2 + 6, gy + gh - 30 - ex * 0.05, 172 + ex * 0.3, gcol, { align: 'center', font: GEAR, literal: true });

        // speed: the hero
        const sx = x0 + 700;
        cv.text(isNum(S.speed) ? String(Math.round(S.speed)) : '--', sx, y0 + 300 + m, 172 + ex * 0.4, t.text, { align: 'center', font: NUM, literal: true });
        const unitY = y0 + 346 + m;
        cv.text(S.unit, sx, unitY, 18, t.dim, { align: 'center', font: TXT, spacing: 8, literal: true });
        cv.text(L.rpmText(S.rpm) + '  RPM', sx, y0 + 156 + ex * 0.15, 22, t.dim, { align: 'center', font: LT, spacing: 3, literal: true });

        // peaks, then the g-meter (or the Spotify panel there)
        if (S.panel !== 'spotify') this.gPart(cv, S, t, x0, y0, ex, m);

        // bottom: warm-up. The two bars spread evenly (outer margins = the gap between them) across the
        // space left of the right panel (Spotify or the peaks / g-meter), x0 + 1000, inset 40 px each side
        const by = S.y + S.h - 28, line = by - 44;
        const tw = 330, wl = x0 + 40, wr = x0 + 1000 - 40, tg = Math.round((wr - wl - 2 * tw) / 3);
        const ox = wl + tg, cx2 = ox + tw + tg;
        cv.fillRect(ox, line, cx2 + tw - ox, 1, '#1e2128');
        if (S.bars === 'fuel') fuelBar(cv, t, ox, by, cx2 + tw - ox, S.fuel);
        else { temp(cv, t, ox, by, tw, 'OIL', S.oil); temp(cv, t, cx2, by, tw, 'COOLANT', S.cool); }
        // the drive mode: under the speed's unit, centred on the speed, midway between it and the warm-up
        // rule (clear of the Spotify panel, which starts at x0 + 1000); smaller where that gap is tight
        const th = line - unitY >= 56 ? 30 : 24;
        modeTag(cv, t, sx, Math.round((unitY + line + th) / 2), th, S);
    },
    gPart(cv, S, t, x0, y0, ex, m) {
        const px = x0 + 1190, gcx = x0 + 1384, gcy = y0 + 250 + m * 0.7, gr = 118 + ex * 0.2;
        [['ACCEL', S.peak.acc], ['BRAKE', S.peak.brk], ['LATERAL', S.peak.lat]].forEach((p, i) => {
            const y = y0 + 170 + m * 0.4 + i * (70 + ex * 0.2);
            cv.text(p[0], px, y, 14, t.dim, { align: 'right', font: TXT, spacing: 3, literal: true });
            cv.text(p[1].toFixed(2), px, y + 38, 36, i === 1 ? '#eef1f5' : '#eef1f5', { align: 'right', font: NUM, literal: true });
        });
        cv.fillRect(px + 22, y0 + 150 + m * 0.4, 1, 200 + ex * 0.4, '#22262d');
        gmeter(cv, t, S, gcx, gcy, gr);
        const tot = isNum(S.gLat) && isNum(S.gLong) ? Math.sqrt(S.gLat * S.gLat + S.gLong * S.gLong) : null;
        cv.text(tot == null ? '-.-- G' : tot.toFixed(2) + ' G', gcx, gcy + gr + 42, 26, t.text, { align: 'center', font: NUM, literal: true });
    },
};
