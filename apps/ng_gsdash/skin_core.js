'use strict';
/**
 * skin_core.js - G's Dash 0.8.1 cluster skins, the parts both the car and the build use: the stock Sport
 * layout's geometry (skin_geom.js) as functions, the two layer regions, the fragment shader each look's
 * layer runs on the cluster's GPU (GLSL ES 1.00), and the uniforms it takes from the car's values.
 *
 * A skin is two "effect" layers on the cluster's "panel" target (1920x720, above the stock gauges and
 * under the stock telltales), one per side, each REGION_W x REGION_H at x 0 / 1060, y 24. Each samples
 * four assets the build made (tools/bake_gsdash_skins.js -> skin_<look>.png, skin_field.png):
 *   u_field  per pixel: arc length s along the nearest contour (r + g * 256: 1/16 px) and, in b, which
 *            gauge and how deep in it (floor(sd * 2) the big dial, 100 + floor(sd * 2) the small one,
 *            255 none); opaque, so nothing depends on how alpha is uploaded
 *   u_art    the look with every fill at rest and no needles or numbers: rgb; alpha < 128: outside or
 *            the envelope's feathered edge (alpha / 127); 128..255: opaque, (a - 128) / 127 is how much
 *            of it is drawn over the fill (ticks, numerals, lines), so a fill never covers those
 *   u_band   the fill "on", unrolled: column = s, row = sd (big dial rows 0..47, small 48..71, the small
 *            one's other colour 72..95: the Pixel look's low fuel, the stock reserve zone)
 *   u_glyph  the speed readout's digits (10 per place, 3 places: 0..999) and the gear letters, whole
 *            cells drawn in place
 * Per frame the app sends a few vec4s (fill range, needle position, which cells): about 24 numbers.
 *
 * What a skin redraws live (and covers opaquely, so no stock needle, glow, trail, tick or numeral shows
 * beside it at any value): the speedometer and the tachometer (arc, needle, numerals, fill), the digital
 * speed (all three places) and the gear. What stays the car's own (a hole in the art and the shader):
 * the fuel and oil gauges (0.8.1: no verified live mapping, so never a stand-in), the ACC / speed-limit /
 * driver-assist area at the speedometer's foot (ACC_AREA, generous: not measured), AUTO H, PARK, the
 * centre and the bottom strip, and the gear readout whenever the gear is not known for sure.
 * Node 8: no ?., no ??, no object spread.
 */
const GEOM = require('./skin_geom');

const PANEL_W = 1920, PANEL_H = 720;
const REGION_W = 860, REGION_H = 636, REGION_Y = 24;
const SIDES = {
    L: { x: 0, y: REGION_Y, w: REGION_W, h: REGION_H, main: 'speedo', small: 'fuel' },
    R: { x: 1060, y: REGION_Y, w: REGION_W, h: REGION_H, main: 'tach', small: 'oil' },
};
const BAND_W = 1544, BAND_ROWS = 96, MAIN_ROWS = 48, SMALL_ROW = 48, SMALL_ROWS = 24, ALT_ROW = 72;
const S_SCALE = 16;                                     // the field's s code: floor(s * 16) in r + g * 256
const SMALL_CODE = 100;                                 // the field's b: floor(sd * 2) (big dial), 100 + floor(sd * 2) (small), 255 none
/** What a skin never draws over (panel px [x0, y0, x1, y1]): the stock content that stays the car's own. */
const ACC_AREA = [492, 420, 720, 660];                  // the stock ACC / speed-limit / assist graphics (not measured: generous)
// the centre (the map area's side): its right edge 8 px in from the measured one, so the tachometer's
// needle at its top end (8000, x >= 1198) is never half in it (0.8.1)
const CENTRE = [GEOM.keep.centre[0], GEOM.keep.centre[1], Math.min(GEOM.keep.centre[2], 1192), GEOM.keep.centre[3]];
const CUTS = [
    GEOM.cut.speedLimit, GEOM.cut.autoH, GEOM.cut.park, CENTRE, GEOM.keep.bottom, ACC_AREA,
];
/**
 * The small gauges, left to the car (0.8.1): their box (dial, needle sweep, numerals, icon; panel px)
 * minus the big dial's own zone (MAIN_ZONE: sd from the big contour, so its rim stays covered). The
 * bake makes the art transparent there; no small fill or needle is drawn.
 */
