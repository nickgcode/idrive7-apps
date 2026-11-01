'use strict';
/**
 * G's TV - EXPERIMENTAL. Plays a video's picture on the head unit while the car is parked.
 *
 * 0.4.0: a home screen of sources. Spelunkr (spelunkr.tv's lineup, tv_channel.js: channels of programmes
 * that are progressive H.264 MP4 files on the Internet Archive, no DRM, no sign-in) with CH UP / CH DOWN,
 * a swipe on the picture, a channel banner, a guide and a fullscreen picture; and the viewer's own
 * sources: direct links to one MP4 file each (H.264 video), sent from the phone (tv_handoff.js: QR code
 * or 6-digit code, end-to-end encrypted through ntfy.sh, the page in web/tv-source/), checked by the car
 * before they are saved (tv_sources.js), resumed where the viewer left off. Hold a source's tile to
 * rename it, send a new link, or remove it. Nothing site-specific: a web page or a player is refused.
 *
 * Byte ranges of the file come over HTTP(S) (mgu-uplink internet, tv_net.js), the video samples are
 * decoded in WebAssembly (FFmpeg's H.264 decoder, h264.wasm, tools/gstv_decoder) and the pictures go:
 *   - on the GPU renderer with video (mgu-render/1, caps bit 16): as I420 frames in
 *     /dev/shm/mgu-video-ng_tv, drawn and scaled by the renderer (tv_out.js ShmOut, kit renderd.js video());
 *   - anywhere else: as a half-size pixel image at a few frames a second (the emulator, the PC preview,
 *     the Software renderer).
 *
 * VIDEO ONLY: the audio track is not played. There is no verified way yet for an app without root to
 * play sound on this head unit, so the screen says so instead of pretending.
 *
 * PARKED ONLY, no override: the picture shows only while the speed (Vehicle2.statusCarSpeed2) is known
 * and at most 3 km/h AND the selector (VehicleInformation, kit car.js) reads P, for 2 s. Anything else -
 * moving, another gear, either signal unknown - blanks the picture, pauses the player and shows "Video
 * available when parked". Only where there is no car at all (no speed and no car signals: the emulator
 * without signals, the PC preview) the environment variable GSTV_SIMULATE_PARKED=1 counts as parked.
 *
 * Play in cluster / Play in HUD / HUD test (0.3.x, parked only, each needs two taps; the HUD ones are off
 * again at every start): unchanged. They follow the watching view: on the home screen nothing plays.
 *
 * 0.4.1, instant resume: when the gate blanks, the player only pauses and keeps its warm state (the
 * index, the decoder, the samples fetched past it, at most WARM_BYTES, and the next picture); the last
 * picture stays on the screen, dimmed, under "Video available when parked" (a still image, not video;
 * the cluster / HUD outputs go at once as before). Back in P for 2 s, the picture continues from the
 * paused place in about a frame, no tuning. Spelunkr's "After driving" setting: resume where I stopped
 * (the default) or jump to what's on now (after more than a minute away). The warm state is let go after
 * WARM_MS out of park or when memory is tight; then the place (programme and second, also kept across
 * restarts in tv-sources.json) is tuned again exactly. Opening the app goes back to what was watched.
 *
 * 0.4.1, the panel test (parked only, two taps, off at every start, 30 s): a still test card over the
 * whole cluster ("panel" target, tv_cluster.js), "Full cluster test", then "Side panels test" (only after
 * the full one ran this session). Exactly the HUD test's rules, and one of Cluster video / HUD test /
 * Play in HUD / panel test at a time (panel and HUD share a scene id anyway).
 *
 * Full-screen touch app (kit/runtime/fullscreen.js); the HMI's bar buttons and the More menu do the main
 * jobs where the kit can't run the screen. Node 8: no optional chaining, no ?? and no object spread.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const FS = require('./kit/fullscreen');
const M = require('./kit/gmark');
const Car = require('./kit/car');
const parkedWatch = require('./kit/parked');
const { Net } = require('./tv_net');
const { Lineup, config, clean } = require('./tv_channel');
const Player = require('./tv_player');
const { ShmOut, ImageOut } = require('./tv_out');
const { ClusterOut } = require('./tv_cluster');
const Src = require('./tv_sources');
const { Handoff } = require('./tv_handoff');
const qrcodegen = require('./qrcodegen');

const NAME = "G's TV";
let VERSION = '';
try { VERSION = require('./kit/app-spec.json').version || ''; } catch (e) { VERSION = ''; }
const VIDEO_ID = 1;                 // the renderer's video id, and the pixel image's id
const GB_W = 116, HEAD_H = 72;
const MAX_KMH = parkedWatch.MAX_KMH;    // 3
const RESUME_MS = 2000;             // parked this long before the picture comes back
const ASK_MS = 5000;                // Play in cluster / HUD, HUD test: the second tap that confirms, within this
const HUD_TEST_MS = Math.min(30000, Number(process.env.GSTV_HUD_TEST_MS) || 30000);
const RETUNE_MS = 60000;            // "jump to what's on now": blanked longer than this, back to what the channel plays now
const STILL_ID = 2;                 // the dimmed last picture under the parked message (a pixel image)
const WARM_MS = Math.min(30 * 60000, Number(process.env.GSTV_WARM_MS) || 30 * 60000);   // the warm state, at most this long paused
const WARM_BYTES = 8 * 1024 * 1024; // fetched samples kept while paused (the keyframe's chunk always)
const WARM_FREE_MB = 96;            // MemAvailable below this: memory is tight, the warm state goes
const WARM_RSS_MB = 420;            // or the app itself above this
const AFTER_NAME = { resume: 'Resume where I stopped', live: 'Jump to what\'s on now' };
const BANNER_MS = 4000;             // the channel banner after a change
const CONTROLS_MS = 5000;           // the controls over the picture, after a tap
const HOLD_MS = 650;                // a held tile: its edit sheet
const REMOVE_MS = 5000;             // Remove, then Tap again to remove within this
const POS_MS = 15000;               // a custom source's position saved this often while it plays
const SWIPE = 70;                   // px up / down on the picture: a channel change
const RAIL_W = 230, GAP = 14, TOP_H = 88, BANNER_H = 150;
const THEME_NAME = { m_red: 'M Red', m_tricolour: 'M Tricolour', ice: 'Ice White', amber: 'Night Amber' };
const MODE_NAME = { auto: 'Auto', full: 'Every picture', light: 'Light (about 10 fps)' };
const SIM = process.env.GSTV_SIMULATE_PARKED === '1';
const OFFLINE = /ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|ECONNRESET|NOLEASE/;

function fit(cv, s, size, w, opts) {
    s = String(s || '');
    const o = Object.assign({ literal: true }, opts || {});
    if (w <= 0) return '';
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
/**
 * ctx for the car's watches with every signal handler wrapped: after the handler has stored the value,
 * after() runs (the gate re-check). The watches and their values are unchanged.
 */
