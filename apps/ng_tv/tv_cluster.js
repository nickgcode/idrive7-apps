'use strict';
/**
 * tv_cluster.js - G's TV's picture in the instrument cluster's central map area ("Play in cluster"),
 * through the separately installed "Cluster renderer" tool (cluster-render, robertnisipeanu/idrive-apps,
 * from the Store). Written for G's TV from the tool's PROTOCOL.md and README; it contains none of the
 * tool's code. The tool's own Node client (MPL-2.0) is loaded at run time from where the tool installs it,
 * nothing of it is copied here:
 *     /var/opt/cluster-render/current/cluster_render_client.js
 *
 * What goes there: one "video" layer on the "map" target only (slot 0x100, 1088x480, the area between the
 * dials), class "content" at z 100 (above the CarPlay map of waze-on-cluster, content at z 0, however
 * old either layer is), never "alert", never video on the "panel" target (see 0.4.1 below). It covers the whole map area
 * and is "exclusive": while it is drawn the service suspends (does not remove) the layers below it on the
 * map, so the picture replaces the CarPlay map instead of sitting on it; the suspended layers write
 * nothing to the display and come back in the flush ours goes. A drawn layer is one with a frame within
 * stall_ms, so a stalled picture also gives the map back. Layers above ours (overlay, alert) still show.
 *
 * The frame is 544x240, half the map area, which the cluster's GPU doubles to 1088x480: the picture
 * fitted into it at its own aspect (4:3: 320x240, shown 640x480 at x 224; 16:9: 426x240, shown 852x480),
 * black around it (the bars never change, so after the first frame the service writes only the picture's
 * tiles). Each frame is the decoder's I420 picture scaled to that size and repacked into the service's
 * 4:2:0 atlas (Y rows, then U and V side by side in h/2 rows), its levels stretched from limited to full
 * range (the service's shader is full-range BT.601). At most 15 a second: 196 KB a frame over the local
 * socket; to the cluster about 1.7 MB/s worst case for 4:3 (2.3 MB/s for 16:9), with the map below
 * suspended and writing nothing, well under the service's shared 6000 KB/s ceiling; fewer a second when
 * the service reports a lower upload cap.
 *
 * Safety (main.js decides when; this file makes it immediate): stop() drops the layer, which the service
 * removes at once (no fade). stall_ms 1000 (the service's minimum) as a backstop: if frames stop without a
 * drop, the last one stops being drawn within about a second. When the app ends its socket closes and
 * the service removes its layers at once.
 *
 * Trust: the client file is code that runs in G's TV, so it is used only when it is a regular file owned
 * by root and not writable by group or others (the Store installs tools as root), in a directory with the
 * same properties. NG_CR_CLIENT / NG_CR_SOCK point at a test client and socket (the emulator, tests) and
 * skip that check.
 *
 * Service 0.2.2 adds "rendering" to its target events (verified: the cluster's renderer draws our scene;
 * checking: not yet, and after 1.5 s shown the service asks for the slot again by itself; unobservable;
 * none). The tool's client (unchanged) does not pass it on, so it is read from the event before the client
 * handles it, and shown in the status line. 0.2.1 sends none: the status is as before. Nothing here acts
 * on it: the service does the asking again, and the layer, its class, z and stall_ms stay as they are.
 *
 * 0.3.0, the HUD (an experiment, parked only, see main.js): the same class with target "hud" (slot 0x323,
 * 800x480, a separate connection) draws either a still test card (an "image" layer: 200x120 RGBA, 96 KB
 * sent once, doubled twice by the HUD's GPU with nearest sampling) or the same video as on the map, in a
 * 400x240 frame doubled to 800x480 (4:3: 320x240, shown 640x480; 16:9: 400x224, shown 800x448), black
 * around. Class "content", z 100, contend (asks again after the stock HMI took the slot; the service's
 * default hud_take_over_stock = 0 never unmaps the stock HUD content, so behind it ours is only parked),
 * and NOT exclusive: exclusive only suspends other cluster-render layers below ours on the same target,
 * it cannot cover the HUD's own content (that is a different mapping in the slot, the KOMBI's queue
 * decides), and our layer is opaque over the whole target anyway. Never "alert".
 *
 * 0.4.1, the panel test (an experiment, parked only, see main.js; unproven on the car): target "panel"
 * (slot 0x203, 1920x720, the whole cluster, over the gauges), which shares the HUD's scene id, so the two
 * exclude each other. Only ever a still test card, never video: one "image" layer exactly like the HUD
 * test card's (class "content", z 100, NOT exclusive, contend, nearest sampling), 480x180 RGBA (338 KB sent
 * once) drawn 4x by the cluster's GPU. Two cards: "full" (opaque, the whole panel: a 1-px border at the
 * very edge, TL / TR / BL / BR corner marks, coordinate ticks in panel px, a coarse grid, seven colour
 * bars, "G'S TV PANEL TEST · PARKED ONLY") and "sides" (the left and right thirds only, open line work
 * over a transparent background and a transparent centre third: whether the stock gauges stay visible
 * under our layer).
 *
 * Never throws into the player, never blocks. Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const path = require('path');

const CLIENT = process.env.NG_CR_CLIENT || '/var/opt/cluster-render/current/cluster_render_client.js';
const SOCK = process.env.NG_CR_SOCK || '/dev/shm/cluster-render/render.sock';
const TESTING = !!(process.env.NG_CR_CLIENT || process.env.NG_CR_SOCK);

const TARGET = 'map';                     // the cluster's map area (the default target)
const MAP_W = 1088, MAP_H = 480;          // the map target's size
/* The targets G's TV may use: size, z and whether the layer is exclusive (see above). panel: cards only. */
const TARGETS = {
    map: { name: 'map', W: MAP_W, H: MAP_H, exclusive: true, tag: 'cluster', area: 'the map area' },
    hud: { name: 'hud', W: 800, H: 480, exclusive: false, tag: 'hud', area: 'the HUD' },
    panel: { name: 'panel', W: 1920, H: 720, exclusive: false, tag: 'panel', area: 'the whole cluster', cardsOnly: true },
};
const CARD_W = 200, CARD_H = 120;         // the HUD test card, drawn 4x (800x480) by the HUD's GPU
const PANEL_CW = 480, PANEL_CH = 180;     // the panel test cards, drawn 4x (1920x720) by the cluster's GPU
const AREA = { x: 0, y: 0, w: MAP_W, h: MAP_H };  // the layer: the whole map area
const FRAME_W = MAP_W / 2, FRAME_H = MAP_H / 2;   // 544x240, doubled on the cluster's GPU
const FPS = 15;                           // at most, while the upload cap is at its ceiling
const Z = 100;                            // above other "content" layers on the map whatever their age (the
                                          // service orders by class, then z, then newest; the CarPlay map of
                                          // waze-on-cluster is content at z 0), never "alert"
