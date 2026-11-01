'use strict';
/**
 * fcluster_core.js - G's Dash 0.12.0: the full-screen cluster test's picture (fcluster.js draws it): classic
 * twin round dials over the whole cluster panel (1920 x 720), original art (no maker's marks): the speedometer
 * (0-160 mph) on the left, the tachometer (0-8 x1000 r/min, red from REDLINE_RPM, fixed 7,000) on the right,
 * coolant (120-260 °F, hot from 235) under the speedometer and oil (120-320 °F, hot from 290) under the
 * tachometer, no fuel; between them a centre display: the drive mode, the gear (P / R / N letters, D3 style in
 * drive; nothing when unknown or guessed), the clock H:MM with a colon and the oil temperature.
 *
 * One effect layer's fragment shader (GLSL ES 1.00, procedural) and one r8 asset, fcluster.png (1024 x 576,
 * tools/bake_gsdash_fcluster.py): the numerals and words. Uniforms (none of the renderer's reserved names):
 *   u_lab   the atlas
 *   u_val   speed mph, rpm / 1000, oil °F, coolant °F (rpm, oil, coolant -1: none, no needle / '--')
 *   u_gear  stage glyph (0 P, 1 R, 2 N, 3 D, -1 none), gear number (1-8, 0 none), drive mode (0-7, -1 none), night (0 / 1)
 *   u_clock hour (1-12), minute, valid (0 / 1)
 *   u_fresh the fail-safe (failsafe.js): the output's alpha
 * Node 8: no ?., ?? or object spread.
 */
const W = 1920, H = 720;
const ATLAS = { file: 'fcluster.png', w: 1024, h: 576 };
const REDLINE_RPM = 7000;
const STAGES = { P: 0, R: 1, N: 2, D: 3 };
const MODES = ['COMFORT', 'SPORT', 'SPORT+', 'ECO PRO', 'COMFORT+', 'ECO PRO+', 'INDIVIDUAL', 'ADAPTIVE'];
const KMH_PER_MPH = 1.609344;
const isNum = (v) => typeof v === 'number' && isFinite(v);

const FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    '// G\'s Dash full-screen cluster test (0.12.0): classic twin round dials, procedural; one r8 label atlas',
    'varying vec2 v_uv;',
    'uniform sampler2D u_lab;   // r8 label atlas 1024x576, bilinear',
    'uniform vec4 u_val;        // speed mph, rpm / 1000, oil F, coolant F (rpm, oil, coolant: -1 none)',
    'uniform vec4 u_gear;       // stage glyph (0 P 1 R 2 N 3 D 4 M 5 S, -1 none), gear number (1-8, 0 none), drive mode label (0-7, -1 none), night 0/1',
    'uniform vec3 u_clock;      // hour (1-12), minute, clock valid',
    'uniform float u_fresh;     // the fail-safe: 1 shown, fades to 0 by itself if G\'s Dash stops (failsafe.js)',
    'const vec2 SZ = vec2(1920.0, 720.0);',
    'const vec2 ATL = vec2(1024.0, 576.0);',
    'const float REDLINE = 7.0;                        // rpm / 1000, fixed',
    'const vec2 CL = vec2(500.0, 360.0);',
    'const vec2 CR = vec2(1420.0, 360.0);',
    'const float A0 = -2.1817, A1 = 2.1817;          // -125..125 degrees from the top, clockwise',
    'const float SA = 0.8378;                         // sub-dials: -48..48 degrees',
    '',
    'float glyph(vec2 lp, vec2 org, vec2 cell) {',
    '    if (lp.x < 0.0 || lp.y < 0.0 || lp.x >= cell.x || lp.y >= cell.y) return 0.0;',
    '    return texture2D(u_lab, (org + lp) / ATL).r;',
    '}',
    '// one fixed-width character of the small digit row (0-9, 10 \':\', 11 deg, 12 F)',
    'float digit(vec2 q, vec2 at, float k) { return k < 0.0 ? 0.0 : glyph(q - at + vec2(20.0, 28.0), vec2(k * 40.0, 400.0), vec2(40.0, 56.0)); }',
    'float label(vec2 q, vec2 at, float k) { return k < 0.0 ? 0.0 : glyph(q - at + vec2(128.0, 20.0), vec2(mod(k, 4.0) * 256.0, 456.0 + floor(k / 4.0) * 40.0), vec2(256.0, 40.0)); }',
    'float big(vec2 q, vec2 at, float k) { return k < 0.0 ? 0.0 : glyph(q - at + vec2(48.0, 68.0), vec2(mod(k, 7.0) * 96.0, 128.0 + floor(k / 7.0) * 136.0), vec2(96.0, 136.0)); }',
    'float aa(float d) { return clamp(d + 0.5, 0.0, 1.0); }',
    '// a tapered bar along direction d from the origin: from r0 to r1, half widths w0 at r0 to w1 at r1',
    'float bar(vec2 p, vec2 d, float r0, float r1, float w0, float w1) {',
    '    float al = dot(p, d), pe = abs(dot(p, vec2(-d.y, d.x)));',
    '    float hw = mix(w0, w1, clamp((al - r0) / (r1 - r0), 0.0, 1.0));',
    '    return aa(hw - pe) * aa(al - r0) * aa(r1 - al);',
    '}',
    'vec2 dirOf(float a) { return vec2(sin(a), -cos(a)); }',
    'vec3 chrome(vec2 p, float r, float r0, float r1, float night) {',
    '    float k = (r - r0) / (r1 - r0);',
    '    float lit = 0.55 + 0.45 * (-p.y / max(r, 1.0));              // light from above',
    '    float band = 0.35 + 0.65 * pow(sin(3.14159 * k), 0.6);',
    '    vec3 c = vec3(0.30, 0.31, 0.33) + vec3(0.62, 0.63, 0.66) * band * lit;',
    '    c += vec3(0.25) * exp(-pow((k - 0.3) * 9.0, 2.0)) * lit;     // a sharp highlight line',
    '    return mix(c, c * vec3(0.20, 0.13, 0.08), night);            // night: dim, warm',
    '}',
    '',
    '// one main dial at c: vmax its full scale, val its needle, red its red zone start, row its numeral row (0 speed, 1 rpm)',
    'vec3 dial(vec3 col, vec2 q, vec2 c, float vmax, float val, float red, float row, float night, vec3 ink, vec3 ndl) {',
    '    vec2 p = q - c; float r = length(p);',
    '    if (r > 318.0) return col;',
    '    float a = atan(p.x, -p.y);',
    '    // the tube behind: a soft dark rim, then the face',
    '    col = mix(col, vec3(0.0), clamp((318.0 - r) / 18.0, 0.0, 1.0) * 0.9);',
    '    if (r < 300.0) {',
    '        float fr = r / 300.0;',
    '        vec3 face = mix(vec3(0.060, 0.064, 0.072), vec3(0.018, 0.019, 0.022), fr * fr);',
    '        face += vec3(0.010) * sin(r * 0.9);                       // fine concentric grain',
    '        col = face;',
    '    }',
    '    // chrome bezel',
    '    if (r >= 286.0 && r < 301.0) col = mix(col, chrome(p, r, 286.0, 301.0, night), aa(r - 286.0) * aa(301.0 - r));',
    '    // scale: 32 steps, majors every 4 (labelled), mids every 2',
    '    float t = (a - A0) / (A1 - A0);',
    '    float n = clamp(floor(t * 32.0 + 0.5), 0.0, 32.0);',
    '    vec2 d = dirOf(A0 + n / 32.0 * (A1 - A0));',
    '    float maj = 1.0 - step(0.5, mod(n, 4.0)), mid = 1.0 - step(0.5, mod(n, 2.0));',
    '    float rin = maj > 0.5 ? 232.0 : (mid > 0.5 ? 246.0 : 254.0);',
    '    float hw = maj > 0.5 ? 3.2 : (mid > 0.5 ? 2.0 : 1.4);',
    '    float tk = bar(p, d, rin, 268.0, hw, hw);',
    '    float inRed = red > 0.0 ? step(red / vmax * 32.0 - 0.01, n) : 0.0;',
    '    vec3 redc = mix(vec3(0.86, 0.06, 0.04), vec3(1.0, 0.16, 0.05), night);',
    '    col = mix(col, mix(ink, redc, inRed), tk);',
    '    // red zone arc',
    '    if (red > 0.0) {',
    '        float ra = A0 + red / vmax * (A1 - A0);',
    '        float on = aa((a - ra) * r) * aa((A1 - a) * r) * aa(r - 270.0) * aa(280.0 - r);',
    '        col = mix(col, redc, on);',
    '    }',
    '    // a thin inner scale line',
    '    float sl = aa(1.0 - abs(r - 269.5)) * step(-0.004, t) * step(t, 1.004);',
    '    col = mix(col, ink * 0.55, sl * 0.8);',
    '    // numerals, upright, on a radius that comes in at the sides',
    '    float m = clamp(floor(t * 8.0 + 0.5), 0.0, 8.0);',
    '    float ma = A0 + m / 8.0 * (A1 - A0);',
    '    vec2 lc = c + dirOf(ma) * (204.0 - 26.0 * abs(sin(ma)));',
    '    float g = glyph(q - lc + vec2(56.0, 32.0), vec2(m * 112.0, row * 64.0), vec2(112.0, 64.0));',
    '    col = mix(col, ink, g);',
    '    // the unit under the hub',
    '    col = mix(col, ink * 0.8, label(q, c + vec2(0.0, 100.0), row));',
    '    // needle (none without a value): shadow, glow (night), body with a lighter spine',
    '    if (val >= 0.0) {',
    '    float na = A0 + clamp(val / vmax, 0.0, 1.025) * (A1 - A0);',
    '    vec2 nd = dirOf(na);',
    '    float sh = bar(p - vec2(5.0, 9.0), nd, -40.0, 262.0, 10.0, 5.0);',
    '    col *= 1.0 - 0.55 * sh * (1.0 - night * 0.5);',
    '    float al = dot(p, nd), pe = abs(dot(p, vec2(-nd.y, nd.x)));',
    '    float gl = exp(-pe / 7.0) * aa(al + 40.0) * aa(266.0 - al) * night;',
    '    col += ndl * gl * 0.45;',
    '    float body = bar(p, nd, -46.0, 264.0, 6.5, 1.6);',
    '    float spine = bar(p, nd, 30.0, 250.0, 1.2, 0.5);',
    '    col = mix(col, ndl, body);',
    '    col = mix(col, min(ndl + vec3(0.35, 0.30, 0.25), 1.0), spine * body);',
    '    }',
    '    // hub cap',
    '    if (r < 33.0) {',
    '        vec3 cap = mix(vec3(0.16, 0.16, 0.17), vec3(0.03), r / 33.0);',
    '        cap = mix(cap, chrome(p, r, 27.0, 33.0, night), aa(r - 27.0));',
    '        col = mix(col, cap, aa(33.0 - r));',
    '    }',
    '    return col;',
    '}',
    '',
    '// a sub-dial pivoting at s (radius 88, -48..48 degrees): lo..hi, hot zone from hot, needle at v',
    'vec3 subdial(vec3 col, vec2 q, vec2 s, float lo, float hi, float hot, float v, float lab, float night, vec3 ink, vec3 ndl) {',
    '    vec2 p = q - s; float r = length(p);',
    '    if (r > 100.0 || p.y > 60.0) return col;',
    '    float a = atan(p.x, -p.y);',
    '    float inArc = aa((a + SA) * r) * aa((SA - a) * r);',
    '    float ha = -SA + (hot - lo) / (hi - lo) * 2.0 * SA;',
    '    float band = inArc * aa(r - 83.0) * aa(88.0 - r);',
    '    vec3 redc = mix(vec3(0.86, 0.06, 0.04), vec3(1.0, 0.16, 0.05), night);',
    '    col = mix(col, mix(ink * 0.75, redc, step(ha, a)), band);',
    '    float n = clamp(floor((a + SA) / SA + 0.5), 0.0, 2.0);',
    '    col = mix(col, ink, bar(p, dirOf(-SA + n * SA), 72.0, 90.0, 1.8, 1.8));',
    '    col = mix(col, ink * 0.75, label(q, s + vec2(0.0, 34.0), lab));',
    '    if (v >= 0.0) {',
    '        vec2 nd = dirOf(-SA + clamp((v - lo) / (hi - lo), 0.0, 1.0) * 2.0 * SA);',
    '        col = mix(col, ndl, bar(p, nd, -8.0, 80.0, 3.4, 1.2));',
    '    }',
    '    if (r < 9.0) col = mix(col, vec3(0.12, 0.12, 0.13), aa(9.0 - r));',
    '    return col;',
    '}',
    '',
    'float rbox(vec2 q, vec4 b, float rad) {      // rounded rect coverage (b: x0, y0, x1, y1)',
    '    vec2 c = (b.xy + b.zw) * 0.5, h = (b.zw - b.xy) * 0.5 - rad;',
    '    vec2 d = abs(q - c) - h;',
    '    return aa(rad - (length(max(d, 0.0)) + min(max(d.x, d.y), 0.0)));',
    '}',
    '',
    'void main() {',
    '    vec2 q = v_uv * SZ;',
    '    float night = u_gear.w;',
    '    vec3 ink = mix(vec3(0.94, 0.95, 0.96), vec3(1.0, 0.62, 0.26), night);          // white by day, orange backlight at night',
    '    vec3 ndl = mix(vec3(1.0, 0.27, 0.07), vec3(1.0, 0.33, 0.10), night);',
    '    // the panel: black, a faint brow light from above',
    '    vec3 col = vec3(0.012, 0.013, 0.016) + vec3(0.025, 0.026, 0.03) * (1.0 - night) * clamp(1.0 - q.y / 300.0, 0.0, 1.0);',
    '    // centre display between the dials',
    '    vec4 B = vec4(846.0, 150.0, 1074.0, 570.0);',
    '    float bx = rbox(q, B, 18.0);',
    '    if (bx > 0.0) {',
    '        float edge = bx - rbox(q, B + vec4(2.0, 2.0, -2.0, -2.0), 16.0);',
    '        vec3 lcd = mix(vec3(0.030, 0.034, 0.042), vec3(0.012, 0.013, 0.016), (q.y - B.y) / (B.w - B.y));',
    '        col = mix(col, lcd, bx);',
    '        col = mix(col, vec3(0.22, 0.23, 0.26) * (1.0 - 0.75 * night), edge);',
    '        vec3 txt = mix(vec3(0.96), vec3(1.0, 0.70, 0.36), night);',
    '        col = mix(col, ink * 0.85, label(q, vec2(960.0, 192.0), u_gear.z < 0.0 ? -1.0 : u_gear.z + 4.0));',
    '        // gear: the stage letter, and the gear number beside it when there is one',
    '        float hasN = step(0.5, u_gear.y);',
    '        float gx = 960.0 - 40.0 * hasN;',
    '        col = mix(col, txt, big(q, vec2(gx, 318.0), u_gear.x));',
    '        col = mix(col, txt, big(q, vec2(1002.0, 318.0), hasN > 0.5 ? 5.0 + u_gear.y : -1.0));',
    '        col = mix(col, vec3(0.30, 0.32, 0.36) * (1.0 - 0.6 * night), aa(1.0 - abs(q.y - 412.0)) * step(870.0, q.x) * step(q.x, 1050.0));',
    '        // H:MM',
    '        if (u_clock.z > 0.5) {',
    '            float h = u_clock.x, ht = floor(h / 10.0), ho = h - ht * 10.0, mt = floor(u_clock.y / 10.0), mo = u_clock.y - mt * 10.0;',
    '            float n2 = ht > 0.0 ? 5.0 : 4.0, x0 = 960.0 - n2 * 15.0 + 15.0;',
    '            float k0 = ht > 0.0 ? ht : -1.0, o = ht > 0.0 ? 30.0 : 0.0;',
    '            float tg = digit(q, vec2(x0, 462.0), k0);',
    '            tg = max(tg, digit(q, vec2(x0 + o, 462.0), ho));',
    '            tg = max(tg, digit(q, vec2(x0 + o + 24.0, 462.0), 10.0));',
    '            tg = max(tg, digit(q, vec2(x0 + o + 48.0, 462.0), mt));',
    '            tg = max(tg, digit(q, vec2(x0 + o + 78.0, 462.0), mo));',
    '            col = mix(col, txt, tg);',
    '        }',
    '        // oil temperature line',
    '        float oil = floor(u_val.z + 0.5), o1 = floor(oil / 100.0), o2 = floor((oil - o1 * 100.0) / 10.0), o3 = oil - o1 * 100.0 - o2 * 10.0;',
    '        float og = 0.0;',
    '        if (u_val.z >= 0.0) {',
    '            og = max(og, digit(q, vec2(978.0, 528.0), o1 > 0.0 ? o1 : -1.0));',
    '            og = max(og, digit(q, vec2(1004.0, 528.0), o2));',
    '            og = max(og, digit(q, vec2(1030.0, 528.0), o3));',
    '        } else {',
    '            og = max(og, digit(q, vec2(1004.0, 528.0), 14.0));',
    '            og = max(og, digit(q, vec2(1030.0, 528.0), 14.0));',
    '        }',
    '        col = mix(col, txt * 0.9, og);',
    '        col = mix(col, ink * 0.7, label(q, vec2(918.0, 528.0), 2.0));',
    '    }',
    '    col = dial(col, q, CL, 160.0, u_val.x, 0.0, 0.0, night, ink, ndl);',
    '    col = dial(col, q, CR, 8.0, u_val.y, REDLINE, 1.0, night, ink, ndl);',
    '    col = subdial(col, q, CL + vec2(0.0, 236.0), 120.0, 260.0, 235.0, u_val.w, 3.0, night, ink, ndl);',
    '    col = subdial(col, q, CR + vec2(0.0, 236.0), 120.0, 320.0, 290.0, u_val.z, 2.0, night, ink, ndl);',
    '    gl_FragColor = vec4(col, clamp(u_fresh, 0.0, 1.0));',
    '}'
].join('\n') + '\n';

