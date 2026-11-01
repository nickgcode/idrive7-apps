'use strict';
/**
 * px.js - the Pixel look's own pixel art (all drawn for G's Dash, nothing copied): a 5 x 7 block
 * font, the G's Dash logo redrawn on a small cell grid (px.EMB), a heart. Used both to bake the font atlas
 * (tools/bake_px_font.js -> fonts/gs_p_px.json, for the hub and Options text) and to draw the big
 * numerals and the emblem as rects (pixel-exact at any size). Node 8: no ?., no ??, no object spread.
 */
/* eslint-disable */
const F = {
    '0': ['.###.', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
    '1': ['..##.', '.###.', '..##.', '..##.', '..##.', '..##.', '.####'],
    '2': ['.###.', '##.##', '...##', '..##.', '.##..', '##...', '#####'],
    '3': ['####.', '...##', '...##', '.###.', '...##', '...##', '####.'],
    '4': ['...##', '..###', '.#.##', '#..##', '#####', '...##', '...##'],
    '5': ['#####', '##...', '####.', '...##', '...##', '##.##', '.###.'],
    '6': ['.###.', '##...', '##...', '####.', '##.##', '##.##', '.###.'],
    '7': ['#####', '...##', '..##.', '..##.', '.##..', '.##..', '.##..'],
    '8': ['.###.', '##.##', '##.##', '.###.', '##.##', '##.##', '.###.'],
    '9': ['.###.', '##.##', '##.##', '.####', '...##', '...##', '.###.'],
    'A': ['.###.', '##.##', '##.##', '#####', '##.##', '##.##', '##.##'],
    'B': ['####.', '##.##', '##.##', '####.', '##.##', '##.##', '####.'],
    'C': ['.####', '##...', '##...', '##...', '##...', '##...', '.####'],
    'D': ['####.', '##.##', '##.##', '##.##', '##.##', '##.##', '####.'],
    'E': ['#####', '##...', '##...', '####.', '##...', '##...', '#####'],
    'F': ['#####', '##...', '##...', '####.', '##...', '##...', '##...'],
    'G': ['.####', '##...', '##...', '##.##', '##.##', '##.##', '.####'],
    'H': ['##.##', '##.##', '##.##', '#####', '##.##', '##.##', '##.##'],
    'I': ['####', '.##.', '.##.', '.##.', '.##.', '.##.', '####'],
    'J': ['...##', '...##', '...##', '...##', '##.##', '##.##', '.###.'],
    'K': ['##.##', '##.##', '####.', '###..', '####.', '##.##', '##.##'],
    'L': ['##...', '##...', '##...', '##...', '##...', '##...', '#####'],
    'M': ['#...#', '##.##', '#####', '##.##', '##.##', '##.##', '##.##'],
    'N': ['##.##', '###.#', '#####', '##.##', '##.##', '##.##', '##.##'],
    'O': ['.###.', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
    'P': ['####.', '##.##', '##.##', '####.', '##...', '##...', '##...'],
    'Q': ['.###.', '##.##', '##.##', '##.##', '##.##', '##.#.', '.##.#'],
    'R': ['####.', '##.##', '##.##', '####.', '##.##', '##.##', '##.##'],
    'S': ['.####', '##...', '##...', '.###.', '...##', '...##', '####.'],
    'T': ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
    'U': ['##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
    'V': ['##.##', '##.##', '##.##', '##.##', '##.##', '.###.', '..#..'],
    'W': ['##.##', '##.##', '##.##', '##.##', '#####', '##.##', '#...#'],
    'X': ['##.##', '##.##', '.###.', '..#..', '.###.', '##.##', '##.##'],
    'Y': ['##.##', '##.##', '##.##', '.###.', '..##.', '..##.', '..##.'],
    'Z': ['#####', '...##', '..##.', '.##..', '##...', '##...', '#####'],
    ' ': ['...', '...', '...', '...', '...', '...', '...'],
    '.': ['..', '..', '..', '..', '..', '##', '##'],
    ',': ['..', '..', '..', '..', '##', '##', '#.'],
    ':': ['..', '##', '##', '..', '##', '##', '..'],
    "'": ['##', '##', '#.', '..', '..', '..', '..'],
    '"': ['##.##', '##.##', '#..#.', '.....', '.....', '.....', '.....'],
    '-': ['....', '....', '....', '####', '....', '....', '....'],
    '+': ['......', '..##..', '..##..', '######', '..##..', '..##..', '......'],
    '/': ['...##', '...##', '..##.', '..#..', '.##..', '##...', '##...'],
    '(': ['.##', '##.', '##.', '##.', '##.', '##.', '.##'],
    ')': ['##.', '.##', '.##', '.##', '.##', '.##', '##.'],
    '!': ['##', '##', '##', '##', '##', '..', '##'],
    '?': ['.###.', '##.##', '...##', '..##.', '..##.', '.....', '..##.'],
    '%': ['##..#', '##.##', '..##.', '.##..', '##...', '#.###', '..###'],
    '&': ['.##..', '#..#.', '.##..', '###.#', '#..##', '#..#.', '.##.#'],
    '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
    '<': ['...##', '..##.', '.##..', '##...', '.##..', '..##.', '...##'],
    '>': ['##...', '.##..', '..##.', '...##', '..##.', '.##..', '##...'],
    '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
    '#': ['.#.#.', '#####', '.#.#.', '.#.#.', '#####', '.#.#.', '.....'],
    '\u00b0': ['###', '#.#', '###', '...', '...', '...', '...'],
    '\u00b7': ['..', '..', '..', '##', '##', '..', '..'],
    '\u2026': ['.......', '.......', '.......', '.......', '.......', '##.##.#', '##.##.#'],
    '|': ['##', '##', '##', '##', '##', '##', '##'],
};
// cells: [[x, y], ...] per char (lower case drawn as upper case)
const CELLS = {};
Object.keys(F).forEach((ch) => {
    const rows = F[ch], out = [];
    rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === '#') out.push([x, y]); });
    CELLS[ch] = { w: rows[0].length, cells: out, runs: runs(rows) };
});
/** horizontal runs [x, y, len]: one rect each */
function runs(rows) {
    const out = [];
    rows.forEach((r, y) => { let x = 0; while (x < r.length) { if (r[x] !== '#') { x++; continue; } let e = x; while (e < r.length && r[e] === '#') e++; out.push([x, y, e - x]); x = e; } });
    return out;
}
const glyph = (ch) => CELLS[ch] || CELLS[String(ch).toUpperCase()] || CELLS['?'];