const EXCLUSIVE = true;                   // the layers below ours on the map are suspended while ours is drawn
const STALL_MS = 1000;                    // the service's minimum
const READY_MS = 5000;                    // no hello within this: "not answering"

/* ----- the picture ----- */

/** Levels: limited range (16-235 / 16-240) -> full range, as two lookup tables. */
const LUT_Y = new Uint8Array(256), LUT_C = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    LUT_Y[i] = Math.max(0, Math.min(255, Math.round((i - 16) * 255 / 219)));
    LUT_C[i] = Math.max(0, Math.min(255, Math.round((i - 128) * 255 / 224 + 128)));
}

/**
 * For a w x h picture: the layer (x, y, w, h: the whole map area), its frame (vw x vh, 544x240), the
 * picture in the frame (pw x ph at px, py: the largest that fits at the picture's aspect, even sizes and
 * places for the 4:2:0 chroma, centred) and where that shows on the map (sx, sy, sw, sh).
 */
function geometry(w, h, target) {
    const T = TARGETS[target] || TARGETS.map;
    const AREA = { x: 0, y: 0, w: T.W, h: T.H }, FRAME_W = T.W / 2, FRAME_H = T.H / 2;
    const asp = w / h;
    let pw = Math.round(FRAME_H * asp), ph = FRAME_H;
    if (pw > FRAME_W) { pw = FRAME_W; ph = Math.round(FRAME_W / asp); }
    pw = Math.max(2, pw & ~1); ph = Math.max(2, ph & ~1);
    const px = ((FRAME_W - pw) >> 1) & ~1, py = ((FRAME_H - ph) >> 1) & ~1;
    const kx = AREA.w / FRAME_W, ky = AREA.h / FRAME_H;
    return { vw: FRAME_W, vh: FRAME_H, x: AREA.x, y: AREA.y, w: AREA.w, h: AREA.h, pw, ph, px, py,
        sx: AREA.x + px * kx, sy: AREA.y + py * ky, sw: pw * kx, sh: ph * ky };
}

/** A vw x vh atlas, black (full-range Y 0, neutral chroma) everywhere. */
function blackAtlas(vw, vh) {
    const b = Buffer.alloc(vw * vh * 3 / 2);
    b.fill(128, vw * vh);
    return b;
}

