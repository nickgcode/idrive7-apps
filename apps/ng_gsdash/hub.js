'use strict';
/**
 * hub.js - G's Dash's screens besides Drive (the look's own dash, main.js): Showcase, Warm-up,
 * G-force and Tires, switched by a horizontal swipe (main.js), page dots beside the G button. Each
 * screen draws with the current look's palette, fonts and plates, so a look carries across.
 * Car data only: a value the car hasn't sent shows "--", never a made-up one.
 * Node 8: no ?., no ??, no object spread.
 */
const L = require('./lib');
const G = require('./kit/gauges');
const { withAlpha, isNum } = L;

// left to right as the swipe goes; the app opens on HOME (Drive), second: Showcase is a swipe right of it
const SCREENS = [['showcase', 'Showcase'], ['drive', 'Drive'], ['warmup', 'Warm-up'], ['gforce', 'G-force'], ['tires', 'Tires']];
const HOME = 'drive';
const GREEN = '#2fd27a';

/* ---------- look adapter ---------- */
function style(lk, t0) {
    const u = lk.ui, t = Object.assign({ cold: '#5aa9ff', warn: '#ffb020', crit: '#ff3b30', track: withAlpha('#ffffff', 0.12) }, t0);
    const up = (s) => (u.upper ? String(s).toUpperCase() : String(s));
    return {
        t, u, up,
        txt: (cv, s, x, y, size, c, o) => cv.text(up(s), x, y, size, c, Object.assign({ font: u.lbl || u.txt, spacing: u.upper ? u.spacing : 0, literal: true }, o || {})),
        txtW: (cv, s, size, o) => cv.textWidth(up(s), size, Object.assign({ font: u.lbl || u.txt, spacing: u.upper ? u.spacing : 0, literal: true }, o || {})),
        num: (cv, s, x, y, size, c, o) => cv.text(String(s), x, y, size, c, Object.assign({ font: u.num, literal: true }, o || {})),
        numW: (cv, s, size) => cv.textWidth(String(s), size, { font: u.num, literal: true }),
        plate: (cv, x, y, w, h, accent) => {
            if (lk.panelPlate) { lk.panelPlate(cv, t, x, y, w, h); return; }
            cv.roundRect(x, y, w, h, u.radius, withAlpha('#ffffff', 0.035));
            cv.strokeRoundRect(x, y, w, h, u.radius, 1, withAlpha('#ffffff', 0.10));
            if (accent) cv.roundRect(x + 14, y, 46, 3, 1.5, accent);
        },
        r: u.radius,
    };
}

/* ---------- small parts ---------- */
function pill(cv, st, x, y, text, c, o) {
    o = o || {};
    const size = o.size || 18, tw = st.txtW(cv, text, size), h = o.h || 34, dot = o.dot !== false;
    const w = tw + (dot ? 46 : 28) + (o.extraW || 0);
    const X = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    cv.roundRect(X, y, w, h, Math.min(h / 2, st.r + 6), withAlpha(c, o.fill || 0.16));
    if (o.ring) cv.strokeRoundRect(X, y, w, h, Math.min(h / 2, st.r + 6), 1.5, withAlpha(c, 0.7));
    if (dot) cv.circle(X + 19, y + h / 2, 6, c);
    st.txt(cv, text, X + (dot ? 34 : 14), y + h / 2 + size * 0.36, size, o.textColor || c);
    return { x: X, w };
}
function title(cv, st, S, name, sub) {
    st.txt(cv, name, S.x + 8, S.y + 30, 24, st.t.text);
    if (sub) st.txt(cv, sub, S.x + 8 + st.txtW(cv, name, 24) + 18, S.y + 30, 16, st.t.dim);
}

