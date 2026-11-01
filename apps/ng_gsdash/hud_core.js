'use strict';
/*
 * hud_core.js - G's Dash 0.8.2's HUD shift lights + gear: what is drawn, where, and the shader that
 * draws it. The HUD (cluster-render target 'hud', 800 x 480) gets one thin band at its top,
 * BAND = x 120..680, y 10..94, holding one look's style:
 *   default  10 pills, 5 a side, filling outside-in toward the gear; flash: all red
 *   pixel    the item box with the gear (1:1, nearest pixels), a 20-block power bar and a heart;
 *            flash: blue blocks and SHIFT!
 *   lumen    12 glowing beads on a shallow arc, the gear under it; flash: ice / red
 *   m        12 slanted segments (light blue, dark blue, red) filling inward; flash: red
 *   gt       a 15-LED strip filling from both ends to the centre (green, yellow, red, blue); flash: blue
 * The art is baked (tools/bake_gsdash_hud.js) into hud_shift.png: per style four 560 x 84 panes,
 *   0 ON      everything lit            1 OFF   the lights dim (the bar's rest)
 *   2 FLASH   the shift flash frame     3 INDEX R = the light's step (0..steps-1), G = group:
 *             0 nothing, 1 always (shown with just the gear), 2 shown while the lights run, 3 a light
 * colours stored "as light": alpha = brightness (black is see-through on the HUD).
 * The gear is the look's own cluster-skin gear cells (skin_<look>.png, meta.cells.R), placed and
 * scaled per style. Node 8.
 */
const SKIN = require('./skin_looks');

const BAND = { x: 120, y: 10, w: 560, h: 84 };
const PANES = 4;
const ORDER = ['default', 'pixel', 'lumen', 'm', 'gt'];
/* steps: how many steps the lights fill in (pairs that light together count once); whole: a light is
 * either off or on (blocks, LEDs), else it fades in over its step */
const STYLES = {
    default: { steps: 5, gear: { cx: 280, cy: 42, scale: 0.9, nearest: false } },
    pixel: { steps: 20, whole: true, gear: { cx: 52, cy: 42, scale: 1, nearest: true } },
    lumen: { steps: 12, gear: { cx: 280, cy: 56, scale: 0.66, nearest: false } },
    m: { steps: 6, gear: { cx: 280, cy: 42, scale: 0.9, nearest: false } },
    gt: { steps: 8, whole: true, gear: { cx: 280, cy: 56, scale: 0.66, nearest: false } },
};
const RANGE = 2000;              // the lights cover the last RANGE rpm before the shift point
const BLINK_MS = 120;            // the flash: on / off every 120 ms (about 4 Hz)
const LIT_STEPS = 240;           // the fill is sent in 1/240ths: no pushes for rpm wobble below a step

const styleOf = (look) => (STYLES[look] && look !== 'default' ? look : 'default');
/** Style s's panes in hud_shift.png: x, y, w, h */
const paneRect = (style) => ({ x: 0, y: ORDER.indexOf(styleOf(style)) * PANES * BAND.h, w: BAND.w, h: PANES * BAND.h });

/** The look's gear cells (skin_looks.js META): { file, labels, x, y, w, h, cols, cw } or null */
function gearCells(look) {
    const m = SKIN.looks && SKIN.looks[look];
    const g = m && m.cells && m.cells.R;
    if (!m || !g || !g.atlas) return null;
    const at = g.at || [0, 0];
    return { file: m.file, labels: g.labels, x: at[0], y: at[1], w: g.atlas[0], h: g.atlas[1], cols: g.cols, cw: g.atlas[0] / g.cols };
}

/**
 * The gear shown: the gearbox's own gear only. P, unknown ('-'), a guessed gear and no signal: none
 * (null). R and N as letters, D when the gearbox says D with no number.
 */
function gearShown(text, guessed) {
    const g = text == null ? '' : String(text);
    if (!g || g === '-' || g === 'P') return null;
    if (/^[1-9]$/.test(g)) return guessed ? null : g;
    return g === 'R' || g === 'N' || g === 'D' ? g : null;
}

/**
 * What the band shows for rpm, the shift point and the gear text: { lit (0..1, in LIT_STEPS),
 * mode (0 just the gear, 1 the lights, 2 flash off, 3 flash on), gear (cell index or -1) }.
 */