/* A 5x7 font for the test card's few letters. */
const GLYPHS = {
    'A': '01110100011000111111100011000110001', 'D': '11110100011000110001100011000111110',
    'E': '11111100001000011110100001000011111', 'G': '01110100011000010111100011000101111',
    'H': '10001100011000111111100011000110001', 'K': '10001100101010011000101001001010001',
    'L': '10000100001000010000100001000011111', 'N': '10001110011010110011100011000110001',
    'O': '01110100011000110001100011000101110', 'P': '11110100011000111110100001000010000',
    'R': '11110100011000111110101001001010001', 'S': '01111100001000001110000010000111110',
    'T': '11111001000010000100001000010000100', 'U': '10001100011000110001100011000101110',
    'V': '10001100011000110001100010101000100', 'Y': '10001100010101000100001000010000100',
    "'": '00100001000100000000000000000000000', ' ': '00000000000000000000000000000000000',
    // 0.4.1, for the panel cards
    'B': '11110100011000111110100011000111110', 'C': '01110100011000010000100001000101110',
    'F': '11111100001000011110100001000010000', 'I': '01110001000010000100001000010001110',
    'M': '10001110111010110101100011000110001', 'X': '10001100010101000100010101000110001',
    'W': '10001100011000110101101011010101010',
    '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110',
    '2': '01110100010000100010001000100011111', '3': '11111000100010000010000011000101110',
    '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
    '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000',
    '8': '01110100011000101110100011000101110', '9': '01110100011000101111000010001001100',
    '\u00b7': '00000000000111001110011100000000000', '/': '00001000100001000100010000100010000',
    '-': '00000000000000011111000000000000000',
};
/** A W x H RGBA raster (straight alpha, all transparent) with the few drawing calls the cards use. */
function raster(W, H) {
    const b = Buffer.alloc(W * H * 4);
    const px = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; b[o] = c[0]; b[o + 1] = c[1]; b[o + 2] = c[2]; b[o + 3] = c.length > 3 ? c[3] : 255; };
    const rect = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(i, j, c); };
    const textW = (s, k) => (s.length * 6 - 1) * k;
    /** s at x, y (align: 'left' | 'center' | 'right' about x), k: the glyph scale */
    const text = (s, x, y, k, c, align) => {
        const x0 = align === 'center' ? Math.round(x - textW(s, k) / 2) : align === 'right' ? x - textW(s, k) : x;
        for (let n = 0; n < s.length; n++) {
            const g = GLYPHS[s[n]] || GLYPHS[' '];
            for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r * 5 + q] === '1') rect(x0 + (n * 6 + q) * k, y + r * k, k, k, c);
        }
    };
    return { b, W, H, px, rect, text, textW };
}
const WHITE = [255, 255, 255], YELLOW = [255, 204, 0], GREY = [70, 70, 70], GREY2 = [120, 120, 120];
const BARS = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255]];
/** Corner marks: an L of len card px at each corner, inset by d, and its TL / TR / BL / BR label. */
function corners(R, x0, x1, len, d, labels) {
    const { rect, text, H } = R, k = 2, th = 2;
    const c = [[x0 + d, d, 1, 1, 'TL'], [x1 - d, d, -1, 1, 'TR'], [x0 + d, H - 1 - d, 1, -1, 'BL'], [x1 - d, H - 1 - d, -1, -1, 'BR']];
    c.forEach((q) => {
        if (labels.indexOf(q[4]) < 0) return;
        const x = q[0], y = q[1], sx = q[2], sy = q[3];
        rect(sx > 0 ? x : x - len + 1, sy > 0 ? y : y - th + 1, len, th, YELLOW);
        rect(sx > 0 ? x : x - th + 1, sy > 0 ? y : y - len + 1, th, len, YELLOW);
        const tx = sx > 0 ? x + 5 : x - 4, ty = sy > 0 ? y + 5 : y - 4 - 7 * k;
        text(q[4], tx, ty, k, YELLOW, sx > 0 ? 'left' : 'right');
    });
}
/**
 * The panel test cards, PANEL_CW x PANEL_CH RGBA (one card px = 4 panel px). kind 'full': opaque over the
 * whole panel; 'sides': the left and right thirds only, open line work, everything else transparent.
 */