const SMALL_BOX = { L: [0, 428, 184, 660], R: [1720, 426, 1920, 660] };
const MAIN_ZONE = [-16, 127];
/** Opaque cover for the stock readouts at their widest: the speed (3 places) and the gear (2 characters) */
const SPEED_COVER = [354, 317, 628, 403];
const GEAR_COVER = [1224, 309, 1451, 403];
const SPEED_MAX = 999;
const CUT_PAD = 3;
/* The value range per gauge (the scale's ends) and its unit */
const RANGE = { speedo: [0, 200], tach: [0, 8], fuel: [0, 1], oil: [120, 300] };

/* ---------------- geometry ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const LEN = {};
const MAJ = {};
Object.keys(GEOM.gauges).forEach((k) => {
    const g = GEOM.gauges[k];
    LEN[k] = g.xy.length / 2 - 1;
    const num = (l) => parseFloat(l.replace('3/4', '0.75').replace('1/2', '0.5').replace('1/4', '0.25'));
    MAJ[k] = Object.keys(g.majors).map((l) => ({ label: l, v: num(l), s: g.majors[l] })).sort((a, b) => a.v - b.v);
});
/** the contour point at arc length s: { x, y, nx, ny } (n: the inward normal) */
function at(k, s) {
    const g = GEOM.gauges[k], n = LEN[k];
    s = clamp(s, 0, n);
    const i = Math.min(n - 1, Math.floor(s)), f = s - i;
    const x = g.xy[2 * i] + (g.xy[2 * i + 2] - g.xy[2 * i]) * f, y = g.xy[2 * i + 1] + (g.xy[2 * i + 3] - g.xy[2 * i + 1]) * f;
    const a0 = g.ang[i] * Math.PI / 1800, a1 = g.ang[i + 1] * Math.PI / 1800;
    let nx = Math.cos(a0) * (1 - f) + Math.cos(a1) * f, ny = Math.sin(a0) * (1 - f) + Math.sin(a1) * f;
    const l = Math.hypot(nx, ny) || 1;
    return { x, y, nx: nx / l, ny: ny / l };
}
/** a value -> s along the contour (piecewise linear through the major ticks) */
function sOf(k, v) {
    const m = MAJ[k];
    if (v <= m[0].v) return m[0].s + (v - m[0].v) * (m[1].s - m[0].s) / (m[1].v - m[0].v);
    for (let i = 1; i < m.length; i++) if (v <= m[i].v) return m[i - 1].s + (v - m[i - 1].v) * (m[i].s - m[i - 1].s) / (m[i].v - m[i - 1].v);
    return m[m.length - 1].s;
}
/** a needle's or tick's direction at s: from the contour toward the numerals, interpolated between majors */
function dirAt(k, s) {
    const num = GEOM.gauges[k].numerals;
    const m = MAJ[k].filter((q) => num[q.label]).sort((a, b) => a.s - b.s);
    if (m.length < 2) { const p = at(k, s); return [p.nx, p.ny]; }
    const dirs = m.map((q) => { const p = at(k, q.s), c = num[q.label]; return { s: q.s, a: Math.atan2(c[1] - p.y, c[0] - p.x) }; });
    let a = dirs[0].a;
    if (s >= dirs[dirs.length - 1].s) a = dirs[dirs.length - 1].a;
    else if (s > dirs[0].s) {
        for (let i = 1; i < dirs.length; i++) {
            if (s > dirs[i].s) continue;
            let d = dirs[i].a - dirs[i - 1].a;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            a = dirs[i - 1].a + d * (s - dirs[i - 1].s) / (dirs[i].s - dirs[i - 1].s);
            break;
        }
    }
    return [Math.cos(a), Math.sin(a)];
}
/** panel rect -> the side's layer rect (may be empty / outside) */
function local(side, r) { const S = SIDES[side]; return [r[0] - S.x, r[1] - S.y, r[2] - S.x, r[3] - S.y]; }
/** the cut-outs that touch a side, in its layer px, padded */
function cutsOf(side) {
    const S = SIDES[side];
    return CUTS.map((r) => local(side, [r[0] - CUT_PAD, r[1] - CUT_PAD, r[2] + CUT_PAD, r[3] + CUT_PAD]))
        .filter((r) => r[2] > 0 && r[3] > 0 && r[0] < S.w && r[1] < S.h)
        .map((r) => [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(S.w, r[2]), Math.min(S.h, r[3])]);
}

