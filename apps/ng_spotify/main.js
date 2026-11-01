'use strict';
/**
 * G's Music - shows what your Spotify account is playing (track, artist, album, album art, progress)
 * and controls it: previous, play/pause, next, shuffle, repeat, like, and seek (tap or drag the progress
 * bar). Between the track and the progress bar: the track's synced lyrics (LRCLIB, lyrics.js) or a
 * visualizer coloured from the album art (Settings: Show).
 *
 * Source: the Spotify Web API (spotify.js) over mgu-uplink (mgu-store), so it controls whatever device
 * your account plays on - the phone that is connected to the car included. Player commands need
 * Spotify Premium. Sign-in: the not-connected screen (and the settings page's Sign in with phone)
 * shows a QR code; the phone signs in and the car fetches the result itself (signin.js, end-to-end
 * encrypted, PKCE verifier never leaves the car).
 *
 * A full-screen touch app ("fullscreen": true in app.json, kit/runtime/fullscreen.js): the page is the
 * whole screen under the HMI's status strip and every control is a touch target on it (cv.target):
 * the control dock (shuffle, previous, play/pause, next, repeat), the heart (like), the progress bar
 * (tap or drag to seek: ctx.onTouch through FS.drag where the kit has it, else ctx.onTap) and the G (bottom right: the settings page, with phone sign-in). Nothing
 * that needs a tap is in the top 76 screen px (the HMI's pull-down; touches there never reach the
 * app): the kit's header shows the app's name there, as a label. Where the kit can't run the screen
 * (Software renderer, or a renderer without touch) the HMI's bar buttons and the More menu (app.json)
 * do the same jobs, as before.
 *
 * Artwork: a pixel image (JPEG decoded by jpeg_decoder.js, corners rounded in its alpha), uploaded
 * once per track. On the GPU renderer (mgu-render/1, the default) it goes as a native picture (kit
 * renderd.js); on Software it is drawn into the PNG frame.
 *
 * Node 8 (the head unit's runtime): no optional chaining, no ?? and no object spread.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const FS = require('./kit/fullscreen');
const M = require('./kit/gmark');
const record = require('./kit/record');
const Spotify = require('./spotify').Spotify;
const decodeJpeg = require('./jpeg_decoder');
const QrSignIn = require('./signin').QrSignIn;
const signinConfig = require('./signin_config');
const qrcodegen = require('./qrcodegen');
const LyricsLib = require('./lyrics');
const { Canvas } = require('./kit/canvas');
const zlib = require('zlib');
const WLOGO = require('./widget_logo');
const Lyrics = LyricsLib.Lyrics;

const NAME = "G's Music";
let VERSION = '';
try { VERSION = require('./kit/app-spec.json').version || ''; } catch (e) { VERSION = ''; }
const ART_ID = 1;                       // pixel image id (record.setImage: a number)
const ART_PX = 600;                     // the artwork's pixels (drawn ~520 logical, ~610 screen px)
const ART_R = 0.035;                    // its corner radius, share of its side
const DOCK_H = 116;                     // the control dock's height (logical px, ~135 screen px)
const GB_W = 116;                       // the G (settings) button, right of the dock
const HEAD_H = 72;                      // the settings page's header row
const WASH = 0.2;                       // the artwork colour's wash over the page (at the top)
const FRAME_MS = 1000 / 30;             // animation clock step: at most 30 different frames a second
const LEAD_MS = 250;                    // a lyric line lights up this much before its time stamp
const SCROLL_MS = 380;                  // the lyrics' scroll to the next line
const VIZ_BARS = 38;
const POLL_MS = 3000;                   // Spotify polled this often while the app is on screen (0.5.1: no setting)
const WIDGET_POLL_MS = 5000;            // Spotify polled at most this often for the home-screen widget alone
const WIDGET_STEPS = 30;                // the big widget's progress bar moves in 1/30 steps (a new picture every ~7 s)
const REPEAT_NEXT = { off: 'context', context: 'track', track: 'off' };
const REPEAT_WORD = { off: 'off', context: 'all', track: 'one' };
const THEME_NAME = { m_red: 'M Red', m_tricolour: 'M Tricolour', ice: 'Ice White', amber: 'Night Amber' };

function fmt(ms) {
    if (!(ms >= 0)) return '-:--';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
}

/** Cut a string to fit width w at size (adds an ellipsis). */
function fit(cv, s, size, w, opts) {
    s = LyricsLib.fold(s);                         // accents and curly quotes the fonts don't have
    const o = Object.assign({ literal: true }, opts || {});
    if (cv.textWidth(s, size, o) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cv.textWidth(s.slice(0, mid) + '...', size, o) <= w) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, lo).replace(/\s+$/, '') + '...';
}

/** Word-wrap s into lines of at most w px at size (at most max lines, the last one cut). */
function wrap(cv, s, size, w, max, opts) {
    const o = Object.assign({ literal: true }, opts || {});
    const words = String(s || '').split(/\s+/).filter(Boolean), lines = [];
    let cur = '';
    words.forEach((word) => {
        const next = cur ? cur + ' ' + word : word;
        if (!cur || cv.textWidth(next, size, o) <= w) cur = next;
        else { lines.push(cur); cur = word; }
    });
    if (cur) lines.push(cur);
    if (max && lines.length > max) { const rest = lines.slice(max - 1).join(' '); lines.length = max - 1; lines.push(fit(cv, rest, size, w, opts)); }
    return lines;
}

/**
 * Bilinear resample of RGBA (sw x sh) to a square n x n, centre-cropped to a square first; the corners
 * rounded (radius r px) in the alpha (straight alpha: renderd.js premultiplies for the GPU). Returns
 * { px, avg } with avg the picture's average colour ('#rrggbb').
 */
function squareResample(src, sw, sh, n, r) {
    const side = Math.min(sw, sh), ox = (sw - side) / 2, oy = (sh - side) / 2;
    const out = new Uint8Array(n * n * 4), k = side / n;
    let sr = 0, sg = 0, sb = 0;
    for (let y = 0; y < n; y++) {
        const fy = Math.max(0, Math.min(sh - 1.001, oy + (y + 0.5) * k - 0.5)), y0 = fy | 0, wy = fy - y0;
        for (let x = 0; x < n; x++) {
            const fx = Math.max(0, Math.min(sw - 1.001, ox + (x + 0.5) * k - 0.5)), x0 = fx | 0, wx = fx - x0;
            const a = (y0 * sw + x0) * 4, b = a + 4, c = a + sw * 4, d = c + 4, o = (y * n + x) * 4;
            for (let ch = 0; ch < 3; ch++) {
                out[o + ch] = (src[a + ch] * (1 - wx) + src[b + ch] * wx) * (1 - wy) + (src[c + ch] * (1 - wx) + src[d + ch] * wx) * wy;
            }
            sr += out[o]; sg += out[o + 1]; sb += out[o + 2];
            // rounded corners: coverage of the pixel by the corner's circle (1 px soft edge)
            let al = 255;
            if (r > 0) {
                const cx = x < r ? r : x >= n - r ? n - r : -1, cy = y < r ? r : y >= n - r ? n - r : -1;
                if (cx >= 0 && cy >= 0) {
                    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dist = Math.sqrt(dx * dx + dy * dy);
                    al = Math.round(255 * Math.max(0, Math.min(1, r - dist + 0.5)));
                }
            }
            out[o + 3] = al;
        }
    }
    const m = n * n, hex = (v) => ('0' + Math.round(v / m).toString(16)).slice(-2);
    return { px: out, avg: '#' + hex(sr) + hex(sg) + hex(sb) };
}

/**
 * Up to three vivid colours of the artwork (RGBA n x n), strongest first, lifted to show on the dark
 * page: a hue histogram weighted by saturation and brightness. Grey artwork: [] (the theme's colours).
 */
function palette(px, n) {
    const BINS = 12, acc = [];
    for (let i = 0; i < BINS; i++) acc.push({ w: 0, r: 0, g: 0, b: 0 });
    const step = Math.max(1, Math.floor(n / 90));
    for (let y = 0; y < n; y += step) {
        for (let x = 0; x < n; x += step) {
            const o = (y * n + x) * 4, r = px[o], g = px[o + 1], b = px[o + 2];
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, sat = mx ? (mx - mn) / mx : 0;
            if (v < 0.18 || sat < 0.22) continue;
            let h = 0;
            if (mx === r) h = ((g - b) / (mx - mn)) % 6; else if (mx === g) h = (b - r) / (mx - mn) + 2; else h = (r - g) / (mx - mn) + 4;
            const bin = Math.floor((((h * 60) + 360) % 360) / (360 / BINS)), w = sat * v * v, a = acc[bin];
            a.w += w; a.r += r * w; a.g += g * w; a.b += b * w;
        }
    }
    const top = acc.filter((a) => a.w > 0).sort((p, q) => q.w - p.w);
    if (!top.length || top[0].w < 2) return [];
    const hex = (v) => ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2);
    return top.filter((a) => a.w >= top[0].w * 0.08).slice(0, 3).map((a) => {
        let r = a.r / a.w, g = a.g / a.w, b = a.b / a.w;
        const mx = Math.max(r, g, b, 1), k = Math.max(1, 215 / mx);          // lift dark colours
        r *= k; g *= k; b *= k;
        return '#' + hex(r) + hex(g) + hex(b);
    });
}