function panelCard(kind) {
    const R = raster(PANEL_CW, PANEL_CH), W = R.W, H = R.H, S = 1920 / W;
    const { rect, text } = R;
    if (kind === 'sides') {
        const third = W / 3;                              // 160: 640 panel px
        [[0, third - 1, ['TL', 'BL'], 'LEFT'], [W - third, W - 1, ['TR', 'BR'], 'RIGHT']].forEach((z) => {
            const a = z[0], e = z[1];
            for (let x = a + 20; x < e; x += 20) for (let y = 0; y < H; y += 2) R.px(x, y, GREY2);      // a dotted grid
            for (let y = 20; y < H; y += 20) for (let x = a; x <= e; x += 2) R.px(x, y, GREY2);
            rect(a, 0, e - a + 1, 1, WHITE); rect(a, H - 1, e - a + 1, 1, WHITE);              // the third's outline
            rect(a, 0, 1, H, WHITE); rect(e, 0, 1, H, WHITE);
            corners(R, a, e, 12, 3, z[2]);
            const bw = 14, bx = Math.round((a + e + 1) / 2 - bw * 3.5);
            BARS.forEach((c, i) => rect(bx + i * bw, 26, bw, 8, c));                            // a thin bar strip
            text(z[3], (a + e + 1) / 2, H / 2 - 7, 2, WHITE, 'center');
            text('SIDE TEST', (a + e + 1) / 2, H / 2 + 12, 1, YELLOW, 'center');
            text('X ' + (a * S) + '-' + ((e + 1) * S), (a + e + 1) / 2, H - 40, 1, WHITE, 'center');
        });
        return R.b;
    }
    rect(0, 0, W, H, [0, 0, 0]);
    for (let x = 30; x < W; x += 30) rect(x, 1, 1, H - 2, x % 60 ? GREY : GREY2);                // the grid: 120 / 240 panel px
    for (let y = 30; y < H; y += 30) rect(1, y, W - 2, 1, y % 60 ? GREY : GREY2);
    // coordinate ticks in panel px: every 40 (short), every 160 (long, labelled)
    for (let x = 10; x < W; x += 10) {
        const L = x % 40 ? 3 : 7;
        rect(x, 1, 1, L, WHITE); rect(x, H - 1 - L, 1, L, WHITE);
        if (!(x % 40) && x > 60 && x < W - 60) { text(String(x * S), x, 10, 1, WHITE, 'center'); text(String(x * S), x, H - 18, 1, WHITE, 'center'); }
    }
    for (let y = 10; y < H; y += 10) {
        const L = y % 40 ? 3 : 7;
        rect(1, y, L, 1, WHITE); rect(W - 1 - L, y, L, 1, WHITE);
        if (!(y % 40) && y > 20 && y < H - 30) { text(String(y * S), 10, y - 3, 1, WHITE, 'left'); text(String(y * S), W - 10, y - 3, 1, WHITE, 'right'); }
    }
    rect(0, 0, W, 1, WHITE); rect(0, H - 1, W, 1, WHITE); rect(0, 0, 1, H, WHITE); rect(W - 1, 0, 1, H, WHITE);   // the very edge
    corners(R, 0, W - 1, 14, 3, ['TL', 'TR', 'BL', 'BR']);
    text("G'S TV PANEL TEST \u00b7 PARKED ONLY", W / 2, 36, 2, WHITE, 'center');
    const bw = 44, bx = (W - bw * BARS.length) >> 1;
    BARS.forEach((c, i) => rect(bx + i * bw, 64, bw, 44, c));
    rect(W / 2, 112, 1, 8, WHITE); rect(W / 2 - 4, 116, 9, 1, WHITE);                             // the centre
    text('1920X720 \u00b7 CARD 480X180 X4 \u00b7 TICKS IN PANEL PX', W / 2, 126, 1, YELLOW, 'center');
    return R.b;
}
/**
 * The HUD test card: CARD_W x CARD_H RGBA (straight alpha, all opaque), high contrast: black, a white
 * border, "G'S TV" / "HUD TEST" in white, seven colour bars and "PARKED ONLY" in yellow.
 */
function testCard() {
    const W = CARD_W, H = CARD_H, b = Buffer.alloc(W * H * 4);
    const px = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; b[o] = c[0]; b[o + 1] = c[1]; b[o + 2] = c[2]; b[o + 3] = 255; };
    const rect = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(i, j, c); };
    const text = (s, y, k, c) => {
        const x0 = Math.round((W - (s.length * 6 - 1) * k) / 2);
        for (let n = 0; n < s.length; n++) {
            const g = GLYPHS[s[n]] || GLYPHS[' '];
            for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r * 5 + q] === '1') rect(x0 + (n * 6 + q) * k, y + r * k, k, k, c);
        }
    };
    rect(0, 0, W, H, [0, 0, 0]);
    rect(0, 0, W, 3, [255, 255, 255]); rect(0, H - 3, W, 3, [255, 255, 255]);
    rect(0, 0, 3, H, [255, 255, 255]); rect(W - 3, 0, 3, H, [255, 255, 255]);
    text("G'S TV", 10, 3, [255, 255, 255]);
    text('HUD TEST', 36, 2, [255, 255, 255]);
    const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255]];
    const bw = Math.floor((W - 20) / bars.length), bx = (W - bw * bars.length) >> 1;
    bars.forEach((c, i) => rect(bx + i * bw, 58, bw, 36, c));
    text('PARKED ONLY', 100, 1, [255, 204, 0]);
    return b;
}

/**
 * I420 (f.w x f.h, limited range) -> a vw x vh picture (full range) in the service's atlas in out. With
 * at (a geometry()), the picture is pw x ph at px, py of a frame at.vw x at.vh (out: its atlas; the rest
 * is left as it is: black from blackAtlas()); without, out is the picture's own vw*vh*3/2 atlas.
 * Luma: the average of the 2x2 source pixels at each output pixel's place (an exact 2x2 box for a 2x
 * reduction); chroma: the nearest source sample.
 */