/* ---------------- the uniforms ---------------- */
/**
 * The car's values -> the side's uniforms, for the look's meta (skin_looks.js). st: { speed (mph, as
 * shown), rpm, gear ('P', 'R', 'N', 'D', '1'..'9', or '-' / null: unknown) }.
 * -> { u_fill, u_nm, u_gl, u_cut }: 4 numbers each. u_gl: left, the speed's ones, tens, hundreds digit
 * (-1: no digit there); right, the gear's cell.
 */
function uniforms(meta, side, st) {
    const S = SIDES[side], out = {};
    const val = (k) => {
        const v = k === 'speedo' ? st.speed : k === 'tach' ? (isNum(st.rpm) ? st.rpm / 1000 : null) : k === 'fuel' ? st.fuel : st.oil;
        return isNum(v) ? clamp(v, RANGE[k][0], RANGE[k][1]) : null;
    };
    const NONE = [1, 0, 0, 0];                         // lo > hi: no fill
    [['u_fill', 'u_nm', S.main, 0]].forEach((g) => {
        const k = g[2], f = meta.fill[k], v = val(k);
        let fill = NONE;
        if (f && f.kind === 'sweep' && v !== null) {
            const s0 = sOf(k, f.v0 !== undefined ? f.v0 : RANGE[k][0]), s1 = sOf(k, Math.max(v, f.min || -1e9));
            const alt = f.altBelow !== undefined && v < f.altBelow;
            fill = [Math.min(s0, s1), Math.max(s0, s1), s1, alt ? ALT_ROW : g[3] ? SMALL_ROW : 0];
        } else if (f && f.kind === 'reserve' && v !== null && v < f.below) {
            fill = [f.s[0], f.s[1], f.s[1], ALT_ROW];
        }
        out[g[0]] = fill.map(r2);
        if (v === null) { out[g[1]] = [0, 0, 0, 0]; return; }
        const s = sOf(k, v), p = at(k, s), d = dirAt(k, s);
        out[g[1]] = [r2(p.x - S.x), r2(p.y - S.y), r4(d[0]), r4(d[1])];
    });
    const cells = meta.cells[side];
    let cell = -1;
    if (side === 'L') {
        const n = isNum(st.speed) ? clamp(Math.round(st.speed), 0, SPEED_MAX) : -1;
        out.u_gl = n < 0 || !cells.labels.length ? [-1, -1, -1, 0] : [n % 10, n >= 10 ? Math.floor(n / 10) % 10 : -1, n >= 100 ? Math.floor(n / 100) % 10 : -1, 0];
    } else {
        cell = cells.labels.indexOf(String(st.gear));
        out.u_gl = [cell, 0, 0, 0];
    }
    // the gear unknown (or only guessed): its whole widest box cut out, so the stock gear shows
    const gb = GEAR_COVER;
    out.u_cut = side === 'R' && cell < 0 && cells.labels.length ? local('R', [gb[0] - 4, gb[1] - 4, gb[2] + 4, gb[3] + 4]).map(r2) : [0, 0, 0, 0];
    return out;
}
function isNum(v) { return typeof v === 'number' && isFinite(v); }
const r2 = (v) => Math.round(v * 100) / 100, r4 = (v) => Math.round(v * 10000) / 10000;