/** Pick the image closest above our box from Spotify's list (widest first). */
function pickImage(images) {
    if (!Array.isArray(images) || !images.length) return null;
    const ok = images.filter((im) => im && im.url);
    let best = ok[0] || null;
    ok.forEach((im) => { if ((im.width || 0) >= ART_PX * 0.8 && (im.width || 0) < ((best && best.width) || 1e9)) best = im; });
    return best ? best.url : null;
}

/** The fields we show, from GET /v1/me/player (tracks and podcast episodes). */
function fromPlayer(j) {
    const it = j && j.item;
    const p = {
        playing: !!(j && j.is_playing), progress: (j && j.progress_ms) || 0, at: Date.now(),
        shuffle: !!(j && j.shuffle_state), device: j && j.device ? j.device.name : '', deviceType: j && j.device ? j.device.type : '',
        repeat: j && REPEAT_NEXT[j.repeat_state] ? j.repeat_state : 'off',
        ad: j && j.currently_playing_type === 'ad',
        title: '', artist: '', artist1: '', album: '', duration: 0, uri: '', art: null, kind: '',
    };
    if (it) {
        p.title = it.name || ''; p.duration = it.duration_ms || 0; p.uri = it.uri || ''; p.kind = it.type || '';
        if (it.type === 'episode') {
            p.artist = it.show ? it.show.name : ''; p.album = it.show ? it.show.publisher : '';
            p.art = pickImage(it.images) || (it.show ? pickImage(it.show.images) : null);
        } else {
            p.artist = (it.artists || []).map((a) => a.name).join(', ');
            p.artist1 = it.artists && it.artists[0] ? it.artists[0].name || '' : '';
            p.album = it.album ? it.album.name : '';
            p.art = it.album ? pickImage(it.album.images) : null;
        }
    }
    return p;
}

/* ---------- drawing ---------- */