/** Page dots: a compact pill left of the G button, the current one a lit bar. Returns its rect. */
const dotsW = (n) => 22 + (n - 1) * 24 + 30 + 2;
/** The G button with the page dots left of it: what a panel beside them keeps clear of. */
const dotsBox = (gr, n) => ({ x: gr.x - 18 - dotsW(n), y: gr.y, w: gr.w + 18 + dotsW(n), h: gr.h });
function dots(cv, st, gr, idx, n, above) {
    const d = 10, gap = 14, cur = 30, w = dotsW(n), h = 30;
    // left of the G; above it (right aligned) where the look has its own readouts there
    const x = above ? gr.x + gr.w - w : gr.x - 18 - w, y = above ? gr.y - h - 10 : gr.y + (gr.h - h) / 2;
    cv.roundRect(x, y, w, h, h / 2, withAlpha('#000000', 0.35));
    cv.strokeRoundRect(x, y, w, h, h / 2, 1, withAlpha('#ffffff', 0.10));
    let px = x + 11;
    for (let i = 0; i < n; i++) {
        const on = i === idx, ww = on ? cur : d;
        cv.roundRect(px, y + h / 2 - d / 2, ww, d, d / 2, on ? (st.t.sel || st.t.accent) : withAlpha(st.t.text, 0.28));
        px += ww + gap;
    }
    return { x, y, w, h };
}

/** A short-lived label when the screen changes (or the auto-jump fires). */
function toast(cv, st, S, text, age, sub, at) {
    if (age > 2600) return;
    const a = age < 2200 ? 1 : 1 - (age - 2200) / 400;
    cv.alpha(a);
    const size = 16, tw = st.txtW(cv, text, size), sw = sub ? st.txtW(cv, sub, 14) : 0, w = tw + (sub ? sw + 24 : 0) + 56, h = 30;
    const x = (at ? at.cx : 800) - w / 2, y = at ? at.y : S.y + 2;
    cv.roundRect(x, y, w, h, h / 2, withAlpha('#000000', 0.72));
    cv.strokeRoundRect(x, y, w, h, h / 2, 1.5, withAlpha(GREEN, 0.75));
    cv.circle(x + 18, y + h / 2, 6, GREEN);
    st.txt(cv, text, x + 32, y + 21, size, GREEN);
    if (sub) st.txt(cv, sub, x + 32 + tw + 20, y + 20, 14, st.t.dim);
    cv.alpha(1);
}

/* ---------- warm-up ---------- */
/** Temperature arc (270 deg): ramp cold blue -> warm white -> ready green, the ready mark. */
function tempArc(cv, st, cx, cy, r, g) {
    const t = st.t, th = 24, A0 = -135, SPAN = 270, v = g.value;
    const f = (x) => Math.max(0, Math.min(1, (x - g.min) / (g.max - g.min)));
    cv.arc(cx, cy, r - th, r, A0, A0 + SPAN, t.track, { round: true });
    const ready = isNum(v) && v >= g.ready;
    if (isNum(v)) {
        const a1 = A0 + SPAN * Math.max(0.01, f(v));
        if (ready) cv.arc(cx, cy, r - th - 6, r + 6, A0, a1, withAlpha(GREEN, 0.18), { round: true });
        cv.arc(cx, cy, r - th, r, A0, a1, ready ? GREEN : t.cold, ready ? { round: true } : { round: true, ramp: [t.cold, t.cold, '#e8f1ff', '#ffd27a'], rampFrom: A0, rampTo: A0 + SPAN * f(g.ready) });
    }
    // the ready mark: a tick across the track and its temperature outside
    const am = (A0 + SPAN * f(g.ready)) * Math.PI / 180, sx = Math.sin(am), sy = -Math.cos(am);
    cv.line(cx + sx * (r - th - 8), cy + sy * (r - th - 8), cx + sx * (r + 10), cy + sy * (r + 10), 4, ready ? GREEN : t.text);
    st.num(cv, String(g.ready), cx + sx * (r + 34), cy + sy * (r + 34) + 8, 20, t.dim, { align: sx > 0.2 ? 'left' : sx < -0.2 ? 'right' : 'center' });
    // centre: the temperature, label, state
    const big = Math.round(r * 0.62), s = isNum(v) ? String(Math.round(v)) : '--', w = st.numW(cv, s, big);
    st.num(cv, s, cx - 12, cy + big * 0.30, big, isNum(v) ? t.text : t.dim, { align: 'center' });
    st.num(cv, '°F', cx - 12 + w / 2 + 6, cy + big * 0.30 - big * 0.42, 26, t.dim);
    st.txt(cv, g.label, cx, cy - big * 0.52, 20, t.dim, { align: 'center' });
    const stt = ready ? 'Ready' : g.eta;
    if (stt) st.txt(cv, stt, cx, cy + r * 0.62, 18, ready ? GREEN : isNum(v) ? t.warn : t.dim, { align: 'center' });
    st.txt(cv, g.foot, cx, cy + r + 24, 16, t.dim, { align: 'center' });
}

