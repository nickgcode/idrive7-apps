'use strict';
/**
 * G's TV - EXPERIMENTAL. Plays a TV channel's picture on the head unit while the car is parked.
 *
 * Source (default): spelunkr.tv's "toonertia" channel (tv_channel.js): a schedule of programmes that are
 * progressive H.264 MP4 files on the Internet Archive, no DRM and no sign-in. Byte ranges of the file
 * come over HTTPS (mgu-uplink internet, tv_net.js), the video samples are decoded in WebAssembly
 * (FFmpeg's H.264 decoder, h264.wasm, tools/gstv_decoder) and the pictures go:
 *   - on the GPU renderer with video (mgu-render/1, caps bit 16): as I420 frames in
 *     /dev/shm/mgu-video-ng_tv, drawn and scaled by the renderer (tv_out.js ShmOut, kit renderd.js video());
 *   - anywhere else: as a half-size pixel image at a few frames a second (the emulator, the PC preview,
 *     the Software renderer).
 *
 * VIDEO ONLY: the audio track is not played. There is no verified way yet for an app without root to
 * play sound on this head unit, so the screen says so instead of pretending.
 *
 * PARKED ONLY, no override: the picture shows only while the speed (Vehicle2.statusCarSpeed2) is known
 * and at most 3 km/h AND the selector (VehicleInformation, kit car.js) reads P. Anything else - moving,
 * another gear, either signal unknown - blanks the picture, pauses the player and shows "Video available
 * when parked". Only where there is no car at all (no speed and no car signals: the emulator without
 * signals, the PC preview) the environment variable GSTV_SIMULATE_PARKED=1 counts as parked, for testing.
 *
 * Full-screen touch app (kit/runtime/fullscreen.js); the HMI's bar buttons and the More menu do the same
 * jobs where the kit can't run the screen. Node 8: no optional chaining, no ?? and no object spread.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const FS = require('./kit/fullscreen');
const M = require('./kit/gmark');
const Car = require('./kit/car');
const parkedWatch = require('./kit/parked');
const { Net } = require('./tv_net');
const { Channel, config } = require('./tv_channel');
const Player = require('./tv_player');
const { ShmOut, ImageOut } = require('./tv_out');

const NAME = "G's TV";
let VERSION = '';
try { VERSION = require('./kit/app-spec.json').version || ''; } catch (e) { VERSION = ''; }
const VIDEO_ID = 1;                 // the renderer's video id, and the pixel image's id
const DOCK_H = 116, GB_W = 116, HEAD_H = 72;
const MAX_KMH = parkedWatch.MAX_KMH;    // 3
const RESUME_MS = 2000;             // parked this long before the picture comes back
const RETUNE_MS = 60000;            // blanked longer than this: back to what the channel plays now
const THEME_NAME = { m_red: 'M Red', m_tricolour: 'M Tricolour', ice: 'Ice White', amber: 'Night Amber' };
const MODE_NAME = { auto: 'Auto', full: 'Every picture', light: 'Light (about 10 fps)' };
const SIM = process.env.GSTV_SIMULATE_PARKED === '1';

function fit(cv, s, size, w, opts) {
    s = String(s || '');
    const o = Object.assign({ literal: true }, opts || {});
    if (cv.textWidth(s, size, o) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cv.textWidth(s.slice(0, mid) + '...', size, o) <= w) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, lo).replace(/\s+$/, '') + '...';
}
function wrap(cv, s, size, w, max, opts) {
    const o = Object.assign({ literal: true }, opts || {});
    const words = String(s || '').split(/\s+/).filter(Boolean), lines = [];
    let cur = '';
    words.forEach((word) => {
        const next = cur ? cur + ' ' + word : word;
        if (!cur || cv.textWidth(next, size, o) <= w) cur = next; else { lines.push(cur); cur = word; }
    });
    if (cur) lines.push(cur);
    if (max && lines.length > max) { const rest = lines.slice(max - 1).join(' '); lines.length = max - 1; lines.push(fit(cv, rest, size, w, opts)); }
    return lines;
}
function clock(s) {
    if (!(s >= 0)) return '-:--';
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (r < 10 ? '0' : '') + r;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const net = new Net(ctx.dataDir, log);
        const cfg = config(ctx.spec, ctx.dataDir, log);
        const channel = new Channel(net, cfg, log);
        const shm = new ShmOut(ctx.spec.id || 'ng_tv', log);
        const img = new ImageOut(VIDEO_ID);
        const car = new Car(ctx, ['gear']);
        const parked = parkedWatch.watch(ctx, log);

        let page = 'main';
        let toast = null;
        let want = true;              // the viewer wants it playing (Play / Pause)
        let chState = 'loading';      // loading | ok | offline | error
        let chError = '', chRetry = 0;
        let cur = null;               // { index, title, year } what plays
        let gateOpen = false, parkedSince = 0, gatedAt = 0;
        let regGen = -1, regGpu = null;
        const say = (text, ms) => { toast = { text, until: Date.now() + (ms || 3000) }; };

        /* ----- where the pictures go ----- */
        const gpuOn = () => !!(ctx.display && ctx.display.gpu && ctx.display.active && ctx.display.active('MAIN'));
        const videoPath = () => { const g = gpuOn() ? ctx.display.gpu : null; return !!(g && g.native && g.info && g.info.video); };
        const pathName = () => (videoPath() ? 'GPU video (/dev/shm)' : gpuOn() ? 'GPU image (about 10 fps)' : 'Software image (2 fps)');
        const capFps = () => {
            if (!videoPath()) return gpuOn() ? 10 : 2;
            return Math.max(5, Number(settings.get('maxFps')) || 30);
        };
        const player = new Player({
            net, log, dir: __dirname,
            cap: capFps,
            mode: () => settings.get('mode') || 'auto',
            sink: (f) => {
                if (!gateOpen) return;                         // never a picture while not parked
                if (videoPath()) shm.write(f); else img.write(f);
            },
        });
        player.on('state', () => labels());

        /* ----- the channel ----- */
        function srcAt(i, offset) {
            const it = channel.items[i];
            return {
                href: it.href, moov: it.moov, title: it.title, year: it.year,
                startS: it.inS + (offset || 0), endS: it.duration ? it.inS + it.duration : 0,
                next: () => { const n = channel.next(i); cur = { index: n, title: channel.items[n].title, year: channel.items[n].year }; return srcAt(n, 0); },
            };
        }
        async function loadChannel() {
            chState = 'loading'; labels();
            try {
                await channel.load();
                chState = 'ok'; chError = '';
            } catch (e) {
                const off = /ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|ECONNRESET|NOLEASE/.test(e.code || e.message);
                chState = off ? 'offline' : 'error'; chError = e.message;
                chRetry = Date.now() + (off ? 5000 : 30000);
                log.warn('channel: ' + (e.code || '') + ' ' + e.message);
            }
            labels();
        }
        /** Back to what the channel plays now (the schedule; close to the site's, see tv_channel.js). */
        async function live() {
            if (chState !== 'ok' || Date.now() - channel.loadedAt > 6 * 3600e3) await loadChannel();
            if (chState !== 'ok') return;
            const now = channel.at(Date.now());
            cur = { index: now.index, title: now.item.title, year: now.item.year };
            player.paused = !(want && gateOpen);
            player.tune(srcAt(now.index, now.offset));
        }

        /* ----- the parked gate ----- */
        function gate() {
            const speed = parked.speed(), stage = car.live.stage;
            if (SIM && speed === null && !car.carPresent()) return { ok: true, sim: true, why: 'Simulated parked (no car)' };
            if (speed === null) return { ok: false, why: 'Waiting for the car\'s speed' };
            if (speed > MAX_KMH) return { ok: false, why: 'Moving (' + Math.round(speed) + ' km/h)' };
            if (stage === undefined) return { ok: false, why: 'Gear position unknown' };
            if (stage !== 'P') return { ok: false, why: 'Selector in ' + stage + ' - put it in P' };
            return { ok: true, why: 'Parked' };
        }
        let lastGate = gate();
        function gateStep() {
            const g = lastGate = gate(), now = Date.now();
            if (!g.ok) {
                parkedSince = 0;
                if (gateOpen) {
                    gateOpen = false; gatedAt = now;
                    log.info('gate: closed (' + g.why + ')');
                    player.pause();
                    blank();
                }
                return;
            }
            if (!parkedSince) parkedSince = now;
            if (!gateOpen && now - parkedSince >= (g.sim ? 0 : RESUME_MS)) {
                gateOpen = true;
                log.info('gate: open (' + g.why + ')');
                if (want && visible()) resumeOrLive();
            }
        }
        function blank() {
            img.clear();
            const gpu = ctx.display && ctx.display.gpu;
            if (gpu && gpu.dropVideo) gpu.dropVideo(VIDEO_ID);
            regGpu = null; regGen = -1;
            shm.remove();
        }
        function resumeOrLive() {
            if (!player.v || player.state === 'idle' || (gatedAt && Date.now() - gatedAt > RETUNE_MS)) { gatedAt = 0; live(); return; }
            gatedAt = 0;
            player.resume();
        }
        // shown: the HMI says so, or the page was drawn just now (the PC preview tells no visibility)
        let lastDraw = 0;
        const visible = () => ui.isVisible('MAIN') || ui.isVisible('MORE') || Date.now() - lastDraw < 1500;

        /* ----- controls ----- */
        function togglePlay() {
            if (!gateOpen) { say('Video available when parked'); return; }
            want = !(want && !player.paused);
            if (want) resumeOrLive(); else player.pause();
            labels();
        }
        function goLive() {
            if (!gateOpen) { say('Video available when parked'); return; }
            want = true; say('Back to the channel\'s schedule'); live();
        }
        ui.onClick('BTN_PLAY', togglePlay);
        ui.onClick('BTN_LIVE', goLive);
        ui.onClick('BTN_MORE', () => ui.open('MORE'));

        ui.onVisible((name, on) => {
            if (name !== 'MAIN' && name !== 'MORE') return;
            if (ui.isVisible('MAIN') || ui.isVisible('MORE')) { gateStep(); if (gateOpen && want) resumeOrLive(); }
            else { lastDraw = 0; player.pause(); gatedAt = gatedAt || Date.now(); blank(); }
        });
        const cleanup = () => { try { shm.remove(); } catch (e) { /* gone */ } };
        process.on('exit', cleanup);
        process.once('SIGTERM', () => { cleanup(); process.exit(0); });

        setInterval(() => {
            gateStep();
            if (chState !== 'ok' && chState !== 'loading' && Date.now() >= chRetry && visible() && gateOpen && want) live();
        }, 250);

        /* ----- HMI labels (bar buttons, More menu) ----- */
        const shown = {};
        const label = (n, s) => { if (shown[n] !== s) { shown[n] = s; ui.text(n, s); } };
        function statusLine() {
            if (!lastGate.ok) return 'Video available when parked (' + lastGate.why + ')';
            if (chState === 'loading') return 'Loading the channel...';
            if (chState === 'offline') return 'No internet: connect the phone hotspot / Wi-Fi uplink';
            if (chState === 'error') return 'Channel: ' + chError;
            const s = player.state;
            return s === 'tuning' ? 'Tuning...' : s === 'buffering' ? 'Buffering...' : s === 'paused' ? 'Paused'
                : s === 'offline' ? 'No connection - trying again' : s === 'error' ? 'Error: ' + player.text : s === 'playing' ? 'Playing' : 'Stopped';
        }
        function labels() {
            label('BTN_PLAY', want && !player.paused ? 'Pause' : 'Play');
            label('MORE_INFO', statusLine() + ' | video only, no sound yet');
        }
        labels();

        /* ----- the screen ----- */
        FS.setup(ctx);
        let downKey = '', downAt = 0;
        const press = (key, fn) => { downKey = key; downAt = Date.now(); setTimeout(fn, 140); };
        const isDown = (key) => downKey === key && Date.now() - downAt < 200;
        if (ctx.onBack) ctx.onBack(() => { if (page === 'main') return false; page = 'main'; return true; });
        ui.onVisible((name, on) => { if (name === 'MAIN' && !on) page = 'main'; });

        ctx.loop('MAIN', 2, () => {
            const first = Date.now() - lastDraw > 1500;
            lastDraw = Date.now();
            if (first && gateOpen && want && chState === 'ok' && (player.paused || player.state === 'idle')) resumeOrLive();
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            const A = FS.area(cv);
            G.frame(cv, t, cv.own ? [] : [NAME], 0, [{ text: 'EXPERIMENTAL' }, lastGate.sim && { text: 'SIM PARKED' }]);
            if (!cv.own) page = 'main';
            if (page === 'settings') drawSettings(cv, t, A);
            else drawMain(cv, t, A);
            if (toast && Date.now() < toast.until) {
                const o = { font: 'bold', literal: true }, s = fit(cv, toast.text, 26, 1100, o), w = cv.textWidth(s, 26, o) + 64;
                const ty = Math.round((A.y + A.bottom) / 2) - 30;
                cv.roundRect(800 - w / 2, ty, w, 60, 30, '#000000e8');
                cv.strokeRoundRect(800 - w / 2, ty, w, 60, 30, 2, t.accent2 || t.accent);
                cv.text(s, 800, ty + 39, 26, '#ffffff', { align: 'center', font: 'bold', literal: true });
            }
            return ui.image('MAIN_GFX', cv);
        });

        function plate(cv, t, x, y, w, h, on, down) {
            const acc = t.sel || t.accent;
            cv.roundRect(x, y, w, h, 14, down ? G.withAlpha(acc, 0.3) : on ? G.withAlpha(acc, 0.16) : G.withAlpha('#ffffff', 0.05));
            cv.strokeRoundRect(x, y, w, h, 14, on || down ? 2 : 1, on || down ? acc : G.withAlpha('#ffffff', 0.14));
        }
        function gButton(cv, t, r, lit, key, fn) {
            plate(cv, t, r.x, r.y, r.w, r.h, lit, isDown(key));
            const h = isDown(key) ? 32 : 34, bw = M.badgeWidth(h);
            M.badge(cv, r.x + (r.w - bw) / 2, r.y + (r.h + h) / 2 - 2, h);
            FS.button(cv, key, r.x, r.y, r.w, r.h, fn, { slop: 0, r: 14 });
        }
        function action(cv, t, key, x, y, w, h, text, fn, glyph) {
            plate(cv, t, x, y, w, h, false, isDown(key));
            const o = { font: 'bold', spacing: 1.5, literal: true }, cx = x + w / 2;
            if (glyph) glyph(cx, y + h / 2 - 12);
            cv.text(fit(cv, text.toUpperCase(), glyph ? 16 : 20, w - 24, o), cx, glyph ? y + h - 16 : y + h / 2 + 7, glyph ? 16 : 20, t.text, Object.assign({ align: 'center' }, o));
            FS.button(cv, key, x, y, w, h, () => { downKey = key; downAt = Date.now(); return fn(); }, { slop: 6, r: 14 });
        }
        function chip(cv, x, y, text, fg, bg) {
            const o = { font: 'bold', spacing: 1.5, literal: true }, w = cv.textWidth(text, 15, o) + 28;
            cv.roundRect(x, y, w, 30, 15, bg); cv.text(text, x + 14, y + 21, 15, fg, o);
            return w;
        }

        /** The picture box (left, the stream's aspect), the programme and status (right), the dock below. */
        function drawMain(cv, t, A) {
            const on = t.accent2 || t.accent, inf = player.info(), g = lastGate;
            const H = A.bottom - A.y, asp = inf.w && inf.h ? inf.w / inf.h : 4 / 3;
            let vw = Math.round(Math.min(H * asp, (A.right - A.x) * 0.62)), vh = Math.round(vw / asp);
            if (vh > H) { vh = H; vw = Math.round(vh * asp); }
            const vx = A.x, vy = A.y + Math.round((H - vh) / 2);
            cv.roundRect(vx, vy, vw, vh, 10, '#000000');
            const playingPic = gateOpen && want && !player.paused;
            if (!g.ok || !gateOpen) drawGate(cv, t, vx, vy, vw, vh, g);
            else if (videoPath() && shm.fd !== null && playingPic) {
                const gpu = ctx.display.gpu;
                if (regGpu !== gpu || regGen !== shm.gen) { if (gpu.video(VIDEO_ID, shm.file)) { regGpu = gpu; regGen = shm.gen; } }
                cv.video(VIDEO_ID, vx, vy, vw, vh);
            } else if (img.has && (playingPic || player.state === 'paused')) cv.image(VIDEO_ID, vx, vy, vw, vh);
            if (g.ok && gateOpen && !(player.state === 'playing' || player.state === 'paused')) {
                const s = statusLine();
                cv.text(fit(cv, s, 28, vw - 60, { font: 'bold' }), vx + vw / 2, vy + vh / 2 + 10, 28, player.state === 'error' || chState === 'error' ? t.crit : t.dim, { align: 'center', font: 'bold', literal: true });
            }
            cv.strokeRoundRect(vx, vy, vw, vh, 10, 1, G.withAlpha('#ffffff', 0.12));

            // right column
            const X = vx + vw + 40, W = A.right - X;
            let y = A.y + 22;
            cv.text(fit(cv, (channel.name || cfg.channel || 'TV').toUpperCase(), 18, W, { font: 'bold', spacing: 2 }), X, y, 18, on, { font: 'bold', spacing: 2, literal: true });
            y += 46;
            const title = cur ? cur.title : chState === 'loading' ? 'Loading the channel...' : '';
            wrap(cv, title, 36, W, 2, { font: 'bold' }).forEach((s) => { cv.text(s, X, y, 36, t.text, { font: 'bold', literal: true }); y += 42; });
            if (cur && cur.year) { cv.text(cur.year, X, y, 24, t.dim, { literal: true }); y += 34; }
            y += 6;
            let cx = X;
            cx += chip(cv, cx, y, 'VIDEO ONLY \u00b7 NO SOUND YET', '#1a1a1a', '#ffcc33') + 10;
            if (g.ok && gateOpen && player.state === 'playing') chip(cv, cx, y, 'ON AIR', '#ffffff', G.withAlpha(t.crit, 0.85));
            y += 66;
            const st = statusLine();
            const bad = !g.ok || player.state === 'error' || chState === 'error' || chState === 'offline' || player.state === 'offline';
            cv.circle(X + 9, y - 8, 8, !g.ok ? t.dim : bad ? t.crit : player.state === 'playing' ? '#2fd27a' : on);
            wrap(cv, st, 24, W - 28, 2).forEach((s) => { cv.text(s, X + 28, y, 24, t.text, { literal: true }); y += 32; });
            if (gateOpen && inf.w) {
                const tech = inf.w + 'x' + inf.h + '  ' + (inf.fps ? inf.fps.toFixed(0) + ' fps shown' : '') + (inf.decMs ? '  decode ' + inf.decMs.toFixed(1) + ' ms' : '') + (inf.light ? '  light' : '');
                cv.text(fit(cv, tech, 20, W), X, y + 2, 20, t.dim, { literal: true });
                if (inf.end > inf.start) cv.text(clock(inf.pos - (channel.items && cur ? channel.items[cur.index].inS : 0)) + ' / ' + clock(inf.end - (channel.items && cur ? channel.items[cur.index].inS : 0)), X, y + 30, 20, t.dim, { font: 'num', literal: true });
            }

            // dock: play/pause, live, the G
            const DY = A.bottom - DOCK_H, gx = cv.own ? A.right - GB_W : A.right, bw = (gx - X - (cv.own ? 16 : 0) - 16) / 2;
            const isPlay = want && !player.paused && gateOpen, gc = gateOpen ? t.text : t.dim;
            action(cv, t, 'play', X, DY, bw, DOCK_H, isPlay ? 'Pause' : 'Play', togglePlay, (px, py) => {
                if (isPlay) { cv.fillRect(px - 15, py - 18, 11, 36, gc); cv.fillRect(px + 4, py - 18, 11, 36, gc); }
                else cv.quad([[px - 13, py - 20], [px + 20, py], [px + 20, py], [px - 13, py + 20]], gc);
            });
            action(cv, t, 'live', X + bw + 16, DY, bw, DOCK_H, 'Live', goLive, (px, py) => {
                cv.circle(px, py, 10, gateOpen ? t.crit : t.dim);
                cv.strokeRoundRect(px - 21, py - 21, 42, 42, 21, 3, gc);
            });
            if (cv.own) gButton(cv, t, { x: gx, y: DY, w: GB_W, h: DOCK_H }, false, 'g', () => press('g', () => { page = 'settings'; }));
        }

        function drawGate(cv, t, x, y, w, h, g) {
            cv.roundRect(x, y, w, h, 10, t.panelBottom || '#101014');
            const cx = x + w / 2, cy = y + h / 2 - 40;
            cv.circle(cx, cy, 52, G.withAlpha(t.accent2 || t.accent, 0.18));
            cv.strokeRoundRect(cx - 52, cy - 52, 104, 104, 52, 3, t.accent2 || t.accent);
            cv.text('P', cx, cy + 22, 64, t.text, { font: 'bold', align: 'center', literal: true });
            cv.text(fit(cv, 'Video available when parked', 34, w - 40, { font: 'bold' }), cx, cy + 108, 34, t.text, { font: 'bold', align: 'center', literal: true });
            const why = g.ok ? 'Starting in a moment...' : g.why;
            cv.text(fit(cv, why, 24, w - 40), cx, cy + 146, 24, t.dim, { align: 'center', literal: true });
            cv.text(fit(cv, 'Speed at most ' + MAX_KMH + ' km/h and the selector in P', 20, w - 40), cx, cy + 178, 20, t.dim, { align: 'center', literal: true });
        }

        const SET_ROWS = [
            ['mode', 'Pictures', (v) => MODE_NAME[v] || v],
            ['maxFps', 'At most (GPU video)', (v) => v + ' fps'],
            ['theme', 'Colours', (v) => THEME_NAME[v] || v],
            ['renderer', 'Renderer', (v) => (v === 'software' ? 'Software (fallback)' : 'GPU')],
        ];
        function drawSettings(cv, t, A) {
            const on = t.accent2 || t.accent, hy = A.y, cyH = hy + HEAD_H / 2, bw = 220;
            plate(cv, t, A.x, hy, bw, HEAD_H, false, isDown('back'));
            cv.line(A.x + 38, cyH - 12, A.x + 25, cyH, 3, t.text);
            cv.line(A.x + 25, cyH, A.x + 38, cyH + 12, 3, t.text);
            cv.text('TV', A.x + 56, cyH + 8, 22, t.text, { font: 'bold', spacing: 1.5, literal: true });
            FS.button(cv, 'back', A.x, hy, bw, HEAD_H, () => press('back', () => { page = 'main'; }), { slop: 8, r: 14 });
            cv.text('SETTINGS', A.x + bw + 32, cyH + 11, 30, t.text, { font: 'bold', spacing: 1.5, literal: true });
            const gr = { x: A.right - GB_W, y: hy, w: GB_W, h: HEAD_H };
            cv.text(NAME + ' ' + VERSION + ' (experimental)', gr.x - 24, cyH + 7, 18, t.dim, { align: 'right', literal: true });
            gButton(cv, t, gr, true, 'g-set', () => press('g-set', () => { page = 'main'; }));

            const top = hy + HEAD_H + 24, colW = (A.right - A.x - 32) / 2, rx = A.x + colW + 32;
            const lbl = (s, x, yy) => cv.text(s.toUpperCase(), x, yy, 18, t.dim, { font: 'bold', spacing: 1.5, literal: true });
            lbl('Stream', A.x, top + 20);
            const inf = player.info();
            const lines = [
                ['Channel', (channel.name || cfg.channel) + (cfg.streamUrl ? '' : ' (spelunkr.tv lineup)')],
                ['Video', inf.w ? 'H.264 ' + (inf.profile === 100 ? 'High' : inf.profile === 77 ? 'Main' : 'profile ' + inf.profile) + ', ' + inf.w + 'x' + inf.h + ', ' + inf.srcFps.toFixed(2) + ' fps' : '-'],
                ['Decoder', inf.decMs ? 'WebAssembly, ' + inf.decMs.toFixed(1) + ' ms a picture' + (inf.light ? ' (light)' : '') : 'WebAssembly (FFmpeg H.264)'],
                ['Output', pathName()],
                ['Sound', 'None yet: no verified way for an app to play audio'],
                ['Source', 'Programmes stream from the Internet Archive; no DRM'],
            ];
            let y = top + 60;
            lines.forEach((l) => {
                cv.text(l[0].toUpperCase(), A.x + 4, y, 15, t.dim, { font: 'bold', spacing: 1.5, literal: true });
                cv.text(fit(cv, l[1], 22, colW - 150), A.x + 150, y, 22, l[0] === 'Sound' ? on : t.text, { literal: true });
                y += 46;
            });
            lbl('Settings', rx, top + 20);
            const nr = SET_ROWS.length, rgap = 12, rh = Math.min(96, (A.bottom - (top + 36) - (nr - 1) * rgap) / nr);
            SET_ROWS.forEach((r, i) => {
                const yy = top + 36 + i * (rh + rgap), key = 'set:' + r[0];
                plate(cv, t, rx, yy, colW, rh, false, isDown(key));
                cv.text(r[1].toUpperCase(), rx + 20, yy + rh / 2 - 6, 15, t.dim, { font: 'bold', spacing: 1.5, literal: true });
                cv.text(r[2](settings.get(r[0])), rx + 20, yy + rh / 2 + 22, 24, t.text, { font: 'bold', literal: true });
                FS.button(cv, key, rx, yy, colW, rh, () => { downKey = key; downAt = Date.now(); settings.cycle(r[0]); }, { slop: 6, r: 14 });
            });
        }

        // start: the channel at once; the picture once the gate opens
        player.paused = true;
        await loadChannel();
        if (chState === 'ok') { const now = channel.at(Date.now()); cur = { index: now.index, title: now.item.title, year: now.item.year }; }
        gateStep();
        if (gateOpen && want && visible()) live();
    },
});