function tapSignals(ctx, after) {
    if (!ctx.signals || typeof ctx.signals.watch !== 'function') return ctx;
    const sig = Object.create(ctx.signals);
    sig.watch = function (iface, instance, handlers, log, opts) {
        const wrapped = {};
        Object.keys(handlers || {}).forEach((k) => {
            wrapped[k] = function () {
                const r = handlers[k].apply(this, arguments);
                try { after(); } catch (e) { if (log) log.warn('gate re-check: ' + e.message); }
                return r;
            };
        });
        return ctx.signals.watch(iface, instance, wrapped, log, opts);
    };
    const c = Object.create(ctx);
    c.signals = sig;
    return c;
}
function clock(s) {
    if (!(s >= 0)) return '-:--';
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (r < 10 ? '0' : '') + r;
}
/** "42 min", "1 h 05 min" (apps don't know the car's time zone: the screen gives durations, not clock times) */
function mins(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60 < 10 ? '0' : '') + (m % 60) + ' min' : m + ' min';
}
/** A filled triangle (the recorder has quads: one corner twice). */
function tri(cv, p, c) { return cv.quad([p[0], p[1], p[1], p[2]], c); }
const inside = (r, x, y) => !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
/** A colour for a custom source's tile, from its id. */
function tint(id) {
    const P = ['#2fa8e8', '#e4572e', '#7d5ba6', '#2fbf71', '#f0a202', '#d7263d', '#1b998b', '#3a86ff'];
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return P[h % P.length];
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const net = new Net(ctx.dataDir, log);
        const cfg = config(ctx.spec, ctx.dataDir, log);
        const lineup = new Lineup(net, cfg, log);
        const store = new Src.Store(ctx.dataDir, log);
        const relay = (ctx.spec.config && ctx.spec.config.relay) || '';
        const handoff = new Handoff(net, log, { relay, mailbox: (ctx.spec.config && ctx.spec.config.mailbox) || 'https://ntfy.sh' });
        const shm = new ShmOut(ctx.spec.id || 'ng_tv', log);
        const img = new ImageOut(VIDEO_ID);
        const still = new ImageOut(STILL_ID);           // 0.4.1: the last picture, shown dimmed while not parked
        let onSignal = () => {};
        const tapped = tapSignals(ctx, () => onSignal());
        const car = new Car(tapped, ['gear']);
        const parked = parkedWatch.watch(tapped, log);
        const cluster = new ClusterOut({ log, app: ctx.spec.id || 'ng_tv' });
        const hud = new ClusterOut({ log, app: ctx.spec.id || 'ng_tv', target: 'hud' });
        const panel = new ClusterOut({ log, app: ctx.spec.id || 'ng_tv', target: 'panel' });
        // the HUD experiment and the panel tests are never on at a start, whatever was saved
        ['hud', 'hudtest', 'paneltest', 'sidetest'].forEach((k) => { if (settings.get(k)) settings.set(k, false); });

        // 0.4.1: opening the app goes back to what was watched last (tuned where it stopped once parked)
        const lastKey = store.data.last;
        const reopen = !cfg.streamUrl && (lastKey === 'spelunkr' || (!!lastKey && !!store.get(lastKey)));
        let page = cfg.streamUrl || reopen ? 'watch' : 'home';
        let setFrom = 'home';               // the page the settings page goes back to
        let toast = null;
        let want = true;                    // the viewer wants it playing (Play / Pause)
        let luState = 'loading', luError = '', luRetry = 0;
        // what is tuned: { kind: 'spelunkr', ch } | { kind: 'custom', id } | { kind: 'stream' } | null
        let src = cfg.streamUrl ? { kind: 'stream' } : null;
        if (reopen) src = lastKey === 'spelunkr' ? { kind: 'spelunkr', ch: store.data.channel || cfg.channel } : { kind: 'custom', id: lastKey };
        let chId = store.data.channel || cfg.channel;
        let cur = null;                     // { title, year } what plays
        let schErr = '';                    // the tuned channel's schedule could not be had
        let tuneGen = 0;
        let full = false;                   // fullscreen picture (kept across channel changes, not restarts)
        let bannerUntil = 0, controlsUntil = 0;
        let edit = null;                    // { id, armed } the held tile's sheet
        let conf = null;                    // the confirm page: { mode, id, name, url, checking, res, why, same }
        let homeScroll = 0, guideScroll = 0, guideFam = '';
        let gateOpen = false, parkedSince = 0, gatedAt = 0;
        let regGen = -1, regGpu = null;
        let posAt = 0;
        let warmAt = 0, memAt = 0;          // paused since (the warm state's age), the last memory check
        let panelRan = false;               // the full cluster test was up once this session
        const say = (text, ms) => { toast = { text, until: Date.now() + (ms || 3000) }; };
        const watching = () => page === 'watch' || page === 'guide' || (page === 'settings' && (setFrom === 'watch' || setFrom === 'guide'));

        /* ----- where the pictures go ----- */
        const gpuOn = () => !!(ctx.display && ctx.display.gpu && ctx.display.active && ctx.display.active('MAIN'));
        const videoPath = () => { const g = gpuOn() ? ctx.display.gpu : null; return !!(g && g.native && g.info && g.info.video); };
        const pathName = () => (videoPath() ? 'GPU video (/dev/shm)' : gpuOn() ? 'GPU image (about 10 fps)' : 'Software image (2 fps)');
        const screenFps = () => {
            if (!videoPath()) return gpuOn() ? 10 : 2;
            return Math.max(5, Number(settings.get('maxFps')) || 30);
        };
        const capFps = () => ((settings.get('cluster') || settings.get('hud')) && gateOpen ? Math.max(screenFps(), 15) : screenFps());
        let imgAt = 0;
        const player = new Player({
            net, log, dir: __dirname,
            cap: capFps,
            mode: () => settings.get('mode') || 'auto',
            sink: (f) => {
                if (!gateOpen) return;                         // never a picture while not parked
                if (videoPath()) shm.write(f);
                else { const now = Date.now(); if (now - imgAt >= 1000 / screenFps() - 5) { imgAt = now; img.write(f); } }
                const toCluster = !!settings.get('cluster'), toHud = !!settings.get('hud');
                if (toCluster || toHud) {
                    if (gate().ok) {                           // the gate again, now, before each cluster / HUD picture
                        if (toCluster) cluster.write(f);
                        if (toHud) hud.write(f);
                    } else gateStep();                         // closes the gate and takes the picture off
                }
            },
        });
        player.on('state', () => {
            if (player.state === 'paused') { if (!warmAt) warmAt = Date.now(); } else if (player.state !== 'buffering') warmAt = 0;
            if (/^(idle|tuning|paused|offline|error)$/.test(player.state)) {
                cluster.stop();
                if (!settings.get('hudtest')) hud.stop();      // the test card does not depend on the player
            }
            labels();
        });

        /* ----- the lineup ----- */
        async function loadLineup() {
            luState = 'loading'; labels();
            try {
                await lineup.load();
                luState = 'ok'; luError = '';
                if (!lineup.byId(chId)) chId = lineup.byId(cfg.channel) ? cfg.channel : (lineup.channels[0] ? lineup.channels[0].id : chId);
            } catch (e) {
                const off = OFFLINE.test(e.code || e.message);
                luState = off ? 'offline' : 'error'; luError = e.message;
                luRetry = Date.now() + (off ? 5000 : 30000);
                log.warn('lineup: ' + (e.code || '') + ' ' + e.message);
            }
            labels();
        }
        const chan = (id) => lineup.byId(id || chId);
        /** What the channel plays now, if its schedule is here: { item, startMs, endMs, next } */
        function nowOn(id, ms) {
            const s = lineup.peek(id);
            if (!s) return null;
            const t = ms || Date.now(), a = s.at(t), ni = s.next(a.index);
            return { item: a.item, index: a.index, offset: a.offset, startMs: a.startMs, endMs: a.startMs + a.item.duration * 1000, next: s.items[ni] };
        }

        /* ----- tuning ----- */
        /** exactS: the picture starts at that second of the file (a resume), else at the keyframe before startS */
        function srcSpel(s, i, offset, exactS, ch) {
            const it = s.items[i];
            return {
                href: it.href, moov: it.moov, title: it.title, year: it.year,
                startS: it.inS + (offset || 0), endS: it.duration ? it.inS + it.duration : 0, exactS: exactS || 0,
                meta: { kind: 'spelunkr', ch, href: it.href, title: it.title, year: it.year, inS: it.inS, dur: it.duration },
                next: () => { const n = s.next(i); cur = { title: s.items[n].title, year: s.items[n].year }; return srcSpel(s, n, 0, 0, ch); },
            };
        }
        function srcCustom(s, fromS, exactS) {
            return {
                href: s.url, moov: 0, title: s.name, year: '', startS: fromS || 0, endS: 0, exactS: exactS || 0,
                meta: { kind: 'custom', id: s.id },
                next: () => { store.position(s.id, 0, s.durS); return srcCustom(s, 0); },
            };
        }
        function srcStream() {
            const file = decodeURIComponent((cfg.streamUrl.split(/[?#]/)[0].split('/').pop()) || 'video');
            return { href: cfg.streamUrl, moov: 0, title: clean(file, 80), year: '', startS: 0, endS: 0, next: () => srcStream() };
        }
        const playNow = () => want && gateOpen && watching() && visible();
        /**
         * (Re)tune what src names: Spelunkr at what the channel plays now (with resume: where the viewer
         * stopped in it, unless "After driving" says what's on now), a custom source where it was left.
         */
        async function tune(opts) {
            const o = opts || {};
            const gen = ++tuneGen;
            savePos();
            if (!src) return;
            player.paused = !playNow();
            if (src.kind === 'stream') {
                if (!/^https?:\/\//.test(cfg.streamUrl)) { say('streamUrl must be http(s)'); return; }
                cur = { title: srcStream().title };
                player.tune(srcStream());
                return;
            }
            if (src.kind === 'custom') {
                const s = store.get(src.id);
                if (!s) { src = null; player.stop(); return; }
                cur = { title: s.name };
                player.tune(s.posS > 3 ? srcCustom(s, s.posS, s.posS) : srcCustom(s, 0));
                return;
            }
            // Spelunkr
            schErr = '';
            if (luState !== 'ok' || lineup.stale()) await loadLineup();
            if (gen !== tuneGen) return;
            if (luState !== 'ok') { player.stop(); return; }
            const id = src.ch;
            let s;
            try { s = await lineup.schedule(id); } catch (e) {
                if (gen !== tuneGen) return;
                schErr = OFFLINE.test(e.code || e.message) ? 'No connection' : e.message;
                log.warn('channel ' + id + ': ' + (e.code || '') + ' ' + e.message);
                player.stop();
                return;
            }
            if (gen !== tuneGen) return;
            player.paused = !playNow();
            const rec = store.data.resume;
            if (o.resume && afterDrive() === 'resume' && rec && rec.ch === id) {
                let i = -1;
                for (let k = 0; k < s.items.length; k++) if (s.items[k].href === rec.href) { i = k; break; }
                const it = i >= 0 ? s.items[i] : null;
                if (it && rec.posS >= it.inS && (!it.duration || rec.posS < it.inS + it.duration - 5)) {
                    cur = { title: it.title, year: it.year };
                    log.info('resume: ' + id + ' "' + it.title + '" at ' + clock(rec.posS - it.inS));
                    player.tune(srcSpel(s, i, rec.posS - it.inS, rec.posS, id));
                    return;
                }
                if (it) {                                      // it had ended: the next programme from its start
                    const n = s.next(i);
                    cur = { title: s.items[n].title, year: s.items[n].year };
                    player.tune(srcSpel(s, n, 0, 0, id));
                    return;
                }
            }
            const a = s.at(Date.now());
            cur = { title: a.item.title, year: a.item.year };
            player.tune(srcSpel(s, a.index, a.offset, 0, id));
        }
        const afterDrive = () => (settings.get('afterDrive') === 'live' ? 'live' : 'resume');
        /** resume: the Spelunkr tile on Home / reopening (where the viewer stopped); a channel change: what's on */
        function watchSpelunkr(id, resume) {
            if (id) chId = id;
            src = { kind: 'spelunkr', ch: chId };
            store.setLast('spelunkr', chId);
            cur = null; still.clear();
            showBanner();
            tune({ resume: !!resume });
        }
        function watchCustom(id) {
            src = { kind: 'custom', id };
            store.setLast(id);
            cur = null; still.clear();
            showBanner();
            tune();
        }
        /** CH UP (+1) / CH DOWN (-1): the next channel by dial number, around the lineup; Spelunkr only. */
        function chStep(dir) {
            if (!src || src.kind !== 'spelunkr') { showBanner(); return; }
            if (luState !== 'ok' || !lineup.channels.length) { say(luState === 'loading' ? 'Loading the channels...' : 'No channel list yet'); return; }
            watchSpelunkr(lineup.step(chId, dir));
        }
        function showBanner() { bannerUntil = Date.now() + BANNER_MS; }
        function showControls() { controlsUntil = Date.now() + CONTROLS_MS; }
        /** Where the player is, for the programme it plays (src may already name the next one). */
        function savePos() {
            const m = player.src && player.src.meta;
            if (!m || !player.v) return;
            const inf = player.info();
            if (!(inf.pos > 0)) return;
            posAt = Date.now();
            if (m.kind === 'custom') store.position(m.id, inf.pos, inf.end);
            else if (m.kind === 'spelunkr') store.setResume({ ch: m.ch, href: m.href, title: m.title + (m.year ? ' (' + m.year + ')' : ''), inS: m.inS, dur: m.dur, posS: inf.pos });
        }
        /** The Spelunkr programme the player is in, when it is the shown channel's. */
        const playingSpel = () => { const m = player.src && player.src.meta; return m && m.kind === 'spelunkr' && m.ch === chId && player.v ? m : null; };
        /** A custom source: jump by ds seconds (re-tunes there). */
        function seek(ds) {
            if (!src || src.kind !== 'custom' || !player.v) return;
            const s = store.get(src.id);
            if (!s) return;
            const inf = player.info(), to = Math.max(0, Math.min((inf.end || 0) - 5, inf.pos + ds));
            store.position(s.id, to, inf.end);
            player.paused = !playNow();
            still.clear();
            player.tune(srcCustom(s, to));
            showControls();
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
        onSignal = () => gateStep();
        function gateStep() {
            const g = lastGate = gate(), now = Date.now();
            if (!g.ok) {
                parkedSince = 0;
                if (gateOpen) {
                    gateOpen = false; gatedAt = now;
                    log.info('gate: closed (' + g.why + ')');
                    player.pause();
                    blank(g.why);
                    keepStill();
                    savePos();
                    player.trim(WARM_BYTES);
                }
                return;
            }
            if (!parkedSince) parkedSince = now;
            if (!gateOpen && now - parkedSince >= (g.sim ? 0 : RESUME_MS)) {
                gateOpen = true;
                log.info('gate: open (' + g.why + ')');
                if (want && visible() && watching()) resumeOrLive();
            }
        }
        function blank(why) {
            cluster.stop();                                    // first: the cluster and HUD pictures go at once
            hud.stop();
            panel.stop();
            if (settings.get('hudtest')) endHudTest(why || 'hidden');
            endPanelTests(why || 'hidden');
            img.clear();
            const gpu = ctx.display && ctx.display.gpu;
            if (gpu && gpu.dropVideo) gpu.dropVideo(VIDEO_ID);
            regGpu = null; regGen = -1;
            shm.remove();
        }
        /** The newest picture, kept for the dimmed screen while not parked (none: none shown). */
        function keepStill() {
            const p = player.still();
            if (p && p.w >= 16 && p.h >= 16) still.write(p); else still.clear();
        }
        /**
         * Back to watching: the warm state continues where it paused (no tuning); without it (let go, or
         * never there) the place is tuned again exactly. Spelunkr with "jump to what's on now": what the
         * channel plays now after more than RETUNE_MS away.
         */
        function resumeOrLive() {
            if (!src) return;
            const away = gatedAt ? Date.now() - gatedAt : 0;
            gatedAt = 0;
            if (src.kind === 'spelunkr' && afterDrive() === 'live' && away > RETUNE_MS) { dropWarm('jump to what\'s on now', false, true); tune(); return; }
            if (player.warm() && (!warmAt || Date.now() - warmAt <= WARM_MS)) {
                log.info('resume: in place at ' + clock(player.now()) + ' (warm, ' + Math.round(player.warmBytes() / 1024) + ' KB)');
                player.resume();
                return;
            }
            if (player.v && player.state !== 'idle' && player.state !== 'paused') { player.resume(); return; }   // offline / error: it tries again
            tune({ resume: true });
        }
        /** Lets go of the warm state (the place is saved first, for an exact tune later). */
        function dropWarm(why, all, quiet) {
            if (!player.v) return;
            savePos();
            const pos = player.release(all);
            warmAt = 0;
            if (!quiet) log.info('resume: warm state let go (' + why + ') at ' + clock(pos) + '; the place is kept');
        }
        function memTight() {
            let availMb = -1;
            try {
                const m = /MemAvailable:\s+(\d+)/.exec(require('fs').readFileSync('/proc/meminfo', 'utf8'));
                if (m) availMb = Number(m[1]) / 1024;
            } catch (e) { availMb = -1; }
            if (availMb < 0) availMb = require('os').freemem() / 1048576;
            const rssMb = process.memoryUsage().rss / 1048576;
            const lim = Number(process.env.GSTV_WARM_FREE_MB) || WARM_FREE_MB;
            return availMb < lim ? 'free memory ' + Math.round(availMb) + ' MB' : rssMb > WARM_RSS_MB ? 'app memory ' + Math.round(rssMb) + ' MB' : '';
        }
        /** Off the watching view (home, add source...): nothing plays, nothing on the cluster / HUD. */
        function leaveWatch(why) {
            player.pause();
            blank(why);
            keepStill();
            savePos();
            player.trim(WARM_BYTES);
            gatedAt = gatedAt || Date.now();
        }
        function go(p) {
            const was = watching();
            if (p === 'settings') setFrom = page;
            page = p;
            edit = null;
            if (was && !watching()) leaveWatch(p);
            else if (!was && watching() && gateOpen && want) resumeOrLive();
        }
        let lastDraw = 0;
        const visible = () => ui.isVisible('MAIN') || ui.isVisible('MORE') || Date.now() - lastDraw < 1500;

        /* ----- controls ----- */
        function togglePlay() {
            if (!gateOpen) { say('Video available when parked'); return; }
            if (!src) { openLast(); return; }
            want = !(want && !player.paused);
            if (want) resumeOrLive(); else { player.pause(); endPanelTests('paused'); savePos(); }
            labels();
        }
        function openLast() {
            const last = store.data.last;
            want = true;
            page = 'watch';
            if (last && last !== 'spelunkr' && store.get(last)) watchCustom(last); else watchSpelunkr(null, true);
        }
        ui.onClick('BTN_PLAY', togglePlay);
        ui.onClick('BTN_CHUP', () => { if (page !== 'watch' || !src) openLast(); else chStep(1); });
        ui.onClick('BTN_CHDN', () => { if (page !== 'watch' || !src) openLast(); else chStep(-1); });
        ui.onClick('BTN_MORE', () => ui.open('MORE'));

        /* ----- Play in cluster ('cluster'), Play in HUD ('hud'), HUD test ('hudtest'): all off by default ----- */
        // A first tap asks, a second within ASK_MS turns it on. The confirm holds for every way in: the page's
        // buttons, the own settings page, and the kit's generic settings (the HMI's More menu checkbox, the
        // settings sheet), which set the bool in one tap. A change to on that did not come through a second tap
        // within ASK_MS counts as the first tap and is undone. One cluster / HUD output at a time.
        const OUT = {
            cluster: { name: 'Cluster', ask: 'Tap Cluster again to play in the cluster\'s map area (parked only)' },
            hud: { name: 'Play in HUD', ask: 'Tap HUD again to play in the HUD (experiment, parked only)' },
            hudtest: { name: 'HUD test', ask: 'Tap again to show a test card in the HUD for 30 s (parked only)' },
            paneltest: { name: 'Full cluster test', ask: 'Tap again to show a test card over the whole cluster for 30 s (parked only)' },
            sidetest: { name: 'Side panels test', ask: 'Tap again to show the side panels test card for 30 s (parked only)' },
        };
        const asks = { cluster: 0, hud: 0, hudtest: 0, paneltest: 0, sidetest: 0 };
        let okKey = '';
        let hudTestAt = 0, panelTestAt = 0;
        const SIDE_FIRST = 'Side panels test: run the Full cluster test first';
        const panelKey = () => (settings.get('paneltest') ? 'paneltest' : settings.get('sidetest') ? 'sidetest' : '');
        const asking = (k) => Date.now() - asks[k] < ASK_MS;
        const askOut = (k) => { asks[k] = Date.now(); say(OUT[k].ask, ASK_MS); };
        function toggleOut(k) {
            if (settings.get(k)) { asks[k] = 0; settings.set(k, false); say(OUT[k].name + ': off'); return; }
            if (k === 'sidetest' && !panelRan) { say(SIDE_FIRST); return; }
            if (Date.now() - asks[k] > ASK_MS) { askOut(k); return; }
            asks[k] = 0; toast = null;
            okKey = k;
            try { settings.set(k, true); } finally { okKey = ''; }
        }
        function endHudTest(why) {
            hud.stop();
            log.info('hudtest: off (' + why + ')');
            settings.set('hudtest', false);
            say('HUD test: ended (' + why + ')');
        }
        /** The panel test(s) off now: the layer first. */
        function endPanelTests(why) {
            ['paneltest', 'sidetest'].forEach((k) => {
                if (!settings.get(k)) return;
                panel.stop();
                log.info(k + ': off (' + why + ')');
                settings.set(k, false);
                say(OUT[k].name + ': ended (' + why + ')');
            });
        }
        settings.onChange((key, value) => {
            if (!OUT[key]) return;
            if (key === 'sidetest' && value && !panelRan) {
                asks[key] = 0; say(SIDE_FIRST);
                log.info('sidetest: refused (the full cluster test has not run this session)');
                settings.set(key, false);
                return;
            }
            if (value && okKey !== key) {
                if (Date.now() - asks[key] > ASK_MS) {
                    askOut(key);
                    log.info(key + ': asked to confirm (one tap in the settings)');
                    settings.set(key, false);                 // undone: the listeners see off again
                    return;
                }
                asks[key] = 0; toast = null;                   // the second tap within ASK_MS
            }
            if (value) {
                Object.keys(OUT).forEach((k) => {
                    if (k !== key && settings.get(k)) { log.info(k + ': off (' + key + ' turned on; one at a time)'); settings.set(k, false); }
                });
            }
            if (key === 'cluster') cluster.enable(!!value);
            else if (key === 'paneltest' || key === 'sidetest') {
                if (value) panelTestAt = Date.now();
                if (!value) panel.stop();
                panel.enable(!!(settings.get('paneltest') || settings.get('sidetest')));
            } else {
                if (key === 'hudtest') hudTestAt = value ? Date.now() : 0;
                if (!value) hud.stop();
                hud.enable(!!(settings.get('hud') || settings.get('hudtest')));
            }
            log.info(key + ': ' + (value ? 'on' : 'off'));
            labels();
        });
        cluster.enable(!!settings.get('cluster'));
        const clusterText = (s) => (/^Cluster /.test(s.text) ? s.text : 'Cluster: ' + s.text);
        function outStatus(playing) {
            if (settings.get('cluster')) { const cs = cluster.status(gateOpen, playing); return { level: cs.level, text: clusterText(cs) }; }
            if (settings.get('hud')) { const hs = hud.status(gateOpen, playing); return { level: hs.level, text: 'Play in HUD: ' + hs.text }; }
            if (settings.get('hudtest')) {
                const left = Math.max(0, Math.ceil((HUD_TEST_MS - (Date.now() - hudTestAt)) / 1000));
                const hs = hud.status(gateOpen, true);
                return { level: hs.level, text: 'HUD test (' + left + ' s): ' + hs.text };
            }
            const pk = panelKey();
            if (pk) {
                const left = Math.max(0, Math.ceil((HUD_TEST_MS - (Date.now() - panelTestAt)) / 1000));
                const ps = panel.status(gateOpen, true);
                return { level: ps.level, text: OUT[pk].name + ' (' + left + ' s): ' + ps.text };
            }
            return null;
        }
        const outLine = () => { const o = outStatus(gateOpen && want && !player.paused && player.state === 'playing'); return o ? o.text : ''; };

        ui.onVisible((name, on) => {
            if (name !== 'MAIN' && name !== 'MORE') return;
            if (ui.isVisible('MAIN') || ui.isVisible('MORE')) { gateStep(); if (gateOpen && want && watching()) resumeOrLive(); }
            else { lastDraw = 0; leaveWatch('app hidden'); }
        });
        const cleanup = () => {
            try { savePos(); } catch (e) { /* gone */ }
            try { cluster.close(); } catch (e) { /* gone */ }
            try { hud.close(); } catch (e) { /* gone */ }
            try { panel.close(); } catch (e) { /* gone */ }
            try { shm.remove(); } catch (e) { /* gone */ }
        };
        process.on('exit', cleanup);
        process.once('SIGTERM', () => { cleanup(); process.exit(0); });

        /* ----- the phone hand-off ----- */
        function startAdd(mode) {
            if (!handoff.configured()) { say('The phone page is not set up in this build (config.relay)'); return; }
            if ((!mode || mode.kind === 'add') && store.full()) { say('At most ' + Src.MAX_SOURCES + ' sources: hold one to remove it'); return; }
            handoff.start(mode || { kind: 'add' });
            qrPic = null;
            go('add');
        }
        async function received(got) {
            const s = handoff.s, mode = s ? s.mode : { kind: 'add' };
            const old = mode.kind === 'edit' ? store.get(mode.id) : null;
            const name = Src.cleanName(got.name) || (old ? old.name : '');
            const u = got.url ? Src.checkUrl(got.url) : (old ? { ok: true, url: old.url, same: true } : Src.checkUrl(''));
            conf = { mode: mode.kind, id: mode.id, name, url: u.ok ? u.url : String(got.url || '').slice(0, 300), checking: false, res: null, why: '', same: !!u.same };
            go('confirm');
            if (!name) { conf.why = 'No name was sent'; return; }
            if (!u.ok) { conf.why = u.why; return; }
            if (u.same || (old && u.url === old.url)) { conf.same = true; conf.res = { ok: true, checks: [] }; return; }
            conf.checking = true;
            const me = conf;
            let res;
            try { res = await Src.check(net, u.url); } catch (e) { res = { ok: false, why: String(e && e.message || e), checks: [] }; }
            if (conf !== me) return;
            conf.checking = false; conf.res = res; conf.why = res.ok ? '' : res.why;
        }
        function confirmSave() {
            const c = conf;
            if (!c || c.checking || !c.res || !c.res.ok) return;
            try {
                const info = c.res.info || {};
                const s = c.mode === 'edit' ? store.update(c.id, { name: c.name, url: c.same ? null : c.url, durS: info.durS, w: info.w, h: info.h })
                    : store.add({ name: c.name, url: c.url, durS: info.durS, w: info.w, h: info.h });
                handoff.ack({ t: 'done', ok: true });
                say((c.mode === 'edit' ? 'Saved: ' : 'Added: ') + s.name);
                if (src && src.kind === 'custom' && src.id === s.id && !c.same) { player.stop(); src = null; }
            } catch (e) {
                handoff.ack({ t: 'done', ok: false, error: e.message });
                say('Not saved: ' + e.message);
            }
            handoff.cancel(); conf = null;
            go('home');
        }
        function confirmCancel(why) {
            if (handoff.got) handoff.ack({ t: 'done', ok: false, error: why || 'Cancelled on the car.' });
            handoff.cancel(); conf = null;
            go('home');
        }
        function removeSource(id) {
            const s = store.get(id);
            if (src && src.kind === 'custom' && src.id === id) { player.stop(); src = null; }
            store.remove(id);
            edit = null;
            if (s) say('Removed: ' + s.name);
        }

        let clusterShown = '';
        setInterval(() => {
            gateStep();
            if (settings.get('hudtest')) {
                if (Date.now() - hudTestAt >= HUD_TEST_MS) endHudTest(Math.round(HUD_TEST_MS / 1000) + ' s up');
                else if (gateOpen && gate().ok && visible()) hud.card();   // once; the card stays until stopped
            }
            const pk = panelKey();
            if (pk) {
                if (Date.now() - panelTestAt >= HUD_TEST_MS) endPanelTests(Math.round(HUD_TEST_MS / 1000) + ' s up');
                else if (gateOpen && gate().ok && visible()) { if (panel.card(pk === 'paneltest' ? 'full' : 'sides') && pk === 'paneltest') panelRan = true; }
                else panel.stop();
            }
            // the warm state: at most WARM_MS paused, not while memory is tight, at most WARM_BYTES of samples
            if (player.v && player.paused && warmAt) {
                if (Date.now() - warmAt > WARM_MS) dropWarm(Math.round(WARM_MS / 60000) + ' min paused');
                else if (Date.now() - memAt > 5000) {
                    memAt = Date.now();
                    const tight = memTight();
                    if (tight) dropWarm(tight, true); else player.trim(WARM_BYTES);
                }
            }
            const cl = outLine();
            if (cl !== clusterShown) { clusterShown = cl; labels(); }
            if (luState !== 'ok' && luState !== 'loading' && Date.now() >= luRetry && visible()) {
                if (src && src.kind === 'spelunkr' && watching() && gateOpen && want) tune({ resume: true }); else if (!watching()) loadLineup();
            }
            if (src && src.kind === 'spelunkr' && schErr && luState === 'ok' && watching() && gateOpen && want && Date.now() >= luRetry) { luRetry = Date.now() + 10000; tune({ resume: true }); }
            if (player.src && player.src.meta && player.state === 'playing' && Date.now() - posAt > POS_MS) savePos();
            if (page === 'add' && handoff.active()) {
                if (handoff.expired()) { handoff.start(handoff.s.mode); qrPic = null; }
                else handoff.tick().then((got) => { if (got && page === 'add') received(got); }, (e) => log.warn('handoff: ' + e.message));
            }
            if (edit && edit.armed && Date.now() - edit.armed > REMOVE_MS) edit.armed = 0;
        }, 250);

        /* ----- HMI labels (bar buttons, More menu) ----- */
        const shown = {};
        const label = (n, s) => { if (shown[n] !== s) { shown[n] = s; ui.text(n, s); } };
        function statusLine() {
            if (!lastGate.ok) return 'Video available when parked (' + lastGate.why + ')' + (player.warm() ? ' - resumes where you stopped' : '');
            if (!src) return 'Press Play to watch, or pick a source on the home screen';
            if (src.kind === 'spelunkr') {
                if (luState === 'loading') return 'Loading the channels...';
                if (luState === 'offline') return 'No internet: connect the phone hotspot / Wi-Fi uplink';
                if (luState === 'error') return 'Channels: ' + luError;
                if (schErr) return 'Channel: ' + schErr;
            }
            const s = player.state;
            return s === 'tuning' ? 'Tuning...' : s === 'buffering' ? 'Buffering...' : s === 'paused' ? 'Paused'
                : s === 'offline' ? 'No connection - trying again' : s === 'error' ? 'Error: ' + player.text : s === 'playing' ? 'Playing' : 'Starting...';
        }
        function labels() {
            label('BTN_PLAY', want && !player.paused ? 'Pause' : 'Play');
            const ol = outLine();
            label('MORE_INFO', statusLine() + ' | video only, no sound yet' + (ol ? ' | ' + ol : ''));
        }
        labels();

        /* ----- the screen ----- */
        FS.setup(ctx);
        let downKey = '', downAt = 0;
        let qrPic = null;
        const press = (key, fn) => { downKey = key; downAt = Date.now(); setTimeout(fn, 140); };
        const isDown = (key) => downKey === key && Date.now() - downAt < 200;
        const L = { video: null, noSwipe: [], guide: null, rows: [], tiles: null, tileRects: [] };
        let sched = 0;                       // schedules being fetched for the guide
        function ensureSched(id) {
            if (lineup.peek(id) || sched >= 3 || (lineup.loading && lineup.loading.has && lineup.loading.has(id))) return;
            sched++;
            lineup.schedule(id).then(() => { sched--; }, (e) => { sched--; log.warn('guide ' + id + ': ' + e.message); });
        }
        const controlsShown = () => Date.now() < controlsUntil || (!full && (!gateOpen || !lastGate.ok || player.paused || player.state !== 'playing'));
        function enterFull(on) {
            full = !!on;
            if (full) controlsUntil = 0; else showControls();
            say(full ? 'Fullscreen: tap the picture for the controls' : 'Fullscreen: off', 2000);
        }
        if (ctx.onBack) ctx.onBack(() => {
            if (edit) { edit = null; return true; }
            if (page === 'home') return false;
            if (page === 'watch' && full) { enterFull(false); return true; }
            if (page === 'confirm') { confirmCancel(); return true; }
            if (page === 'add') { handoff.cancel(); go('home'); return true; }
            if (page === 'guide') { go('watch'); return true; }
            if (page === 'settings') { go(setFrom === 'settings' ? 'home' : setFrom); return true; }
            go('home');
            return true;
        });

        // touch: swipes and taps on the picture, the guide's scroll and taps, the home tiles' scroll, taps and holds
        let T = null;
        FS.drag(ctx, (x, y) => {
            if (edit) return false;
            if (page === 'watch' && inside(L.video, x, y) && !L.noSwipe.some((r) => inside(r, x, y))) return true;
            if (page === 'guide' && inside(L.guide, x, y)) return true;
            if (page === 'home' && inside(L.tiles, x, y)) return true;
            return false;
        }, (phase, x, y) => {
            if (phase === 1) {
                T = { x0: x, y0: y, x, y, moved: false, s0: page === 'guide' ? guideScroll : homeScroll, held: false, timer: null };
                if (page === 'home') {
                    const t0 = T;
                    t0.timer = setTimeout(() => {
                        if (T !== t0 || t0.moved) return;
                        const hit = L.tileRects.filter((r) => inside(r, t0.x0, t0.y0))[0];
                        if (hit && hit.kind === 'custom') { t0.held = true; edit = { id: hit.id, armed: 0 }; }
                    }, HOLD_MS);
                }
                return;
            }
            if (!T) return;
            T.x = x; T.y = y;
            if (Math.abs(x - T.x0) > 14 || Math.abs(y - T.y0) > 14) T.moved = true;
            if (phase === 2) {
                if (page === 'guide' && T.moved) guideScroll = Math.max(0, T.s0 - (y - T.y0));
                if (page === 'home' && T.moved) homeScroll = Math.max(0, T.s0 - (x - T.x0));
                return;
            }
            // release
            const t1 = T; T = null;
            clearTimeout(t1.timer);
            if (t1.held) return;
            if (page === 'watch') {
                const dy = y - t1.y0, dx = x - t1.x0;
                if (Math.abs(dy) > SWIPE && Math.abs(dy) > Math.abs(dx)) {
                    if (src && src.kind === 'spelunkr') chStep(dy < 0 ? 1 : -1); else showBanner();
                } else if (!t1.moved) {
                    if (Date.now() < controlsUntil) controlsUntil = 0; else showControls();
                    showBanner();
                }
                return;
            }
            if (t1.moved) return;
            if (page === 'guide') {
                const row = L.rows.filter((r) => inside(r, x, y))[0];
                if (row) { want = true; go('watch'); watchSpelunkr(row.id); showControls(); }
                return;
            }
            if (page === 'home') {
                const hit = L.tileRects.filter((r) => inside(r, x, y))[0];
                if (!hit) return;
                if (hit.kind === 'add') { startAdd({ kind: 'add' }); return; }
                want = true;
                page = 'watch'; edit = null;
                showControls();
                if (hit.kind === 'spelunkr') watchSpelunkr(null, true); else watchCustom(hit.id);
            }
        });

        ctx.loop('MAIN', 6, () => {
            const first = Date.now() - lastDraw > 1500;
            lastDraw = Date.now();
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            if (first && gateOpen && want && watching() && src && (player.paused || player.state === 'idle')) resumeOrLive();
            const A = FS.area(cv);
            L.video = null; L.noSwipe = []; L.guide = null; L.rows = []; L.tiles = null; L.tileRects = [];
            const bare = page === 'watch' && full && cv.own;
            if (!bare) G.frame(cv, t, cv.own ? [] : [NAME], 0, [{ text: 'EXPERIMENTAL' }, lastGate.sim && { text: 'SIM PARKED' }]);
            // without the kit's touch screen the picture page only (the HMI's Play / Ch + / Ch - / More do the rest)
            if (!cv.own) drawWatch(cv, t, A);
            else if (page === 'settings') drawSettings(cv, t, A);
            else if (page === 'home') drawHome(cv, t, A);
            else if (page === 'guide') drawGuide(cv, t, A);
            else if (page === 'add') drawAdd(cv, t, A);
            else if (page === 'confirm') drawConfirm(cv, t, A);
            else drawWatch(cv, t, A);
            if (edit && page === 'home') drawEdit(cv, t, A);
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
        /** A plate with a label (and a glyph above it when glyph is given). */
        function action(cv, t, key, x, y, w, h, text, fn, glyph, opts) {
            const o2 = opts || {};
            plate(cv, t, x, y, w, h, !!o2.on, isDown(key));
            if (o2.solid) cv.roundRect(x, y, w, h, 14, isDown(key) ? G.withAlpha(o2.solid, 0.7) : o2.solid);
            const o = { font: 'bold', spacing: 1.5, literal: true }, cx = x + w / 2, size = o2.size || (glyph ? 16 : 20);
            if (glyph) glyph(cx, y + h / 2 - 12);
            cv.text(fit(cv, text.toUpperCase(), size, w - 24, o), cx, glyph ? y + h - 14 : y + h / 2 + size * 0.36, size, o2.fg || t.text, Object.assign({ align: 'center' }, o));
            FS.button(cv, key, x, y, w, h, () => { downKey = key; downAt = Date.now(); return fn(); }, { slop: o2.slop == null ? 6 : o2.slop, r: 14 });
        }
        function chip(cv, x, y, text, fg, bg) {
            const o = { font: 'bold', spacing: 1.5, literal: true }, w = cv.textWidth(text, 15, o) + 28;
            cv.roundRect(x, y, w, 30, 15, bg); cv.text(text, x + 14, y + 21, 15, fg, o);
            return w;
        }
        function backButton(cv, t, A, label, fn) {
            const hy = A.y, cyH = hy + HEAD_H / 2, bw = 220;
            plate(cv, t, A.x, hy, bw, HEAD_H, false, isDown('back'));
            cv.line(A.x + 38, cyH - 12, A.x + 25, cyH, 3, t.text);
            cv.line(A.x + 25, cyH, A.x + 38, cyH + 12, 3, t.text);
            cv.text(fit(cv, label.toUpperCase(), 22, bw - 70, { font: 'bold', spacing: 1.5 }), A.x + 56, cyH + 8, 22, t.text, { font: 'bold', spacing: 1.5, literal: true });
            FS.button(cv, 'back', A.x, hy, bw, HEAD_H, () => press('back', fn), { slop: 8, r: 14 });
            return bw;
        }
        /** A channel's logomark (32 x 32 runs) in a square of side s; a coloured square with the dial without one. */
        function logo(cv, ch, x, y, s) {
            if (!ch) return;
            if (ch.logo && ch.logo.runs && ch.logo.runs.length) {
                const n = ch.logo.n || 32, c = s / n;
                ch.logo.runs.forEach((r) => cv.fillRect(x + r[0] * c, y + r[1] * c, r[2] * c + 0.5, c + 0.5, r[3]));
                return;
            }
            cv.roundRect(x, y, s, s, 8, ch.color || '#444444');
            cv.text(String(ch.dial), x + s / 2, y + s / 2 + s * 0.14, s * 0.4, '#ffffff', { font: 'bold', align: 'center', literal: true });
        }
        function progress(cv, t, x, y, w, frac, col) {
            cv.roundRect(x, y, w, 8, 4, G.withAlpha('#ffffff', 0.18));
            if (frac > 0) cv.roundRect(x, y, Math.max(8, Math.min(1, frac) * w), 8, 4, col || t.accent2 || t.accent);
        }
        /** The picture scaled to fit box r, letterboxed, the stream's aspect kept. */
        function drawPicture(cv, t, r) {
            const inf = player.info(), g = lastGate;
            cv.fillRect(r.x, r.y, r.w, r.h, '#000000');
            const asp = inf.w && inf.h ? inf.w / inf.h : 16 / 9;
            let vw = r.w, vh = Math.round(vw / asp);
            if (vh > r.h) { vh = r.h; vw = Math.round(vh * asp); }
            const vx = r.x + Math.round((r.w - vw) / 2), vy = r.y + Math.round((r.h - vh) / 2);
            const playingPic = gateOpen && want && !player.paused;
            // the last picture (still, not video), placed like the picture, at its own aspect
            const stillAt = () => {
                const sa = still.w / still.h;
                let sw = r.w, sh = Math.round(sw / sa);
                if (sh > r.h) { sh = r.h; sw = Math.round(sh * sa); }
                cv.image(STILL_ID, r.x + Math.round((r.w - sw) / 2), r.y + Math.round((r.h - sh) / 2), sw, sh);
            };
            if (!g.ok || !gateOpen) {
                if (still.has && still.w && still.h) {
                    stillAt();
                    cv.fillRect(r.x, r.y, r.w, r.h, '#000000b4');     // dimmed
                    drawGate(cv, t, r.x, r.y, r.w, r.h, g, true);
                } else drawGate(cv, t, r.x, r.y, r.w, r.h, g);
                return;
            }
            const live = (videoPath() && shm.fd !== null && playingPic) || (img.has && (playingPic || player.state === 'paused'));
            if (!live && still.has && still.w && still.h) stillAt();                // back in P: until the first new picture
            if (videoPath() && shm.fd !== null && playingPic) {
                const gpu = ctx.display.gpu;
                if (regGpu !== gpu || regGen !== shm.gen) { if (gpu.video(VIDEO_ID, shm.file)) { regGpu = gpu; regGen = shm.gen; } }
                cv.video(VIDEO_ID, vx, vy, vw, vh);
            } else if (img.has && (playingPic || player.state === 'paused')) cv.image(VIDEO_ID, vx, vy, vw, vh);
            if (!(player.state === 'playing' || player.state === 'paused')) {
                const s = statusLine();
                const bad = player.state === 'error' || luState === 'error' || !!schErr;
                cv.text(fit(cv, s, 28, r.w - 60, { font: 'bold' }), r.x + r.w / 2, r.y + r.h / 2 + 10, 28, bad ? t.crit : t.dim, { align: 'center', font: 'bold', literal: true });
            }
        }
        function drawGate(cv, t, x, y, w, h, g, over) {
            if (!over) cv.roundRect(x, y, w, h, 10, t.panelBottom || '#101014');
            const cx = x + w / 2, cy = y + h / 2 - 40;
            cv.circle(cx, cy, 52, G.withAlpha(t.accent2 || t.accent, 0.18));
            cv.strokeRoundRect(cx - 52, cy - 52, 104, 104, 52, 3, t.accent2 || t.accent);
            cv.text('P', cx, cy + 22, 64, t.text, { font: 'bold', align: 'center', literal: true });
            cv.text(fit(cv, 'Video available when parked', 34, w - 40, { font: 'bold' }), cx, cy + 108, 34, t.text, { font: 'bold', align: 'center', literal: true });
            const why = g.ok ? 'Starting in a moment...' : g.why;
            cv.text(fit(cv, why, 24, w - 40), cx, cy + 146, 24, t.dim, { align: 'center', literal: true });
            cv.text(fit(cv, 'Speed at most ' + MAX_KMH + ' km/h and the selector in P', 20, w - 40), cx, cy + 178, 20, t.dim, { align: 'center', literal: true });
        }

        /** The whole app area, x 84-1920 and y 76-720 on the screen, in page px (fullscreen). */
        function fullRect(cv, A) {
            if (!cv.own || !cv.place) return { x: A.x, y: A.y, w: A.w, h: A.h };
            const a = FS.toPage(cv, FS.TOUCH_LEFT, FS.TOUCH_TOP), b = FS.toPage(cv, FS.SCREEN.w, FS.SCREEN.h);
            const x0 = Math.max(0, Math.floor(a.x)), y0 = Math.max(0, Math.floor(a.y));
            const x1 = Math.min(FS.PAGE.w, Math.ceil(b.x)), y1 = Math.min(FS.PAGE.h + (cv.extra || 0), Math.ceil(b.y));
            return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        }
        const srcTitle = () => {
            if (!src) return '';
            if (src.kind === 'spelunkr') { const c = chan(src.ch); return c ? c.name : src.ch; }
            if (src.kind === 'custom') { const s = store.get(src.id); return s ? s.name : ''; }
            return cur ? cur.title : 'Stream';
        };

        /** The watching view: CH column (left), the picture, the top controls and the banner over it; or fullscreen. */
        function drawWatch(cv, t, A) {
            const on = t.accent2 || t.accent;
            const spel = !!src && src.kind === 'spelunkr', custom = !!src && src.kind === 'custom';
            const fs = full && cv.own;
            const V = fs ? fullRect(cv, A) : cv.own ? { x: A.x + RAIL_W + GAP, y: A.y, w: A.right - (A.x + RAIL_W + GAP), h: A.h } : { x: A.x, y: A.y, w: Math.round(A.w * 0.62), h: A.h };
            L.video = V;
            drawPicture(cv, t, V);
            if (!fs) cv.strokeRoundRect(V.x, V.y, V.w, V.h, 10, 1, G.withAlpha('#ffffff', 0.12));

            // the CH column (not in fullscreen)
            if (!fs && cv.own) {
                const x = A.x, w = RAIL_W, bh = Math.round((A.h - 2 * GAP) * 0.36), mid = A.h - 2 * GAP - 2 * bh;
                const up = (px, py) => tri(cv, [[px - 22, py + 12], [px + 22, py + 12], [px, py - 14]], t.text);
                const dn = (px, py) => tri(cv, [[px - 22, py - 12], [px + 22, py - 12], [px, py + 14]], t.text);
                if (custom) {
                    action(cv, t, 'fwd', x, A.y, w, bh, '30 s ahead', () => seek(30), up);
                    action(cv, t, 'rew', x, A.bottom - bh, w, bh, '30 s back', () => seek(-30), dn);
                } else {
                    action(cv, t, 'chup', x, A.y, w, bh, 'CH up', () => chStep(1), up);
                    action(cv, t, 'chdn', x, A.bottom - bh, w, bh, 'CH down', () => chStep(-1), dn);
                }
                const my = A.y + bh + GAP, c = spel ? chan(chId) : null;
                cv.roundRect(x, my, w, mid, 14, G.withAlpha('#ffffff', 0.04));
                if (c) {
                    const ls = Math.min(64, mid - 60);
                    logo(cv, c, x + 18, my + (mid - ls) / 2, ls);
                    cv.text(String(c.dial), x + w - 18, my + mid / 2 + 4, 44, t.text, { font: 'num', align: 'right', literal: true });
                    cv.text(fit(cv, c.name.toUpperCase(), 14, w - 36, { font: 'bold', spacing: 1 }), x + w - 18, my + mid / 2 + 30, 14, t.dim, { font: 'bold', spacing: 1, align: 'right', literal: true });
                } else {
                    cv.text(fit(cv, custom ? 'MY SOURCE' : 'STREAM', 16, w - 30, { font: 'bold', spacing: 1.5 }), x + w / 2, my + mid / 2 + 6, 16, t.dim, { font: 'bold', spacing: 1.5, align: 'center', literal: true });
                }
                if (spel) FS.button(cv, 'rail-guide', x, my, w, mid, () => { downKey = 'rail-guide'; downAt = Date.now(); go('guide'); }, { slop: 0, r: 14 });
            }

            // the banner (after a change, or with the controls)
            const now = Date.now();
            if (now < bannerUntil || (controlsShown() && !fs) || (fs && now < controlsUntil)) drawBanner(cv, t, V, spel, custom);

            // the top controls
            if (!cv.own) { drawSide(cv, t, A, V); return; }
            if (!controlsShown()) return;
            const y = V.y + 10, h = TOP_H - 14, gx = V.x + V.w - 10 - GB_W;
            cv.gradientRect(V.x, V.y, V.w, TOP_H + 30, [[0, '#000000c0'], [1, '#00000000']]);
            L.noSwipe.push({ x: V.x, y: V.y, w: V.w, h: TOP_H });
            const isPlay = want && !player.paused && gateOpen, gc = gateOpen ? t.text : t.dim;
            const items = [
                ['home', 'Home', () => go('home'), (px, py) => { tri(cv, [[px - 16, py - 1], [px + 16, py - 1], [px, py - 15]], t.text); cv.fillRect(px - 11, py - 1, 22, 13, t.text); }],
                spel ? ['guide', 'Guide', () => go('guide'), (px, py) => { [-9, 0, 9].forEach((d) => cv.fillRect(px - 16, py + d - 2, 32, 4, t.text)); }] : null,
                ['play', isPlay ? 'Pause' : 'Play', togglePlay, (px, py) => {
                    if (isPlay) { cv.fillRect(px - 11, py - 13, 8, 26, gc); cv.fillRect(px + 3, py - 13, 8, 26, gc); }
                    else tri(cv, [[px - 10, py - 14], [px + 14, py], [px - 10, py + 14]], gc);
                }],
                ['cluster', asking('cluster') ? 'Tap again' : settings.get('cluster') ? 'Cluster on' : 'Cluster', () => toggleOut('cluster'), (px, py) => {
                    const c = settings.get('cluster') ? (t.sel || t.accent) : asking('cluster') ? '#ffcc33' : t.text;
                    cv.strokeRoundRect(px - 24, py - 11, 48, 22, 11, 3, c); cv.circle(px - 12, py, 4, c); cv.circle(px + 12, py, 4, c);
                }],
                ['full', fs ? 'Exit fullscreen' : 'Fullscreen', () => enterFull(!fs), (px, py) => {
                    const c = t.text, a = 9, d = fs ? -1 : 1;
                    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach((q) => {
                        const cx = px + q[0] * 16, cy = py + q[1] * 11;
                        cv.fillRect(Math.min(cx, cx - q[0] * d * a), cy - 1.5, a, 3, c);
                        cv.fillRect(cx - 1.5, Math.min(cy, cy - q[1] * d * a), 3, a, c);
                    });
                }],
            ].filter(Boolean);
            const bw = Math.min(200, Math.floor((gx - 10 - V.x - 10 - (items.length - 1) * 10) / items.length));
            items.forEach((it, i) => cv.roundRect(V.x + 10 + i * (bw + 10), y, bw, h, 14, '#000000a8'));
            items.forEach((it, i) => action(cv, t, it[0], V.x + 10 + i * (bw + 10), y, bw, h, it[1], () => { showControls(); return it[2](); }, it[3], { size: 14, slop: 4, on: it[0] === 'full' && fs }));
            cv.roundRect(gx, y, GB_W, h, 14, '#000000a8');
            gButton(cv, t, { x: gx, y, w: GB_W, h }, false, 'g', () => press('g', () => go('settings')));
        }
        /** The channel banner: number, logo, name, what plays (title, year), progress, time left, next. */
        function drawBanner(cv, t, V, spel, custom) {
            const on = t.accent2 || t.accent, h = BANNER_H, x = V.x + 16, w = V.w - 32, y = V.y + V.h - h - 14;
            cv.roundRect(x, y, w, h, 16, '#000000d0');
            cv.strokeRoundRect(x, y, w, h, 16, 1, G.withAlpha('#ffffff', 0.16));
            const o = { font: 'bold', literal: true };
            let X = x + 22;
            const c = spel ? chan(chId) : null;
            if (c) {
                cv.text(String(c.dial), X, y + 66, 56, t.text, { font: 'num', literal: true });
                X += Math.max(70, cv.textWidth(String(c.dial), 56, { font: 'num', literal: true })) + 18;
                logo(cv, c, X, y + 20, 56);
                X += 74;
            }
            const right = x + w - 22, W = right - X;
            const head = (c ? c.name : srcTitle()).toUpperCase();
            cv.text(fit(cv, head, 16, W - 220, { font: 'bold', spacing: 2 }), X, y + 30, 16, on, { font: 'bold', spacing: 2, literal: true });
            cv.text('VIDEO ONLY \u00b7 NO SOUND', right, y + 30, 13, '#ffcc33', { font: 'bold', spacing: 1, align: 'right', literal: true });
            let title = cur ? cur.title : '', frac = 0, left = '', next = '';
            const pm = spel ? playingSpel() : null;
            if (pm) {
                // what the player is in (after a resume that can be behind what the channel plays now)
                const n = nowOn(chId), pos = player.info().pos, behind = n && (n.item.href !== pm.href || Math.abs(pos - (pm.inS + n.offset)) > 60);
                title = pm.title + (pm.year ? ' (' + pm.year + ')' : '');
                if (pm.dur > 0) { frac = (pos - pm.inS) / pm.dur; left = mins((pm.inS + pm.dur - pos) * 1000) + ' left'; }
                next = behind ? 'Resumed where you stopped \u00b7 on now: ' + n.item.title : n && n.next ? 'Next: ' + n.next.title : '';
            } else if (spel) {
                const n = nowOn(chId);
                if (n) {
                    title = n.item.title + (n.item.year ? ' (' + n.item.year + ')' : '');
                    frac = (Date.now() - n.startMs) / (n.endMs - n.startMs);
                    left = mins(n.endMs - Date.now()) + ' left';
                    next = n.next ? 'Next: ' + n.next.title : '';
                } else if (!title) title = luState === 'ok' ? 'Tuning...' : statusLine();
            } else {
                const inf = player.info(), s = custom ? store.get(src.id) : null;
                const end = inf.end || (s ? s.durS : 0), pos = inf.pos || (s ? s.posS : 0);
                if (end > 0) { frac = pos / end; left = clock(pos) + ' / ' + clock(end); }
                if (s) next = Src.hostOf(s.url);
                if (!title) title = srcTitle();
            }
            cv.text(fit(cv, title, 30, W, o), X, y + 72, 30, t.text, o);
            progress(cv, t, X, y + 92, Math.max(40, W - 230), frac, on);
            if (left) cv.text(left, right, y + 101, 20, t.text, { font: 'bold', align: 'right', literal: true });
            if (next) cv.text(fit(cv, next, 20, W, { literal: true }), X, y + 132, 20, t.dim, { literal: true });
        }
        /** Without the kit's touch screen: the programme and status beside the picture (the HMI buttons do the rest). */
        function drawSide(cv, t, A, V) {
            const on = t.accent2 || t.accent, X = V.x + V.w + 40, W = A.right - X;
            let y = A.y + 22;
            const c = src && src.kind === 'spelunkr' ? chan(chId) : null;
            cv.text(fit(cv, ((c ? 'CH ' + c.dial + '  ' : '') + srcTitle()).toUpperCase(), 18, W, { font: 'bold', spacing: 2 }), X, y, 18, on, { font: 'bold', spacing: 2, literal: true });
            y += 46;
            wrap(cv, cur ? cur.title : '', 34, W, 2, { font: 'bold' }).forEach((s) => { cv.text(s, X, y, 34, t.text, { font: 'bold', literal: true }); y += 40; });
            y += 10;
            chip(cv, X, y, 'VIDEO ONLY \u00b7 NO SOUND YET', '#1a1a1a', '#ffcc33');
            y += 66;
            wrap(cv, statusLine(), 24, W, 2).forEach((s) => { cv.text(s, X, y, 24, t.text, { literal: true }); y += 32; });
            const ol = outLine();
            if (ol) cv.text(fit(cv, ol, 20, W), X, y, 20, t.text, { literal: true });
            cv.text(fit(cv, 'Ch + / Ch - and More on the bar below', 20, W), X, A.bottom - 10, 20, t.dim, { literal: true });
        }

        /** Home: the Spelunkr tile, the viewer's sources, Add source. Scrolls sideways; hold a source to edit it. */
        function drawHome(cv, t, A) {
            const on = t.accent2 || t.accent, hy = A.y, cyH = hy + HEAD_H / 2;
            cv.text(NAME.toUpperCase(), A.x + 4, cyH + 12, 34, t.text, { font: 'bold', spacing: 2, literal: true });
            const tw = cv.textWidth(NAME.toUpperCase(), 34, { font: 'bold', spacing: 2, literal: true });
            chip(cv, A.x + tw + 24, cyH - 15, 'VIDEO ONLY \u00b7 PARKED ONLY', '#1a1a1a', '#ffcc33');
            const gr = { x: A.right - GB_W, y: hy, w: GB_W, h: HEAD_H };
            cv.text(fit(cv, lastGate.ok ? 'Pick what to watch' : 'Video available when parked', 20, 420), gr.x - 24, cyH + 7, 20, lastGate.ok ? t.dim : '#ffcc33', { align: 'right', literal: true });
            gButton(cv, t, gr, false, 'g-home', () => press('g-home', () => go('settings')));

            const top = hy + HEAD_H + 22, th = A.bottom - top - 34, TW = Math.round(th * 0.95), SW = Math.round(th * 1.45);
            const box = { x: A.x, y: top, w: A.right - A.x, h: th };
            L.tiles = box;
            const tiles = [{ kind: 'spelunkr', w: SW }].concat(store.list().map((s) => ({ kind: 'custom', id: s.id, s, w: TW }))).concat([{ kind: 'add', w: Math.round(TW * 0.8) }]);
            const total = tiles.reduce((a, b) => a + b.w + GAP, -GAP);
            homeScroll = Math.max(0, Math.min(homeScroll, total - box.w));
            let x = box.x - homeScroll;
            if (cv.clip) cv.clip(box.x, box.y - 4, box.w, box.h + 8);
            tiles.forEach((tl) => {
                const r = { x, y: top, w: tl.w, h: th, kind: tl.kind, id: tl.id };
                x += tl.w + GAP;
                if (r.x + r.w < box.x - 4 || r.x > box.x + box.w + 4) return;
                L.tileRects.push(r);
                if (tl.kind === 'spelunkr') drawSpelTile(cv, t, r);
                else if (tl.kind === 'custom') drawSourceTile(cv, t, r, tl.s);
                else drawAddTile(cv, t, r);
            });
            if (cv.noclip) cv.noclip();
            // edge fades when there is more to scroll to
            if (homeScroll > 0) cv.fillRect(Math.max(0, box.x - 12), top, 12, th, t.bg);
            const hint = store.list().length ? 'Hold a source to rename it, send a new link or remove it' : 'Add your own MP4 links from your phone';
            cv.text(fit(cv, hint, 18, box.w), box.x + 4, A.bottom - 6, 18, t.dim, { literal: true });
            if (total > box.w) {
                const bw = box.w * box.w / total, bx = box.x + (box.w - bw) * (homeScroll / (total - box.w));
                cv.roundRect(box.x + box.w - 160, A.bottom - 20, 160, 6, 3, G.withAlpha('#ffffff', 0.12));
                cv.roundRect(box.x + box.w - 160 + (bx - box.x) * 160 / box.w, A.bottom - 20, Math.max(16, bw * 160 / box.w), 6, 3, on);
            }
        }
        function tileFrame(cv, t, r, col) {
            cv.roundRect(r.x, r.y, r.w, r.h, 18, G.withAlpha('#ffffff', 0.05));
            cv.gradientRect(r.x + 1, r.y + 1, r.w - 2, Math.round(r.h * 0.55), [[0, G.withAlpha(col, 0.55)], [1, G.withAlpha(col, 0.05)]]);
            cv.strokeRoundRect(r.x, r.y, r.w, r.h, 18, edit && edit.id === r.id ? 3 : 1, edit && edit.id === r.id ? (t.sel || t.accent) : G.withAlpha('#ffffff', 0.14));
        }
        function drawSpelTile(cv, t, r) {
            const on = t.accent2 || t.accent, c = chan(chId), col = c ? c.color || on : on;
            tileFrame(cv, t, r, col);
            const X = r.x + 24, W = r.w - 48;
            cv.text('SPELUNKR', X, r.y + 40, 18, '#ffffff', { font: 'bold', spacing: 3, literal: true });
            cv.text(luState === 'ok' ? lineup.channels.length + ' CHANNELS' : '', r.x + r.w - 24, r.y + 40, 15, G.withAlpha('#ffffff', 0.8), { font: 'bold', spacing: 1.5, align: 'right', literal: true });
            if (c) {
                const ls = Math.min(96, Math.round(r.h * 0.34));
                logo(cv, c, X, r.y + 62, ls);
                cv.text(String(c.dial), X + ls + 20, r.y + 62 + ls * 0.58, 52, '#ffffff', { font: 'num', literal: true });
                cv.text(fit(cv, c.name, 24, W - ls - 20, { font: 'bold' }), X + ls + 20, r.y + 62 + ls * 0.95, 24, '#ffffff', { font: 'bold', literal: true });
                const n = nowOn(c.id);
                if (!n) ensureSched(c.id);
                const yy = r.y + r.h - 70;
                cv.text('RESUME', X, yy - 26, 14, on, { font: 'bold', spacing: 2, literal: true });
                const rec = store.data.resume;
                if (rec && rec.ch === c.id && afterDrive() === 'resume' && rec.title) {
                    // where the viewer stopped (what the tile's tap goes back to)
                    cv.text(fit(cv, rec.title, 24, W), X, yy + 4, 24, t.text, { literal: true });
                    if (rec.dur > 0) { progress(cv, t, X, yy + 22, W - 130, (rec.posS - rec.inS) / rec.dur, on); cv.text(mins((rec.inS + rec.dur - rec.posS) * 1000) + ' left', X + W, yy + 31, 17, t.dim, { align: 'right', literal: true }); }
                } else {
                cv.text(fit(cv, n ? n.item.title : 'What\'s on now', 24, W), X, yy + 4, 24, t.text, { literal: true });
                if (n) { progress(cv, t, X, yy + 22, W - 130, (Date.now() - n.startMs) / (n.endMs - n.startMs), on); cv.text(mins(n.endMs - Date.now()) + ' left', X + W, yy + 31, 17, t.dim, { align: 'right', literal: true }); }
                }
            } else {
                cv.text(fit(cv, luState === 'loading' ? 'Loading the channels...' : luState === 'ok' ? 'Pick a channel' : statusLine(), 24, W), X, r.y + r.h / 2, 24, t.text, { literal: true });
            }
        }
        function drawSourceTile(cv, t, r, s) {
            const col = tint(s.id), X = r.x + 22, W = r.w - 44;
            tileFrame(cv, t, r, col);
            cv.text('MY SOURCE', X, r.y + 38, 14, '#ffffff', { font: 'bold', spacing: 2, literal: true });
            // a film-frame glyph
            const gx = X, gy = r.y + 62, gw = 74, gh = 54;
            cv.strokeRoundRect(gx, gy, gw, gh, 8, 3, '#ffffff');
            tri(cv, [[gx + 28, gy + 14], [gx + 52, gy + 27], [gx + 28, gy + 40]], '#ffffff');
            const lines = wrap(cv, s.name, 26, W, 2, { font: 'bold' });
            lines.forEach((ln, i) => cv.text(ln, X, r.y + 154 + i * 32, 26, t.text, { font: 'bold', literal: true }));
            cv.text(fit(cv, Src.hostOf(s.url), 17, W), X, r.y + r.h - 64, 17, t.dim, { literal: true });
            const frac = s.durS > 0 ? s.posS / s.durS : 0;
            progress(cv, t, X, r.y + r.h - 44, W, frac, col);
            cv.text(s.posS > 5 ? 'Resume at ' + clock(s.posS) : s.durS ? clock(s.durS) : 'MP4', X, r.y + r.h - 14, 17, t.dim, { literal: true });
        }
        function drawAddTile(cv, t, r) {
            const on = t.accent2 || t.accent, cx = r.x + r.w / 2, cy = r.y + r.h / 2 - 30;
            cv.roundRect(r.x, r.y, r.w, r.h, 18, G.withAlpha('#ffffff', 0.03));
            cv.strokeRoundRect(r.x, r.y, r.w, r.h, 18, 2, G.withAlpha(on, 0.6));
            cv.circle(cx, cy, 44, G.withAlpha(on, 0.18));
            cv.fillRect(cx - 22, cy - 3, 44, 6, t.text); cv.fillRect(cx - 3, cy - 22, 6, 44, t.text);
            cv.text('ADD SOURCE', cx, cy + 86, 20, t.text, { font: 'bold', spacing: 2, align: 'center', literal: true });
            cv.text('from your phone', cx, cy + 116, 18, t.dim, { align: 'center', literal: true });
        }
        /** The held source's sheet: Rename / new link (phone), Remove (two taps), Close. */
        function drawEdit(cv, t, A) {
            const s = store.get(edit.id);
            if (!s) { edit = null; return; }
            cv.fillRect(0, 0, 1600, 520 + (cv.extra || 0), '#000000a0');
            const w = 760, h = 300, x = 800 - w / 2, y = Math.round((A.y + A.bottom - h) / 2);
            cv.roundRect(x, y, w, h, 20, t.panelBottom || '#15151a');
            cv.strokeRoundRect(x, y, w, h, 20, 2, G.withAlpha('#ffffff', 0.2));
            cv.text(fit(cv, s.name, 32, w - 60, { font: 'bold' }), x + 30, y + 58, 32, t.text, { font: 'bold', literal: true });
            cv.text(fit(cv, Src.hostOf(s.url) + (s.durS ? '  \u00b7  ' + clock(s.durS) : ''), 20, w - 60), x + 30, y + 92, 20, t.dim, { literal: true });
            const bw = (w - 60 - 2 * 16) / 3, by = y + h - 30 - 110;
            action(cv, t, 'e-phone', x + 30, by, bw, 110, 'Rename / new link', () => { const id = s.id; edit = null; startAdd({ kind: 'edit', id, name: s.name }); }, (px, py) => {
                cv.strokeRoundRect(px - 14, py - 22, 28, 44, 6, 3, t.text); cv.fillRect(px - 5, py + 14, 10, 3, t.text);
            });
            const armed = edit.armed && Date.now() - edit.armed < REMOVE_MS;
            action(cv, t, 'e-remove', x + 30 + bw + 16, by, bw, 110, armed ? 'Tap again to remove' : 'Remove', () => {
                if (armed) removeSource(s.id); else edit.armed = Date.now();
            }, (px, py) => {
                const c = armed ? '#ffffff' : t.crit;
                cv.fillRect(px - 16, py - 16, 32, 4, c); cv.strokeRoundRect(px - 12, py - 10, 24, 30, 4, 3, c);
            }, armed ? { solid: G.withAlpha(t.crit, 0.85), fg: '#ffffff' } : null);
            action(cv, t, 'e-close', x + 30 + 2 * (bw + 16), by, bw, 110, 'Close', () => { edit = null; }, (px, py) => {
                cv.line(px - 13, py - 13, px + 13, py + 13, 4, t.text); cv.line(px + 13, py - 13, px - 13, py + 13, 4, t.text);
            });
        }

        /** The guide: about 2 hours (from 20 min ago), a now-line, the families as filters; tap a row to tune. */
        function drawGuide(cv, t, A) {
            const on = t.accent2 || t.accent, hy = A.y, cyH = hy + HEAD_H / 2;
            const bw = backButton(cv, t, A, 'Watch', () => go('watch'));
            cv.text('GUIDE', A.x + bw + 28, cyH + 11, 30, t.text, { font: 'bold', spacing: 1.5, literal: true });
            // the filters
            const fams = [{ id: '', name: 'All' }].concat(luState === 'ok' ? lineup.families() : []);
            let fx = A.x + bw + 160;
            const fo = { font: 'bold', spacing: 1, literal: true };
            fams.forEach((f) => {
                const w = cv.textWidth(f.name.toUpperCase(), 16, fo) + 40, sel = guideFam === f.id, key = 'fam:' + f.id;
                if (fx + w > A.right) return;
                cv.roundRect(fx, hy + 8, w, HEAD_H - 16, (HEAD_H - 16) / 2, sel ? on : G.withAlpha('#ffffff', isDown(key) ? 0.2 : 0.07));
                cv.text(f.name.toUpperCase(), fx + w / 2, cyH + 6, 16, sel ? '#000000' : t.text, Object.assign({ align: 'center' }, fo));
                FS.button(cv, key, fx, hy + 8, w, HEAD_H - 16, () => { downKey = key; downAt = Date.now(); guideFam = f.id; guideScroll = 0; }, { slop: 6, r: (HEAD_H - 16) / 2 });
                fx += w + 10;
            });
            const top = hy + HEAD_H + 14, CW = 330, TX = A.x + CW + 8, TW = A.right - TX;
            const now = Date.now(), from = now - 20 * 60000, to = from + 2 * 3600000;
            const px = (ms) => TX + (ms - from) / (to - from) * TW;
            // the time scale: relative to now (the car's time zone is not known to apps)
            const sy = top + 22;
            [0, 30, 60, 90].forEach((m) => {
                const x = px(now + m * 60000);
                cv.text(m ? '+' + m + ' min' : 'NOW', x + 6, sy, 16, m ? t.dim : on, { font: 'bold', spacing: 1, literal: true });
                if (m) cv.fillRect(x, sy - 16, 1, 20, G.withAlpha('#ffffff', 0.2));
            });
            const list = luState === 'ok' ? lineup.channels.filter((c) => !guideFam || c.family === guideFam) : [];
            const box = { x: A.x, y: sy + 12, w: A.right - A.x, h: A.bottom - (sy + 12) };
            L.guide = box;
            if (!list.length) {
                cv.text(luState === 'ok' ? 'No channels in this group' : statusLine(), A.x + box.w / 2, box.y + box.h / 2, 26, t.dim, { align: 'center', literal: true });
                return;
            }
            const ROW_H = 74, total = list.length * ROW_H;
            guideScroll = Math.max(0, Math.min(guideScroll, total - box.h));
            const tuned = src && src.kind === 'spelunkr' ? chId : '';
            if (cv.clip) cv.clip(box.x, box.y, box.w, box.h);
            list.forEach((c, i) => {
                const y = box.y + i * ROW_H - guideScroll;
                if (y + ROW_H < box.y || y > box.y + box.h) return;
                const rh = ROW_H - 6, vis = { x: box.x, y: Math.max(y, box.y), w: box.w, h: Math.min(y + rh, box.y + box.h) - Math.max(y, box.y) };
                if (vis.h <= 0) return;
                L.rows.push({ x: vis.x, y: vis.y, w: vis.w, h: vis.h, id: c.id });
                const sel = c.id === tuned;
                cv.roundRect(A.x, y, CW, rh, 12, sel ? G.withAlpha(on, 0.22) : G.withAlpha('#ffffff', 0.06));
                if (sel) cv.strokeRoundRect(A.x, y, CW, rh, 12, 2, on);
                cv.text(String(c.dial), A.x + 66, y + rh / 2 + 10, 28, t.text, { font: 'num', align: 'right', literal: true });
                logo(cv, c, A.x + 80, y + (rh - 44) / 2, 44);
                cv.text(fit(cv, c.name, 21, CW - 150, { font: 'bold' }), A.x + 138, y + rh / 2 + 8, 21, t.text, { font: 'bold', literal: true });
                const s = lineup.peek(c.id);
                if (!s) {
                    ensureSched(c.id);
                    cv.roundRect(TX, y, TW, rh, 10, G.withAlpha('#ffffff', 0.03));
                    cv.text(c.description ? fit(cv, c.description, 18, TW - 30) : 'Loading...', TX + 16, y + rh / 2 + 7, 18, t.dim, { literal: true });
                    return;
                }
                s.span(from, to).forEach((p) => {
                    const st = p.startMs, en = st + p.item.duration * 1000;
                    const x0 = Math.max(TX, px(st)), x1 = Math.min(TX + TW, px(en)) - 4;
                    if (x1 - x0 < 6) return;
                    const live = st <= now && now < en;
                    cv.roundRect(x0, y, x1 - x0, rh, 10, live ? G.withAlpha(c.color || on, 0.38) : G.withAlpha('#ffffff', 0.07));
                    if (x1 - x0 > 40) {
                        cv.text(fit(cv, p.item.title, 19, x1 - x0 - 24, { font: live ? 'bold' : undefined }), x0 + 12, y + 30, 19, t.text, { font: live ? 'bold' : undefined, literal: true });
                        const sub = live ? mins(en - now) + ' left' : st > now ? 'in ' + mins(st - now) : '';
                        if (sub && x1 - x0 > 90) cv.text(fit(cv, sub + (p.item.year ? '  \u00b7  ' + p.item.year : ''), 15, x1 - x0 - 24), x0 + 12, y + 54, 15, t.dim, { literal: true });
                    }
                });
            });
            if (cv.noclip) cv.noclip();
            // the now-line
            const nx = px(now);
            cv.fillRect(nx - 1, sy + 4, 3, A.bottom - sy - 4, on);
            tri(cv, [[nx - 7, sy + 2], [nx + 8, sy + 2], [nx, sy + 10]], on);
            if (total > box.h) {
                const bh = box.h * box.h / total, by = box.y + (box.h - bh) * guideScroll / (total - box.h);
                cv.roundRect(A.right - 5, by, 5, bh, 2, G.withAlpha('#ffffff', 0.3));
            }
        }

        /** Add source (or edit one): the QR code, the 6-digit code, then "Waiting for your phone...". */
        function drawAdd(cv, t, A) {
            const on = t.accent2 || t.accent, s = handoff.s;
            if (!s) { go('home'); return; }
            const S = Math.min(A.h, 400), box = { x: A.x, y: A.y + (A.h - S) / 2, s: S };
            if (!qrPic || qrPic.url !== s.url) qrPic = { url: s.url, qr: qrcodegen.QrCode.encodeText(s.url, qrcodegen.QrCode.Ecc.MEDIUM) };
            const qr = qrPic.qr, n = qr.size + 8, pl = cv.place;
            const k = pl ? pl.scale : 1;
            const dev = { x: box.x * k + (pl ? pl.ox : 0), y: box.y * k + (pl ? pl.oy : 0), s: box.s * k };
            const pxs = Math.max(2, Math.floor(dev.s / n)), side = n * pxs;
            const qx = Math.round(dev.x + (dev.s - side) / 2), qy = Math.round(dev.y + (dev.s - side) / 2);
            cv.roundRect(box.x, box.y, box.s, box.s, 16, '#ffffff');
            if (pl) cv.xf(1, 0, 0);
            const ux = pl ? qx : Math.round(box.x + (box.s - side) / 2), uy = pl ? qy : Math.round(box.y + (box.s - side) / 2);
            for (let y = 0; y < qr.size; y++) {
                let run = -1;
                for (let x = 0; x <= qr.size; x++) {
                    const dark = x < qr.size && qr.getModule(x, y);
                    if (dark && run < 0) run = x;
                    if (!dark && run >= 0) { cv.fillRect(ux + (4 + run) * pxs, uy + (4 + y) * pxs, (x - run) * pxs, pxs, '#000000'); run = -1; }
                }
            }
            if (pl) cv.xf();
            const X = box.x + S + 48, W = A.right - X, edit2 = s.mode.kind === 'edit';
            cv.text(fit(cv, edit2 ? 'Change ' + (s.mode.name || 'a source') : 'Add a source from your phone', 40, W, { font: 'bold' }), X, A.y + 50, 40, t.text, { font: 'bold', literal: true });
            let y = A.y + 108;
            const line = (num, str, c, size) => {
                size = size || 25;
                cv.circle(X + 18, y - 9, 18, G.withAlpha(on, 0.2)); cv.text(num, X + 18, y, 22, on, { font: 'bold', align: 'center', literal: true });
                cv.text(fit(cv, str, size, W - 54), X + 54, y, size, c || t.text, { literal: true });
                y += size + 22;
            };
            line('1', 'Scan this code with your phone\'s camera.');
            line('2', edit2 ? 'Type a new name and / or paste a new MP4 link.' : 'Type a name and paste a direct link to one MP4 file.');
            line('3', 'Tick the box and tap Send. The car checks the link.');
            y += 6;
            const host = (relay.replace(/^https:\/\//, '').replace(/#.*$/, '').replace(/\/+$/, '')) || '';
            cv.text(fit(cv, 'No camera? Open ' + host + ' and enter', 21, W), X, y, 21, t.dim, { literal: true });
            cv.text(handoff.codeText(), X, y + 56, 50, t.text, { font: 'num', spacing: 4, literal: true });
            y += 100;
            cv.circle(X + 10, y - 8, 7, handoff.message ? '#ffcc33' : on);
            cv.text(fit(cv, handoff.message || 'Waiting for your phone...  (' + Math.ceil(handoff.left() / 60000) + ' min)', 22, W - 30), X + 28, y, 22, handoff.message ? '#ffcc33' : t.text, { literal: true });
            const by = A.bottom - 72, bw = 240;
            action(cv, t, 'a-cancel', X, by, bw, 72, 'Cancel', () => { handoff.cancel(); go('home'); });
            action(cv, t, 'a-new', X + bw + 16, by, bw, 72, 'New code', () => { handoff.start(s.mode); qrPic = null; });
        }

        /** The phone's source, checked by the car: Save to Home / Send another / Cancel. */
        function drawConfirm(cv, t, A) {
            const on = t.accent2 || t.accent, c = conf;
            if (!c) { go('home'); return; }
            const colW = Math.round((A.w - 40) * 0.5), X = A.x, RX = A.x + colW + 40, RW = A.right - RX;
            const lbl = (s, x, yy) => cv.text(s.toUpperCase(), x, yy, 16, t.dim, { font: 'bold', spacing: 1.5, literal: true });
            lbl(c.mode === 'edit' ? 'Change from your phone' : 'From your phone', X, A.y + 22);
            cv.text(fit(cv, c.name || '(no name)', 38, colW, { font: 'bold' }), X, A.y + 70, 38, t.text, { font: 'bold', literal: true });
            lbl('Link', X, A.y + 116);
            if (c.same) cv.text('Unchanged', X, A.y + 150, 22, t.text, { literal: true });
            else {
                // the link by characters (it has no spaces), at most 4 lines
                const s = String(c.url || ''), o = { literal: true }, lines = [];
                let i = 0;
                while (i < s.length && lines.length < 4) {
                    let j = i + 1;
                    while (j < s.length && cv.textWidth(s.slice(i, j + 1), 20, o) <= colW) j++;
                    lines.push(s.slice(i, j)); i = j;
                }
                if (i < s.length) lines[3] = fit(cv, lines[3] + s.slice(i), 20, colW);
                lines.forEach((ln, k) => cv.text(ln, X, A.y + 148 + k * 28, 20, t.text, o));
            }
            cv.text(fit(cv, 'Only links to video you have the right to watch.', 18, colW), X, A.bottom - 96, 18, t.dim, { literal: true });

            lbl('Checked by the car', RX, A.y + 22);
            let y = A.y + 66;
            if (c.checking) cv.text('Checking the link...', RX, y, 24, t.text, { literal: true });
            const checks = c.res && c.res.checks ? c.res.checks : [];
            checks.forEach((k) => {
                cv.circle(RX + 14, y - 8, 13, k.ok ? '#2fd27a' : t.crit);
                if (k.ok) { cv.line(RX + 7, y - 8, RX + 12, y - 2, 3, '#000000'); cv.line(RX + 12, y - 2, RX + 21, y - 14, 3, '#000000'); }
                else { cv.line(RX + 9, y - 13, RX + 19, y - 3, 3, '#ffffff'); cv.line(RX + 19, y - 13, RX + 9, y - 3, 3, '#ffffff'); }
                cv.text(k.name, RX + 40, y, 22, t.text, { font: 'bold', literal: true });
                cv.text(fit(cv, k.text || '', 20, RW - 210), RX + 210, y, 20, t.dim, { literal: true });
                y += 44;
            });
            if (c.same && c.res) cv.text('Same link: no check needed', RX, y, 22, t.text, { literal: true });
            if (c.why) wrap(cv, c.why, 22, RW, 3).forEach((s) => { y += 4; cv.text(s, RX, y + 20, 22, t.crit, { literal: true }); y += 30; });
            const ok = !c.checking && c.res && c.res.ok && !c.why;
            const by = A.bottom - 76, bw = Math.floor((A.right - X - 32) / 3);
            action(cv, t, 'c-cancel', X, by, bw, 76, 'Cancel', () => confirmCancel());
            action(cv, t, 'c-again', X + bw + 16, by, bw, 76, 'Send another', () => {
                if (handoff.got) handoff.ack({ t: 'done', ok: false, error: 'Send another link.' });
                const m = handoff.s ? handoff.s.mode : { kind: 'add' };
                conf = null; handoff.cancel(); startAdd(m);
            });
            action(cv, t, 'c-save', X + 2 * (bw + 16), by, bw, 76, c.checking ? 'Checking...' : 'Save to Home', () => { if (ok) confirmSave(); else say(c.checking ? 'Still checking the link' : 'This link can\'t be saved'); },
                null, ok ? { solid: on, fg: '#000000' } : { fg: t.dim });
        }

        const SET_ROWS = [
            ['mode', 'Pictures', (v) => MODE_NAME[v] || v],
            ['maxFps', 'At most (GPU video)', (v) => v + ' fps'],
            ['theme', 'Colours', (v) => THEME_NAME[v] || v],
            ['renderer', 'Renderer', (v) => (v === 'software' ? 'Software (fallback)' : 'GPU')],
            ['afterDrive', 'After driving (Spelunkr)', (v) => AFTER_NAME[v] || AFTER_NAME.resume],
            ['cluster', 'Play in cluster (parked)', (v) => (v ? 'On' : 'Off')],
            ['hudtest', 'HUD test (30 s, parked)', (v) => (v ? 'On' : 'Off')],
            ['hud', 'Play in HUD (parked, experiment)', (v) => (v ? 'On' : 'Off')],
            ['paneltest', 'Full cluster test (30 s, parked)', (v) => (v ? 'On' : 'Off')],
            ['sidetest', 'Side panels test (30 s, parked)', (v) => (v ? 'On' : panelRan ? 'Off' : 'After the full test')],
        ];
        function drawSettings(cv, t, A) {
            const on = t.accent2 || t.accent, hy = A.y, cyH = hy + HEAD_H / 2;
            const back = () => go(setFrom === 'settings' ? 'home' : setFrom);
            const bw = backButton(cv, t, A, setFrom === 'home' ? 'Home' : 'TV', back);
            cv.text('SETTINGS', A.x + bw + 32, cyH + 11, 30, t.text, { font: 'bold', spacing: 1.5, literal: true });
            const gr = { x: A.right - GB_W, y: hy, w: GB_W, h: HEAD_H };
            cv.text(NAME + ' ' + VERSION + ' (experimental)', gr.x - 24, cyH + 7, 18, t.dim, { align: 'right', literal: true });
            gButton(cv, t, gr, true, 'g-set', () => press('g-set', back));

            const top = hy + HEAD_H + 24, colW = (A.right - A.x - 32) / 2, rx = A.x + colW + 32;
            const lbl = (s, x, yy) => cv.text(s.toUpperCase(), x, yy, 18, t.dim, { font: 'bold', spacing: 1.5, literal: true });
            lbl('Stream', A.x, top + 20);
            const inf = player.info();
            const c = src && src.kind === 'spelunkr' ? chan(chId) : null;
            const lines = [
                ['Watching', src ? (c ? 'CH ' + c.dial + ' ' + c.name + ' (Spelunkr)' : srcTitle()) : 'Nothing'],
                ['Video', inf.w ? 'H.264 ' + (inf.profile === 100 ? 'High' : inf.profile === 77 ? 'Main' : 'profile ' + inf.profile) + ', ' + inf.w + 'x' + inf.h + ', ' + inf.srcFps.toFixed(2) + ' fps' : '-'],
                ['Decoder', inf.decMs ? 'WebAssembly, ' + inf.decMs.toFixed(1) + ' ms a picture' + (inf.light ? ' (light)' : '') : 'WebAssembly (FFmpeg H.264)'],
                ['Output', pathName()],
                ['Cluster', settings.get('cluster') ? cluster.status(gateOpen, gateOpen && player.state === 'playing').text : 'Off (Play in cluster)'],
                ['HUD', settings.get('hud') || settings.get('hudtest') || panelKey() ? outLine() : 'Off (HUD test, Play in HUD, panel tests)'],
                ['Sound', 'None yet: no verified way for an app to play audio'],
                ['Sources', 'Spelunkr: the Internet Archive, no DRM. Mine: ' + store.list().length + ' of ' + Src.MAX_SOURCES],
            ];
            let y = top + 60;
            lines.forEach((l) => {
                cv.text(l[0].toUpperCase(), A.x + 4, y, 15, t.dim, { font: 'bold', spacing: 1.5, literal: true });
                cv.text(fit(cv, l[1], 22, colW - 150), A.x + 150, y, 22, l[0] === 'Sound' ? on : t.text, { literal: true });
                y += 46;
            });
            lbl('Settings', rx, top + 20);
            // two columns of rows (0.4.1: ten settings)
            const cols = 2, per = Math.ceil(SET_ROWS.length / cols), cg = 12, cw = (colW - cg) / cols;
            const rgap = 10, rh = Math.min(96, (A.bottom - (top + 36) - (per - 1) * rgap) / per);
            SET_ROWS.forEach((r, i) => {
                const cx = rx + Math.floor(i / per) * (cw + cg), yy = top + 36 + (i % per) * (rh + rgap), key = 'set:' + r[0];
                plate(cv, t, cx, yy, cw, rh, false, isDown(key));
                cv.text(fit(cv, r[1].toUpperCase(), 14, cw - 32, { font: 'bold', spacing: 1.2 }), cx + 16, yy + rh / 2 - 6, 14, t.dim, { font: 'bold', spacing: 1.2, literal: true });
                const ask = !!OUT[r[0]] && asking(r[0]);
                const off = r[0] === 'sidetest' && !panelRan && !settings.get(r[0]);
                cv.text(fit(cv, ask ? 'Tap again to turn on' : r[2](settings.get(r[0])), 22, cw - 32, { font: 'bold' }), cx + 16, yy + rh / 2 + 20, 22, ask ? '#ffcc33' : off ? t.dim : t.text, { font: 'bold', literal: true });
                FS.button(cv, key, cx, yy, cw, rh, () => { downKey = key; downAt = Date.now(); if (OUT[r[0]]) toggleOut(r[0]); else settings.cycle(r[0]); }, { slop: 4, r: 14 });
            });
        }

        // start: the home screen (or, with a test streamUrl in tv.json, that stream); the picture once the gate opens
        player.paused = true;
        loadLineup().then(() => { if (src && src.kind === 'spelunkr' && watching() && gateOpen && want) tune({ resume: true }); });
        gateStep();
        if (src && gateOpen && want && visible() && watching() && player.state === 'idle') tune({ resume: true });
        if (reopen) log.info('start: back to ' + (src.kind === 'spelunkr' ? 'Spelunkr ' + src.ch : 'my source') + ' (resumes once parked)');
    },
});