/** The temporary rev limit: a segmented tach, lit up to the limit, the rest locked (hatched). */
function revLimit(cv, st, x, y, w, M, S) {
    const t = st.t, max = S.maxRpm, red = S.redline, has = isNum(M.limit), lim = has ? M.limit : 0, full = has && lim >= red;
    st.txt(cv, full ? 'Rev limit' : 'Warm-up rev limit', x, y + 18, 18, t.dim);
    const big = 132, s = has ? String(lim) : '--', bw = st.numW(cv, s, big);
    st.num(cv, s, x - 4, y + 34 + big * 0.74, big, full ? GREEN : has ? t.text : t.dim);
    st.txt(cv, 'rpm', x + bw + 10, y + 34 + big * 0.74, 22, t.dim);
    if (!has) pill(cv, st, x + w, y, 'No oil temp', t.dim, { align: 'right', size: 16, h: 30 });
    else if (!full) pill(cv, st, x + w, y, 'Rising', t.warn, { align: 'right', size: 16, h: 30 });
    else pill(cv, st, x + w, y, 'Full revs', GREEN, { align: 'right', size: 16, h: 30 });
    // the bar
    const by = y + 196, bh = 46, step = 250, n = max / step, gap = 3, sw = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
        const r0 = i * step, sx = x + i * (sw + gap);
        if (r0 < lim) {
            const c = r0 >= red ? t.crit : full ? GREEN : r0 >= lim - 750 ? t.warn : t.text;
            cv.fillRect(sx, by, sw, bh, c);
        } else if (r0 < red) {
            cv.fillRect(sx, by, sw, bh, withAlpha('#ffffff', 0.06));
            cv.line(sx, by + bh, sx + sw, by, 1.5, withAlpha('#ffffff', 0.13));
        } else cv.fillRect(sx, by, sw, bh, withAlpha(t.crit, 0.22));
    }
    // limit marker and redline post
    const lx = x + (lim / max) * w - gap / 2;
    if (has && !full) {
        cv.fillRect(lx - 2, by - 14, 4, bh + 28, t.warn);
        cv.quad([[lx - 9, by - 24], [lx + 9, by - 24], [lx, by - 12], [lx, by - 12]], t.warn);
    }
    const rx = x + (red / max) * w - gap / 2;
    cv.fillRect(rx - 1.5, by - 6, 3, bh + 12, t.crit);
    for (let k = 0; k <= max / 1000; k++) st.num(cv, String(k), x + (k * 1000 / max) * w, by + bh + 28, 20, k * 1000 >= red ? t.crit : t.dim, { align: k === 0 ? 'left' : k * 1000 === max ? 'right' : 'center' });
    st.txt(cv, full ? 'Oil warm: the whole rev range is yours' : has ? 'Rises with oil temperature to ' + red + ' rpm at ' + M.fullAt + '°F'
        : 'Waiting for the oil temperature', x, by + bh + 64, 17, t.dim);
}