/** Width in px of s at cell size u (1 cell gap between glyphs). */
function width(s, u) { let w = 0; s = String(s); for (let i = 0; i < s.length; i++) w += (glyph(s[i]).w + 1) * u; return s.length ? w - u : 0; }
/**
 * Pixel text as rects: s at cell size u, top-left (x, y) unless o.align ('center' / 'right' on x),
 * colour c; o.shadow: a colour drawn one cell down-right first. Returns the width.
 */
function text(cv, s, x, y, u, c, o) {
    o = o || {}; s = String(s);
    const w = width(s, u), ts = cv.textScale || 1;
    // on the device's own pixel grid: a cell is a whole number of screen px (no seams, no soft edges)
    const ud = Math.max(1, Math.round(u * ts)) / ts, sn = (v) => Math.round(v * ts) / ts, ov = 0.5 / ts;
    let pen = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
    pen = sn(pen); y = sn(y);
    const sh = sn(Math.min(u, 6));
    for (let i = 0; i < s.length; i++) {
        const g = glyph(s[i]);
        if (o.shadow) g.runs.forEach((r) => cv.fillRect(pen + r[0] * ud + sh, y + r[1] * ud + sh, r[2] * ud + ov, ud + ov, o.shadow));
        g.runs.forEach((r) => cv.fillRect(pen + r[0] * ud, y + r[1] * ud, r[2] * ud + ov, ud + ov, c));
        pen += (g.w + 1) * ud;
    }
    return w;
}

/* ---------------- the heart (9 x 8) ---------------- */
const HEART = ['.##...##.', '####.####', '#########', '#########', '.#######.', '..#####..', '...###...', '....#....'];
const HEART_HI = [[1, 1], [2, 1], [1, 2]];          // its highlight cells
function heart(cv, x, y, u, c, hi, edge) {
    if (edge) runs(HEART).forEach((r) => { cv.fillRect(x + r[0] * u - u, y + r[1] * u, r[2] * u + 2 * u, u, edge); cv.fillRect(x + r[0] * u, y + r[1] * u - u, r[2] * u, u * 2 + u, edge); });
    runs(HEART).forEach((r) => cv.fillRect(x + r[0] * u, y + r[1] * u, r[2] * u, u, c));
    if (hi) HEART_HI.forEach((p) => cv.fillRect(x + p[0] * u, y + p[1] * u, u, u, hi));
}

/* ---------------- the emblem: G's Dash's logo (lib.js badge) as pixel art ----------------
 * Three slanted stripes (light blue, dark blue, red) and the blocky italic G, rasterised once from
 * the badge's own geometry on a 13-cell-tall grid, then shaded by hand rules: a lighter top row, a
 * darker bottom row, a 1-cell dark outline. Grid: EMB.w x EMB.h cells, EMB.px[y][x] = colour key. */