/* ---------------- the shader ---------------- */
const f1 = (v) => { const s = String(Math.round(v * 10000) / 10000); return /[.e]/.test(s) ? s : s + '.0'; };
const vec3 = (c) => 'vec3(' + c.map((v) => f1(v / 255)).join(', ') + ')';

/** one needle's GLSL: composite over c / a at q (layer px) for needle uniform N and style n */
function needleGlsl(n, N, on) {
    if (!n) return '';
    const L = [];
    const q = n.q ? 'qb' : 'q';
    L.push('    if (' + on + ') {');
    if (n.q) L.push('        vec2 qb = floor(q / ' + f1(n.q) + ') * ' + f1(n.q) + ' + ' + f1(n.q / 2) + ';');
    L.push('        vec2 P = ' + N + '.xy, D = ' + N + '.zw;');
    if (n.glow) L.push('        { float k = segCov(' + q + ', P + D * ' + f1(n.a0) + ', P + D * ' + f1(n.len) + ', ' + f1(n.w + n.glow.extra) + ', 0.0) * ' + f1(n.glow.a) + ';'
        + (n.glow.add ? ' c = min(c + ' + vec3(n.glow.col) + ' * k, 1.0);' : ' c = mix(c, ' + vec3(n.glow.col) + ', k);') + ' a = a + k * (1.0 - a); }');
    if (n.shadow) L.push('        { float k = segCov(' + q + ', P + D * ' + f1(n.a0) + ' + vec2(' + f1(n.shadow.dx) + ', ' + f1(n.shadow.dy) + '), P + D * ' + f1(n.len) + ' + vec2(' + f1(n.shadow.dx) + ', ' + f1(n.shadow.dy) + '), ' + f1(n.w) + ', ' + (n.q ? '1.0' : '0.0') + ');'
        + ' c = mix(c, ' + vec3(n.shadow.col) + ', k); a = a + k * (1.0 - a); }');
    if (n.taper) L.push('        { float k = taperCov(q, P, D, ' + f1(n.len) + ', ' + f1(n.w) + '); c = mix(c, ' + vec3(n.col) + ', k); a = a + k * (1.0 - a); }');
    else L.push('        { float k = segCov(' + q + ', P + D * ' + f1(n.a0) + ', P + D * ' + f1(n.len) + ', ' + f1(n.w) + ', ' + (n.q ? '1.0' : '0.0') + '); c = mix(c, ' + vec3(n.col) + ', k); a = a + k * (1.0 - a); }');
    if (n.tip) L.push('        { float k = segCov(' + q + ', P + D * ' + f1(n.len - n.tip.len) + ', P + D * ' + f1(n.len) + ', ' + f1(n.w) + ', ' + (n.q ? '1.0' : '0.0') + '); c = mix(c, ' + vec3(n.tip.col) + ', k); a = a + k * (1.0 - a); }');
    L.push('    }');
    return L.join('\n');
}

/**
 * The side's fragment shader for a look (meta from skin_looks.js). Everything that does not change per
 * frame is a constant here; the fixed cut-outs force alpha 0 again (they are 0 in the art already).
 */