function warmup(cv, st, S, M) {
    const t = st.t, ready = M.ready, known = isNum(M.oil) || isNum(M.cool);
    title(cv, st, S, 'Warm-up', M.oil === null && M.cool === null ? 'No engine temperatures yet' : '');
    // status, top right of the rev area
    if (ready) {
        const pulse = 0.5 + 0.5 * Math.sin(S.now / 380);
        cv.roundRect(1110, S.y + 4, 478, 64, st.r + 6, withAlpha(GREEN, 0.14 + 0.08 * pulse));
        cv.strokeRoundRect(1110, S.y + 4, 478, 64, st.r + 6, 2, GREEN);
        st.txt(cv, 'Ready', 1349, S.y + 50, 40, GREEN, { align: 'center', spacing: 8 });
    } else {
        const c = known ? t.warn : t.dim;
        cv.roundRect(1110, S.y + 4, 478, 64, st.r + 6, withAlpha(c, 0.10));
        cv.strokeRoundRect(1110, S.y + 4, 478, 64, st.r + 6, 1.5, withAlpha(c, 0.6));
        st.txt(cv, known ? 'Warming up' : 'No data', 1349, S.y + 46, 30, c, { align: 'center', spacing: 5 });
    }
    const cy = S.y + 262;
    tempArc(cv, st, 252, cy, 172, { value: M.oil, min: 40, max: 240, ready: M.oilReady, label: 'Oil', eta: M.oilEta, foot: 'Oil ready at ' + M.oilReady + '°F' });
    tempArc(cv, st, 662, cy, 172, { value: M.cool, min: 40, max: 240, ready: M.coolReady, label: 'Coolant', eta: M.coolEta, foot: 'Coolant ready at ' + M.coolReady + '°F' });
    st.plate(cv, 900, S.y + 92, 688, 340, ready ? GREEN : known ? t.warn : null);
    revLimit(cv, st, 930, S.y + 116, 628, M, S);
    // the auto-jump, bottom left
    const by = S.y + S.h - 40;
    if (M.auto && !ready) {
        const p = pill(cv, st, S.x + 4, by, 'Auto: Drive opens when warm', t.dim, { size: 16, h: 34, fill: 0.10 });
        st.txt(cv, 'Swipe to leave any time', p.x + p.w + 16, by + 23, 15, withAlpha(t.dim, 0.8));
    } else if (M.auto && ready) {
        const p = pill(cv, st, S.x + 4, by, 'Opening Drive in ' + M.countdown + ' s', GREEN, { size: 16, h: 34, ring: true });
        const f = 1 - M.countdown / 5;
        cv.roundRect(p.x + 14, by + 31, (p.w - 28) * f, 3, 1.5, GREEN);
        st.txt(cv, 'Swipe to stay here', p.x + p.w + 16, by + 23, 15, withAlpha(t.dim, 0.8));
    }
}

