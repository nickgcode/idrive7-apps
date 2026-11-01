'use strict';
/**
 * G's Dash - a driver display and car hub for the iDrive 7 (MGU) head unit, in seven looks.
 *
 *   - five screens, a horizontal swipe apart (page dots beside the G button, stopping at the ends):
 *     Showcase (the car, Spotify or a 12-hour clock, the logo) · Drive (the look's dash, below;
 *     the screen the app opens on) · Warm-up (oil / coolant, the warm-up rev limit) · G-force (peak hold, hold a finger down to
 *     reset) · Tires (TPMS pressure / temperature). hub.js draws all but Drive. A cold start opens
 *     Warm-up and goes back to Drive by itself once warm (a swipe cancels that).
 *   - the drive mode badge: FES.statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience
 *     (car.js), shown by every look (Eco Pro, Comfort, Comfort+, Sport, Sport+, Individual)
 *   - shift lights over the last 2000 rpm before your shift point, gear (from the gearbox, or learned
 *     from rpm / speed when the car sends none), rpm, speed, a live g-meter with session peaks
 *     (accel / brake / lateral), oil and coolant warm-up state; always mph and degrees F (green = ready)
 *   - looks (setting "look", look_*.js): each its own layout, type, gauges and tab style -
 *     Simple (the original), M Style, GT, Heritage, Flight, Digital '84, Sim Racing, Lumen, Pixel (0.7.0)
 *   - setting "panel": Spotify instead of the g-meter (music.js, G's Music's code shared in by the
 *     build): what plays, art, previous / play-pause / next, a bar to tap or drag; its own QR sign-in
 *   - a hidden diagnostics page (tap "G's Dash <version>" in the Options header 5 times): the drive
 *     mode field's raw values as the car sends them, the TPMS raw values and the car's units, and
 *     what the head unit's catalog says (diag.js)
 *   - full screen, touch, GPU renderer (app.json "fullscreen": true): the G button opens Options
 *     (Theme, Engine & warm-up, G-meter & session, Spotify & cluster map); Theme has the looks as a
 *     gallery (each card drawn once in software into a picture, so the looks' big fonts don't fill the
 *     renderer's shared glyph texture) and the right panel. Shift lights always in the Race colours,
 *     Simple always in M Tricolour (0.6.0 took those settings out). No demo data.
 *   - a home-screen widget (app.json startWidget): the G logo, large and centred (widget_logo.js).
 *   - Options > Cluster map (cluster.js): CarPlay's map on the instrument cluster, on / off, through the
 *     separately installed "Waze on cluster" tool's patch service. Off unless the tool is installed and
 *     the user turns it on (with a confirmation); G's Dash stores nothing for it.
 *
 * Built on the idrive7-apps kit (kit/runtime). Node 8: no optional chaining, no ?? and no object spread.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { Canvas } = require('./kit/canvas');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const record = require('./kit/record');
const PNG = require('./kit/png');
const HUB = require('./hub');
const LOGO = require('./widget_logo');
const L = require('./lib');
const Music = require('./music').Music;
const DIAG = require('./diag');
const ClusterMap = require('./cluster').ClusterMap;
const Fuel = require('./fuel');

const LOOKS = [require('./look_simple'), require('./look_m'), require('./look_gt'),
    require('./look_heritage'), require('./look_flight'), require('./look_digital'), require('./look_simracing'),
    require('./look_lumen'), require('./look_pixel')];
const lookOf = (id) => LOOKS.find((l) => l.id === id) || LOOKS[0];

const MPH = 1.609344;
const TRAIL_MS = 3000;
const OIL_READY_F = 194, COOLANT_READY_F = 176, HYST_F = 4;
const VERSION = '0.7.0';
// Warm-up: the rev limit is COLD_RPM at or below COLD_F oil, rising (250 rpm steps) to WARM_REDLINE at
// the "oil temp for full revs" setting. Auto-jump: AUTO_MS after READY it opens Drive.
const COLD_RPM = 4000, COLD_F = 104, WARM_REDLINE = 6000, OIL_FULL_F = 180, AUTO_MS = 5000;
const HIST_MS = 20000, HIST_N = 80, ENV_N = 48;                  // G-force: last 20 s, the peak envelope
const SWIPE_START = 40, SWIPE_GO = 110, HOLD_MS = 700, HOLD_SLOP = 24;
const IMG = { car: 0x6701, logo: 0x6702, card: 0x6710 };        // record.setImage ids (cards: + look index)
const toF = (c) => (L.isNum(c) ? c * 9 / 5 + 32 : c);

// content box: full screen from page y BOX_OWN to the page's bottom (G.pageBottom), else BOX_STD + BOX_H.
// The renderer's touch area starts at screen y 76 (about page y 22 here: the HMI keeps the strip above
// for its pull-down), so nothing to tap sits higher than BOX_OWN.
const BOX_OWN = 40, BOX_STD = 52, BOX_H = 456;
// the G button (full screen): opens the settings; GB_W x GB_H page px in the content's bottom-right
// corner (~126 x 89 screen px), every look keeps that corner free. The Options pages' header row:
// Back (to the dash) at the left, the G (lit) at the right, page y HEAD_Y .. HEAD_Y + HEAD_H.
const GB_W = 108, GB_H = 76, HEAD_Y = 40, HEAD_H = 64, SET_Y = 118;

/* Options page rows (stepped with - / +): key, label, value text */
const ENGINE = [
    ['redline', 'Redline', (v) => v + ' rpm'],
    ['shiftBefore', 'Shift point, before redline', (v) => (Number(v) ? v + ' rpm' : 'At redline')],
    ['oilFullRevs', 'Oil temp for full revs', (v) => v + ' °F'],
    ['oilReady', 'Oil ready', (v) => v + ' °F'],
    ['coolantReady', 'Coolant ready', (v) => v + ' °F'],
];
const GSCALE = ['gScale', 'G-meter scale', (v) => Number(v).toFixed(1) + ' g'];
// fixed since 0.6.0 (the settings went): the shift lights' Race colours, the Simple look's M Tricolour
const LIGHT_STYLE = 'f1';
const TAPS = 5, TAP_MS = 3000;          // the diagnostics page: taps on the version in the Options header

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        // car data only: no demo feed (opts.demo false), a value not sent shows '--'
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'accel', 'gear', 'drivemode', 'tpms', 'units'], { demo: false });
        L.loadFonts(log);
        // the fuel level and range (fuel.js): only for the Drive page's 'Bottom bars: Fuel' choice
        const fuel = new Fuel();
        fuel.watch(ctx, log);

        const look = () => lookOf(settings.get('look'));
        const palette = () => { const l = look(); return typeof l.palette === 'function' ? l.palette(settings) : l.palette; };
        // the kit's own parts (header, the controller's marks) in the look's colours
        if (ctx.setTheme) ctx.setTheme(palette);
        settings.onChange((k) => { if (k === 'look' && ctx.setTheme) ctx.setTheme(palette); });

        let peak = null, since = Date.now(), env = [], hist = [], gSeen = false, sessionAt = 0;
        const SESSION_FLASH_MS = 450;
        const trail = [];
        const reset = () => {
            peak = { rpm: 0, speed: 0, acc: 0, brk: 0, lat: 0, left: 0, right: 0 }; trail.length = 0; since = Date.now();
            env = []; for (let i = 0; i < ENV_N; i++) env.push(0);
            hist = []; gSeen = false;
        };
        reset();
        car.onSample((d, t) => {
            if (L.isNum(d.rpm)) peak.rpm = Math.max(peak.rpm, d.rpm);
            if (L.isNum(d.speed)) peak.speed = Math.max(peak.speed, d.speed);
            // a road car cannot pull more than ~3 g: anything above is a bad sample
            if (L.isNum(d.gLong) && L.isNum(d.gLat) && Math.abs(d.gLong) < 3 && Math.abs(d.gLat) < 3) {
                peak.acc = Math.max(peak.acc, d.gLong);
                peak.brk = Math.max(peak.brk, -d.gLong);
                peak.lat = Math.max(peak.lat, Math.abs(d.gLat));
                // right / left as the g-meter draws them (+lat to the right)
                peak.right = Math.max(peak.right, d.gLat); peak.left = Math.max(peak.left, -d.gLat);
                const mag = Math.sqrt(d.gLat * d.gLat + d.gLong * d.gLong);
                if (mag > 0.02) {
                    let a = Math.atan2(d.gLat, d.gLong); if (a < 0) a += 2 * Math.PI;
                    const k = Math.round(a / (2 * Math.PI) * ENV_N) % ENV_N;
                    env[k] = Math.max(env[k], mag);
                }
                gSeen = true;
                trail.push([t, d.gLat, d.gLong]);
                while (trail.length && t - trail[0][0] > TRAIL_MS) trail.shift();
            }
        }, reset);
        ui.onClick('BTN_RESET', () => { reset(); log.info('peaks reset'); });

        const speedOf = (kmh) => (L.isNum(kmh) ? kmh / MPH : kmh);          // always mph
        const num = (k, dflt) => { const v = Number(settings.get(k)); return isFinite(v) && v > 0 ? v : dflt; };
        const ready = { oil: false, coolant: false };
        const warm = (key, f, thr) => {
            if (!L.isNum(f)) return null;
            ready[key] = ready[key] ? f >= thr - HYST_F : f >= thr;
            return ready[key];
        };

        // the page: 0 = the hub (screen scr: HUB.SCREENS), 1 = Options (the G), 2 = Spotify, 3 = diagnostics,
        // 4 = Cluster map, 5 = Theme (2..5 go back to Options); the
        // bar's Reset moves to the settings page (no bar: the page reaches the screen's bottom)
        let page = 0, armed = 0, gDown = 0, downKey = '';
        const SCR = (id) => HUB.SCREENS.findIndex((x) => x[0] === id);
        let scr = SCR(HUB.HOME);                 // the hub screen (HUB.SCREENS index): Drive, not index 0
        const go = (i) => { scr = i; };
        if (ctx.hideButton) ctx.hideButton('BTN_RESET');
        // the dash again: Back on Options, the G there, the controller pushed left (ctx.onBack), and
        // whenever the screen is left (the HMI's back arrow / BACK closes it; it comes back on the hub)
        const toDash = () => { if (page === 0) return false; if (ask) { ask = null; return true; } page = page >= 2 ? 1 : 0; return true; };
        if (ctx.onBack) ctx.onBack(toDash);
        if (ui.onVisible) ui.onVisible((st, on) => { if (!on) { page = 0; taps = []; ask = null; } });
        // settings 0.4.0 had and 0.5.0 dropped (demo, layout, renderer, speedUnit, spotifyPoll, showBadge),
        // and 0.6.0's (lights: the Race colours, LIGHT_STYLE; theme: Simple in M Tricolour, look_simple.js)
        // are app.json "retiredSettings": the kit deletes saved values for them at start (mgu.js Settings)
        /** A press on the G (or Back): shown pressed for a moment, then the page changes. */
        const press = (to, key) => { gDown = Date.now(); downKey = key; setTimeout(() => { page = to; }, 140); };
        const isDown = (key) => downKey === key && Date.now() - gDown < 180;

        // Spotify (setting "panel"): polled only while the panel or its page is on screen
        const visible = () => (ui.isVisible ? ui.isVisible('MAIN') : true);
        // the Cluster map (cluster.js): the patch service's socket only while its page is open, apply /
        // revert only from the confirmation (ask: { cmd, at }, it goes after ASK_MS)
        const cmap = new ClusterMap(log);
        let ask = null;
        const ASK_MS = 20000;
        const panelOn = () => settings.get('panel') === 'spotify';
        let ownNow = false;
        const musicOnHub = () => {
            const id = HUB.SCREENS[scr][0];
            return id === 'showcase' || (panelOn() && ((id === 'drive' && !!look().panelRect) || id === 'gforce'));
        };
        const music = new Music(ctx, {
            shown: () => visible() && ((page === 0 && musicOnHub()) || page === 2),
            qrShown: () => visible() && ownNow && page === 2,
            openPage: () => press(2, 'sp:signin'),
        });
        /*
         * Touch on the hub: the Spotify bar's drag first (music.touch), then a horizontal swipe changes the
         * screen (more than SWIPE_START px mostly sideways to start, SWIPE_GO px on release; it stops at the
         * ends), and on G-force a finger held still HOLD_MS resets the peaks. Taking the gesture (true)
         * keeps the kit's tap targets from firing under a swipe or a hold.
         */
        let sw = null, toastMsg = null, autoJump = null, userSwiped = false, coldChecked = false, holdT = null;
        const say = (text, sub) => { toastMsg = { text, sub: sub || '', at: Date.now() }; };
        const endHold = () => { if (holdT) { clearTimeout(holdT); holdT = null; } };
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            if (page !== 0) { sw = null; endHold(); return false; }
            if (musicOnHub() && music.touch(phase, x, y)) { sw = null; endHold(); return true; }
            if (phase === 1) {
                sw = { x0: x, y0: y, on: false, held: false };
                endHold();
                if (HUB.SCREENS[scr][0] === 'gforce' && !(gRectNow && x >= gRectNow.x && y >= gRectNow.y)) {
                    holdT = setTimeout(() => {
                        holdT = null;
                        if (sw && !sw.on && page === 0 && HUB.SCREENS[scr][0] === 'gforce') { sw.held = true; reset(); log.info('peaks reset (long press)'); say('Peaks reset'); }
                    }, HOLD_MS);
                }
                return false;
            }
            if (!sw) return false;
            const dx = x - sw.x0, dy = y - sw.y0;
            if (Math.abs(dx) > HOLD_SLOP || Math.abs(dy) > HOLD_SLOP) endHold();
            if (phase === 2) {
                if (!sw.on && Math.abs(dx) > SWIPE_START && Math.abs(dx) > 1.5 * Math.abs(dy)) sw.on = true;
                return sw.on || sw.held;
            }
            // phase 3
            const was = sw; sw = null; endHold();
            if (was.on && Math.abs(dx) > SWIPE_GO) {
                const to = Math.max(0, Math.min(HUB.SCREENS.length - 1, scr + (dx < 0 ? 1 : -1)));
                if (to !== scr) { go(to); userSwiped = true; autoJump = null; }
            }
            return was.on || was.held;
        });
        // the diagnostics page: TAPS taps on "G's Dash <version>" in the Options header within TAP_MS
        let taps = [], verRect = null;
        if (ctx.onTap) ctx.onTap((x, y) => {
            const r = verRect;
            if (page !== 1 || !r || x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) { taps = []; return; }
            const now = Date.now();
            taps = taps.filter((t) => now - t < TAP_MS).concat([now]);
            if (taps.length >= TAPS) { taps = []; DIAG.reset(); page = 3; log.info('diagnostics page'); }
        });

        /** Everything a look draws from, for this frame. */
        function state(cv, t, reach) {
            const d = car.data(), now = Date.now();
            const redline = num('redline', 6500), shift = redline - (Number(settings.get('shiftBefore')) || 0);
            const oil = toF(d.oil), cool = toF(d.coolant);
            const oilThr = num('oilReady', OIL_READY_F), coolThr = num('coolantReady', COOLANT_READY_F);
            const strobe = L.isNum(d.rpm) && d.rpm >= shift;
            return {
                t, own: !!cv.own, x: 12, y: cv.own ? BOX_OWN : BOX_STD, w: 1576, h: cv.own ? reach - BOX_OWN - 6 : BOX_H, now,
                rpm: d.rpm, speed: speedOf(d.speed), unit: 'MPH', imperial: true, speedMax: 180,
                gear: d.gear, stage: d.stage, guessed: !!d.gearGuessed, gearText: L.gearText(d.gear, d.stage),
                redline, shift, range: 2000, maxRpm: Math.ceil((redline + 500) / 1000) * 1000,
                strobe, blink: Math.floor(now / 120) % 2 === 0, lightStyle: LIGHT_STYLE,
                gLat: d.gLat, gLong: d.gLong, gMax: Number(settings.get('gScale')) || 1.5,
                trail: trail.map((p) => [p[1], p[2]]),
                peak: { acc: peak.acc, brk: peak.brk, lat: peak.lat, rpm: peak.rpm, speed: speedOf(peak.speed) },
                oil: { f: oil, thr: oilThr, ok: warm('oil', oil, oilThr) },
                cool: { f: cool, thr: coolThr, ok: warm('coolant', cool, coolThr) },
                demo: false, session: now - since,
                // a tap on a look's session clock (L.sessionTap): that clock back to 0:00 (the peaks stay), a flash
                sessionTap: cv.own ? () => { since = Date.now(); sessionAt = since; log.info('session clock reset (tap)'); } : null,
                sessionFlash: sessionAt && now - sessionAt < SESSION_FLASH_MS ? 1 - (now - sessionAt) / SESSION_FLASH_MS : 0,
                panel: settings.get('panel') === 'spotify' ? 'spotify' : 'g',
                // the Drive page's bottom bars: oil & coolant, or the fuel level (Warm-up always shows oil & coolant)
                bars: settings.get('bars') === 'fuel' ? 'fuel' : 'temps', fuel: fuel.state(),
                // the drive mode badge: a label only when the car sent a mode we could read (car.js MODE_LABEL)
                mode: d.driveMode || null, modeTone: L.modeTone(d.driveMode || null),
                d,
            };
        }

        /* ---------- the hub screens' data (hub.js) ---------- */
        // oil temperature history for the warm-up estimate: [t, degF], the last few minutes
        const oilHist = [];
        setInterval(() => {
            const d = car.data(), now = Date.now(), f = toF(d.oil);
            if (L.isNum(f)) { oilHist.push([now, f]); while (oilHist.length && now - oilHist[0][0] > 180000) oilHist.shift(); }
            // G-force history: combined g every HIST_MS / HIST_N, a gap (null) when nothing came
            const ok = L.isNum(d.gLat) && L.isNum(d.gLong) && Math.abs(d.gLat) < 3 && Math.abs(d.gLong) < 3;
            hist.push(ok ? Math.sqrt(d.gLat * d.gLat + d.gLong * d.gLong) : null);
            while (hist.length > HIST_N) hist.shift();
        }, HIST_MS / HIST_N);
        const eta = (f, thr) => {
            if (!L.isNum(f)) return 'No data';
            if (f >= thr) return 'Ready';
            if (oilHist.length < 2) return 'Warming up';
            const a = oilHist[0], b = oilHist[oilHist.length - 1], span = (b[0] - a[0]) / 1000, rate = span >= 30 ? (b[1] - a[1]) / span : 0;
            if (!(rate > 0.01)) return 'Warming up';
            const min = Math.ceil((thr - f) / rate / 60);
            return min <= 1 ? 'Almost there' : '~' + min + ' min to ready (est.)';
        };
        const fullRevsAt = () => num('oilFullRevs', OIL_FULL_F);
        /** The warm-up rev limit for an oil temperature (degF): null when there is none. */
        const revLimit = (oil) => {
            if (!L.isNum(oil)) return null;
            const full = fullRevsAt();
            if (oil >= full) return WARM_REDLINE;
            const f = Math.max(0, Math.min(1, (oil - COLD_F) / Math.max(1, full - COLD_F)));
            return Math.floor((COLD_RPM + (WARM_REDLINE - COLD_RPM) * f) / 250) * 250;
        };
        function warmModel(S) {
            const oil = L.isNum(S.oil.f) ? S.oil.f : null, cool = L.isNum(S.cool.f) ? S.cool.f : null;
            const ready = S.oil.ok === true && S.cool.ok === true;
            return {
                oil, cool, oilReady: S.oil.thr, coolReady: S.cool.thr, fullAt: fullRevsAt(), limit: revLimit(oil), ready,
                oilEta: eta(oil, S.oil.thr), coolEta: cool === null ? 'No data' : cool >= S.cool.thr ? 'Ready' : 'Warming up',
                auto: !!autoJump,
                countdown: autoJump && autoJump.readyAt ? Math.max(0, Math.ceil((AUTO_MS - (Date.now() - autoJump.readyAt)) / 1000)) : 5,
            };
        }
        const mmss = (ms) => { const s2 = Math.floor(ms / 1000); return Math.floor(s2 / 60) + ':' + (s2 % 60 < 10 ? '0' : '') + (s2 % 60); };
        function gModel(S) {
            // the envelope: per direction the furthest reach, widened a little to its neighbours (a hull)
            const e = [];
            for (let i = 0; i < ENV_N; i++) {
                let m = 0;
                for (let k = -3; k <= 3; k++) { const j = (i + k + ENV_N) % ENV_N, c = Math.cos(k * 2 * Math.PI / ENV_N); m = Math.max(m, env[j] * c); }
                e.push(m);
            }
            const h = hist.slice();
            while (h.length < HIST_N) h.unshift(null);
            return {
                lat: L.isNum(S.gLat) ? S.gLat : null, long: L.isNum(S.gLong) ? S.gLong : null, trail: S.trail, envelope: e, history: h,
                session: mmss(S.session), live: gSeen, peak: { acc: peak.acc, brk: peak.brk, left: peak.left, right: peak.right },
            };
        }
        function tireModel(S) {
            const ty = S.d.tyres || null, now = Date.now(), M = { tires: {} };
            [['fl', 'FLH'], ['fr', 'FRH'], ['rl', 'RLH'], ['rr', 'RRH']].forEach((w) => {
                const g = (o) => (ty && o && L.isNum(o[w[1]]) ? o[w[1]] : null);
                M.tires[w[0]] = { p: g(ty && ty.p), t: g(ty && ty.t), target: g(ty && ty.target) };
            });
            const any = ty && ty.at && Object.keys(M.tires).some((k) => M.tires[k].p !== null || M.tires[k].t !== null);
            M.fresh = any ? 'TPMS  /  updated ' + Math.max(0, Math.round((now - ty.at) / 1000)) + ' s ago' : 'TPMS  /  no data yet';
            return M;
        }

        // auto-jump: a cold start (the first oil reading, within the first minute, below "oil ready")
        // opens Warm-up; once READY, Drive opens AUTO_MS later with a toast. A swipe cancels it.
        const bootAt = Date.now();
        function autoStep(S) {
            const now = Date.now();
            if (!coldChecked) {
                if (L.isNum(S.oil.f)) {
                    coldChecked = true;
                    if (S.oil.f < S.oil.thr && !userSwiped && now - bootAt < 60000) {
                        go(SCR('warmup')); autoJump = { readyAt: 0 };
                        log.info('cold start (oil ' + Math.round(S.oil.f) + '°F): Warm-up');
                    }
                } else if (now - bootAt > 60000) coldChecked = true;
            }
            if (!autoJump) return;
            if (userSwiped || page !== 0) { if (userSwiped) autoJump = null; return; }
            const ready = S.oil.ok === true && S.cool.ok === true;
            if (!ready) { autoJump.readyAt = 0; return; }
            if (!autoJump.readyAt) autoJump.readyAt = now;
            if (now - autoJump.readyAt >= AUTO_MS) {
                autoJump = null; go(SCR(HUB.HOME));
                say('Engine warm', 'Switched from Warm-up');
                log.info('warm: Drive');
            }
        }

        /** The G button: the G badge on a quiet plate, in the look's own style when it has one (lk.gButton). */
        function gButton(cv, t, lk, r, lit, down) {
            if (lk.gButton) { lk.gButton(cv, t, r, lit, down); return; }
            const rad = lk.ui.radius, acc = t.sel || t.accent;
            cv.roundRect(r.x, r.y, r.w, r.h, rad, down ? L.withAlpha(acc, 0.28) : lit ? L.withAlpha(acc, 0.16) : L.withAlpha('#ffffff', 0.04));
            cv.strokeRoundRect(r.x, r.y, r.w, r.h, rad, lit || down ? 2 : 1, lit || down ? acc : L.withAlpha('#ffffff', 0.12));
            const h = down ? 28 : 30, bw = L.badgeWidth(h);
            L.badge(cv, r.x + (r.w - bw) / 2, r.y + (r.h + h) / 2, h, lk.badgeLetter);
        }

        /** A page's header row: Back (left: to the dash from Options, else to Options), the page's name, the G lit (right: the dash). */
        function header(cv, S, lk, lbl, card, title, backTo) {
            const t = S.t, u = lk.ui, back = backTo || 0;
            const bx = S.x, bw = 210, by = HEAD_Y;
            card(cv, t, bx, by, bw, HEAD_H, isDown('back'));
            const cy = by + HEAD_H / 2;
            cv.line(bx + 36, cy - 11, bx + 24, cy, 3, t.text);
            cv.line(bx + 24, cy, bx + 36, cy + 11, 3, t.text);
            const bt = back ? 'Options' : 'Dash';
            cv.text(u.upper ? bt.toUpperCase() : bt, bx + 52, cy + 9, u.size + 4, t.text, { font: u.txt, spacing: u.upper ? u.spacing : 0, literal: true });
            cv.target(bx, by, bw, HEAD_H, () => press(back, 'back'), 'back', u.radius);
            lbl(title || 'Options', bx + bw + 32, cy + 11, 30, t.text);
            const gr = { x: S.x + S.w - GB_W, y: by, w: GB_W, h: HEAD_H };
            const ver = "G's Dash " + VERSION, vw = cv.textWidth(u.upper ? ver.toUpperCase() : ver, 16, { font: u.lbl || u.txt, spacing: u.upper ? u.spacing : 0, literal: true });
            lbl(ver, gr.x - 24, cy + 7, 16, t.dim, { align: 'right' });
            // no target (a tap there reaches ctx.onTap): the hidden way to the diagnostics page
            verRect = page === 1 ? { x: gr.x - 24 - vw - 16, y: by, w: vw + 32, h: HEAD_H } : null;
            gButton(cv, t, lk, gr, true, isDown('g-set'));
            cv.target(gr.x, gr.y, gr.w, gr.h, () => press(0, 'g-set'), 'g-set', u.radius);
        }

        /* ---------- Options (the G) and Theme ---------- */
        // the look gallery's card size: the same on Options (the current look) and Theme (all), so each
        // card is drawn once (cardImage)
        const TILE_W = 208, TILE_H = 190, ROW_H = 64, ROW_GAP = 19;
        const valueText = (u, s2) => (u.upper ? s2.toUpperCase() : s2);
        /** A chevron (>) at (x, y), size k. */
        const chevron = (cv, x, y, k, c) => { cv.line(x - k / 2, y - k, x + k / 2, y, 2.5, c); cv.line(x + k / 2, y, x - k / 2, y + k, 2.5, c); };
        /** A row's two lines: the setting (small, dim), its value (larger); sub: a dim note after the value. */
        function rowText(cv, S, lk, x, y, w, h, label, value, opts) {
            const t = S.t, u = lk.ui, o = opts || {};
            const lbl = lblOf(cv, u);
            lbl(label, x + 18, y + 24, Math.round(u.size * 0.72), t.dim);
            const vs = u.size + 2, vf = { font: u.txt, spacing: u.upper ? u.spacing * 0.6 : 0, literal: true };
            const v = fitText(cv, valueText(u, value), vs, w - 36, vf);
            cv.text(v, x + 18, y + h - 12, vs, o.warn ? t.crit : t.text, vf);
            if (o.sub) cv.text(valueText(u, o.sub), x + 18 + cv.textWidth(v, vs, vf) + 12, y + h - 13, 14, t.dim, { font: u.lbl || u.txt, spacing: u.upper ? u.spacing : 0, literal: true });
        }
        /**
         * A number setting as a row with - and + (each the row's full height, 76 page px wide, ~88 x 75
         * screen px): one step down / up the setting's steps (app.json), stopping at the ends.
         */
        function stepRow(cv, S, lk, x, y, w, h, row) {
            const t = S.t, u = lk.ui, card = cardOf(lk), key = row[0], it = settings.item(key) || {};
            const steps = it.steps || [], v = Number(settings.get(key));
            let i = steps.indexOf(v);
            if (i < 0) i = steps.reduce((b, s2, k) => (Math.abs(s2 - v) < Math.abs(steps[b] - v) ? k : b), 0);
            const bw = 76;
            card(cv, t, x, y, w, h, false);
            rowText(cv, S, lk, x, y, w - 2 * bw, h, row[1], row[2](settings.get(key)), { sub: it.markDefault && v === it.default ? 'default' : '' });
            [[-1, x + w - 2 * bw], [1, x + w - bw]].forEach((b) => {
                const to = i + b[0], ok = to >= 0 && to < steps.length, bx = b[1], cx = bx + bw / 2, cy = y + h / 2, k2 = 'st:' + key + (b[0] < 0 ? '-' : '+');
                cv.fillRect(bx, y + 12, 1, h - 24, L.withAlpha('#ffffff', 0.12));
                if (isDown(k2)) cv.roundRect(bx + 4, y + 4, bw - 8, h - 8, u.radius, L.withAlpha(t.sel || t.accent, 0.28));
                const c = ok ? t.text : L.withAlpha(t.dim, 0.4);
                cv.line(cx - 12, cy, cx + 12, cy, 3, c);
                if (b[0] > 0) cv.line(cx, cy - 12, cx, cy + 12, 3, c);
                if (ok) cv.target(bx, y, bw, h, () => { gDown = Date.now(); downKey = k2; settings.set(key, steps[to]); }, k2, u.radius);
            });
        }
        /** A row that opens a page: the label, its state line (tone: a dot in that colour), a chevron. */
        function linkRow(cv, S, lk, x, y, w, h, key, label, value, fn, tone) {
            const t = S.t, u = lk.ui;
            cardOf(lk)(cv, t, x, y, w, h, isDown(key));
            rowText(cv, S, lk, x + (tone ? 18 : 0), y, w - 48 - (tone ? 18 : 0), h, label, value);
            if (tone) cv.circle(x + 22, y + h - 20, 6, tone);
            chevron(cv, x + w - 26, y + h / 2, 9, t.dim);
            cv.target(x, y, w, h, fn, key, u.radius);
        }
        const clusterTone = (k) => (k === 'on' ? HUB.GREEN : k === 'pending' || k === 'busy' ? '#ffb020' : k === 'conflict' || k === 'error' ? '#ff3b30' : null);

        /**
         * Options (the G): three columns. Theme: the current look's card and the right panel, a tap
         * opens the Theme page. Engine & warm-up: five stepped rows. G-meter & session, then Spotify &
         * cluster map: the g-meter scale, the session peaks' reset (tap twice), the Spotify and Cluster
         * map pages. "G's Dash <version>" in the header: the hidden diagnostics page (TAPS taps).
         */
        function optionsPage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u), card = cardOf(lk), acc = t.sel || t.accent;
            header(cv, S, lk, lbl, card, 'Options');
            const x0 = S.x, top = S.y + 34, gap = 32, cw = (S.w - 2 * gap) / 3, ch = 4 * (ROW_H + ROW_GAP) + ROW_H;
            const slot = (k) => top + k * (ROW_H + ROW_GAP);
            // 1. Theme
            lbl('Theme', x0, S.y + 20, 18, t.dim);
            const down = isDown('opt:theme');
            card(cv, t, x0, top, cw, ch, down);
            const tx = x0 + (cw - TILE_W) / 2, ty = top + 22, li = LOOKS.indexOf(lk);
            const im = cardImage(lk, li, TILE_W, TILE_H, cv.textScale || 1);
            if (im) cv.image(im, tx, ty, TILE_W, TILE_H);
            cv.strokeRoundRect(tx, ty, TILE_W, TILE_H, 10, 1, L.withAlpha('#ffffff', 0.12));
            lbl('Look', x0 + 24, ty + TILE_H + 40, Math.round(u.size * 0.72), t.dim);
            cv.text(valueText(u, lk.name), x0 + 24, ty + TILE_H + 74, u.size + 6, t.text, { font: u.txt, spacing: u.upper ? u.spacing * 0.6 : 0, literal: true });
            lbl('Right panel', x0 + cw / 2 + 8, ty + TILE_H + 40, Math.round(u.size * 0.72), t.dim);
            cv.text(valueText(u, panelOn() ? 'Spotify' : 'G-meter'), x0 + cw / 2 + 8, ty + TILE_H + 74, u.size + 6, t.text, { font: u.txt, spacing: u.upper ? u.spacing * 0.6 : 0, literal: true });
            // the way in: a lit bar along the card's bottom
            const by = top + ch - 62;
            cv.roundRect(x0 + 16, by, cw - 32, 46, u.radius, L.withAlpha(acc, down ? 0.34 : 0.18));
            lbl('Change theme', x0 + 36, by + 31, u.size, t.text);
            chevron(cv, x0 + cw - 44, by + 23, 9, t.text);
            cv.target(x0, top, cw, ch, () => press(5, 'opt:theme'), 'opt:theme', u.radius);
            // 2. Engine & warm-up
            const x1 = x0 + cw + gap;
            lbl('Engine & warm-up', x1, S.y + 20, 18, t.dim);
            ENGINE.forEach((r, k) => stepRow(cv, S, lk, x1, slot(k), cw, ROW_H, r));
            // 3. G-meter & session; Spotify & cluster map
            const x2 = x1 + cw + gap;
            lbl('G-meter & session', x2, S.y + 20, 18, t.dim);
            stepRow(cv, S, lk, x2, slot(0), cw, ROW_H, GSCALE);
            const live = Date.now() - armed < 5000, ry = slot(1);
            card(cv, t, x2, ry, cw, ROW_H, false);
            rowText(cv, S, lk, x2, ry, cw - 170, ROW_H, live ? 'Tap again to confirm' : 'Session peaks', live ? 'Reset all peaks?' : 'All g and top peaks', { warn: live });
            const rb = { x: x2 + cw - 156, y: ry + 8, w: 144, h: ROW_H - 16 };
            if (live) { cv.roundRect(rb.x, rb.y, rb.w, rb.h, u.radius, L.withAlpha(t.crit || '#ff3b30', 0.3)); cv.strokeRoundRect(rb.x, rb.y, rb.w, rb.h, u.radius, 2, t.crit || '#ff3b30'); }
            else cv.roundRect(rb.x, rb.y, rb.w, rb.h, u.radius, L.withAlpha('#ffffff', 0.08));
            lbl(live ? 'Confirm' : 'Reset', rb.x + rb.w / 2, rb.y + rb.h / 2 + 8, u.size, live ? t.text : t.text, { align: 'center' });
            cv.target(x2, ry, cw, ROW_H, () => {
                if (Date.now() - armed < 5000) { armed = 0; reset(); log.info('peaks reset'); say('Peaks reset'); } else armed = Date.now();
            }, 'opt:reset', u.radius);
            lbl('Spotify & cluster map', x2, slot(3) - 14, 18, t.dim);
            linkRow(cv, S, lk, x2, slot(3), cw, ROW_H, 'opt:spotify', 'Spotify', music.statusLine(), () => press(2, 'opt:spotify'));
            const v = cmap.view();
            linkRow(cv, S, lk, x2, slot(4), cw, ROW_H, 'opt:cluster', 'Cluster map', v.value, () => { ask = null; press(4, 'opt:cluster'); }, clusterTone(v.kind));
        }

        /**
         * Theme: the looks as a gallery of cards, each drawn in its own look (a tap switches at once, the
         * page itself redraws in it), and the right panel on Drive: the g-meter and peaks, or Spotify.
         */
        function themePage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u), card = cardOf(lk), acc = t.sel || t.accent, cur = lk.id;
            header(cv, S, lk, lbl, card, 'Theme', 1);
            const x0 = S.x, top = S.y + 34, cols = 5, g = 14;
            lbl('Look', x0, S.y + 20, 18, t.dim);
            LOOKS.forEach((l, i) => {
                const cx = x0 + (i % cols) * (TILE_W + g), cy = top + Math.floor(i / cols) * (TILE_H + g), on = l.id === cur;
                // each card in its own look (background, motif, name in its own type): a picture drawn once
                // in software (cardImage), so the other looks' big fonts never reach the renderer's glyph texture
                const im = cardImage(l, i, TILE_W, TILE_H, cv.textScale || 1);
                if (im) cv.image(im, cx, cy, TILE_W, TILE_H);
                // the chosen one: a ring in this (the current) look's selection colour and a tick
                if (on) {
                    cv.strokeRoundRect(cx - 4, cy - 4, TILE_W + 8, TILE_H + 8, 14, 3, acc);
                    const kx = cx + TILE_W - 30, ky = cy + TILE_H - 32;
                    cv.circle(kx, ky, 14, acc);
                    cv.line(kx - 7, ky, kx - 2, ky + 6, 3, t.selText || '#ffffff');
                    cv.line(kx - 2, ky + 6, kx + 7, ky - 6, 3, t.selText || '#ffffff');
                } else cv.strokeRoundRect(cx, cy, TILE_W, TILE_H, 10, 1, L.withAlpha('#ffffff', 0.12));
                cv.target(cx, cy, TILE_W, TILE_H, () => { settings.set('look', l.id); }, 'look:' + l.id, 10);
            });
            // the right panel: two choices, the current one lit
            const px = x0 + cols * TILE_W + (cols - 1) * g + 40, pw = S.x + S.w - px, ph = 112;
            lbl('Right panel on Drive', px, S.y + 20, 18, t.dim);
            [['g', 'G-meter', 'Live g-meter and session peaks'], ['spotify', 'Spotify', 'What plays, with touch controls']].forEach((o, i) => {
                const oy = top + i * (ph + g), on = (panelOn() ? 'spotify' : 'g') === o[0];
                if (on) { cv.roundRect(px, oy, pw, ph, u.radius, L.withAlpha(acc, 0.22)); cv.strokeRoundRect(px, oy, pw, ph, u.radius, 3, acc); } else card(cv, t, px, oy, pw, ph, false);
                // a small glyph: rings for the g-meter, three bars for Spotify
                const gx = px + 52, gy = oy + ph / 2, c = on ? t.text : t.dim;
                if (o[0] === 'g') { cv.arc(gx, gy, 28, 30, 0, 360, c); cv.arc(gx, gy, 13, 15, 0, 360, c); cv.circle(gx + 9, gy - 6, 6, on ? acc : c); }
                else [[-14, 34], [0, 50], [14, 26]].forEach((b) => cv.roundRect(gx + b[0] - 4, gy - b[1] / 2, 8, b[1], 4, c));
                lbl(o[1], px + 104, oy + 56, u.size + 6, t.text);
                cv.text(fitText(cv, o[2], 18, pw - 124), px + 104, oy + 92, 18, t.dim, { literal: true });
                cv.target(px, oy, pw, ph, () => settings.set('panel', o[0]), 'panel:' + o[0], u.radius);
            });
            const ny = top + 2 * ph + g + 30;
            ['Spotify also shows on the G-force page.', 'Showcase always shows Spotify.'].forEach((l2, k) => {
                if (ny + k * 26 < S.y + S.h) cv.text(fitText(cv, l2, 18, pw), px, ny + k * 26, 18, t.dim, { literal: true });
            });
            // the Drive page's bottom bars: oil & coolant, or the fuel level (Warm-up keeps oil & coolant)
            const by = ny + 82, bh = 60, bw = (pw - g) / 2, cur2 = settings.get('bars') === 'fuel' ? 'fuel' : 'temps';
            lbl('Bottom bars on Drive', px, by - 18, 18, t.dim);
            [['temps', 'Oil & coolant'], ['fuel', 'Fuel']].forEach((o, i) => {
                const bx = px + i * (bw + g), on = cur2 === o[0];
                if (on) { cv.roundRect(bx, by, bw, bh, u.radius, L.withAlpha(acc, 0.22)); cv.strokeRoundRect(bx, by, bw, bh, u.radius, 3, acc); } else card(cv, t, bx, by, bw, bh, false);
                lbl(o[1], bx + bw / 2, by + bh / 2 + 8, u.size, on ? t.text : t.dim, { align: 'center' });
                cv.target(bx, by, bw, bh, () => settings.set('bars', o[0]), 'bars:' + o[0], u.radius);
            });
        }

        /*
         * A look's gallery card as a picture: recorded at the page's scale, played into a software canvas
         * at the pixels it is shown at (record.play), uploaded once (record.setImage). Redrawn only when
         * its size or scale changes.
         */
        const cards = {};
        function cardImage(l, i, cw, ch, sc) {
            const key = [Math.round(cw), Math.round(ch), sc].join('|');
            const id = IMG.card + i;
            if (cards[l.id] === key) return id;
            try {
                const lt = typeof l.palette === 'function' ? l.palette(settings) : l.palette;
                const r = new record.Recorder(Math.ceil(cw), Math.ceil(ch), { textScale: sc });
                if (l.cardBg) l.cardBg(r, lt, 0, 0, cw, ch); else r.roundRect(0, 0, cw, ch, 10, lt.bg);
                l.swatch(r, lt, 0, 6, cw, ch - 74);
                const nu = l.ui;
                const nm = nu.upper ? l.name.toUpperCase() : l.name, nsz = nu.nameSize || 26, nf = { font: nu.nameFont || nu.txt, spacing: nu.upper ? nu.spacing : 0, literal: true };
                const nw = r.textWidth(nm, nsz, nf), fs = nw > cw - 70 ? Math.max(16, Math.floor(nsz * (cw - 70) / nw)) : nsz;
                r.text(nm, 16, ch - 22, fs, lt.text, nf);
                const W = Math.min(1024, Math.round(cw * sc)), H = Math.min(1024, Math.round(ch * sc));
                const c = new Canvas(W, H);
                record.play(r.words(), c, W / cw);
                record.setImage(id, W, H, c.d);
                cards[l.id] = key;
            } catch (e) { log.warn('gallery card ' + l.id + ': ' + (e.stack || e)); cards[l.id] = key; }
            return id;
        }

        const lblOf = (cv, u) => (s, x, y, size, c, o) => cv.text(u.upper ? s.toUpperCase() : s, x, y, size, c, Object.assign({ font: u.lbl || u.txt, spacing: u.upper ? u.spacing : 0, literal: true }, o || {}));
        const cardOf = (lk) => lk.card || ((c, th, x, y, w, h, on) => {
            c.roundRect(x, y, w, h, lk.ui.radius, on ? L.withAlpha(th.sel || th.accent, 0.16) : L.withAlpha('#ffffff', 0.05));
            c.strokeRoundRect(x, y, w, h, lk.ui.radius, on ? 2.5 : 1, on ? th.sel || th.accent : L.withAlpha('#ffffff', 0.14));
        });

        /** The Spotify page: sign-in with the phone, state, refresh rate (music.js). */
        function spotifyPage(cv, S, lk) {
            header(cv, S, lk, lblOf(cv, lk.ui), cardOf(lk), 'Spotify', 1);
            music.page(cv, S, lk, { x: S.x, y: S.y, w: S.w - 0, h: S.h });
        }

        /**
         * The diagnostics page: per drive mode field what the car last sent (every member, raw), what
         * G's Dash made of it, and the head unit's catalog entries for it. Car data only: no demo, no
         * guesses; a field that sent nothing says so.
         */
        function diagPage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u);
            header(cv, S, lk, lbl, cardOf(lk), 'Diagnostics', 1);
            const dg = car.driveModeDiag(), cat = DIAG.catalog(log), now = Date.now();
            const mono = { font: 'num', literal: true }, F = 20, LH = 27;
            const colW = (S.w - 2 * 16) / 3, top = S.y;
            const box = (x, w) => { cv.roundRect(x, top, w, S.h, 8, L.withAlpha('#000000', 0.55)); cv.strokeRoundRect(x, top, w, S.h, 8, 1, L.withAlpha('#ffffff', 0.16)); };
            const put = (x, y, w, s, c, size) => cv.text(fitText(cv, s, size || F, w), x, y, size || F, c || t.text, { literal: true });
            const sub = dg.sub ? (dg.sub.error ? 'error: ' + dg.sub.error : dg.sub.available ? 'subscribed, available' : 'subscribed, not available') : 'not subscribed (yet)';
            // two columns: the fields
            Object.keys(dg.fields).forEach((f, i) => {
                const x = S.x + i * (colW + 16), w = colW, d = dg.fields[f];
                box(x, w);
                let y = top + 30;
                cv.text(f, x + 14, y, 19, t.accent2 || t.accent, { font: 'bold', literal: true }); y += 26;
                if (!d) {
                    put(x + 14, y, w - 28, 'nothing received yet', t.dim); y += LH;
                    put(x + 14, y, w - 28, 'FES ' + sub, t.dim);
                    return;
                }
                const age = Math.round((now - d.at) / 1000);
                put(x + 14, y, w - 28, 'decoded: ' + (d.mode || '(none)') + (d.from ? '  from .' + d.from : '') + (d.conflict ? '  (members disagree: not shown)' : ''), t.text, 19); y += LH + 4;
                put(x + 14, y, w - 28, 'updates: ' + d.count + '   last: ' + age + ' s ago', t.dim); y += LH + 6;
                cv.fillRect(x + 14, y - 12, w - 28, 1, L.withAlpha('#ffffff', 0.14));
                const rows = Math.floor((top + S.h - 10 - y) / LH);
                const mem = d.members || [];
                mem.slice(0, mem.length > rows ? rows - 1 : rows).forEach((m) => {
                    const val = typeof m[1] === 'string' ? '"' + m[1] + '"' : String(m[1]);
                    cv.text(fitText(cv, m[0] + ' = ' + val, F, w - 28, mono), x + 14, y, F, t.text, mono); y += LH;
                });
                if (mem.length > rows) put(x + 14, y, w - 28, '+ ' + (mem.length - rows + 1) + ' more (in the log)', t.dim);
            });
            // second column: TPMS as received (raw), the car's units, and what Tires shows from them
            {
                const x = S.x + (colW + 16), w = colW, td = car.tyreDiag(), u2 = td.units || {};
                box(x, w);
                let y = top + 30;
                cv.text('TPMS (raw)', x + 14, y, 19, t.accent2 || t.accent, { font: 'bold', literal: true }); y += 26;
                const tsub = td.sub ? (td.sub.error ? 'error: ' + td.sub.error : td.sub.available ? 'subscribed, available' : 'subscribed, not available') : 'not subscribed (yet)';
                put(x + 14, y, w - 28, 'TPMS ' + tsub, t.dim); y += LH;
                put(x + 14, y, w - 28, 'units: pressure ' + (u2.press || '?') + ', temp ' + (u2.temp || '?') + (u2.psiSeen ? ' (pressure unit guessed)' : ''), t.dim); y += LH;
                put(x + 14, y, w - 28, td.at ? 'last: ' + Math.round((now - td.at) / 1000) + ' s ago (polled every 10 s)' : 'nothing received yet', t.dim); y += LH + 6;
                cv.fillRect(x + 14, y - 12, w - 28, 1, L.withAlpha('#ffffff', 0.14));
                const raw = td.raw || {};
                Object.keys(raw).forEach((k) => {
                    if (y > top + S.h - 14) return;
                    const v = raw[k];
                    cv.text(fitText(cv, k + ' = ' + (v === undefined ? '-' : JSON.stringify(v)), F, w - 28, mono), x + 14, y, F, t.text, mono); y += LH;
                });
                const ty = car.data().tyres;
                if (ty && y <= top + S.h - 14) {
                    const sh = ['FLH', 'FRH', 'RLH', 'RRH'].map((p2) => p2 + ' ' + (L.isNum(ty.p[p2]) ? ty.p[p2].toFixed(1) + ' psi' : '--') + ' / ' + (L.isNum(ty.t[p2]) ? Math.round(ty.t[p2]) + '°F' : '--')).join('  ');
                    put(x + 14, y + 4, w - 28, 'shown: ' + sh, t.dim, 15);
                }
            }
            // third column: overall, subscription, catalog
            const x = S.x + 2 * (colW + 16), w = colW;
            box(x, w);
            let y = top + 30;
            cv.text('Drive mode (overall)', x + 14, y, 19, t.accent2 || t.accent, { font: 'bold', literal: true }); y += 26;
            put(x + 14, y, w - 28, 'shown: ' + (dg.mode || '(none: no single mode read)'), t.text, 19); y += LH + 2;
            put(x + 14, y, w - 28, 'FES: ' + sub, t.dim); y += LH + 2;
            put(x + 14, y, w - 28, 'Car data only. No demo, no estimates.', t.dim); y += LH + 12;
            cv.text('Catalog', x + 14, y, 19, t.accent2 || t.accent, { font: 'bold', literal: true }); y += 24;
            put(x + 14, y, w - 28, DIAG.CATALOG, t.dim, 15); y += LH;
            if (cat.status === 'reading') put(x + 14, y, w - 28, 'reading...', t.dim);
            else if (cat.status === 'error') { put(x + 14, y, w - 28, "couldn't read it: " + cat.error, t.warn || t.crit); }
            else {
                // long lines (an enum's values) wrap after a comma, indented
                const out = cat.wrapped && cat.wrapW === w ? cat.wrapped : [];
                if (out !== cat.wrapped) cat.lines.forEach((l) => {
                    const o = l[0] === 'row' ? mono : { literal: true };
                    let rest = l[1], first = true;
                    while (rest) {
                        let cut = rest.length;
                        while (cut > 0 && cv.textWidth(rest.slice(0, cut), 17, o) > w - 28) { const c = rest.lastIndexOf(', ', cut - 1); cut = c > 0 ? c + 1 : 0; }
                        if (cut <= 0) cut = rest.length;            // no comma to break at: cut short below
                        out.push([l[0], (first ? '' : '      ') + rest.slice(0, cut).replace(/^ +/, first ? rest.match(/^ */)[0] : '')]);
                        rest = rest.slice(cut).replace(/^ +/, ''); first = false;
                    }
                });
                cat.wrapped = out; cat.wrapW = w;
                const rows = Math.floor((top + S.h - 10 - y) / 22);
                out.slice(0, rows).forEach((l) => {
                    cv.text(fitText(cv, l[1], 17, w - 28, l[0] === 'row' ? mono : {}), x + 14, y, 17, l[0] === 'head' ? t.text : l[0] === 'warn' ? (t.warn || t.crit) : t.dim, l[0] === 'row' ? { font: 'num', literal: true } : { literal: true });
                    y += 22;
                });
                if (out.length > rows) put(x + 14, y - 2, w - 28, '+ ' + (out.length - rows) + ' more lines', t.dim, 15);
            }
        }
        /**
         * The Cluster map page: Off / On (the patch service's state, nothing stored here), its status
         * line, the map's line (when on), and what it needs. A change asks first (the confirmation, drawn
         * over the page; the page's own targets are left out meanwhile).
         */
        function clusterPage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u), card = cardOf(lk), acc = t.sel || t.accent;
            const mark = cv.targets ? cv.targets.length : 0;
            header(cv, S, lk, lbl, card, 'Cluster map', 1);
            const v = cmap.view(), x0 = S.x, top = S.y + 34, lw = 700;
            if (ask && (Date.now() - ask.at > ASK_MS || v.can !== ask.cmd)) ask = null;
            lbl('Cluster map', x0, S.y + 20, 18, t.dim);
            // the switch: two halves, the state's one lit; a tap on the other asks first
            const bw = (lw - 16) / 2, bh = 104;
            [[false, 'Off', 'revert'], [true, 'On', 'apply']].forEach((b, i) => {
                const bx = x0 + i * (bw + 16), on = v.on === b[0], tap = v.can === b[2];
                if (on) {
                    cv.roundRect(bx, top, bw, bh, u.radius, L.withAlpha(acc, 0.22));
                    cv.strokeRoundRect(bx, top, bw, bh, u.radius, 3, acc);
                } else card(cv, t, bx, top, bw, bh, false);
                const c = on ? t.text : tap ? t.text : L.withAlpha(t.dim, 0.55);
                cv.text(u.upper ? b[1].toUpperCase() : b[1], bx + bw / 2, top + bh / 2 + 15, 42, c, { font: u.txt, align: 'center', spacing: u.upper ? u.spacing : 0, literal: true });
                if (tap) cv.target(bx, top, bw, bh, () => { ask = { cmd: b[2], at: Date.now() }; }, 'cm:' + b[1].toLowerCase(), u.radius);
            });
            // status
            const sy = top + bh + 20, sh = S.y + S.h - sy;
            const tone = v.kind === 'on' ? HUB.GREEN : v.kind === 'pending' || v.kind === 'busy' ? '#ffb020' : v.kind === 'conflict' || v.kind === 'error' ? (t.crit || '#ff3b30') : t.dim;
            cv.roundRect(x0, sy, lw, sh, u.radius, L.withAlpha('#ffffff', 0.04));
            cv.strokeRoundRect(x0, sy, lw, sh, u.radius, 1, L.withAlpha('#ffffff', 0.12));
            cv.circle(x0 + 30, sy + 38, 9, tone);
            lbl(v.value, x0 + 52, sy + 48, 30, v.kind === 'none' || v.kind === 'checking' ? t.text : tone);
            let y = sy + 86;
            [[v.line, t.text], [v.render, t.dim], [v.note, t.dim]].forEach((l) => {
                if (!l[0] || y > sy + sh - 10) return;
                cv.text(fitText(cv, l[0], 20, lw - 48), x0 + 24, y, 20, l[1], { literal: true }); y += 34;
            });
            // what it needs
            const ix = x0 + lw + 40, iw = S.x + S.w - ix;
            lbl('About', ix, S.y + 20, 18, t.dim);
            const INFO = [
                ["CarPlay's map on the instrument cluster, drawn by the", t.text],
                ['Waze on cluster tool. G\'s Dash only switches it on or off.', t.text],
                ['', null],
                ['Needs: Waze on cluster from the Store (source', t.dim],
                ['robertnisipeanu/idrive-apps), and the cluster\'s Central', t.dim],
                ['display area set to Map view.', t.dim],
                ['A change takes effect when CarPlay restarts, usually at', t.dim],
                ['the next head-unit start. CarPlay may restart at once.', t.dim],
                ['Untested on most firmware: "Not supported" means the', t.dim],
                ['tool changed nothing.', t.dim],
                ['To undo: Off here, then restart the head unit; or remove', t.dim],
                ['Waze on cluster in the Store.', t.dim],
            ];
            let iy = top + 22;
            INFO.forEach((l) => { if (l[1]) cv.text(fitText(cv, l[0], 21, iw), ix, iy, 21, l[1], { literal: true }); iy += l[0] ? 31 : 12; });
            if (!ask) return;
            // the confirmation, over the page: only its two buttons take taps
            if (cv.targets) cv.targets.length = mark;
            cv.fillRect(0, S.y - 90, 1600, S.h + 120, L.withAlpha('#000000', 0.72));
            const on = ask.cmd === 'apply', cw = 900, ch = 300, cx = 800 - cw / 2, cy = S.y + (S.h - ch) / 2 - 20;
            cv.roundRect(cx, cy, cw, ch, u.radius + 4, t.bg);
            cv.strokeRoundRect(cx, cy, cw, ch, u.radius + 4, 2, '#ffb020');
            lbl(on ? 'Turn the cluster map on?' : 'Turn the cluster map off?', cx + 32, cy + 52, 30, t.text);
            [on ? 'The Waze on cluster tool patches CarPlay on the head unit.' : 'The Waze on cluster tool puts CarPlay back as stock.',
                'CarPlay may restart now: a call or music on CarPlay may drop.',
                'Otherwise it takes effect at the next head-unit start.'].forEach((l, i) => {
                cv.text(fitText(cv, l, 21, cw - 64), cx + 32, cy + 100 + i * 32, 21, i === 1 ? '#ffb020' : t.dim, { literal: true });
            });
            const bw2 = 300, bh2 = 76, by2 = cy + ch - bh2 - 22;
            card(cv, t, cx + 32, by2, bw2, bh2, false);
            lbl('Cancel', cx + 32 + bw2 / 2, by2 + 48, 26, t.text, { align: 'center' });
            cv.target(cx + 32, by2, bw2, bh2, () => { ask = null; }, 'cm:cancel', u.radius);
            const ox = cx + cw - 32 - bw2;
            cv.roundRect(ox, by2, bw2, bh2, u.radius, L.withAlpha(acc, 0.28));
            cv.strokeRoundRect(ox, by2, bw2, bh2, u.radius, 2.5, acc);
            lbl(on ? 'Turn on' : 'Turn off', ox + bw2 / 2, by2 + 48, 26, t.text, { align: 'center' });
            cv.target(ox, by2, bw2, bh2, () => {
                const a = ask; ask = null;
                // the state may have changed under the question: only what the switch still offers goes
                if (a && cmap.view().can === a.cmd) cmap.request(a.cmd);
            }, 'cm:confirm', u.radius);
        }
        function fitText(cv, s, size, w, o) {
            s = String(s);
            const opt = Object.assign({ literal: true }, o || {});
            if (cv.textWidth(s, size, opt) <= w) return s;
            let lo = 0, hi = s.length;
            while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, mid) + '...', size, opt) <= w) lo = mid; else hi = mid - 1; }
            return s.slice(0, lo) + '...';
        }

        // the Showcase pictures (app root PNGs, copied next to main.js by the build): decoded once
        const img = { car: null, logo: null };
        [['car', 'showcase_car.png'], ['logo', 'showcase_logo.png']].forEach((p) => {
            try {
                const im = PNG.decode(fs.readFileSync(path.join(__dirname, p[1])));
                record.setImage(IMG[p[0]], im.w, im.h, im.data);
                img[p[0]] = { id: IMG[p[0]], w: im.w, h: im.h };
            } catch (e) { log.warn('showcase picture ' + p[1] + ': ' + e.message); }
        });
        let gRectNow = null;
        log.info('clock: the head unit\'s local time, UTC offset ' + (-new Date().getTimezoneOffset() / 60) + ' h (12-hour on Showcase)');

        ctx.loop('MAIN', 10, () => {
            const lk = look(), t = palette();
            const cv = ctx.canvas(1600, 520);
            const reach = cv.own ? G.pageBottom(cv) : 520;        // reading cv.extra: the page reaches lower on screen
            cv.clear(t.bg);
            if (lk.background) lk.background(cv, t, reach);
            const S = state(cv, t, reach);
            G.frame(cv, t, cv.own ? [] : ["G's Dash"], 0, []);
            ownNow = !!cv.own;
            if (!cv.own) page = 0;
            autoStep(S);
            const P = Object.assign({}, S, { y: SET_Y, h: reach - SET_Y - 6 });
            // the patch service's socket: open only while the Cluster map page is on screen
            if (page === 4 && visible()) cmap.open(); else { cmap.close(); ask = null; }
            if (page === 1) optionsPage(cv, P, lk);
            else if (page === 2) spotifyPage(cv, P, lk);
            else if (page === 4) clusterPage(cv, P, lk);
            else if (page === 5) themePage(cv, P, lk);
            else if (page === 3) diagPage(cv, P, lk);
            else {
                const id = HUB.SCREENS[scr][0];
                // the G: the settings button, in the look's corner on Drive, bottom right elsewhere
                const corner = { x: S.x + S.w - GB_W, y: S.y + S.h - GB_H, w: GB_W, h: GB_H };
                const gr = id === 'drive' && lk.gRect ? lk.gRect(S) : corner;
                gRectNow = gr;
                const st = HUB.style(lk, t);
                music.band = null;
                if (id === 'drive') {
                    // a look without a panel place keeps its g-meter
                    if (!lk.panelRect) S.panel = 'g';
                    lk.draw(cv, S);
                    if (S.panel === 'spotify') music.panel(cv, S, lk, lk.panelRect(S), HUB.dotsBox(gr, HUB.SCREENS.length));
                } else if (id === 'showcase') HUB.showcase(cv, st, S, music, lk, gr, img, S.now);
                else if (id === 'warmup') HUB.warmup(cv, st, Object.assign({}, S, { redline: WARM_REDLINE, maxRpm: Math.max(7000, S.maxRpm) }), warmModel(S));
                else if (id === 'gforce') HUB.gforce(cv, st, S, gModel(S), S.panel === 'spotify' ? music : null, gr, lk);
                else if (id === 'tires') HUB.tires(cv, st, S, tireModel(S));
                HUB.dots(cv, st, gr, scr, HUB.SCREENS.length, id === 'drive' && !!lk.dotsAbove && S.panel !== 'spotify');
                if (toastMsg) {
                    const age = Date.now() - toastMsg.at;
                    if (age > 2600) toastMsg = null;
                    else HUB.toast(cv, st, S, toastMsg.text, age, toastMsg.sub, { cx: S.x + S.w / 2, y: gr.y + gr.h - 30 });
                }
                gButton(cv, t, lk, gr, false, isDown('g'));
                if (cv.own) cv.target(gr.x, gr.y, gr.w, gr.h, () => press(1, 'g'), 'g', lk.ui.radius);
            }
            return ui.image('MAIN_GFX', cv);
        });

        /* ---------- home-screen widget (app.json startWidget) ----------
         * Just the G logo, large and centred, on both sizes: no live data, nothing written over it.
         * The picture (widget_logo.js, drawn by tools/make_g_icon.py at the big widget's picture size,
         * transparent so the HMI's own widget tile shows through) goes into the layout's image cell.
         * Every text line and the progress bar stay empty (startWidget.cells). The small widget does
         * not show pictures on this firmware (upstream's eDrive finding: images pushed, nothing on
         * screen), so the layout's title carries the name there; on the big one it is empty. */
        const logo = new Canvas(LOGO.w, LOGO.h);
        logo.d.set(zlib.inflateSync(Buffer.from(LOGO.rgba, 'base64')));
        const wtitle = {};
        function renderWidget(inst) {
            if (inst) {
                const title = inst.big ? '' : "G's Dash";
                if (wtitle[inst.spawnId] !== title) { wtitle[inst.spawnId] = title; ctx.widget.set(inst.spawnId, 'Title', title, 'Text'); }
            }
            return logo;
        }
        if (ctx.widget) {
            // the same picture every time: the kit pushes it when a widget is placed, shown or
            // resized, and again only every few seconds (unchanged pixels are skipped)
            ctx.widget.loop(1, renderWidget);
            ctx.widget.onChange((why) => { if (why === 'resized' || why === 'placed' || why === 'shown') Object.keys(wtitle).forEach((k) => delete wtitle[k]); });
        }
    },
});
