'use strict';
/*
 * hud_core.js - G's Dash's HUD (0.9.0: the full HUD - speed, gear, shift lights): what is drawn, where,
 * and the shader that draws it. One effect layer covers the whole HUD (cluster-render target 'hud',
 * 800 x 480):
 *   - the speed in mph, big, centred at x 370 (1 to 3 digits, no leading zeros), MPH under it
 *   - the gear right of it (x 645): R, N, D as letters, the gearbox's own gear number; none in P and
 *     never a guessed gear. GT: a thin divider between the two (not shown with no gear)
 *   - the shift lights' band at the top, BAND = x 120..680, y 10..94, in the look's style:
 *       default  10 pills, 5 a side, filling outside-in; flash: all red
 *       pixel    the item box (the pixel G emblem in it), a 20-block power bar and a heart;
 *                flash: blue blocks and SHIFT!
 *       lumen    12 glowing beads on a shallow arc; flash: ice / red
 *       m        12 slanted segments (light blue, dark blue, red) filling inward; flash: red
 *       gt       a 15-LED strip filling from both ends to the centre (green, yellow, red, blue); flash: blue
 *     The lights fill over the last RANGE rpm before the shift point and flash at about 4 Hz past it.
 * Art (tools/bake_gsdash_hud.js), stored "as light": alpha = brightness (black is see-through on the HUD):
 *   hud_shift.png  per style four 560 x 84 panes: 0 ON everything lit, 1 OFF the lights dim, 2 FLASH,
 *                  3 INDEX R = the light's step (0..steps-1), G = group: 0 nothing, 1 always (shown
 *                  whenever the HUD is), 2 shown while the lights run, 3 a light
 *   hud_full.png   per look the speed's digits, the gears (GEARS) and the unit; hud_full.js says where
 *                  (Pixel's are pixel art drawn scaled up, nearest: pixelated).
 * TODO (speed limit): not shown. The car's speed-limit info (camera / map) is not among the signals
 * G's Dash reads; if it becomes readable it could sit under the gear. Node 8.
 */
const FULL = require('./hud_full');

const HUD = { w: 800, h: 480 };
const BAND = { x: 120, y: 10, w: 560, h: 84 };
const PANES = 4;
const ORDER = ['default', 'pixel', 'lumen', 'm', 'gt'];
/* steps: how many steps the lights fill in (pairs that light together count once); whole: a light is
 * either off or on (blocks, LEDs), else it fades in over its step */