/* ---------- g-force ---------- */
function gforce(cv, st, S, M, music, gr, lk) {
    const t = st.t, cx = 352, cy = S.y + 268, r = 206, max = S.gMax;
    title(cv, st, S, 'G-force', 'Peak hold this session · hold to reset');
    G.gmeter(cv, t, cx, cy, r, { lat: M.lat, long: M.long, max, trail: M.trail });
    // peak hold: the furthest the dot went in each direction, as a filled outline
    const P = (lat, lon) => [cx + Math.max(-1.1, Math.min(1.1, lat / max)) * r, cy - Math.max(-1.1, Math.min(1.1, lon / max)) * r];
    const env = M.envelope, n = env.length, pts = [];
    for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; pts.push(P(Math.sin(a) * env[i], Math.cos(a) * env[i])); }
    const hc = t.accent2 || t.accent, any = env.some((e) => e > 0.02);
    if (any) {
        for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; cv.quad([[cx, cy], a, b, [cx, cy]], withAlpha(hc, 0.10)); }
        cv.polyline(pts.concat([pts[0]]), 3, withAlpha(hc, 0.9));
        // the four peaks as markers on the outline
        [[0, M.peak.acc], [Math.PI, M.peak.brk], [-Math.PI / 2, M.peak.left], [Math.PI / 2, M.peak.right]].forEach((p) => {
            if (!(p[1] > 0.02)) return;
            const q = P(Math.sin(p[0]) * p[1], Math.cos(p[0]) * p[1]);
            cv.circle(q[0], q[1], 7, t.bg); cv.circle(q[0], q[1], 5, hc);
        });
    }
    // peak tiles
    const tx = 640, tw = 300, th = 98, tg = 14;
    [['Accel', M.peak.acc, ''], ['Brake', M.peak.brk, ''], ['Left', M.peak.left, ''], ['Right', M.peak.right, '']].forEach((p, i) => {
        const y = S.y + 54 + i * (th + tg);
        st.plate(cv, tx, y, tw, th);
        st.txt(cv, p[0], tx + 18, y + 30, 17, t.dim);
        st.txt(cv, 'Peak', tx + tw - 18, y + 30, 14, withAlpha(t.dim, 0.7), { align: 'right' });
        const has = isNum(p[1]) && M.live, v = has ? p[1].toFixed(2) : '--';
        st.num(cv, v, tx + 18, y + 84, 50, has ? hc : t.dim);
        st.txt(cv, 'g', tx + 18 + st.numW(cv, v, 50) + 8, y + 84, 22, t.dim);
        const bw = tw - 36, f = has ? Math.min(1, p[1] / max) : 0;
        cv.roundRect(tx + 18, y + th - 9, bw, 4, 2, t.track);
        cv.roundRect(tx + 18, y + th - 9, Math.max(4, bw * f), 4, 2, hc);
    });
    st.txt(cv, 'Session ' + M.session, tx, S.y + S.h - 14, 15, t.dim);
    // right: Spotify panel (setting), else live readouts
    const rx = 980, rw = S.x + S.w - rx;
    if (S.panel === 'spotify' && music) {
        music.panel(cv, S, lk, { x: rx, y: S.y + 54, w: rw, h: S.h - 54 - 92 }, gr);
        return;
    }
    const ph = S.h - 54 - 92;
    st.plate(cv, rx, S.y + 54, rw, ph);
    st.txt(cv, 'Now', rx + 24, S.y + 90, 18, t.dim);
    const now = isNum(M.lat) && isNum(M.long), tot = now ? Math.sqrt(M.lat * M.lat + M.long * M.long).toFixed(2) : '--';
    st.num(cv, tot, rx + 24, S.y + 220, 120, now ? t.text : t.dim);
    st.txt(cv, 'g', rx + 24 + st.numW(cv, tot, 120) + 10, S.y + 220, 30, t.dim);
    // lat / long centre-origin bars
    [['Lateral', M.lat], ['Longitudinal', M.long]].forEach((p, i) => {
        const y = S.y + 262 + i * 46, bx = rx + 190, bw = rw - 214;
        st.txt(cv, p[0], rx + 24, y + 8, 15, t.dim);
        cv.roundRect(bx, y - 6, bw, 14, 7, t.track);
        const mid = bx + bw / 2, f = isNum(p[1]) ? Math.max(-1, Math.min(1, p[1] / max)) * bw / 2 : 0;
        if (Math.abs(f) > 0.5) cv.roundRect(Math.min(mid, mid + f), y - 6, Math.abs(f), 14, 7, hc);
        cv.fillRect(mid - 1, y - 12, 2, 26, t.text);
        st.num(cv, isNum(p[1]) ? (p[1] >= 0 ? '+' : '') + p[1].toFixed(2) : '--', bx + bw, y - 14, 18, t.dim, { align: 'right' });
    });
    // the last 20 s of combined g, inside the plate's foot
    const cy2 = S.y + 360, ch = S.y + 54 + ph - 16 - cy2, cw2 = rw - 48;
    cv.fillRect(rx + 24, cy2 - 14, cw2, 1, withAlpha('#ffffff', 0.10));
    st.txt(cv, 'Last 20 s', rx + 24, cy2 + 10, 15, t.dim);
    // newest at the right; a gap in the data (null) breaks the line
    const H = M.history, nh = H.length, runs = [];
    let run = [];
    H.forEach((v, i) => {
        if (!isNum(v)) { if (run.length) runs.push(run); run = []; return; }
        run.push([rx + 24 + i * (cw2 - 40) / Math.max(1, nh - 1), cy2 + ch - Math.min(1, v / max) * (ch - 20)]);
    });
    if (run.length) runs.push(run);
    runs.forEach((r2) => { if (r2.length > 1) { cv.fillUnder(r2, cy2 + ch, withAlpha(hc, 0.12)); cv.polyline(r2, 2.5, hc); } });
    if (!runs.length) st.txt(cv, 'No acceleration data yet', rx + 24 + (cw2 - 40) / 2, cy2 + ch / 2 + 14, 16, t.dim, { align: 'center' });
}