function frame(o, now, labels) {
    const rpm = Number(o.rpm), shift = Number(o.shift);
    const ok = isFinite(rpm) && isFinite(shift) && shift > 0;
    const start = shift - RANGE;
    let lit = ok ? Math.max(0, Math.min(1, (rpm - start) / RANGE)) : 0;
    lit = Math.round(lit * LIT_STEPS) / LIT_STEPS;
    let mode = 0;
    if (ok && rpm >= shift) mode = Math.floor(now / BLINK_MS) % 2 === 0 ? 3 : 2;
    else if (lit > 0) mode = 1;
    const g = gearShown(o.gear, o.guessed);
    const gi = g && labels ? labels.indexOf(g) : -1;
    return { lit, mode, gear: gi };
}

const f1 = (v) => { const s = String(Math.round(v * 10000) / 10000); return s.indexOf('.') < 0 && s.indexOf('e') < 0 ? s + '.0' : s; };

/** The fragment shader for a style and the look's gear cells (GLSL ES 1.00) */
function fragment(style, cells) {
    const st = STYLES[styleOf(style)], g = st.gear;
    const cw = cells ? cells.cw : 1, ch = cells ? cells.h : 1, aw = cells ? cells.w : 1;
    const H = BAND.h;
    return [
        '#ifdef GL_FRAGMENT_PRECISION_HIGH',
        'precision highp float;',
        '#else',
        'precision mediump float;',
        '#endif',
        'varying vec2 v_uv;',
        'uniform sampler2D u_hud;',
        'uniform sampler2D u_gear;',
        'uniform float u_fresh;',
        'uniform vec4 u_lv;',
        'const vec2 SZ = vec2(' + f1(BAND.w) + ', ' + f1(H) + ');',
        'const vec2 HSZ = vec2(' + f1(BAND.w) + ', ' + f1(H * PANES) + ');',
        'const vec2 GSZ = vec2(' + f1(aw) + ', ' + f1(ch) + ');',
        'const vec2 CELL = vec2(' + f1(cw) + ', ' + f1(ch) + ');',
        'const vec2 GO = vec2(' + f1(g.cx) + ', ' + f1(g.cy) + ');',
        'const float GS = ' + f1(g.scale) + ';',
        'const float STEPS = ' + f1(st.steps) + ';',
        'vec4 texel(sampler2D t, vec2 p, vec2 sz) { return texture2D(t, p / sz); }',
        'void main() {',
        '    vec2 q = floor(v_uv * SZ) + 0.5;',
        '    float m = floor(u_lv.y + 0.5);',
        '    vec4 on = texel(u_hud, q, HSZ);',
        '    vec4 ix = texel(u_hud, q + vec2(0.0, ' + f1(3 * H) + '), HSZ);',
        '    float idx = floor(ix.r * 255.0 + 0.5);',
        '    float grp = floor(ix.g * 255.0 + 0.5);',
        '    vec4 c = vec4(0.0);',
        '    if (m < 0.5) { if (grp > 0.5 && grp < 1.5 && u_lv.z > -0.5) c = on; }',
        '    else if (m > 2.5) c = texel(u_hud, q + vec2(0.0, ' + f1(2 * H) + '), HSZ);',
        '    else if (m > 1.5) c = texel(u_hud, q + vec2(0.0, ' + f1(H) + '), HSZ);',
        '    else if (grp > 2.5) {',
        '        vec4 off = texel(u_hud, q + vec2(0.0, ' + f1(H) + '), HSZ);',
        st.whole ? '        c = mix(off, on, step(0.001, u_lv.x * STEPS - idx));'
            : '        c = mix(off, on, clamp(u_lv.x * STEPS - idx, 0.0, 1.0));',
        '    } else c = on;',
        '    if (u_lv.z > -0.5) {',
        '        vec2 p = (q - GO) / GS + CELL * 0.5;',
        '        if (p.x >= 0.0 && p.y >= 0.0 && p.x < CELL.x && p.y < CELL.y) {',
        '            float x0 = floor(u_lv.z + 0.5) * CELL.x;',
        g.nearest
            ? '            vec4 t = texel(u_gear, floor(vec2(x0, 0.0) + p) + 0.5, GSZ);'
            : '            vec4 t = texel(u_gear, vec2(clamp(x0 + p.x, x0 + 0.5, x0 + CELL.x - 0.5), clamp(p.y, 0.5, CELL.y - 0.5)), GSZ);',
        '            float a = t.a + c.a * (1.0 - t.a);',
        '            c = vec4((t.rgb * t.a + c.rgb * c.a * (1.0 - t.a)) / max(a, 0.0001), a);',
        '        }',
        '    }',
        '    gl_FragColor = vec4(c.rgb, c.a * clamp(u_fresh, 0.0, 1.0));',
        '}',
        '',
    ].join('\n');
}

module.exports = { BAND, PANES, ORDER, STYLES, RANGE, BLINK_MS, LIT_STEPS, styleOf, paneRect, gearCells, gearShown, frame, fragment };