const STYLES = {
    default: { steps: 5 },
    pixel: { steps: 20, whole: true },
    lumen: { steps: 12 },
    m: { steps: 6 },
    gt: { steps: 8, whole: true },
};
const GEARS = ['R', 'N', 'D', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const RANGE = 2000;              // the lights cover the last RANGE rpm before the shift point
const BLINK_MS = 120;            // the flash: on / off every 120 ms (about 4 Hz)
const LIT_STEPS = 240;           // the fill is sent in 1/240ths: no pushes for rpm wobble below a step
const MAX_MPH = 299;

const styleOf = (look) => (STYLES[look] && look !== 'default' ? look : 'default');
/** Style s's panes in hud_shift.png: x, y, w, h */
const paneRect = (style) => ({ x: 0, y: ORDER.indexOf(styleOf(style)) * PANES * BAND.h, w: BAND.w, h: PANES * BAND.h });
/** The look's block of hud_full.png (hud_full.js meta, x/y/w/h added) or null */
function bigOf(look) {
    const m = FULL.looks && FULL.looks[look];
    return m ? Object.assign({ file: FULL.file, x: 0 }, m) : null;
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
/** km/h -> whole mph shown (0..MAX_MPH), or -1 with no number */
function mphOf(kmh) {
    const v = Number(kmh);
    if (kmh == null || kmh === '' || !isFinite(v)) return -1;
    return Math.max(0, Math.min(MAX_MPH, Math.round(Math.abs(v) / 1.609344)));
}

/**
 * What the HUD shows for rpm, the shift point, the gear text and the speed: { lit (0..1, in LIT_STEPS),
 * mode (0 no lights, 1 the lights, 2 flash off, 3 flash on), gear (GEARS index or -1), mph (-1: none) }.
 */
function frame(o, now) {
    const rpm = Number(o.rpm), shift = Number(o.shift);
    const ok = o.rpm != null && o.rpm !== '' && isFinite(rpm) && isFinite(shift) && shift > 0;
    const start = shift - RANGE;
    let lit = ok ? Math.max(0, Math.min(1, (rpm - start) / RANGE)) : 0;
    lit = Math.round(lit * LIT_STEPS) / LIT_STEPS;
    let mode = 0;
    if (ok && rpm >= shift) mode = Math.floor(now / BLINK_MS) % 2 === 0 ? 3 : 2;
    else if (lit > 0) mode = 1;
    const g = gearShown(o.gear, o.guessed);
    return { lit, mode, gear: g ? GEARS.indexOf(g) : -1, mph: mphOf(o.kmh) };
}

const f1 = (v) => { const s = String(Math.round(v * 10000) / 10000); return s.indexOf('.') < 0 && s.indexOf('e') < 0 ? s + '.0' : s; };
const v2 = (a, b) => 'vec2(' + f1(a) + ', ' + f1(b) + ')';

/** The fragment shader for a band style and a look's big block (bigOf) (GLSL ES 1.00) */
function fragment(style, big) {
    const st = STYLES[styleOf(style)], H = BAND.h, B = big;
    const near = B.sampling === 'nearest', d = B.digit, g = B.gear, u = B.unit, dv = B.divider;
    const L = [
        '#ifdef GL_FRAGMENT_PRECISION_HIGH',
        'precision highp float;',
        '#else',
        'precision mediump float;',
        '#endif',
        'varying vec2 v_uv;',
        'uniform sampler2D u_hud;',
        'uniform sampler2D u_big;',
        'uniform float u_fresh;',
        'uniform vec4 u_lv;',
        'const vec2 SZ = ' + v2(HUD.w, HUD.h) + ';',
        'const vec2 BO = ' + v2(BAND.x, BAND.y) + ';',
        'const vec2 BSZ = ' + v2(BAND.w, H) + ';',
        'const vec2 HSZ = ' + v2(BAND.w, H * PANES) + ';',
        'const vec2 ASZ = ' + v2(B.w, B.h) + ';',
        'const float STEPS = ' + f1(st.steps) + ';',
        'vec4 texel(sampler2D t, vec2 p, vec2 sz) { return texture2D(t, p / sz); }',
        'vec4 over(vec4 t, vec4 c) { float a = t.a + c.a * (1.0 - t.a); return vec4((t.rgb * t.a + c.rgb * c.a * (1.0 - t.a)) / max(a, 0.0001), a); }',
        '/* p: px inside a cell (unscaled) at atlas px at, sz the cell */',
        'vec4 cell(vec2 p, vec2 at, vec2 sz) {',
        '    if (p.x < 0.0 || p.y < 0.0 || p.x >= sz.x || p.y >= sz.y) return vec4(0.0);',
        near ? '    return texel(u_big, floor(at + p) + 0.5, ASZ);'
            : '    return texel(u_big, at + clamp(p, vec2(0.5), sz - 0.5), ASZ);',
        '}',
        'void main() {',
        '    vec2 q = floor(v_uv * SZ) + 0.5;',
        '    vec4 c = vec4(0.0);',
        '    vec2 b = q - BO;',
        '    if (b.x >= 0.0 && b.y >= 0.0 && b.x < BSZ.x && b.y < BSZ.y) {',
        '        float m = floor(u_lv.y + 0.5);',
        '        vec4 on = texel(u_hud, b, HSZ);',
        '        vec4 ix = texel(u_hud, b + vec2(0.0, ' + f1(3 * H) + '), HSZ);',
        '        float idx = floor(ix.r * 255.0 + 0.5);',
        '        float grp = floor(ix.g * 255.0 + 0.5);',
        '        if (m < 0.5) { if (grp > 0.5 && grp < 1.5) c = on; }',
        '        else if (m > 2.5) c = texel(u_hud, b + vec2(0.0, ' + f1(2 * H) + '), HSZ);',
        '        else if (m > 1.5) c = texel(u_hud, b + vec2(0.0, ' + f1(H) + '), HSZ);',
        '        else if (grp > 2.5) {',
        '            vec4 off = texel(u_hud, b + vec2(0.0, ' + f1(H) + '), HSZ);',
        st.whole ? '            c = mix(off, on, step(0.001, u_lv.x * STEPS - idx));'
            : '            c = mix(off, on, clamp(u_lv.x * STEPS - idx, 0.0, 1.0));',
        '        } else c = on;',
        '    }',
        '    float v = floor(u_lv.w + 0.5);',
        '    if (v > -0.5) {',
        '        // the speed: n digit slots (ink wide, GAP apart) centred on SX; digit i of n from the left',
        '        float n = v < 9.5 ? 1.0 : (v < 99.5 ? 2.0 : 3.0);',
        '        float pitch = ' + f1(d.ink * d.s + d.gap) + ';',
        '        float x0 = floor(' + f1(d.x) + ' - (n * pitch - ' + f1(d.gap) + ') * 0.5);',
        '        float i = clamp(floor((q.x - x0 + ' + f1(d.gap / 2) + ') / pitch), 0.0, n - 1.0);',
        '        float pl = n - 1.0 - i;',
        '        float dg = mod(floor(v / (pl > 1.5 ? 100.0 : (pl > 0.5 ? 10.0 : 1.0)) + 0.001), 10.0);',
        '        vec2 p = vec2((q.x - (x0 + i * pitch)) / ' + f1(d.s) + ' + ' + f1(d.pad) + ', (q.y - ' + f1(d.top) + ') / ' + f1(d.s) + ');',
        '        c = over(cell(p, ' + v2(d.at[0], d.at[1]) + ' + vec2(dg * ' + f1(d.cell[0]) + ', 0.0), ' + v2(d.cell[0], d.cell[1]) + '), c);',
        '        c = over(cell((q - ' + v2(u.x, u.top) + ') / ' + f1(u.s) + ', ' + v2(u.at[0], u.at[1]) + ', ' + v2(u.cell[0], u.cell[1]) + '), c);',
        '    }',
        '    float gi = floor(u_lv.z + 0.5);',
        '    if (gi > -0.5) {',
        '        c = over(cell((q - ' + v2(g.x, g.top) + ') / ' + f1(g.s) + ', ' + v2(g.at[0], g.at[1]) + ' + vec2(gi * ' + f1(g.cell[0]) + ', 0.0), ' + v2(g.cell[0], g.cell[1]) + '), c);',
    ];
    if (dv) {
        L.push('        if (q.x >= ' + f1(dv.x) + ' && q.x < ' + f1(dv.x + dv.w) + ' && q.y >= ' + f1(dv.y) + ' && q.y < ' + f1(dv.y + dv.h) + ')');
        L.push('            c = over(vec4(' + dv.col.map((k) => f1(k / 255)).join(', ') + ', 1.0), c);');
    }
    L.push('    }', '    gl_FragColor = vec4(c.rgb, c.a * clamp(u_fresh, 0.0, 1.0));', '}', '');
    return L.join('\n');
}

module.exports = { HUD, BAND, PANES, ORDER, STYLES, GEARS, RANGE, BLINK_MS, LIT_STEPS, MAX_MPH, styleOf, paneRect, bigOf, gearShown, mphOf, frame, fragment };