/* ---------- tires ---------- */
const TEMP = { cold: 80, hot: 150 };          // TPMS air temperature, deg F (assumption, configurable)
function tempState(f) { return !isNum(f) ? null : f < TEMP.cold ? 'cold' : f > TEMP.hot ? 'hot' : 'ok'; }
function pressState(p, tgt) { return !isNum(p) || !isNum(tgt) ? null : p < tgt - 2 ? 'low' : p > tgt + 4 ? 'high' : 'ok'; }

function carOutline(cv, st, cx, top, bw, bh) {
    const t = st.t, x = cx - bw / 2, line = withAlpha(t.text, 0.55), faint = withAlpha(t.text, 0.16);
    // body: a long rounded hull, slightly narrower at the nose and tail
    cv.roundRect(x, top, bw, bh, bw * 0.34, withAlpha('#ffffff', 0.025));
    cv.strokeRoundRect(x, top, bw, bh, bw * 0.34, 2.5, line);
    // windscreen, roof, rear window
    const gx = x + 26, gw = bw - 52;
    cv.quad([[gx + 10, top + bh * 0.30], [gx + gw - 10, top + bh * 0.30], [gx + gw, top + bh * 0.40], [gx, top + bh * 0.40]], withAlpha(t.accent2 || t.accent, 0.20));
    cv.roundRect(gx + 4, top + bh * 0.42, gw - 8, bh * 0.26, 18, withAlpha('#ffffff', 0.05));
    cv.strokeRoundRect(gx + 4, top + bh * 0.42, gw - 8, bh * 0.26, 18, 1.5, faint);
    cv.quad([[gx, top + bh * 0.70], [gx + gw, top + bh * 0.70], [gx + gw - 14, top + bh * 0.78], [gx + 14, top + bh * 0.78]], withAlpha(t.accent2 || t.accent, 0.14));
    // bonnet lines, mirrors, lights
    cv.line(cx - bw * 0.18, top + 26, cx - bw * 0.14, top + bh * 0.27, 1.5, faint);
    cv.line(cx + bw * 0.18, top + 26, cx + bw * 0.14, top + bh * 0.27, 1.5, faint);
    cv.roundRect(x - 16, top + bh * 0.34, 18, 12, 5, line);
    cv.roundRect(x + bw - 2, top + bh * 0.34, 18, 12, 5, line);
    cv.roundRect(x + 22, top + 8, 40, 7, 3.5, withAlpha('#ffffff', 0.7));
    cv.roundRect(x + bw - 62, top + 8, 40, 7, 3.5, withAlpha('#ffffff', 0.7));
    cv.roundRect(x + 22, top + bh - 15, 46, 7, 3.5, withAlpha(t.crit, 0.85));
    cv.roundRect(x + bw - 68, top + bh - 15, 46, 7, 3.5, withAlpha(t.crit, 0.85));
}

