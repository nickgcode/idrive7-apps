'use strict';
/**
 * fullscreen.js - helpers for full-screen touch apps.
 *
 * A full-screen app says "fullscreen": true on its canvas screen in app.json: the display then always
 * uses the 'full' layout (no layout setting; a 'standard' saved by an older version is ignored), and
 * where the renderer can (native mgu-render/1 with touch, display.js own()) the kit runs the whole screen:
 * the page's cv.target() rects take taps, the kit flashes the one pressed, ctx.onTap gets the rest.
 *
 * The 1920 x 720 centre display, as the renderer sees it (mgu-render: touch_area 84,76,1836,644):
 *   - y 0..76   the HMI's status strip: its pull-down. Touches there never reach the app, so nothing
 *               there may need a tap. The kit draws the app's title header in the black 80 px strip
 *               (G.frame: title, badges); treat it as a label, never as a button.
 *   - x 0..84   the HMI's back / home column: not the app's either.
 *   - the rest  the app's: the page (1600 x 520 logical, scaled ~1.16) below the header, reaching down
 *               to the screen's bottom (cv.extra more logical px, G.pageBottom).
 *
 *   const FS = require('./kit/fullscreen');
 *   const fs = FS.setup(ctx, { hide: ['BTN_PLAY', ...] });   // bar buttons only for the fallback paths
 *   ctx.loop(fps, (cv) => {
 *       const a = FS.area(cv);                                  // { x, y, w, h, bottom, own }
 *       ...
 *       FS.button(cv, 'play', x, y, w, h, () => togglePlay(), { slop: 14 });
 *   });
 *   FS.drag(ctx, (x, y) => inBar(x, y), (phase, x) => scrubTo(x, phase === 3));   // drag (ctx.onTouch)
 *
 * Where the kit can't run the screen (software renderer, no touch from the renderer) the app falls
 * back to its HMI bar buttons, as before: keep them in app.json, the helpers hide them in own mode.
 */

/** Screen geometry (device px) of the centre display. */
const SCREEN = { w: 1920, h: 720 };
/** First screen row (device px) that delivers touches to the app (the HMI keeps the strip above). */
const TOUCH_TOP = 76;
/** First screen column (device px) that delivers touches to the app (the HMI's back / home column). */
const TOUCH_LEFT = 84;
/** The header strip the kit draws the title into (device px): label only, see above. */
const STRIP_H = 80;
/** device px kept clear below the strip, so a finger reaching for the pull-down misses the page's buttons */
const GAP = 14;
/** Logical page size (ctx.canvas) and the part of it the full layout shows (display.js FULL.src). */
const PAGE = { w: 1600, h: 520, x0: 12, x1: 1588 };
/** Logical px a target's hit rect grows on every side by default (fingers are not mouse pointers). */
const SLOP = 12;

/** Logical px -> screen px and back, for the frame being recorded (null place: not on screen yet). */
function toScreen(cv, x, y) {
    const p = cv && cv.place;
    return p ? { x: x * p.scale + p.ox, y: y * p.scale + p.oy } : { x, y };
}
function toPage(cv, sx, sy) {
    const p = cv && cv.place;
    return p ? { x: (sx - p.ox) / p.scale, y: (sy - p.oy) / p.scale } : { x: sx, y: sy };
}

/**
 * The page rect (logical px) safe for content and touch: below the strip (and GAP), right of the back
 * column, down to the screen's bottom when the kit runs the screen (reads cv.extra: the page is placed
 * as one that reaches down). Elsewhere (the HMI shows the page in its own frame, 1600 x 520, with the
 * kit's tab bar on top, G.BAR_H 38) the area under that bar.
 */
function area(cv, margin) {
    const m = margin == null ? 8 : margin;
    if (cv && cv.own && cv.place) {
        const p = cv.place;
        const extra = cv.extra || 0;
        const top = Math.max(38, Math.ceil(toPage(cv, 0, STRIP_H + GAP).y));
        const left = Math.max(PAGE.x0, Math.ceil(toPage(cv, TOUCH_LEFT + GAP, 0).x));
        const bottom = Math.min(PAGE.h + extra, Math.floor(toPage(cv, 0, SCREEN.h - 6).y)) - m;
        return { x: left + m, y: top, w: PAGE.x1 - m - (left + m), h: bottom - top, bottom, right: PAGE.x1 - m, own: true, scale: p.scale };
    }
    return { x: PAGE.x0 + m, y: 38 + m, w: PAGE.x1 - PAGE.x0 - 2 * m, h: PAGE.h - 38 - 2 * m, bottom: PAGE.h - m, right: PAGE.x1 - m, own: false, scale: 1 };
}

/**
 * A touch button: target rect x, y, w, h (logical px), grown by opts.slop on every side but never into
 * the strip the HMI keeps (toward the top) and never past the page. run() runs on a tap (touch up on the
 * same target), and the kit flashes the rect (opts.r: its corner radius, default h / 2). Only in own
 * mode (elsewhere the page takes no touches: the bar buttons do the job). Returns cv.
 */
function button(cv, key, x, y, w, h, run, opts) {
    if (!cv || !cv.own || !cv.target) return cv;
    const o = opts || {}, s = o.slop == null ? SLOP : o.slop;
    const a = area(cv, 0);
    let x0 = x - s, y0 = y - s, x1 = x + w + s, y1 = y + h + s;
    if (y0 < a.y - GAP) y0 = Math.min(y, a.y - GAP);
    if (x0 < PAGE.x0) x0 = PAGE.x0;
    if (x1 > PAGE.x1) x1 = PAGE.x1;
    if (y1 > a.bottom + 6) y1 = Math.max(y + h, a.bottom + 6);
    const r = o.r != null ? o.r + s : null;
    return cv.target(x0, y0, x1 - x0, y1 - y0, run, key, r);
}

/**
 * A drag area (a scrub bar, a slider): hit(x, y) is asked on every touch-down (page px); when it says
 * yes, that whole touch is the app's: on(1, x, y) for the down, on(2, x, y) for each move and on(3, x, y)
 * for the release, and no target or ctx.onTap sees it. Uses ctx.onTouch (one handler per app: call
 * drag() once and have hit() look at what the frame drew). Returns false where the kit has no
 * ctx.onTouch (then keep a tap fallback through ctx.onTap).
 */
function drag(ctx, hit, on) {
    if (!ctx || typeof ctx.onTouch !== 'function') return false;
    let active = false;
    ctx.onTouch((phase, x, y) => {
        if (phase === 1) {
            active = !!hit(x, y);
            if (active) on(1, x, y);
            return active;
        }
        if (!active) return false;
        if (phase === 3) active = false;
        on(phase, x, y);
        return true;
    });
    return true;
}

/**
 * Set up a full-screen app: in own mode the given bar buttons (all of the main screen's when opts.hide
 * is true or left out) are hidden, their jobs being on the page. Returns { own() } for convenience.
 */
function setup(ctx, opts) {
    const o = opts || {};
    let ids = o.hide;
    if (ids == null || ids === true) {
        let spec = null;
        try { spec = require('./app-spec.json'); } catch (e) { spec = null; }
        const scr = spec && (spec.screens || []).find((x) => x.kind === 'canvas');
        ids = scr ? (scr.buttons || []).map((b) => b[0]) : [];
    }
    (ids || []).forEach((id) => { try { ctx.hideButton(id); } catch (e) { /* older kit */ } });
    return { area, button, drag, toScreen, toPage };
}

module.exports = { SCREEN, TOUCH_TOP, TOUCH_LEFT, STRIP_H, GAP, PAGE, SLOP, area, button, drag, setup, toScreen, toPage };