function fragment(meta, side, dims) {
    const S = SIDES[side], cells = meta.cells[side], fm = meta.fill[S.main];
    const D = dims || nominalDims();
    const vat = (d) => 'vec3(' + d.map(f1).join(', ') + ')';
    const trail = (f) => (f && f.trail ? f.trail : [1, 0, 1]);
    const head = (f) => (f && f.head ? f.head : [0, 1]);
    const q = (f) => (f && f.q ? f.q : 0);
    const nm = meta.needle[S.main];
    const cuts = cutsOf(side).map((r) => '    if (inRect(q, vec4(' + r.map(f1).join(', ') + '))) a = 0.0;').join('\n');
    return [
        '#ifdef GL_FRAGMENT_PRECISION_HIGH',
        'precision highp float;',
        '#else',
        'precision mediump float;',
        '#endif',
        '// G\'s Dash cluster skin "' + meta.id + '", ' + (side === 'L' ? 'left' : 'right') + ' side (skin_core.js)',
        'varying vec2 v_uv;',
        'uniform sampler2D u_field;',
        'uniform sampler2D u_art;',
        'uniform sampler2D u_band;',
        'uniform sampler2D u_glyph;',
        'uniform float u_fresh;',
        'uniform vec4 u_fill;',
        'uniform vec4 u_nm;',
        'uniform vec4 u_gl;',
        'uniform vec4 u_cut;',
        'const vec2 SZ = vec2(' + f1(S.w) + ', ' + f1(S.h) + ');',
        'const vec2 FSZ = vec2(' + f1(Math.ceil(S.w / FIELD_K)) + ', ' + f1(Math.ceil(S.h / FIELD_K)) + ');',
        'const vec2 BSZ = vec2(' + f1(BAND_W) + ', ' + f1(BAND_ROWS) + ');',
        'const vec2 GSZ = vec2(' + f1(cells.atlas[0]) + ', ' + f1(cells.atlas[1]) + ');',
        'const vec3 AAT = ' + vat(D.art) + ', BAT = ' + vat(D.band) + ', FAT = ' + vat(D.field) + ';',
        'const float TILE = ' + f1(TILE) + ', TCOLS = ' + f1(ATLAS_W / TILE) + ';',
        'vec4 texel(sampler2D t, vec2 p, vec2 sz) { return texture2D(t, (floor(p) + 0.5) / sz); }',
        '// 0.11.2: tiled (skin_assets.js pack): the sz picture\'s texel p, from its atlas (at: the',
        '// atlas\' width, height, and its first tile row; the tile grid\'s slot numbers are its top-left texels)',
        'vec4 tiled(sampler2D t, vec2 p, vec2 sz, vec3 at) {',
        '    p = clamp(floor(p), vec2(0.0), sz - 1.0);',
        '    vec2 tc = floor(p / TILE);',
        '    vec4 ix = texture2D(t, (tc + 0.5) / at.xy);',
        '    float k = floor(ix.r * 255.0 + 0.5) + floor(ix.g * 255.0 + 0.5) * 256.0;',
        '    float row = floor((k + 0.5) / TCOLS);',
        '    vec2 o = vec2(k - row * TCOLS, row) * TILE + vec2(0.0, at.z);',
        '    return texture2D(t, (o + p - tc * TILE + 0.5) / at.xy);',
        '}',
        'bool inRect(vec2 p, vec4 r) { return p.x >= r.x && p.y >= r.y && p.x < r.z && p.y < r.w; }',
        '// a capsule from A to B, w wide: anti-aliased coverage, or (hard 1) all or nothing',
        'float segCov(vec2 p, vec2 A, vec2 B, float w, float hard) {',
        '    vec2 ab = B - A; float t = clamp(dot(p - A, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);',
        '    float d = length(p - A - ab * t);',
        '    return hard > 0.5 ? step(d, w * 0.5) : clamp(w * 0.5 + 0.5 - d, 0.0, 1.0);',
        '}',
        '// a needle tapering from w either side at the contour to 1 px at the tip',
        'float taperCov(vec2 p, vec2 P, vec2 D, float len, float w) {',
        '    vec2 r = p - P; float u = dot(r, D), v = abs(dot(r, vec2(-D.y, D.x)));',
        '    float hw = w + (1.0 - w) * clamp(u / len, 0.0, 1.0);',
        '    return clamp(hw - v + 0.5, 0.0, 1.0) * clamp(u + 0.5, 0.0, 1.0) * clamp(len - u + 0.5, 0.0, 1.0);',
        '}',
        '// a fill: the band\'s "on" colour over c where s is inside [F.x, F.y], with the look\'s trail and head',
        'vec3 fill(vec3 c, float top, float s, float sd, vec4 F, float rows, vec3 tr, vec2 hd, float add, float hard) {',
        '    if (F.x > F.y || sd < 0.0 || sd >= rows) return c;',
        '    float ends = hard > 0.5 ? step(F.x - 0.5, s) * step(s, F.y + 0.5) : clamp(s - F.x + 0.5, 0.0, 1.0) * clamp(F.y - s + 0.5, 0.0, 1.0);',
        '    if (ends <= 0.0) return c;',
        '    vec4 b = tiled(u_band, vec2(s, F.w + sd), BSZ, BAT);',
        '    float ds = abs(F.z - s), w = (tr.x + tr.y * exp(-ds / tr.z)) * ends * (1.0 - top);',
        '    if (add > 0.5) return min(c + (b.rgb + (b.a - b.rgb) * hd.x * exp(-ds / hd.y)) * w, 1.0);',
        '    return mix(c, b.rgb, b.a * w);',
        '}',
        'void main() {',
        '    vec2 q = floor(v_uv * SZ) + 0.5;',
        '    vec4 art = tiled(u_art, q, SZ, AAT);',
        '    float code = floor(art.a * 255.0 + 0.5);',
        '    float a = code < 128.0 ? code / 127.0 : 1.0;',
        '    float top = code < 128.0 ? 0.0 : (code - 128.0) / 127.0;',
        '    vec3 c = art.rgb;',
        '    if (code >= 128.0) {',
        // each gauge class may sample on its own grid (the Pixel look: 4 px blocks)
        fillCall('u_fill', MAIN_ROWS, fm, q(fm), trail(fm), head(fm), 1),
        '    }',
        needleGlsl(nm, 'u_nm', 'u_nm.z != 0.0 || u_nm.w != 0.0'),
        glyphGlsl(cells),
        cuts,
        '    if (inRect(q, u_cut)) a = 0.0;',
        '    gl_FragColor = vec4(c, a * clamp(u_fresh, 0.0, 1.0));',
        '}',
        '',
    ].join('\n');
}
/** the readout cells: the gear (one cell, u_gl.x) or the speed's places (cells.slots: u_gl.x, .y, .z) */
function glyphGlsl(cells) {
    const slots = cells.slots ? cells.slots : (cells.labels.length ? [[cells.rect[0], cells.rect[1]]] : []);
    const cw = cells.slots ? cells.cell[0] : cells.rect[2], ch = cells.slots ? cells.cell[1] : cells.rect[3];
    const comp = ['x', 'y', 'z'];
    return slots.map((o, p) => [
        '    if (u_gl.' + comp[p] + ' >= 0.0) {',
        '        vec2 g = q - vec2(' + f1(o[0]) + ', ' + f1(o[1]) + ');',
        '        if (g.x >= 0.0 && g.y >= 0.0 && g.x < ' + f1(cw) + ' && g.y < ' + f1(ch) + ') {',
        '            float col = mod(u_gl.' + comp[p] + ', ' + f1(cells.cols) + '), row = ' + (cells.slots ? f1(p) : 'floor(u_gl.x / ' + f1(cells.cols) + ' + 0.001)') + ';',
        '            vec4 t = texel(u_glyph, g + vec2(col * ' + f1(cw) + ', row * ' + f1(ch) + '), GSZ);',
        '            c = mix(c, t.rgb, t.a); a = a + t.a * (1.0 - a);',
        '        }',
        '    }',
    ].join('\n')).join('\n');
}
function fillCall(U, rows, f, q, tr, hd, g) {
    if (!f || f.kind === 'none') return '';
    const p = q ? 'floor(q / ' + f1(q) + ') * ' + f1(q) + ' + ' + f1(q / 2) : 'q';
    const b0 = g === 1 ? 0 : SMALL_CODE;
    return [
        '        {',
        '            vec4 fd = tiled(u_field, floor((' + p + ') / ' + f1(FIELD_K) + '), FSZ, FAT);',
        '            float b = floor(fd.b * 255.0 + 0.5) - ' + f1(b0) + ';',
        '            if (b >= 0.0 && b < ' + f1(rows * 2) + ') {',
        '                float s = (floor(fd.r * 255.0 + 0.5) + floor(fd.g * 255.0 + 0.5) * 256.0) / ' + f1(S_SCALE) + ';',
        '                c = fill(c, top, s, floor(b / 2.0 + 0.01), ' + U + ', ' + f1(rows) + ', vec3(' + tr.map(f1).join(', ') + '), vec2(' + hd.map(f1).join(', ') + '), ' + (f.add ? '1.0' : '0.0') + ', ' + (q ? '1.0' : '0.0') + ');',
        '            }',
        '        }',
    ].join('\n');
}