const EMB_H = 13;
const EMB = (function () {
    // upright, then slanted: row y moves right by round(0.27 * (12 - y)) cells (the badge's lean)
    const B = [
        'LL.DD.RR..GGGGGGGGGGG',
        'LL.DD.RR..GGGGGGGGGGG',
        'LL.DD.RR..GGGGGGGGGGG',
        'LL.DD.RR..GGG........',
        'LL.DD.RR..GGG........',
        'LL.DD.RR..GGG........',
        'LL.DD.RR..GGG..GGGGGG',
        'LL.DD.RR..GGG..GGGGGG',
        'LL.DD.RR..GGG...GGGGG',
        'LL.DD.RR..GGG.....GGG',
        'LL.DD.RR..GGGGGGGGGGG',
        'LL.DD.RR..GGGGGGGGGGG',
        'LL.DD.RR..GGGGGGGGGGG',
    ];
    const key = { L: 'lb', D: 'db', R: 'rd', G: 'g' };
    const h = B.length, W = B[0].length + 4 + 2, H = h + 2, px = [];
    for (let y = 0; y < H; y++) { const r = []; for (let x = 0; x < W; x++) r.push(null); px.push(r); }
    B.forEach((row, y) => {
        const sh = Math.round(0.27 * (h - 1 - y));
        for (let x = 0; x < row.length; x++) if (row[x] !== '.') px[y + 1][x + 1 + sh] = key[row[x]];
    });
    // shading: a lit top row, a shadowed bottom row per shape
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = px[y][x]; if (!c || c.length > 2) continue;
        const up = y > 0 ? px[y - 1][x] : null, dn = y < H - 1 ? px[y + 1][x] : null;
        if (!up || up[0] !== c[0]) px[y][x] = c + '+';
        else if (!dn || dn[0] !== c[0]) px[y][x] = c + '-';
    }
    // outline: empty cells touching a shape (4-way, plus diagonals for a solid edge)
    const out = px.map((r) => r.slice());
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (px[y][x]) continue;
        let near = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const r = px[y + dy]; if (r && r[x + dx]) near = true; }
        if (near) out[y][x] = 'o';
    }
    return { w: W, h: H, px: out };
})();
const EMB_COL = {
    lb: '#2fa8e8', 'lb+': '#8fd6ff', 'lb-': '#1d7cb8',
    db: '#1e4ca0', 'db+': '#4a7fd6', 'db-': '#12306a',
    rd: '#e4212b', 'rd+': '#ff7a6e', 'rd-': '#9c1018',
    g: '#f5f7fa', 'g+': '#ffffff', 'g-': '#aeb8c8',
    o: '#05060c',
};
/** The emblem's cells as runs of one colour: [x, y, len, key] (drawn as one rect each). */
const EMB_RUNS = (function () {
    const out = [];
    EMB.px.forEach((r, y) => { let x = 0; while (x < r.length) { const c = r[x]; if (!c) { x++; continue; } let e = x; while (e < r.length && r[e] === c) e++; out.push([x, y, e - x, c]); x = e; } });
    return out;
})();
/**
 * The emblem at (x, y), cell size u. o.shine: the sweep's position in cells (a 2-cell diagonal band
 * that whitens what it crosses, null = none); o.slide: 0..1 per stripe [a, b, c] (stripes sliding in
 * from the left, 1 = home); o.flash: a colour over the shapes (the redline).
 */
function emblem(cv, x, y, u, o) {
    o = o || {};
    const sl = o.slide || [1, 1, 1];
    const shift = (key, cx) => {
        const i = key[0] === 'l' ? 0 : key[0] === 'd' ? 1 : key[0] === 'r' ? 2 : -1;
        if (i < 0 && key !== 'o') return 0;
        if (key === 'o') return 0;
        return Math.round((1 - sl[i]) * -(12 + 6 * i)) * u;
    };
    const slid = sl[0] < 1 || sl[1] < 1 || sl[2] < 1;
    EMB_RUNS.forEach((r) => {
        if (slid && r[3] === 'o') return;          // (the outline only once they are home)
        const dx = shift(r[3]);
        const c = o.flash && r[3] !== 'o' ? o.flash : EMB_COL[r[3]];
        cv.fillRect(x + r[0] * u + dx, y + r[1] * u, r[2] * u + 0.4, u + 0.4, c);
    });
    if (o.shine !== null && o.shine !== undefined && !o.flash) {
        // the band: cells with x + (h - y) * 0.27 in [shine, shine + 2)
        EMB.px.forEach((row, cy) => row.forEach((c, cx) => {
            if (!c || c === 'o') return;
            const d = cx - 0.27 * (EMB.h - cy) - o.shine;
            if (d >= 0 && d < 2.2) cv.fillRect(x + cx * u, y + cy * u, u, u, d < 1.1 ? '#ffffff' : [255, 255, 255, 140]);
        }));
    }
}

module.exports = { F, glyph, width, text, heart, HEART, emblem, EMB, EMB_COL, EMB_RUNS };