function tires(cv, st, S, M) {
    const t = st.t, cx = 800, top = S.y + 34, bw = 236, bh = S.h - 60;
    const TC = { cold: t.cold, ok: GREEN, hot: t.crit }, PC = { low: t.warn, ok: t.text, high: t.warn };
    title(cv, st, S, 'Tires', '');
    carOutline(cv, st, cx, top, bw, bh);
    const tw = 54, th = 104, spots = [['fl', -1, 0.12], ['fr', 1, 0.12], ['rl', -1, 0.62], ['rr', 1, 0.62]];
    const NAMES = { fl: 'Front left', fr: 'Front right', rl: 'Rear left', rr: 'Rear right' };
    spots.forEach((s) => {
        const k = s[0], side = s[1], d = M.tires[k] || {}, ts = tempState(d.t), ps = pressState(d.p, d.target), tg = isNum(d.target);
        const c = ts ? TC[ts] : t.track;
        const x = side < 0 ? cx - bw / 2 - tw + 10 : cx + bw / 2 - 10, y = top + bh * s[2];
        cv.roundRect(x - 6, y - 6, tw + 12, th + 12, 14, withAlpha(c, 0.18));
        cv.roundRect(x, y, tw, th, 10, c);
        for (let i = 1; i < 6; i++) cv.fillRect(x + 8, y + i * th / 6, tw - 16, 2, withAlpha('#000000', 0.25));
        // the card beside it
        const cw = 400, chh = 178, cxp = side < 0 ? x - 40 - cw : x + tw + 40, cyp = y + th / 2 - chh / 2;
        st.plate(cv, cxp, cyp, cw, chh, ps === 'ok' ? null : PC[ps]);
        cv.line(side < 0 ? cxp + cw : cxp, y + th / 2, side < 0 ? x - 6 : x + tw + 6, y + th / 2, 1.5, withAlpha(t.text, 0.25));
        const L0 = cxp + 22, R0 = cxp + cw - 22;
        st.txt(cv, NAMES[k], L0, cyp + 32, 17, t.dim);
        if (ps && ps !== 'ok') pill(cv, st, R0, cyp + 12, ps === 'low' ? 'Low' : 'High', t.warn, { align: 'right', size: 14, h: 26 });
        const ptxt = isNum(d.p) ? d.p.toFixed(1) : '--', pw = st.numW(cv, ptxt, 72);
        st.num(cv, ptxt, L0 - 2, cyp + 104, 72, ps ? PC[ps] : t.dim);
        st.txt(cv, 'psi', L0 + pw + 8, cyp + 104, 22, t.dim);
        // temperature, right
        const ttxt = isNum(d.t) ? String(Math.round(d.t)) : '--';
        st.num(cv, ttxt + '°F', R0, cyp + 100, 40, ts ? TC[ts] : t.dim, { align: 'right' });
        st.txt(cv, ts === 'cold' ? 'Cold' : ts === 'hot' ? 'Hot' : ts === 'ok' ? 'In range' : 'No data', R0, cyp + 66, 14, ts ? TC[ts] : t.dim, { align: 'right' });
        // pressure vs target: a scale with the target mark (no target from the car: no scale)
        const sx = L0, sw = cw - 44, sy = cyp + 126;
        cv.roundRect(sx, sy, sw, 8, 4, t.track);
        if (tg) {
            const lo = d.target - 6, hi = d.target + 8, P = (v) => sx + Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * sw;
            cv.roundRect(P(d.target - 2), sy, P(d.target + 4) - P(d.target - 2), 8, 4, withAlpha(GREEN, 0.45));
            cv.fillRect(P(d.target) - 1.5, sy - 6, 3, 20, t.text);
            if (isNum(d.p)) { cv.circle(P(d.p), sy + 4, 9, t.bg); cv.circle(P(d.p), sy + 4, 7, ps ? PC[ps] : t.dim); }
        }
        st.txt(cv, 'Target ' + (tg ? d.target.toFixed(1) + ' psi' : '--'), L0, cyp + 164, 15, t.dim);
        if (tg && isNum(d.p)) st.txt(cv, (d.p - d.target >= 0 ? '+' : '') + (d.p - d.target).toFixed(1), R0, cyp + 164, 15, ps ? PC[ps] : t.dim, { align: 'right' });
    });
    // legend + freshness, bottom centre-left (the dots and the G are bottom right)
    const ly = S.y + S.h - 30;
    let lx = S.x + 6;
    [['Cold', t.cold], ['In range', GREEN], ['Hot', t.crit]].forEach((p) => {
        cv.roundRect(lx, ly + 4, 22, 12, 4, p[1]); st.txt(cv, p[0], lx + 30, ly + 16, 14, t.dim); lx += 30 + st.txtW(cv, p[0], 14) + 22;
    });
    st.txt(cv, 'Tire temps are TPMS air temps, not tread', lx + 10, ly + 16, 14, withAlpha(t.dim, 0.8));
    st.txt(cv, M.fresh, 1300, S.y + 30, 15, t.dim, { align: 'right' });
}