/**
 * 0.8.5: the uniforms the Cluster renderer (0.2.2, PROTOCOL.md "Shaders") fills itself, reserved in every
 * shader and only as mat4: a shader declaring one otherwise does not compile there ("effect did not
 * compile": the layer is never made, and everything sent to it after is "no such layer"). 0.8.0-0.8.4's
 * skins named their fill "u_m" (the model matrix's name): refused on the car in every look.
 */
const RESERVED = ['u_mvp', 'u_mv', 'u_m', 'u_v', 'u_p', 'u_normal'];
/** the reserved names a shader uses (whole identifiers): [] when none */
function reservedUses(src) {
    const s = String(src || '');
    return RESERVED.filter((n) => new RegExp('(^|[^A-Za-z0-9_])' + n + '(?![A-Za-z0-9_])').test(s));
}
const FIELD_K = 2;                                        // 0.8.4: the field's texels are 2x2 pixels (skin_assets.js)
/**
 * 0.11.2: the art, band and field go to the cluster tiled (skin_assets.js pack): TILE x TILE tiles, each
 * different one once, in an ATLAS_W wide atlas whose first rows hold the tile grid (each tile's slot). The
 * cluster's renderer keeps 16 MiB for every app's pixels together, an asset counted twice; 0.8.4-0.11.1's
 * whole textures were 14.6 MiB of it (M Style), so G's Music, G's TV, the Waze map or the logo next to
 * them had it refused: "the service's pixel memory is full". Tiled they are under 6.5 MiB, the same texels.
 */