function toAtlas(f, vw, vh, out, maps, at) {
    const sw = f.w, sh = f.h, src = f.yuv, cw = sw >> 1, ch = sh >> 1, us = sw * sh, vs = us + cw * ch;
    const m = maps && maps.key === sw + 'x' + sh + '>' + vw + 'x' + vh ? maps : mapsFor(sw, sh, vw, vh);
    const xm = m.xm, ym = m.ym, cxm = m.cxm, cym = m.cym;
    const fw = at ? at.vw : vw, fh = at ? at.vh : vh, px = at ? at.px : 0, py = at ? at.py : 0;
    for (let j = 0; j < vh; j++) {
        const r0 = ym[j] * sw, r1 = (ym[j] + 1 < sh ? ym[j] + 1 : ym[j]) * sw, o = (py + j) * fw + px;
        for (let i = 0; i < vw; i++) {
            const x0 = xm[i], x1 = x0 + 1 < sw ? x0 + 1 : x0;
            out[o + i] = LUT_Y[(src[r0 + x0] + src[r0 + x1] + src[r1 + x0] + src[r1 + x1] + 2) >> 2];
        }
    }
    const hw = vw >> 1, hh = vh >> 1, ys = fw * fh, fhw = fw >> 1;
    for (let j = 0; j < hh; j++) {
        const o = ys + ((py >> 1) + j) * fw + (px >> 1), ur = us + cym[j] * cw, vr = vs + cym[j] * cw;
        for (let i = 0; i < hw; i++) { const x = cxm[i]; out[o + i] = LUT_C[src[ur + x]]; out[o + fhw + i] = LUT_C[src[vr + x]]; }
    }
    return m;
}
function mapsFor(sw, sh, vw, vh) {
    const xm = new Uint16Array(vw), ym = new Uint16Array(vh), cxm = new Uint16Array(vw >> 1), cym = new Uint16Array(vh >> 1);
    for (let i = 0; i < vw; i++) xm[i] = Math.min(sw - 1, Math.floor((i + 0.5) * sw / vw - 0.5) < 0 ? 0 : Math.floor((i + 0.5) * sw / vw - 0.5));
    for (let j = 0; j < vh; j++) ym[j] = Math.min(sh - 1, Math.floor((j + 0.5) * sh / vh - 0.5) < 0 ? 0 : Math.floor((j + 0.5) * sh / vh - 0.5));
    for (let i = 0; i < vw >> 1; i++) cxm[i] = Math.min((sw >> 1) - 1, Math.floor((i + 0.5) * sw / vw));
    for (let j = 0; j < vh >> 1; j++) cym[j] = Math.min((sh >> 1) - 1, Math.floor((j + 0.5) * sh / vh));
    return { key: sw + 'x' + sh + '>' + vw + 'x' + vh, xm, ym, cxm, cym };
}

/** The frame rate for an upload cap (KB/s) against its ceiling: 15 at the ceiling, then 10, then 5. */
function fpsForBudget(cap, max) {
    if (!(cap > 0) || !(max > 0) || cap >= max) return FPS;
    return cap >= 4000 ? 10 : 5;
}

/* ----- the client ----- */

/** A root-owned file nobody else may write, in a directory with the same properties. */
function trusted(file) {
    try {
        const real = fs.realpathSync(file);
        const st = fs.statSync(real), dir = fs.statSync(path.dirname(real));
        return st.isFile() && st.uid === 0 && !(st.mode & 0o022) && dir.uid === 0 && !(dir.mode & 0o022);
    } catch (e) { return false; }
}

const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };

/**
 * The tool's client, or { error, text } why not:
 *   missing: neither the client nor the socket (the tool isn't installed)
 *   noclient: the socket but no client file (an old or broken install)
 *   untrusted: not a root-owned file only root can write
 *   load: it threw or isn't the expected module
 */
function loadClient(opts) {
    const o = opts || {};
    const file = o.client || CLIENT, sock = o.sock || SOCK, testing = o.testing !== undefined ? o.testing : TESTING;
    if (!exists(file)) {
        return exists(sock) ? { error: 'noclient', text: 'Cluster renderer client missing - update the Cluster renderer tool' }
            : { error: 'missing', text: 'Cluster renderer not installed - get "Cluster renderer" in the Store' };
    }
    if (!testing && !trusted(file)) return { error: 'untrusted', text: 'Cluster renderer client not trusted (not owned by root)' };
    try {
        const m = require(file);
        if (!m || typeof m.ClusterRender !== 'function') return { error: 'load', text: 'Cluster renderer client not recognised' };
        return { ClusterRender: m.ClusterRender, sock: o.sock || process.env.NG_CR_SOCK || m.DEFAULT_PATH || SOCK };
    } catch (e) {
        return { error: 'load', text: 'Cluster renderer client failed to load', detail: e.message };
    }
}

class ClusterOut {
    /** opts: log, app ('ng_tv'), client / sock / testing (tests), now() */
    constructor(opts) {
        const o = opts || {};
        this.log = o.log || { info() {}, warn() {} };
        this.app = o.app || 'ng_tv';
        this.opts = o;
        this.T = TARGETS[o.target] || TARGETS.map;    // never "panel"
        this.tag = this.T.tag;
        this.kind = '';           // the layer: 'video' or 'image' (the HUD test card)
        this.now = o.now || Date.now;
        this.on = false;          // the toggle
        this.cr = null; this.err = null;
        this.ready = false; this.connectAt = 0;
        this.ref = 0; this.geo = null; this.key = '';
        this.atlas = null; this.maps = null; this.id = 0;
        this.fps = FPS; this.lastAt = -1e15; this.sent = 0;
        this.layerState = ''; this.layerReason = '';
        this.target = { state: '', holder: '', reason: '', rendering: '' };
        this.budget = null;
        this.refused = '';
        this.sock = '';
    }