/** the effect layer's fragment shader */
function fragment() { return FRAG; }

/**
 * The gear shown: { stage, n } (u_gear.xy). P / R / N the selector's letters; D with the gearbox's own gear
 * (D3); the gear alone (no selector signal) as D3 too; R from the gear; nothing when only "N or P" is known
 * or the gear is guessed (as the HUD).
 */
function gearOf(d) {
    const st = d && d.stage, g = d && d.gear, guessed = !!(d && d.gearGuessed);
    if (st === 'P' || st === 'R' || st === 'N') return { stage: STAGES[st], n: 0 };
    if (g === -1 && !guessed) return { stage: STAGES.R, n: 0 };
    const n = isNum(g) && g >= 1 && g <= 8 && !guessed ? Math.round(g) : 0;
    if (st === 'D' || n) return { stage: STAGES.D, n };
    return { stage: -1, n: 0 };
}
/** the drive mode label's number (u_gear.z), -1 for none or one not in the atlas */
const modeOf = (label) => MODES.indexOf(label);

/**
 * The uniforms from { data (car.data(), km/h and °C), mph (the speed as shown, else from data), night, clock ({ time: 'H:MM' }) }
 * -> { u_val, u_gear, u_clock } (arrays, rounded so a repeat compares equal)
 */
function values(s) {
    const d = (s && s.data) || {};
    const toF = (c) => (isNum(c) ? c * 9 / 5 + 32 : -1);
    // the speed as the car shows it (mph from main.js / the skins' correction), else plain km/h -> mph
    const mph = Math.max(0, Math.min(170, isNum(s && s.mph) ? s.mph : isNum(d.speed) ? d.speed / KMH_PER_MPH : 0));
    const rpm = isNum(d.rpm) ? Math.max(0, Math.min(8.3, d.rpm / 1000)) : -1;
    const oil = toF(d.oil), cool = toF(d.coolant);
    const g = gearOf(d);
    let h = 0, m = 0, ok = 0;
    const c = /^(\d{1,2}):(\d{2})$/.exec(String((s && s.clock && s.clock.time) || ''));
    if (c) { h = +c[1]; m = +c[2]; ok = h >= 1 && h <= 12 && m <= 59 ? 1 : 0; }
    const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
    return {
        u_val: [r1(mph), r2(rpm), oil < 0 ? -1 : Math.round(oil), cool < 0 ? -1 : Math.round(cool)],
        u_gear: [g.stage, g.n, modeOf(d.driveMode || null), s && s.night ? 1 : 0],
        u_clock: ok ? [h, m, 1] : [0, 0, 0],
    };
}
/** fcluster.png's pixels as one byte a pixel (the red channel of the decoded image) */
function r8(img) {
    const n = img.w * img.h, out = new Uint8Array(n), ch = img.data.length / n;
    for (let i = 0; i < n; i++) out[i] = img.data[i * ch];
    return out;
}

module.exports = { fragment, values, gearOf, modeOf, r8, W, H, ATLAS, REDLINE_RPM, MODES, STAGES };