const TILE = 16, ATLAS_W = 512;
/** an atlas for a w x h picture with n distinct tiles: { nx, ny, hdr (the first tile row), w, h } */
function atlasLayout(w, h, n) {
    const nx = Math.ceil(w / TILE), ny = Math.ceil(h / TILE), hdr = Math.ceil(ny / TILE) * TILE;
    if (nx > ATLAS_W) throw new Error('atlas: ' + w + ' px wide is too wide to tile');
    if (n === undefined) n = nx * ny;
    return { nx, ny, hdr, w: ATLAS_W, h: hdr + Math.ceil(n / (ATLAS_W / TILE)) * TILE };
}
/** the shader's atlas constants for each tiled texture, at most (no tile shared): for compile checks only;
 * the skin passes the atlases it made (skin_assets.js packLook / packField -> dims) */
function nominalDims() {
    const d = (w, h) => { const a = atlasLayout(w, h); return [a.w, a.h, a.hdr]; };
    return { art: d(REGION_W, REGION_H), band: d(BAND_W, BAND_ROWS), field: d(Math.ceil(REGION_W / FIELD_K), Math.ceil(REGION_H / FIELD_K)) };
}
module.exports = { FIELD_K, TILE, ATLAS_W, atlasLayout, nominalDims, GEOM, PANEL_W, PANEL_H, REGION_W, REGION_H, SIDES, BAND_W, BAND_ROWS, MAIN_ROWS, SMALL_ROW, SMALL_ROWS, ALT_ROW,
    SMALL_CODE, S_SCALE, CUTS, CUT_PAD, RANGE, ACC_AREA, CENTRE, SMALL_BOX, MAIN_ZONE, SPEED_COVER, GEAR_COVER, SPEED_MAX, LEN, MAJ, at, sOf, dirAt, local, cutsOf, uniforms, fragment, clamp, isNum, RESERVED, reservedUses };