    /** The toggle: on connects to the service (so its state shows), off drops everything and disconnects. */
    enable(on) {
        on = !!on;
        if (on === this.on) return;
        this.on = on;
        if (on) this._connect(); else this.close();
    }

    _connect() {
        if (this.cr) return;
        const c = loadClient(this.opts);
        if (c.error) {
            this.err = c;
            this.log.warn(this.tag + ': ' + c.text + (c.detail ? ' (' + c.detail + ')' : ''));
            return;
        }
        this.err = null;
        this.sock = c.sock;
        const cr = this.cr = new c.ClusterRender(this.app, this.sock);
        this.ready = false; this.connectAt = this.now();
        cr.on('ready', () => {
            if (this.cr !== cr) return;
            this.ready = true;
            this.log.info(this.tag + ': connected (' + (cr.backend || '?') + ', targets ' + (cr.targets || '?') + ')');
        });
        cr.on('disconnected', () => { if (this.cr === cr) { this.ready = false; this.connectAt = this.now(); this.log.warn(this.tag + ': renderer gone - reconnecting'); } });
        cr.on('layer', (ref, state, reason) => {
            if (this.cr !== cr || ref !== this.ref) return;
            if (state !== this.layerState || reason !== this.layerReason) this.log.info(this.tag + ': layer ' + state + (reason ? ' (' + reason + ')' : ''));
            this.layerState = state || ''; this.layerReason = reason || '';
        });
        // the target event's "rendering" (service 0.2.2), which the client's 'target' event leaves out
        let rendering = '';
        const TN = this.T.name;
        const handle = cr._event;
        if (typeof handle === 'function') {
            cr._event = function (ev) {
                try { if (ev && ev.ev === 'target' && ev.target === TN) rendering = typeof ev.rendering === 'string' ? ev.rendering : ''; } catch (e) { /* as 0.2.1 */ }
                return handle.apply(this, arguments);
            };
        }
        cr.on('target', (name, state, holder, reason) => {
            if (this.cr !== cr || name !== TN) return;
            this.log.info(this.tag + ': ' + TN + ' ' + state + (holder ? ' holder ' + holder : '') + (reason ? ' (' + reason + ')' : '') + (rendering ? ', rendering ' + rendering : ''));
            this.target = { state: state || '', holder: holder || '', reason: reason || '', rendering: rendering };
            rendering = '';
        });
        cr.on('budget', (cap, max, reason) => {
            if (this.cr !== cr) return;
            this.budget = { cap, max, reason: reason || '' };
            const fps = fpsForBudget(cap, max);
            if (fps !== this.fps) this.log.info(this.tag + ': upload cap ' + cap + ' of ' + max + ' KB/s - ' + fps + ' pictures a second');
            this.fps = fps;
        });
        cr.on('refused', (op, ref, reason) => {
            if (this.cr !== cr) return;
            this.refused = (op || '?') + ': ' + (reason || '?');
            this.log.warn(this.tag + ': refused ' + this.refused);
        });
        try { cr.connect(); } catch (e) { this.log.warn(this.tag + ': connect ' + e.message); }
    }

    /**
     * One decoded picture { w, h, yuv (I420) }. Only call while parked (main.js's gate); the layer is
     * made with the first picture after a stop(). False when nothing was sent.
     */
    write(f) {
        if (this.T.cardsOnly) return false;             // never video on the panel
        if (!this.on || !this.cr || !this.ready || !f || !f.yuv || f.w < 16 || f.h < 16 || (f.w & 1) || (f.h & 1)) return false;
        const now = this.now();
        if (now - this.lastAt < 1000 / this.fps - 4) return false;
        try {
            const key = f.w + 'x' + f.h, T = this.T;
            if (this.ref && this.kind !== 'video') this._drop();      // the test card goes first
            if (this.ref && key !== this.key) {
                // a new picture size: the same layer and frame (always the whole map area), the picture
                // placed again on black, so the map below is not let through for a moment
                const g = geometry(f.w, f.h, T.name);
                this.geo = g; this.key = key; this.maps = null;
                this.atlas = blackAtlas(g.vw, g.vh);
                this.log.info(this.tag + ': the picture ' + g.pw + 'x' + g.ph + ' shown ' + g.sw + 'x' + g.sh + ' at ' + g.sx + ',' + g.sy);
            }
            if (!this.ref) {
                const g = geometry(f.w, f.h, T.name);
                const ref = this.cr.video({ target: T.name, klass: 'content', z: Z, exclusive: T.exclusive, x: g.x, y: g.y, w: g.w, h: g.h,
                    vw: g.vw, vh: g.vh, fps: FPS, stall_ms: STALL_MS, contend: true });
                if (!ref) { this.log.warn(this.tag + ': video layer refused by the client'); return false; }
                this.ref = ref; this.geo = g; this.key = key; this.kind = 'video';
                this.atlas = blackAtlas(g.vw, g.vh);
                this.layerState = 'new'; this.layerReason = '';
                this.log.info(this.tag + ': video layer ' + g.vw + 'x' + g.vh + ' over the whole ' + T.name + (T.exclusive ? ' (exclusive)' : '') + ', the picture ' + g.pw + 'x' + g.ph + ' shown ' + g.sw + 'x' + g.sh + ' at ' + g.sx + ',' + g.sy);
            }
            this.maps = toAtlas(f, this.geo.pw, this.geo.ph, this.atlas, this.maps, this.geo);
            if (!this.cr.frame(this.ref, this.atlas, ++this.id)) return false;
            this.lastAt = now; this.sent++;
            return true;
        } catch (e) {
            this.log.warn(this.tag + ': frame ' + e.message);
            return false;
        }
    }