/* ---------- showcase ---------- */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 12-hour clock text from a Date (the head unit's local time). */
function clock12(d) {
    const h = d.getHours() % 12 || 12, m = d.getMinutes();
    return { time: h + ':' + (m < 10 ? '0' : '') + m, ampm: d.getHours() < 12 ? 'AM' : 'PM', date: DAYS[d.getDay()] + ' · ' + MONTHS[d.getMonth()] + ' ' + d.getDate() };
}
/** Fit an image (iw x ih) into a box, aspect kept, centred. */
function fit(iw, ih, x, y, w, h) {
    const k = Math.min(w / iw, h / ih), ww = iw * k, hh = ih * k;
    return { x: x + (w - ww) / 2, y: y + (h - hh) / 2, w: ww, h: hh };
}

/**
 * Showcase: three columns across the page. Left the car (img.car), centre Spotify (music.panel)
 * while a track is there, else a large 12-hour clock; right the logo (img.logo) on a dark plate.
 * img = { car: { id, w, h } | null, logo: ... }. Returns the centre column's rect.
 */
function showcase(cv, st, S, music, lk, gr, img, now) {
    const t = st.t, gap = 16, cw = (S.w - 2 * gap) / 3, top = S.y + 6, h = S.h - 6;
    const c0 = S.x, c1 = S.x + cw + gap, c2 = S.x + 2 * (cw + gap);
    // left: the car, a soft floor shadow under it
    if (img.car) {
        const r = fit(img.car.w, img.car.h, c0 + 8, top + 10, cw - 16, h - 40);
        cv.roundRect(r.x + r.w * 0.08, r.y + r.h * 0.86, r.w * 0.84, r.h * 0.1, r.h * 0.05, withAlpha('#000000', 0.35));
        cv.image(img.car.id, r.x, r.y, r.w, r.h);
    }
    // centre: Spotify, or the clock
    const mid = { x: c1, y: top, w: cw, h: h };
    if (music && music.hasTrack()) music.panel(cv, S, lk, mid, gr);
    else {
        if (music) music.band = null;
        const c = clock12(new Date(now)), size = 132, tw = st.numW(cv, c.time, size), aw = st.txtW(cv, c.ampm, 30);
        const cx = c1 + cw / 2, by = top + h / 2 + size * 0.32, x0 = cx - (tw + 14 + aw) / 2;
        st.num(cv, c.time, x0, by, size, t.text);
        st.txt(cv, c.ampm, x0 + tw + 14, by, 30, t.dim);
        st.txt(cv, c.date, cx, by + 58, 22, t.dim, { align: 'center' });
        if (music) {
            const s = music.status, note = s === 'noauth' || s === 'reauth' ? 'Spotify: not signed in (Settings > Spotify)' : s === 'offline' ? 'Spotify: no internet' : '';
            if (note) st.txt(cv, note, cx, top + h - 18, 15, withAlpha(t.dim, 0.8), { align: 'center' });
        }
    }
    // right: the logo on a dark plate, clear of the G button and the dots below it
    const ph = Math.min(h, (gr ? gr.y : top + h) - 14 - top);
    cv.roundRect(c2, top, cw, ph, Math.max(8, st.r), '#050607');
    cv.strokeRoundRect(c2, top, cw, ph, Math.max(8, st.r), 1, withAlpha('#ffffff', 0.08));
    if (img.logo) {
        const r = fit(img.logo.w, img.logo.h, c2 + 34, top + 20, cw - 68, ph - 40);
        cv.image(img.logo.id, r.x, r.y, r.w, r.h);
    }
    return mid;
}

module.exports = { SCREENS, HOME, GREEN, style, dots, dotsBox, toast, pill, warmup, gforce, tires, showcase, clock12 };