function playGlyph(cv, x, y, s, c) {          // triangle in an s x s box
    cv.quad([[x + s * 0.18, y], [x + s * 0.18, y + s], [x + s, y + s / 2], [x + s, y + s / 2]], c);
}
function pauseGlyph(cv, x, y, s, c) {
    cv.roundRect(x + s * 0.12, y, s * 0.28, s, 3, c);
    cv.roundRect(x + s * 0.6, y, s * 0.28, s, 3, c);
}
function noteGlyph(cv, cx, cy, s, c) {        // a quaver, for the empty artwork box
    cv.circle(cx - s * 0.18, cy + s * 0.3, s * 0.16, c);
    cv.fillRect(cx - s * 0.06, cy - s * 0.42, s * 0.08, s * 0.72, c);
    cv.quad([[cx - s * 0.06, cy - s * 0.42], [cx + s * 0.3, cy - s * 0.26], [cx + s * 0.3, cy - s * 0.12], [cx - s * 0.06, cy - s * 0.28]], c);
}
function heart(cv, cx, cy, s, c) {
    const r = s * 0.27;
    cv.circle(cx - r * 0.95, cy - r * 0.35, r, c);
    cv.circle(cx + r * 0.95, cy - r * 0.35, r, c);
    cv.quad([[cx - r * 1.9, cy - r * 0.1], [cx, cy - r * 0.2], [cx + r * 1.9, cy - r * 0.1], [cx, cy + s * 0.55]], c);
}
/** Outline heart: the heart in c, a smaller one in the background colour over it. */
function heartOutline(cv, cx, cy, s, c, bg) {
    heart(cv, cx, cy, s, c);
    heart(cv, cx, cy - s * 0.02, s * 0.72, bg);
}
function prevGlyph(cv, cx, cy, s, c) {
    cv.roundRect(cx - s * 0.5, cy - s * 0.42, s * 0.14, s * 0.84, 2, c);
    cv.quad([[cx + s * 0.45, cy - s * 0.42], [cx + s * 0.45, cy + s * 0.42], [cx - s * 0.32, cy], [cx - s * 0.32, cy]], c);
}
function nextGlyph(cv, cx, cy, s, c) {
    cv.roundRect(cx + s * 0.36, cy - s * 0.42, s * 0.14, s * 0.84, 2, c);
    cv.quad([[cx - s * 0.45, cy - s * 0.42], [cx - s * 0.45, cy + s * 0.42], [cx + s * 0.32, cy], [cx + s * 0.32, cy]], c);
}
function arrowHead(cv, x, y, dx, dy, s, c) {    // a filled head at (x, y) pointing along (dx, dy)
    const px = -dy, py = dx;
    cv.quad([[x + dx * s, y + dy * s], [x + px * s * 0.6, y + py * s * 0.6], [x - px * s * 0.6, y - py * s * 0.6], [x - px * s * 0.6, y - py * s * 0.6]], c);
}
function shuffleGlyph(cv, cx, cy, s, c) {
    const w = 4, x0 = cx - s * 0.5, x1 = cx + s * 0.36, y0 = cy - s * 0.3, y1 = cy + s * 0.3;
    cv.line(x0, y1, x1, y0, w, c);
    cv.line(x0, y0, cx - s * 0.12, cy - s * 0.04, w, c);
    cv.line(cx + s * 0.06, cy + s * 0.12, x1, y1, w, c);
    arrowHead(cv, x1, y0, 1, 0, s * 0.2, c);
    arrowHead(cv, x1, y1, 1, 0, s * 0.2, c);
}
function repeatGlyph(cv, cx, cy, s, c) {
    const w = s * 1.0, h = s * 0.62, x = cx - w / 2, y = cy - h / 2;
    cv.strokeRoundRect(x, y, w, h, h * 0.4, 4, c);
    arrowHead(cv, cx + s * 0.12, y, 1, 0, s * 0.2, c);
    arrowHead(cv, cx - s * 0.12, y + h, -1, 0, s * 0.2, c);
}
function moreGlyph(cv, cx, cy, s, c) {
    [-1, 0, 1].forEach((k) => cv.circle(cx + k * s * 0.32, cy, s * 0.1, c));
}
/** Placeholder tile when there is no artwork: the album's (or track's) initials. */
function initials(s) {
    const w = String(s || '').replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const sp = new Spotify(ctx.dataDir, log);
        const qs = new QrSignIn(sp, log, signinConfig);

        // what the screen shows
        let pb = null;               // playback (fromPlayer), null = nothing playing
        let status = 'starting';     // noauth | offline | reauth | ok | idle | error
        let detail = '';             // error text for the screen
        let liked = null, likedUri = '';
        let artUrl = '', artReady = false, artBusy = false, artTint = '', artPal = [];
        let artPx = null, artGen = 0;  // the artwork's pixels (ART_PX square), and a count of changes (the widget's copy)
        // lyrics (LRCLIB): User-Agent as LRCLIB asks (app, version, homepage)
        const lyr = new Lyrics((m, h, p, hd) => sp.request(m, h, p, hd), log,
            'GsMusic/' + (VERSION || '0') + ' (iDrive 7 head-unit app; https://github.com/nickgcode/idrive7-apps)');
        let toast = null;            // { text, until }
        let page = 'main';           // 'main' | 'settings' (full screen: the G opens the settings page)
        let nextPoll = 0, polling = false;
        const say = (text, ms) => { toast = { text: text, until: Date.now() + (ms || 3500) }; };

        /* ----- artwork ----- */
        function setArt(buf, url) {
            try {
                const im = decodeJpeg(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 48 });
                const sq = squareResample(im.data, im.width, im.height, ART_PX, Math.round(ART_PX * ART_R));
                record.setImage(ART_ID, ART_PX, ART_PX, sq.px);
                artUrl = url; artReady = true; artTint = sq.avg; artPal = palette(sq.px, ART_PX); artPx = sq.px; artGen++;
            } catch (e) { log.warn('artwork: ' + e.message); artUrl = url; artReady = false; }
        }
        async function loadArt(url) {
            if (!url) { artUrl = ''; artReady = false; return; }
            if (url === artUrl || artBusy) return;
            artBusy = true;
            try { setArt(await sp.image(url), url); } catch (e) { log.warn('artwork ' + url + ': ' + e.message); artUrl = url; artReady = false; }
            artBusy = false;
        }

        /* ----- polling ----- */
        function errStatus(e) {
            if (e.code === 'NOAUTH') return 'noauth';
            if (e.code === 'REAUTH') return 'reauth';
            if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ESERVFAIL|ECONNRESET/.test(e.code || e.message)) return 'offline';
            return 'error';
        }
        async function poll() {
            if (polling) return;
            if (!sp.loadAuth()) { status = 'noauth'; detail = sp.authError || ''; pb = null; labels(); return; }
            polling = true;
            try {
                const j = await sp.player();
                if (!j) { status = 'idle'; pb = null; detail = ''; }
                else {
                    pb = fromPlayer(j); status = 'ok'; detail = '';
                    loadArt(pb.art);
                    if (pb.uri && pb.uri !== likedUri && /^spotify:(track|episode):/.test(pb.uri)) {
                        likedUri = pb.uri; liked = null;
                        sp.isSaved(pb.uri).then((v) => { if (likedUri === pb.uri) liked = v; }, (e) => log.warn('liked: ' + e.message));
                    }
                }
            } catch (e) {
                if (e.code !== 'RATE') { status = errStatus(e); detail = e.message; }
                log.warn('spotify: ' + (e.code || '') + ' ' + e.message);
            }
            polling = false;
            labels();
        }
        const every = () => POLL_MS;
        // a home-screen widget on show also needs the player's state, but no faster than every 5 s
        const widgetOn = () => !!(ctx.widget && typeof ctx.widget.active === 'function' && ctx.widget.active());
        setInterval(() => {
            const shown = ui.isVisible('MAIN') || ui.isVisible('MORE');
            const wOn = !shown && widgetOn();
            if (Date.now() >= nextPoll && (shown || wOn || status === 'starting')) { nextPoll = Date.now() + (wOn ? Math.max(every(), WIDGET_POLL_MS) : every()); poll(); }
            if (shown) qrStep();
        }, 500);

        /* ----- sign-in with the phone (QR code, signin.js) ----- */
        let qrMode = false;          // Settings > Sign in with phone: the code even while signed in
        let qrErrorAt = 0;
        let qrPic = null;            // { url, qr } the code drawn for qs.s.url
        const knownClientId = () => {
            if (sp.auth && sp.auth.client_id) return sp.auth.client_id;
            try { const a = JSON.parse(require('fs').readFileSync(sp.authFile, 'utf8')); return a && typeof a.client_id === 'string' ? a.client_id : ''; } catch (e) { return ''; }
        };
        function wantQr() {
            return qs.configured() && (qrMode || status === 'noauth' || status === 'reauth');
        }
        function qrStep() {
            if (!wantQr()) { if (qs.phase === 'waiting' && !qrMode) qs.cancel(); return; }
            if (qs.phase === 'error') {
                if (!qrErrorAt) qrErrorAt = Date.now();
                if (Date.now() - qrErrorAt < 20000) return;     // the error stays on screen, then a new code
            }
            if (qs.phase === 'off' || qs.phase === 'error' || (qs.phase === 'waiting' && qs.expired()) || qs.phase === 'done') {
                if (qs.phase === 'done' && Date.now() - qs.doneAt < 10000) return;
                qrErrorAt = 0; qs.start(knownClientId());
            }
            qs.tick().then((ok) => {
                if (!ok) { labels(); return; }
                qrMode = false; status = 'starting'; detail = '';
                say('Signed in to Spotify', 4000);
                nextPoll = 0; poll();
            }, (e) => log.warn('phone sign-in: ' + e.message));
        }
        function startQr() {
            if (!qs.configured()) { say('Phone sign-in is not set up yet (signin_config.js, see docs/spotify.md)', 5000); return; }
            if (qrMode && qs.active()) { qrMode = false; qs.cancel(); labels(); say('Phone sign-in cancelled'); return; }
            qrMode = true; qrErrorAt = 0; qs.start(knownClientId());
            labels();
            ui.close('MORE');
            page = 'main';
            say('Scan the code on the ' + NAME + ' screen with your phone', 5000);
        }
        ui.onVisible((name, on) => { if (on && (name === 'MAIN' || name === 'MORE')) { nextPoll = 0; } });
        const soon = () => { nextPoll = Date.now() + 600; };

        /* ----- controls ----- */
        function position(now) {
            if (!pb) return 0;
            const p = pb.progress + (pb.playing ? (now || Date.now()) - pb.at : 0);
            return pb.duration ? Math.min(pb.duration, p) : p;
        }
        /**
         * A player command: fn() the request, local() the screen's state at once (the next poll
         * confirms it). errs: { status: text } for this command's own refusals.
         */
        async function run(what, fn, local, errs) {
            if (status !== 'ok' && status !== 'idle') { say(status === 'noauth' ? 'Not signed in to Spotify' : status === 'offline' ? 'No internet (phone / Wi-Fi uplink)' : 'Spotify: ' + (detail || status)); return; }
            try {
                await fn();
                if (pb && local) local();
                labels();
            } catch (e) {
                log.warn(what + ': ' + (e.code || '') + ' ' + e.message);
                if (Spotify.isStartError(e)) say(e.code === 'SCOPE' ? e.message + ' (Settings > Sign in with phone)' : e.message, 5000);
                else if (errs && errs[e.status]) say(errs[e.status]);
                else if (e.status === 403) say('Spotify Premium is needed for ' + what);
                else if (e.status === 404) say('No active Spotify device - start playing on your phone');
                else if (e.code === 'RATE') say('Spotify says: too many requests - try again in a moment');
                else say(what + ' failed: ' + e.message);
            }
            soon();
        }
        /** Pause, or play: spotify.js start() resumes, else the last track, else the Liked Songs shuffled, on a device it finds. */
        const togglePlay = () => {
            const was = pb, playing = !!(pb && pb.playing);
            if (playing) return run('pause', () => sp.pause(), () => { pb.progress = position(); pb.at = Date.now(); pb.playing = false; });
            return run('play', async () => started(await sp.start()), () => { if (pb === was) { pb.at = Date.now(); pb.playing = true; } });
        };
        /** What Play started, as a toast when it was more than a resume on the same device. */
        function started(r) {
            if (!r) return;
            const on = r.device ? ' on ' + r.device : '';
            const again = r.missing && r.missing.length ? '. Sign in again to resume your last track' : '';
            if (r.how === 'liked') say('Shuffling your Liked Songs' + on + again, 5000);
            else if (r.how === 'recent') say('Playing your last track' + on);
            log.info('play: ' + r.how + (r.device ? ' (' + r.device + ')' : '') + (r.missing && r.missing.length ? ', scope missing: ' + r.missing.join(' ') : ''));
        }
        /** Seek to ms (the progress bar: a tap, or a drag let go). The bar goes there at once. */
        const seekTo = (ms) => {
            if (!pb || !pb.duration) return;
            ms = Math.max(0, Math.min(pb.duration - 1000, Math.round(ms)));
            // (a refused seek: the next poll, soon after, puts the bar back)
            if (status === 'ok' || status === 'idle') { pb.progress = ms; pb.at = Date.now(); }
            return run('seek', () => sp.seek(ms), () => { pb.progress = ms; pb.at = Date.now(); });
        };
        /** Next, or Previous as other players: past 3 s into the track back to its start (the bar at 0 at once), else the track before (spotify.js back). */
        const skip = (dir) => {
            if (dir > 0) return run('next', () => sp.next(), () => { pb.progress = 0; pb.at = Date.now(); });
            const at = position();
            if (pb && Spotify.restarts(at) && (status === 'ok' || status === 'idle')) { pb.progress = 0; pb.at = Date.now(); }
            return run('previous', () => sp.back(at), () => { pb.progress = 0; pb.at = Date.now(); });
        };
        const toggleShuffle = () => {
            const on = !(pb && pb.shuffle);
            return run('shuffle', () => sp.shuffle(on), () => { pb.shuffle = on; });
        };
        // off -> all (context) -> one (track) -> off, as the Spotify app's repeat button
        const cycleRepeat = () => {
            const next = REPEAT_NEXT[(pb && pb.repeat) || 'off'];
            return run('repeat', () => sp.repeat(next), () => { pb.repeat = next; });
        };
        const toggleLike = () => {
            if (!pb || !pb.uri) { say('Nothing playing'); return; }
            const uri = pb.uri, on = !liked;
            return run(on ? 'save' : 'remove', () => (on ? sp.save(uri) : sp.unsave(uri)), () => { liked = on; say(on ? 'Saved to Liked Songs' : 'Removed from Liked Songs'); });
        };

        ui.onClick('BTN_BACKTRACK', () => skip(-1));
        ui.onClick('BTN_PLAY', togglePlay);
        ui.onClick('BTN_SKIP', () => skip(1));
        ui.onClick('BTN_SHUFFLE', toggleShuffle);
        ui.onClick('BTN_REPEAT', cycleRepeat);
        ui.onClick('BTN_LIKE', toggleLike);
        ui.onClick('BTN_MORE', () => ui.open('MORE'));
        ui.onClick('BTN_SIGNIN', startQr);
        // No 'Reload sign-in file' (0.5.1): the phone sign-in writes spotify-auth.json and polls at once, and
        // a spotify-auth.json put into the data folder by hand is read on the next poll anyway (spotify.js loadAuth()
        // re-reads it when its mtime changes, and a new file clears a refused sign-in).

        /* ----- HMI labels (only on change) ----- */
        const shownLabel = {};
        const label = (name, text) => { if (shownLabel[name] !== text) { shownLabel[name] = text; ui.text(name, text); } };
        function expiry() {
            const a = sp.auth, c = a && Date.parse(a.created || '');
            if (!(c > 0)) return '';
            const d = new Date(c + 182 * 864e5);
            return 'sign in again by ' + d.toISOString().slice(0, 10);
        }
        function labels() {
            // the bar button says what it shows / does; short, as every label widens the bar
            label('BTN_PLAY', pb && pb.playing ? 'Pause' : 'Play');
            label('BTN_SHUFFLE', 'Shuffle ' + (pb && pb.shuffle ? 'on' : 'off'));
            label('BTN_REPEAT', 'Repeat ' + REPEAT_WORD[(pb && pb.repeat) || 'off']);
            label('BTN_LIKE', liked ? 'Liked' : 'Like');
            label('BTN_SIGNIN', qrMode && qs.active() ? 'Cancel phone sign-in' : 'Sign in with phone (QR)');
            label('MORE_INFO', info());
        }
        /** One line on the sign-in and what plays (More menu, the settings page). */
        function info() {
            const qrOn = qs.configured();
            return status === 'noauth' && qrOn ? 'Not signed in: scan the QR code on the ' + NAME + ' screen'
                : status === 'reauth' && qrOn ? 'Sign-in needs renewing: scan the QR code on the ' + NAME + ' screen'
                : qrMode && qs.active() ? 'Phone sign-in: scan the QR code on the ' + NAME + ' screen'
                : status === 'noauth' ? 'Not signed in: phone sign-in (QR) is not set up (signin_config.js)'
                : status === 'offline' ? 'No internet: connect the phone hotspot / Wi-Fi uplink'
                : status === 'reauth' ? 'Sign-in not accepted: phone sign-in (QR) is not set up (signin_config.js)'
                : status === 'error' ? 'Spotify: ' + detail
                : status === 'starting' ? 'Connecting to Spotify...'
                : ['Signed in', pb && pb.device ? 'playing on ' + pb.device : 'nothing playing', expiry()].filter(Boolean).join(' | ');
        }
        labels();
        poll();

        /* ----- full screen: the page's own buttons replace the bar's (kit/runtime/fullscreen.js) ----- */
        FS.setup(ctx);                              // in own mode: every bar button hidden
        let downKey = '', downAt = 0;
        /** A press that changes the page: shown pressed for a moment first (as G's Dash's G). */
        const press = (key, fn) => { downKey = key; downAt = Date.now(); setTimeout(fn, 140); };
        const isDown = (key) => downKey === key && Date.now() - downAt < 200;
        const toMain = () => { if (page === 'main') return false; page = 'main'; return true; };
        if (ctx.onBack) ctx.onBack(toMain);         // the controller pushed left / BACK: the settings close first
        ui.onVisible((name, on) => { if (name === 'MAIN' && !on) page = 'main'; });
        // the progress bar: a finger put down on its band and dragged moves the thumb (and the time and
        // lyrics with it); let go, the track seeks there. A plain tap seeks at once. Where the kit has no
        // ctx.onTouch (older kit) a tap still seeks (ctx.onTap).
        let seekBand = null, seekFlash = 0, scrub = null;          // scrub: { f } while a finger drags
        const inBand = (x, y) => { const b = seekBand; return page === 'main' && !!b && !!pb && !!pb.duration && x >= b.x - 24 && x <= b.x + b.w + 24 && y >= b.y0 && y <= b.y1; };
        const frac = (x) => { const b = seekBand; return b ? Math.max(0, Math.min(1, (x - b.x) / b.w)) : 0; };
        const dragOk = FS.drag(ctx, inBand, (phase, x) => {
            if (phase === 1 || phase === 2) { scrub = { f: frac(x) }; return; }
            const f = scrub ? frac(x) : null;
            scrub = null;
            if (f != null && pb && pb.duration) { seekFlash = Date.now(); seekTo(f * pb.duration); }
        });
        if (ctx.onTap) ctx.onTap((x, y) => {
            if (!inBand(x, y)) return;
            seekFlash = Date.now();
            seekTo(frac(x) * pb.duration);
        });
        log.info('progress bar: ' + (dragOk ? 'drag and tap to seek' : 'tap to seek (kit without ctx.onTouch)'));

        /* ----- the screen ----- */
        // software frames are PNGs pushed to the HMI: 2 a second; on the GPU renderer the kit runs
        // the loop once per screen refresh instead (mgu.js ctx.loop)
        ctx.loop('MAIN', 2, () => {
            const t = ctx.theme();
            // one clock for the frame, in steps of FRAME_MS: frames that come out the same aren't sent
            // (display.js), so a still page (paused, visualizer at rest) costs the renderer nothing and a
            // moving one at most 30 frames a second
            const now = Math.floor(Date.now() / FRAME_MS) * FRAME_MS;
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            const A = FS.area(cv);                  // own: reads cv.extra (the page reaches the screen's bottom)
            const connected = status === 'ok' || status === 'idle';
            // the header (the HMI's status strip on full screen): the name; nothing to tap
            G.frame(cv, t, cv.own ? [] : [NAME], 0, []);
            if (!cv.own) page = 'main';
            seekBand = null;
            if (wantQr() && (!qs.s || qs.phase === 'off')) qs.start(knownClientId());     // the code shows at once
            const Q = geo(A, cv.own);
            if (page === 'settings') drawSettings(cv, t, A);
            else {
                if (wantQr() && qs.s) drawQr(cv, t, Q);
                else if (!connected) drawSetup(cv, t, Q);
                else if (!pb) drawIdle(cv, t, Q);
                else drawPlaying(cv, t, Q, now);
                if (connected && !(wantQr() && qs.s)) drawDock(cv, t, Q);
                if (cv.own) gButton(cv, t, Q.g, false, isDown('g'), 'g', () => press('g', () => { page = 'settings'; }));
            }
            if (toast && Date.now() < toast.until) {
                const opt = { font: 'bold', literal: true };
                // over the text column (between the album and the progress bar), else the page's middle
                const mx = page === 'main' ? (Q.X + Q.R) / 2 : 800, mw = page === 'main' ? Q.W - 32 : 1200;
                const s = fit(cv, toast.text, 26, mw - 64, opt), w = cv.textWidth(s, 26, opt) + 64;
                const ty = page === 'main' ? Q.DY - 172 : Math.round((A.y + A.bottom) / 2) - 30;
                cv.roundRect(mx - w / 2, ty, w, 60, 30, '#000000e8');
                cv.strokeRoundRect(mx - w / 2, ty, w, 60, 30, 2, t.accent2 || t.accent);
                cv.text(s, mx, ty + 39, 26, '#ffffff', { align: 'center', font: 'bold', literal: true });
            }
            return ui.image('MAIN_GFX', cv);
        });

        /**
         * The main page's layout in the safe area A (FS.area): the artwork square on the left, full
         * height; right of it the text column, and at its bottom the control dock with the G at its end.
         */
        function geo(A, own) {
            const S = Math.min(A.bottom - A.y, 560);
            const X = A.x + S + 52, R = A.right;
            const DY = A.bottom - DOCK_H;
            const gx = own ? R - GB_W : R;
            // the progress bar above the dock; the stage (lyrics / visualizer) between the track's
            // name and the bar's touch band
            const BY = DY - 78;
            const stage = { x: X, y: A.y + 128, w: R - X, h: BY - 40 - (A.y + 128) };
            return { A, S, X, R, W: R - X, DY, BY, stage, dockR: own ? gx - 16 : R, g: { x: gx, y: DY, w: GB_W, h: DOCK_H } };
        }

        /** A plate for a button (as G's Dash's settings cards); on: lit, down: pressed. */
        function plate(cv, t, x, y, w, h, on, down) {
            const acc = t.sel || t.accent;
            cv.roundRect(x, y, w, h, 14, down ? G.withAlpha(acc, 0.3) : on ? G.withAlpha(acc, 0.16) : G.withAlpha('#ffffff', 0.05));
            cv.strokeRoundRect(x, y, w, h, 14, on || down ? 2 : 1, on || down ? acc : G.withAlpha('#ffffff', 0.14));
        }
        /** The G (G's Music's badge, an equaliser): opens the settings page; lit there (it goes back). */
        function gButton(cv, t, r, lit, down, key, fn) {
            plate(cv, t, r.x, r.y, r.w, r.h, lit, down);
            const h = down ? 32 : 34, bw = M.badgeWidth(h);
            M.badge(cv, r.x + (r.w - bw) / 2, r.y + (r.h + h) / 2 - 2, h, { levels: M.MUSIC });
            FS.button(cv, key, r.x, r.y, r.w, r.h, fn, { slop: 0, r: 14 });
        }
        /** A labelled action button (the sign-in and setup screens, the settings page). */
        function action(cv, t, key, x, y, w, h, text, fn, opts) {
            const o = opts || {};
            plate(cv, t, x, y, w, h, !!o.lit, isDown(key));
            const opt = { font: 'bold', spacing: 1.5, literal: true };
            cv.text(fit(cv, text.toUpperCase(), 20, w - 32, opt), x + w / 2, y + h / 2 + 7, 20, o.warn ? t.crit : t.text, Object.assign({ align: 'center' }, opt));
            if (o.sub) cv.text(fit(cv, o.sub, 16, w - 32), x + w / 2, y + h - 12, 16, t.dim, { align: 'center', literal: true });
            FS.button(cv, key, x, y, w, h, () => { downKey = key; downAt = Date.now(); return fn(); }, { slop: 6, r: 14 });
        }

        /** The artwork square (or a placeholder) at the page's left. */
        function artBox(cv, t, Q, hasArt, label) {
            const x = Q.A.x, y = Q.A.y, s = Q.S, r = Math.round(s * ART_R);
            if (hasArt) {
                cv.image(ART_ID, x, y, s, s);
                cv.strokeRoundRect(x, y, s, s, r, 1, G.withAlpha('#ffffff', 0.10));
            } else if (label) {
                cv.card(x, y, s, s, r, [[0, G.withAlpha(t.accent2 || t.accent, 0.45)], [1, t.panelBottom]]);
                cv.text(initials(label), x + s / 2, y + s / 2 + 52, 150, G.withAlpha('#ffffff', 0.85), { font: 'bold', align: 'center', literal: true });
            } else {
                cv.roundRect(x, y, s, s, r, t.panelTop);
                cv.strokeRoundRect(x, y, s, s, r, 1.5, t.panelEdge);
                const h = s * 0.26, bw = M.badgeWidth(h);
                cv.alpha(0.22);
                M.badge(cv, x + (s - bw) / 2, y + (s + h) / 2, h, { levels: M.MUSIC });
                cv.alpha(1);
            }
        }

        function drawPlaying(cv, t, Q, now) {
            const X = Q.X, W = Q.W, y0 = Q.A.y, on = t.accent2 || t.accent;
            // the artwork's colour washes the page faintly
            if (artReady && artTint) cv.gradientRect(0, 0, 1600, Q.A.bottom + 8, [[0, G.withAlpha(artTint, WASH)], [1, G.withAlpha(artTint, 0)]]);
            artBox(cv, t, Q, artReady, pb.album || pb.title || 'Spotify');
            cv.text(fit(cv, pb.ad ? 'Advertisement' : pb.title || 'Unknown track', 54, W - 124, { font: 'bold' }), X, y0 + 56, 54, t.text, { font: 'bold', literal: true });
            // artist, then the album dimmer, on one line
            const aw = cv.textWidth(LyricsLib.fold(pb.artist), 30, { literal: true });
            const art = fit(cv, pb.artist, 30, W - 124);
            cv.text(art, X, y0 + 100, 30, t.text, { literal: true });
            if (pb.album && aw < W - 124 - 120) cv.text(fit(cv, '  \u00b7  ' + pb.album, 30, W - 124 - aw), X + aw, y0 + 100, 30, t.dim, { literal: true });

            // the heart (like), right of the title: 96 x 96 and a finger's slop
            const hx = Q.R - 48, hy = y0 + 42, lk = 'like';
            if (isDown(lk)) cv.circle(hx, hy, 46, G.withAlpha(t.sel || t.accent, 0.25));
            // (the outline's inside: the background there, the wash included)
            const inside = artReady && artTint ? G.mix(t.bg, artTint, WASH * (1 - hy / (Q.A.bottom + 8))) : t.bg;
            if (liked) heart(cv, hx, hy, 50, t.crit); else heartOutline(cv, hx, hy, 50, !pb.uri ? t.track : t.dim, inside);
            FS.button(cv, lk, hx - 48, hy - 48, 96, 96, () => { downKey = lk; downAt = Date.now(); return toggleLike(); }, { r: 48 });

            // progress (moved on locally between polls; a finger on the bar shows where it will seek)
            const dur = pb.duration || 0, pos = scrub && dur ? scrub.f * dur : position(now);
            const f = dur ? Math.max(0, Math.min(1, pos / dur)) : 0;
            drawStage(cv, t, Q.stage, pos, now);
            const by = Q.BY, bh = scrub ? 14 : 10, fx = Math.round(W * f);
            cv.roundRect(X, by - bh / 2 + 5, W, bh, bh / 2, t.track);
            if (f > 0) cv.rampRect(X, by - bh / 2 + 5, Math.max(bh, fx), bh, bh / 2, pb.playing || scrub ? (t.hotRamp || t.ramp) : [t.dim, t.dim], X, W);
            const flash = Date.now() - seekFlash < 400;
            if (scrub) cv.circle(X + fx, by + 5, 30, G.withAlpha('#ffffff', 0.16));
            cv.circle(X + fx, by + 5, scrub ? 20 : flash ? 18 : 13, pb.playing || scrub ? '#ffffff' : t.dim);
            cv.text(fmt(pos), X, by + 50, 26, scrub ? t.text : t.dim, { font: 'num', literal: true });
            const mid = scrub ? 'SEEK TO ' + fmt(pos) : (pb.playing ? 'PLAYING' : 'PAUSED') + (pb.device ? ' ON ' + pb.device.toUpperCase() : '');
            cv.text(fit(cv, mid, 18, W - 260, { font: 'bold', spacing: 2 }), X + W / 2, by + 48, 18, pb.playing || scrub ? on : t.text, { font: 'bold', spacing: 2, align: 'center', literal: true });
            cv.text(dur ? '-' + fmt(dur - pos) : '', X + W, by + 50, 26, t.dim, { font: 'num', align: 'right', literal: true });
            // the touch band: the bar and well around it (~80 screen px tall, the column's width)
            if (dur) seekBand = { x: X, w: W, y0: by - 34, y1: by + 36 };
        }

        /* ----- the stage: lyrics or the visualizer ----- */
        const viz = { t: 0, e: 0, last: 0 };
        /** What the stage shows now: 'lyrics' (synced), 'plain', 'viz' or '' (off). */
        function stageMode() {
            const want = settings.get('stage') || 'lyrics';
            if (want === 'off' || !pb) return { mode: '' };
            if (want === 'visualizer' || pb.ad || pb.kind === 'episode') return { mode: 'viz' };
            const e = lyr.get({ uri: pb.uri, title: pb.title, artist: pb.artist, artist1: pb.artist1, album: pb.album, duration: pb.duration });
            if (e.state === 'synced') return { mode: 'lyrics', e };
            if (e.state === 'plain') return { mode: 'plain', e };
            return { mode: 'viz' };          // loading, instrumental, none, error
        }
        function drawStage(cv, t, R, pos, now) {
            const m = stageMode();
            // the visualizer's clock runs while playing and eases to rest when paused (then frozen: the
            // frames repeat and aren't sent)
            const dt = viz.last ? Math.min(0.1, Math.max(0, (now - viz.last) / 1000)) : 0;
            viz.last = now;
            const goal = pb && pb.playing && !scrub ? 1 : 0;
            viz.e += (goal - viz.e) * Math.min(1, dt * 2.5);
            if (Math.abs(goal - viz.e) < 0.004) viz.e = goal;
            viz.t += dt * viz.e;
            if (!m.mode || R.h < 60) return;
            if (m.mode === 'viz') drawViz(cv, t, R);
            else if (m.mode === 'lyrics') drawLyrics(cv, t, R, m.e.lines, pos);
            else drawPlain(cv, t, R, m.e.text);
        }
        /** Colours for the stage: the artwork's, else the theme's. */
        function stageColours(t) {
            const p = artPal.slice();
            const base = [t.accent2 || t.accent, t.accent, t.sel || '#ffffff'];
            while (p.length < 3) p.push(p.length ? G.mix(p[0], base[p.length], 0.45) : base[0]);
            return p;
        }
        /**
         * The visualizer: bars mirrored about the stage's middle, their heights a slow sum of waves (the
         * app can't hear the music: Spotify's audio analysis isn't open to new apps), coloured across
         * by the artwork's palette. ~40 rounded rects a frame.
         */
        function drawViz(cv, t, R) {
            const pal = stageColours(t), N = VIZ_BARS, gap = R.w / N, bw = Math.max(4, gap * 0.52), cy = R.y + R.h / 2, T = viz.t;
            const rest = 0.07, amp = 0.82 * viz.e;
            for (let i = 0; i < N; i++) {
                const u = i / (N - 1);
                const wv = 0.5 + 0.5 * (0.5 * Math.sin(T * 2.1 + i * 0.42) + 0.3 * Math.sin(T * 3.7 - i * 0.27 + 1.3) + 0.2 * Math.sin(T * 6.3 + i * 0.91 + 0.4));
                const env = 0.45 + 0.55 * Math.sin(Math.PI * (0.1 + 0.8 * u));
                const h = Math.max(bw, R.h * (rest + amp * wv * env));
                const c = u < 0.5 ? G.mix(pal[0], pal[1], u * 2) : G.mix(pal[1], pal[2], (u - 0.5) * 2);
                const x = R.x + i * gap + (gap - bw) / 2;
                cv.roundRect(x, cy - h / 2, bw, h, bw / 2, G.withAlpha(c, 0.55 + 0.45 * wv * viz.e));
            }
        }
        /** Synced lyrics: the line playing large and bright in the middle, the ones around it fading. */
        function drawLyrics(cv, t, R, lines, pos) {
            const p = pos + LEAD_MS, i = LyricsLib.lineAt(lines, p);
            const e = i >= 0 ? Math.max(0, Math.min(1, (p - lines[i].t) / SCROLL_MS)) : 1;
            const ease = 1 - Math.pow(1 - e, 3);
            const sc = i >= 0 ? i - 1 + ease : -1;             // the line index at the middle (fraction: scrolling)
            const LH = 46, cy = R.y + R.h * 0.42, on = artPal[0] || t.text;
            cv.clip(R.x, R.y, R.w, R.h);
            for (let j = Math.floor(sc) - 2; j <= Math.floor(sc) + 3; j++) {
                if (j < 0 || j >= lines.length) continue;
                const d = j - sc, y = cy + d * LH, ad = Math.abs(d);
                const a = Math.max(0, 1 - Math.abs(y - cy) / (R.h * 0.62));
                if (a <= 0.02) continue;
                const cur = j === i, k = Math.max(0, 1 - ad);
                let size = Math.round(26 + 10 * k);
                const txt = lines[j].text;
                cv.alpha(cur ? 1 : 0.35 + 0.45 * a);
                if (!txt) { cv.text('\u00b7   \u00b7   \u00b7', R.x, y + size * 0.35, 40, cur ? on : t.dim, { font: 'bold', literal: true }); cv.alpha(1); continue; }
                const opt = { font: cur ? 'bold' : undefined, literal: true };
                while (size > 24 && cv.textWidth(txt, size, opt) > R.w) size -= 2;
                cv.text(fit(cv, txt, size, R.w, opt), R.x, y + size * 0.35, size, cur ? G.mix(on, '#ffffff', 0.35) : t.dim, opt);
                cv.alpha(1);
            }
            cv.noclip();
        }
        /** Lyrics without timing: the first lines, as they are (nothing pretends to follow the song). */
        function drawPlain(cv, t, R, text) {
            const LH = 36, n = Math.max(1, Math.floor((R.h - 26) / LH));
            cv.text('LYRICS (NOT SYNCED)', R.x + R.w, R.y + 16, 14, t.dim, { font: 'bold', spacing: 1.5, align: 'right', literal: true });
            text.filter(Boolean).slice(0, n).forEach((s, k) => cv.text(fit(cv, s, 26, R.w - 200), R.x, R.y + 30 + k * LH, 26, k ? t.dim : t.text, { literal: true }));
        }

        /**
         * The control dock: shuffle, previous, play/pause, next, repeat; each cell a touch target as tall
         * as the dock (~195 x 135 screen px).
         */
        const DOCK = ['shuffle', 'prev', 'play', 'next', 'repeat'];
        function drawDock(cv, t, Q) {
            const x0 = Q.X, w = Q.dockR - Q.X, y0 = Q.DY, h = DOCK_H, cw = w / DOCK.length, cy = y0 + 48, sz = 44;
            const have = !!pb, rep = (pb && pb.repeat) || 'off', on = t.accent2 || t.accent, off = t.dim, dim = have ? t.text : t.dim;
            cv.roundRect(x0, y0, w, h, 18, G.withAlpha('#ffffff', 0.045));
            cv.strokeRoundRect(x0, y0, w, h, 18, 1, G.withAlpha('#ffffff', 0.12));
            const word = (s, cx, c) => cv.text(s, cx, y0 + h - 16, 15, c, { font: 'bold', spacing: 1.5, align: 'center', literal: true });
            DOCK.forEach((id, k) => {
                const cx = x0 + cw * k + cw / 2;
                let fn = null;
                switch (id) {
                case 'prev': prevGlyph(cv, cx, cy, sz * 0.9, dim); word('PREV', cx, off); fn = () => skip(-1); break;
                case 'next': nextGlyph(cv, cx, cy, sz * 0.9, dim); word('NEXT', cx, off); fn = () => skip(1); break;
                case 'play': {
                    const p = !!(pb && pb.playing);
                    cv.circle(cx, cy + 10, 48, have ? t.text : t.dim);
                    if (p) pauseGlyph(cv, cx - 18, cy + 10 - 18, 36, t.bg);
                    else playGlyph(cv, cx - 16, cy + 10 - 19, 38, t.bg);
                    fn = togglePlay; break;
                }
                case 'shuffle': {
                    const s = !!(pb && pb.shuffle);
                    shuffleGlyph(cv, cx, cy, sz, s ? on : off);
                    word(s ? 'SHUFFLE ON' : 'SHUFFLE', cx, s ? on : off); fn = toggleShuffle; break;
                }
                case 'repeat': {
                    const r = rep !== 'off';
                    repeatGlyph(cv, cx, cy, sz, r ? on : off);
                    if (rep === 'track') {
                        cv.circle(cx, cy, 12, t.bg);
                        cv.text('1', cx, cy + 7, 19, on, { font: 'bold', align: 'center', literal: true });
                    }
                    word(r ? 'REPEAT ' + REPEAT_WORD[rep].toUpperCase() : 'REPEAT', cx, r ? on : off); fn = cycleRepeat; break;
                }
                }
                // the cells touch each other: no slop sideways, the dock's own height and the screen's bottom
                FS.button(cv, 'dock:' + id, x0 + cw * k, y0, cw, h, fn, { slop: 0, r: 18 });
            });
        }

        function drawIdle(cv, t, Q) {
            artBox(cv, t, Q, false);
            const X = Q.X, y0 = Q.A.y;
            cv.text('Nothing playing', X, y0 + 104, 56, t.text, { font: 'bold' });
            cv.text(fit(cv, 'Tap Play to pick up your last track, or shuffle your Liked Songs.', 28, Q.W), X, y0 + 160, 28, t.dim, { literal: true });
            cv.text(fit(cv, 'Plays on your phone (or the last Spotify device) - keep Spotify open there.', 24, Q.W), X, y0 + 200, 24, t.dim, { literal: true });
        }

        /**
         * The sign-in QR code (black on white, 4-module quiet zone) where the artwork goes, and what to
         * do. On screen in whole device pixels per module (r.xf: drawn in the surface's pixels), so the
         * scaled page doesn't blur its edges.
         */
        function drawQr(cv, t, Q) {
            const s = qs.s, on = t.accent2 || t.accent;
            if (!qrPic || qrPic.url !== s.url) qrPic = { url: s.url, qr: qrcodegen.QrCode.encodeText(s.url, qrcodegen.QrCode.Ecc.MEDIUM) };
            const qr = qrPic.qr, n = qr.size + 8, pl = cv.place;
            const box = { x: Q.A.x, y: Q.A.y, s: Q.S };
            // white plate (logical), then the modules in device pixels when the page is scaled
            const k = pl ? pl.scale : 1;
            const dev = { x: box.x * k + (pl ? pl.ox : 0), y: box.y * k + (pl ? pl.oy : 0), s: box.s * k };
            const px = Math.max(2, Math.floor(dev.s / n)), side = n * px;
            const qx = Math.round(dev.x + (dev.s - side) / 2), qy = Math.round(dev.y + (dev.s - side) / 2);
            cv.roundRect(box.x, box.y, box.s, box.s, 16, '#ffffff');
            if (pl) cv.xf(1, 0, 0);
            const ux = pl ? qx : Math.round(box.x + (box.s - side) / 2), uy = pl ? qy : Math.round(box.y + (box.s - side) / 2);
            for (let y = 0; y < qr.size; y++) {
                let run = -1;
                for (let x = 0; x <= qr.size; x++) {
                    const dark = x < qr.size && qr.getModule(x, y);
                    if (dark && run < 0) run = x;
                    if (!dark && run >= 0) { cv.fillRect(ux + (4 + run) * px, uy + (4 + y) * px, (x - run) * px, px, '#000000'); run = -1; }
                }
            }
            if (pl) cv.xf();
            const X = Q.X, W = Q.R - X;
            const head = status === 'reauth' ? 'Spotify sign-in needs renewing' : status === 'noauth' ? 'Sign in to Spotify' : 'Sign in again with your phone';
            cv.text(fit(cv, head, 46, W, { font: 'bold' }), X, Q.A.y + 60, 46, t.text, { font: 'bold', literal: true });
            let y = Q.A.y + 122;
            const line = (num, str, c, size) => {
                size = size || 27;
                if (num) { cv.circle(X + 18, y - 9, 18, G.withAlpha(on, 0.2)); cv.text(num, X + 18, y, 22, on, { font: 'bold', align: 'center', literal: true }); }
                cv.text(fit(cv, str, size, W - 54), X + (num ? 54 : 0), y, size, c || t.text, { literal: true });
                y += size + 24;
            };
            line('1', 'Scan this code with your phone\'s camera.');
            line('2', 'Sign in to Spotify on the phone and accept.');
            line('3', 'The car finishes the sign-in by itself.');
            y += 4;
            const mm = Math.floor(qs.left() / 60000), ss = Math.floor(qs.left() / 1000) % 60;
            if (qs.phase === 'exchanging') line('', 'Phone answered: signing in...', on);
            else if (qs.phase === 'done') line('', 'Signed in.', on);
            else if (qs.phase === 'error') line('', qs.message, t.warn);
            else line('', 'Waiting for the phone' + (qs.message ? ' (' + qs.message + ')' : '') + '   new code in ' + mm + ':' + (ss < 10 ? '0' : '') + ss, t.dim, 22);
            if (status === 'reauth') line('', 'A sign-in lasts 6 months at most (Spotify).', t.dim, 20);
            line('', 'Phone and car both need internet.', t.dim, 20);
            // buttons along the bottom, the G at the end
            const bw = (Q.dockR - X - 16) / 2;
            action(cv, t, 'qr:new', X, Q.DY, bw, DOCK_H, 'New code', () => { qrErrorAt = 0; qs.start(knownClientId()); say('New sign-in code'); });
            if (qrMode && status !== 'noauth' && status !== 'reauth') action(cv, t, 'qr:cancel', X + bw + 16, Q.DY, bw, DOCK_H, 'Cancel', () => startQr());
        }

        function drawSetup(cv, t, Q) {
            artBox(cv, t, Q, false);
            const X = Q.X, W = Q.R - X, on = t.accent2 || t.accent;
            const head = status === 'offline' ? 'No internet connection'
                : status === 'reauth' ? 'Spotify sign-in needs renewing'
                : status === 'error' ? 'Spotify is not answering'
                : status === 'starting' ? 'Connecting...' : 'Not connected to Spotify';
            cv.text(fit(cv, head, 46, W, { font: 'bold' }), X, Q.A.y + 60, 46, t.text, { font: 'bold', literal: true });
            let y = Q.A.y + 118;
            const line = (num, s, c) => {
                if (num) { cv.circle(X + 16, y - 8, 16, G.withAlpha(on, 0.2)); cv.text(num, X + 16, y, 20, on, { font: 'bold', align: 'center', literal: true }); }
                cv.text(fit(cv, s, 24, W - 48), X + (num ? 48 : 0), y, 24, c || t.text, { literal: true });
                y += 46;
            };
            if (status === 'offline') {
                line('', 'This app talks to Spotify over the internet (mgu-uplink).', t.dim);
                line('1', 'Turn on the phone\'s hotspot or the car\'s Wi-Fi uplink in the Store.');
                line('2', 'Check that "' + NAME + '" is allowed to use the internet (Store > mgu-uplink).');
                if (detail) line('', detail, t.dim);
            } else if (status === 'error' || status === 'starting') {
                line('', detail || 'Waiting for the first answer.', t.dim);
                line('', 'It keeps trying while this screen is open.', t.dim);
            } else {
                if (detail) line('', detail, t.warn);
                if (status === 'reauth') line('', 'A sign-in lasts 6 months at most (Spotify); sign in again:', t.dim);
                if (!qs.configured()) {
                    line('', 'Sign-in is with your phone (QR code), and it is not set up in this copy of the app:', t.dim);
                    line('1', 'Put the sign-in page\'s https address (relay) into signin_config.js (docs/spotify.md).');
                    line('2', 'Reinstall the app, then scan the QR code it shows with your phone.');
                } else line('', 'Preparing the sign-in code...', t.dim);
            }
            const bw = (Q.dockR - X - 16) / 2;
            action(cv, t, 'setup:retry', X, Q.DY, bw, DOCK_H, 'Try again', () => { nextPoll = 0; return poll(); });
        }

        /**
         * The settings page (full screen; the G opens it, the G or Back closes it): Spotify on the left
         * (status, phone sign-in), the settings on the right; a tap steps a setting on.
         */
        const SET_ROWS = [
            ['theme', 'Colours', (v) => THEME_NAME[v] || v],
            ['stage', 'Show', (v) => ({ lyrics: 'Lyrics (else visualizer)', visualizer: 'Visualizer', off: 'Nothing' })[v] || v],
        ];
        function drawSettings(cv, t, A) {
            const on = t.accent2 || t.accent, hy = A.y, cyH = hy + HEAD_H / 2;
            // header row: Back (left), the page's name, version and the G lit (right, also back)
            const bw = 220;
            plate(cv, t, A.x, hy, bw, HEAD_H, false, isDown('back'));
            cv.line(A.x + 38, cyH - 12, A.x + 25, cyH, 3, t.text);
            cv.line(A.x + 25, cyH, A.x + 38, cyH + 12, 3, t.text);
            cv.text('MUSIC', A.x + 56, cyH + 8, 22, t.text, { font: 'bold', spacing: 1.5, literal: true });
            FS.button(cv, 'back', A.x, hy, bw, HEAD_H, () => press('back', () => { page = 'main'; }), { slop: 8, r: 14 });
            cv.text('SETTINGS', A.x + bw + 32, cyH + 11, 30, t.text, { font: 'bold', spacing: 1.5, literal: true });
            const g = { x: A.right - GB_W, y: hy, w: GB_W, h: HEAD_H };
            cv.text(NAME + ' ' + VERSION, g.x - 24, cyH + 7, 18, t.dim, { align: 'right', literal: true });
            gButton(cv, t, g, true, isDown('g-set'), 'g-set', () => press('g-set', () => { page = 'main'; }));

            const top = hy + HEAD_H + 24, colW = (A.right - A.x - 32) / 2, rx = A.x + colW + 32;
            const lbl = (s, x, y) => cv.text(s.toUpperCase(), x, y, 18, t.dim, { font: 'bold', spacing: 1.5, literal: true });
            // left: Spotify
            lbl('Spotify', A.x, top + 20);
            const ih = 150, iy = top + 36;
            cv.roundRect(A.x, iy, colW, ih, 14, G.withAlpha('#ffffff', 0.03));
            const st = status === 'ok' || status === 'idle' ? 'Signed in' : status === 'noauth' ? 'Not signed in'
                : status === 'reauth' ? 'Sign-in needs renewing' : status === 'offline' ? 'No internet' : status === 'starting' ? 'Connecting' : 'Spotify error';
            const good = status === 'ok' || status === 'idle';
            cv.circle(A.x + 26, iy + 34, 8, good ? '#2fd27a' : t.warn);
            cv.text(st, A.x + 46, iy + 42, 28, t.text, { font: 'bold', literal: true });
            wrap(cv, info(), 22, colW - 40, 3).forEach((s, i) => cv.text(s, A.x + 20, iy + 82 + i * 30, 22, t.dim, { literal: true }));
            const ah = 84, ay = iy + ih + 16;
            const qrOn = qrMode && qs.active();
            action(cv, t, 'set:signin', A.x, ay, colW, ah, qrOn ? 'Cancel phone sign-in' : 'Sign in with phone (QR)', () => startQr(), { lit: qrOn });
            // right: the settings, one card each
            lbl('Settings', rx, top + 20);
            const nr = SET_ROWS.length, rgap = 12, rh = Math.min(120, (A.bottom - (top + 36) - (nr - 1) * rgap) / nr);
            SET_ROWS.forEach((r, i) => {
                const y = top + 36 + i * (rh + rgap), key = 'set:' + r[0];
                plate(cv, t, rx, y, colW, rh, false, isDown(key));
                cv.text(r[1].toUpperCase(), rx + 20, y + rh / 2 - 6, 15, t.dim, { font: 'bold', spacing: 1.5, literal: true });
                cv.text(r[2](settings.get(r[0])), rx + 20, y + rh / 2 + 22, 24, t.text, { font: 'bold', literal: true });
                const ax = rx + colW - 28, ay2 = y + rh / 2;
                cv.line(ax - 6, ay2 - 10, ax + 4, ay2, 2.5, t.dim);
                cv.line(ax + 4, ay2, ax - 6, ay2 + 10, 2.5, t.dim);
                FS.button(cv, key, rx, y, colW, rh, () => { downKey = key; downAt = Date.now(); settings.cycle(r[0]); }, { slop: 6, r: 14 });
            });
        }
        /* ----- home-screen widget (app.json startWidget) -----
         * As G's Dash's widget (same layout: BMW's Drive Recorder widget), but live while something plays:
         * the big widget is a picture (the layout's image cell, pushed by the kit when it changes): the
         * album art with the title, artist and a progress line beside it; with nothing playing (or not
         * signed in, offline, an ad) the G's Music logo alone. The HMI draws its tile and a dark vignette
         * around widgets and crops their edges, so everything sits well inside startWidget.safe, centred,
         * in bright colours. The small widget shows no pictures on this firmware, so its text lines
         * carry the track there (or just the name). Nothing made up: only what the player reports. */
        const wLogo = new Canvas(WLOGO.w, WLOGO.h);
        wLogo.d.set(zlib.inflateSync(Buffer.from(WLOGO.rgba, 'base64')));
        const wSw = ctx.spec && ctx.spec.startWidget ? ctx.spec.startWidget : {};
        const [WW, WH] = wSw.size || [384, 256];
        const wCv = new Canvas(WW, WH);
        let wKey = '', wArt = null, wArtGen = -1;
        const wCells = {};
        const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); };
        /** What the widget may show: the current item, or null (the logo). */
        function wTrack() {
            if (!pb || pb.ad || !pb.title) return null;
            if (status !== 'ok') return null;
            return pb;
        }
        /** The artwork at side n for the widget (box-filtered down from the app's copy), once per track. */
        function wArtwork(n) {
            if (!artReady || !artPx) return null;
            if (wArt && wArtGen === artGen && wArt.w === n) return wArt;
            const c = new Canvas(n, n), k = ART_PX / n, d = c.d;
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    let r = 0, g = 0, b = 0, a = 0, m = 0;
                    for (let sy = Math.floor(y * k); sy < Math.floor((y + 1) * k); sy++) {
                        for (let sx = Math.floor(x * k); sx < Math.floor((x + 1) * k); sx++) {
                            const o = (sy * ART_PX + sx) * 4, al = artPx[o + 3];
                            r += artPx[o] * al; g += artPx[o + 1] * al; b += artPx[o + 2] * al; a += al; m++;
                        }
                    }
                    const o = (y * n + x) * 4;
                    if (a) { d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; }
                    d[o + 3] = m ? a / m : 0;
                }
            }
            wArt = c; wArtGen = artGen;
            return c;
        }
        function wDraw(tr, t) {
            const cv = wCv.clear([0, 0, 0, 0]);
            if (!tr) { cv.blit(wLogo, Math.round((WW - wLogo.w) / 2), Math.round((WH - wLogo.h) / 2)); return cv; }
            // one block, centred: the art (124 px) and a text column, 46 px in from each side (the safe
            // margin is 35; the vignette darkens more of the edge than the HMI crops)
            const AS = 124, gap = 16, x0 = 46, x1 = WW - 46, ay = Math.round((WH - AS) / 2), tx = x0 + AS + gap, tw = x1 - tx;
            const art = wArtwork(AS);
            if (art) cv.blit(art, x0, ay);
            else {
                // no artwork (yet): a dark tile with the G's Music mark, not a made-up cover
                cv.roundRect(x0, ay, AS, AS, 8, '#262a33');
                const bh = 44, bw = M.badgeWidth(bh);
                M.badge(cv, x0 + (AS - bw) / 2, ay + AS / 2 + bh / 2, bh, { levels: M.MUSIC });
            }
            const lab = pb.playing ? 'NOW PLAYING' : 'PAUSED';
            const labC = pb.playing ? (t.accent2 || t.accent || '#2fa8e8') : '#c9ced8';
            cv.text(lab, tx, ay + 16, 12, labC, { font: 'bold', spacing: 1.5, literal: true });
            const title = LyricsLib.fold(tr.title).replace(/\s+/g, ' ').trim();
            const lines = wrap(cv, title, 22, tw, 2, { font: 'bold' });
            let y = ay + 46;
            lines.forEach((l) => { cv.text(l, tx, y, 22, '#ffffff', { font: 'bold', literal: true }); y += 25; });
            const by = ay + AS - 5;
            const sub = tr.kind === 'episode' ? tr.album || tr.artist : tr.artist;
            if (sub) cv.text(fit(cv, sub, 17, tw), tx, Math.min(y + 1, by - 16), 17, '#d5d9e0', { literal: true });
            if (tr.duration) {
                const f = Math.round(Math.max(0, Math.min(1, position(Date.now()) / tr.duration)) * WIDGET_STEPS) / WIDGET_STEPS;
                cv.roundRect(tx, by, tw, 5, 2.5, '#ffffff38');
                if (f > 0) cv.roundRect(tx, by, Math.max(5, Math.round(tw * f)), 5, 2.5, pb.playing ? (t.accent2 || t.accent || '#2fa8e8') : '#c9ced8');
            }
            return cv;
        }
        /** The small widget's text lines (and the big one's, cleared); only changed cells are sent. */
        function wText(inst, tr) {
            const small = !inst.big, on = small && !!tr;
            const pos = tr ? position(Date.now()) : 0;
            const cells = {
                Title: [small ? (tr ? LyricsLib.fold(tr.title) : NAME) : '', 'Text'],
                TextRecordings: [on ? LyricsLib.fold((tr.kind === 'episode' ? tr.album || tr.artist : tr.artist) || '') : '', 'Text'],
                TextCam: [on ? (pb.playing ? '' : 'Paused') : '', 'Text'],
                ProgressbarVisible: [on && !!tr.duration, 'Bool'],
                // whole steps of 2 %: a new value every few seconds, not every second
                Progress: [on && tr.duration ? Math.round(Math.max(0, Math.min(1, pos / tr.duration)) * 50) * 2 : 0, 'Float'],
                TimeElapsed: ['', 'Text'],
                TimeRemaining: [on && tr.duration ? clock(tr.duration) : '', 'Text'],
            };
            const prev = wCells[inst.spawnId] || (wCells[inst.spawnId] = {});
            Object.keys(cells).forEach((k) => {
                const v = JSON.stringify(cells[k][0]);
                if (prev[k] === v) return;
                prev[k] = v;
                ctx.widget.set(inst.spawnId, k, cells[k][0], cells[k][1]);
            });
        }
        function renderWidget(inst) {
            const tr = wTrack(), t = ctx.theme();
            if (inst) wText(inst, tr);
            // the picture is drawn again only when what it shows changes (the kit skips unchanged pixels too)
            const f = tr && tr.duration ? Math.round(Math.max(0, Math.min(1, position(Date.now()) / tr.duration)) * WIDGET_STEPS) : -1;
            const key = tr ? [status, tr.uri, tr.title, tr.artist, tr.album, pb.playing, f, artGen, artReady, t.accent2 || t.accent].join('|') : 'logo';
            if (key !== wKey) { wKey = key; wDraw(tr, t); }
            // the small size shows no pictures (upstream's finding): nothing pushed there, its text lines do the job
            return inst && !inst.big ? null : wCv;
        }
        if (ctx.widget) {
            ctx.widget.loop(1, renderWidget);
            ctx.widget.onChange((why) => {
                if (why === 'resized' || why === 'placed' || why === 'shown') Object.keys(wCells).forEach((k) => delete wCells[k]);
                if ((why === 'placed' || why === 'shown') && Date.now() < nextPoll - 1000) nextPoll = 0;   // fresh state at once
            });
        }

    },
});