    /**
     * The HUD test card (target "hud" only): one image layer over the whole HUD, sent once (the client
     * sends it whole again after a reconnect). Idempotent; true while it is up. Only call while parked.
     */
    card(kind) {
        const TN = this.T.name;
        if ((TN !== 'hud' && TN !== 'panel') || !this.on || !this.cr || !this.ready) return false;
        const k = TN === 'panel' ? (kind === 'sides' ? 'sides' : 'full') : 'hud';
        if (this.ref && this.kind === 'image' && this.cardKind === k) return true;
        try {
            if (this.ref) this._drop();
            const iw = TN === 'panel' ? PANEL_CW : CARD_W, ih = TN === 'panel' ? PANEL_CH : CARD_H;
            // the same layer as the HUD test card's: content, z 100, not exclusive, contend
            const ref = this.cr.image({ target: TN, klass: 'content', z: Z, exclusive: false, x: 0, y: 0, w: this.T.W, h: this.T.H,
                iw, ih, sampling: 'nearest', contend: true });
            if (!ref) { this.log.warn(this.tag + ': image layer refused by the client'); return false; }
            this.ref = ref; this.kind = 'image'; this.cardKind = k; this.layerState = 'new'; this.layerReason = '';
            this.cr.pixels(ref, null, TN === 'panel' ? panelCard(k) : testCard());
            this.sent++;
            this.log.info(this.tag + ': test card ' + (TN === 'panel' ? '"' + k + '" ' : '') + iw + 'x' + ih + ' over ' + this.T.area + ' (' + this.T.W + 'x' + this.T.H + ')');
            return true;
        } catch (e) {
            this.log.warn(this.tag + ': test card ' + e.message);
            return false;
        }
    }

    _drop() {
        const ref = this.ref;
        this.ref = 0; this.kind = ''; this.cardKind = ''; this.key = ''; this.geo = null; this.layerState = ''; this.layerReason = ''; this.lastAt = -1e15;
        if (ref && this.cr) { try { this.cr.drop(ref); } catch (e) { /* gone */ } }
    }

    /** Off the cluster now: the layer is dropped (the service removes it at once, without a fade). */
    stop() {
        if (!this.ref) return;
        this._drop();
        this.log.info(this.tag + ': picture off');
    }

    /** Toggle off, app end: drop and disconnect. */
    close() {
        this._drop();
        if (this.cr) { try { this.cr.close(); } catch (e) { /* gone */ } }
        this.cr = null; this.ready = false;
        this.target = { state: '', holder: '', reason: '', rendering: '' };
        this.budget = null; this.refused = ''; this.fps = FPS;
    }

    /** Whether the picture is in the cluster now. */
    showing() { return !!(this.ref && this.layerState === 'shown'); }

