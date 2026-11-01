'use strict';
/**
 * viz.js - G's Music's visualizer, shared by the head unit's stage (main.js) and the cluster
 * (music_cluster.js) so both look and move alike: VIZ_BARS rounded bars mirrored about the middle,
 * their heights a slow sum of waves (the app can't hear the music: Spotify's audio analysis isn't
 * open to new apps), taller towards the middle, coloured across by the artwork's palette.
 *
 * The clock { t, e, last }: t runs while playing; e eases to 1 on Play and to 0 on Pause, so the
 * bars settle to rest and then stand still.
 *
 * Node 8: no optional chaining, no ??, no object spread.
 */

const VIZ_BARS = 38;
const REST = 0.07, AMP = 0.82;

/** A new clock. */
const clock = () => ({ t: 0, e: 0, last: 0 });
/** Moves the clock to now (ms); goal 1 playing, 0 paused. True while it still changes the picture. */
function step(c, now, goal) {
    const dt = c.last ? Math.min(0.1, Math.max(0, (now - c.last) / 1000)) : 0;
    c.last = now;
    c.e += (goal - c.e) * Math.min(1, dt * 2.5);
    if (Math.abs(goal - c.e) < 0.004) c.e = goal;
    c.t += dt * c.e;
    return c.e > 0 || goal > 0;
}

function rgba(c) {
    if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0, c.length > 3 ? c[3] | 0 : 255];
    const s = String(c || '#ffffff').replace('#', '');
    const v = [0, 2, 4, 6].map((k) => parseInt(s.slice(k, k + 2), 16));
    return [v[0] || 0, v[1] || 0, v[2] || 0, s.length >= 8 && !isNaN(v[3]) ? v[3] : 255];
}
/** As kit/canvas's mix and withAlpha (the cluster has no kit/gauges). */
function mix(a, b, t) {
    a = rgba(a); b = rgba(b);
    return [0, 1, 2, 3].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}
function withAlpha(c, a) { const v = rgba(c); return [v[0], v[1], v[2], Math.round(a * 255)]; }

/** Bar i of N at clock time T, ease e: { u (0..1 across), wv (the wave, 0..1), f (height / stage height) }. */
function bar(i, N, T, e) {
    const u = i / (N - 1);
    const wv = 0.5 + 0.5 * (0.5 * Math.sin(T * 2.1 + i * 0.42) + 0.3 * Math.sin(T * 3.7 - i * 0.27 + 1.3) + 0.2 * Math.sin(T * 6.3 + i * 0.91 + 0.4));
    const env = 0.45 + 0.55 * Math.sin(Math.PI * (0.1 + 0.8 * u));
    return { u, wv, f: REST + AMP * e * wv * env };
}

/**
 * Draws the bars in rect R on cv (kit/canvas) at clock c ({ t, e }), pal: three colours (left,
 * middle, right). opts.mix / opts.withAlpha: the caller's (kit/gauges'), else this file's. ~40
 * rounded rects.
 */
function draw(cv, R, c, pal, opts) {
    const o = opts || {}, M = o.mix || mix, A = o.withAlpha || withAlpha;
    const N = VIZ_BARS, gap = R.w / N, bw = Math.max(4, gap * 0.52), cy = R.y + R.h / 2;
    for (let i = 0; i < N; i++) {
        const b = bar(i, N, c.t, c.e), u = b.u;
        const h = Math.max(bw, R.h * b.f);
        const col = u < 0.5 ? M(pal[0], pal[1], u * 2) : M(pal[1], pal[2], (u - 0.5) * 2);
        const x = R.x + i * gap + (gap - bw) / 2;
        cv.roundRect(x, cy - h / 2, bw, h, bw / 2, A(col, 0.55 + 0.45 * b.wv * c.e));
    }
}

module.exports = { VIZ_BARS, REST, AMP, clock, step, bar, draw, mix, withAlpha };