    /**
     * { level: 'off' | 'info' | 'ok' | 'warn' | 'bad', text } for the screen. parked: the gate is open,
     * playing: the player has pictures to send.
     */
    status(parked, playing) {
        if (this.T.name === 'hud' || this.T.name === 'panel') return this._hudStatus(parked, playing);
        if (!this.on) return { level: 'off', text: 'Off' };
        if (this.err) return { level: 'bad', text: this.err.text };
        if (!this.cr) return { level: 'bad', text: 'Cluster renderer unavailable' };
        if (!this.ready) {
            const sockThere = exists(this.sock || SOCK);
            if (!sockThere) return { level: 'bad', text: 'Cluster renderer not running (no socket)' };
            return this.now() - this.connectAt > READY_MS ? { level: 'bad', text: 'Cluster renderer not answering' }
                : { level: 'info', text: 'Connecting to the cluster renderer...' };
        }
        if (!parked) return { level: 'info', text: 'Ready - plays in the cluster when parked' };
        if (!this.ref) return { level: 'info', text: playing ? 'Starting...' : 'Ready - press Play' };
        const t = this.target, ls = this.layerState;
        if (this.refused && ls !== 'shown') return { level: 'bad', text: 'Refused (' + this.refused + ')' };
        if (ls === 'error') return { level: 'bad', text: 'Refused by the renderer' + (this.layerReason ? ' (' + this.layerReason + ')' : '') };
        if (ls === 'shown' || t.state === 'shown') {
            const g = this.geo;
            const low = this.budget && this.budget.cap < this.budget.max;
            const text = 'Playing in the map area' + (g ? ' - ' + g.pw + 'x' + g.ph : '') + ' ' + this.fps + ' fps' + (low ? ' (link busy)' : '');
            // service 0.2.2: whether the cluster's renderer is drawing it; it asks again by itself
            if (t.rendering === 'checking') return { level: 'warn', text: text + ' - cluster not drawing it yet, asking again' };
            return { level: low ? 'warn' : 'ok', text: text + (t.rendering === 'verified' ? ' (drawn)' : '') };
        }
        if (t.holder === 'stock') return { level: 'warn', text: 'Taking over the stock map (Central display area: Map view)' };
        if (t.holder === 'foreign') return { level: 'warn', text: 'Map area busy (warning or other content)' };
        if (t.state === 'unavailable') return { level: 'bad', text: 'Map area unavailable' };
        if (ls === 'suspended') return { level: 'warn', text: 'Hidden by other cluster content' };
        if (ls === 'stalled') return { level: 'info', text: 'Waiting for pictures...' };
        return { level: 'info', text: 'Asking for the map area...' };
    }

    /** What the service reports for the target, in its own words: requested / shown / parked / ... */
    service() {
        const t = this.target;
        if (!t.state) return this.ref ? 'requested' : 'idle';
        const st = t.state === 'acquiring' ? 'requested' : t.state;
        return st + (t.holder && t.holder !== 'none' ? ' (' + t.holder + ')' : '') + (t.rendering && t.rendering !== 'none' ? ', rendering ' + t.rendering : '');
    }

    _hudStatus(parked, playing) {
        if (!this.on) return { level: 'off', text: 'Off' };
        if (this.err) return { level: 'bad', text: this.err.text };
        if (!this.cr) return { level: 'bad', text: 'Cluster renderer unavailable' };
        if (!this.ready) {
            if (!exists(this.sock || SOCK)) return { level: 'bad', text: 'Cluster renderer not running (no socket)' };
            return this.now() - this.connectAt > READY_MS ? { level: 'bad', text: 'Cluster renderer not answering' }
                : { level: 'info', text: 'Connecting to the cluster renderer...' };
        }
        const P = this.T.name === 'panel', NM = P ? 'Panel' : 'HUD';
        const svc = ' [' + (P ? 'PANEL' : 'HUD') + ': ' + this.service() + ']';
        if (!parked) return { level: 'info', text: 'Ready - only when parked' + svc };
        if (!this.ref) return { level: 'info', text: (playing ? 'Starting...' : 'Ready - press Play') + svc };
        const t = this.target, ls = this.layerState, what = this.kind === 'image' ? 'Test card' : 'Playing';
        if (this.refused && ls !== 'shown') return { level: 'bad', text: 'Refused (' + this.refused + ')' + svc };
        if (ls === 'error') return { level: 'bad', text: 'Refused by the renderer' + (this.layerReason ? ' (' + this.layerReason + ')' : '') + svc };
        if (t.state === 'unavailable') return { level: 'bad', text: NM + ' unavailable' + svc };
        if (ls === 'shown' || t.state === 'shown') {
            const g = this.geo;
            const on = P ? ' on the whole cluster' : ' on the HUD';
            const detail = this.kind === 'image' ? on : on + (g ? ' - ' + g.sw + 'x' + g.sh : '') + ' ' + this.fps + ' fps';
            const level = t.rendering === 'checking' ? 'warn' : 'ok';
            return { level, text: what + detail + svc };
        }
        if (/scene id/.test(t.reason)) return { level: 'warn', text: P ? 'Panel busy - another app uses the HUD (it shares the panel\'s scene)' + svc : 'HUD busy - another app uses the cluster panel (it shares the HUD\'s scene)' + svc };
        if (t.state === 'parked' || t.state === 'waiting') return { level: 'warn', text: (P ? 'Panel busy - the car\'s own cluster content is in front' : 'HUD busy - the car\'s own HUD content is in front') + svc };
        if (ls === 'suspended') return { level: 'warn', text: 'Hidden by other ' + NM + ' content' + svc };
        if (ls === 'stalled') return { level: 'info', text: 'Waiting for pictures...' + svc };
        return { level: 'info', text: 'Asking for the ' + (P ? 'panel' : 'HUD') + '...' + svc };
    }
}

module.exports = { ClusterOut, loadClient, toAtlas, blackAtlas, geometry, fpsForBudget, trusted, testCard, panelCard, TARGET, TARGETS, AREA, FPS, STALL_MS, Z, EXCLUSIVE, CARD_W, CARD_H, PANEL_CW, PANEL_CH, GLYPHS };
