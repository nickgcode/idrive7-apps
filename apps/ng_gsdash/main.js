'use strict';
/**
 * G's Dash - a driver display and car hub for the iDrive 7 (MGU) head unit, in six looks.
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
 *     M Style (the default), GT, Digital '84, Sim Racing, Lumen, Pixel (0.7.0). 0.9.0 took Simple, Heritage
 *     and Flight out: a saved one of those opens as M Style (migrated at start)
 *   - setting "panel": Spotify instead of the g-meter (music.js, G's Music's code shared in by the
 *     build): what plays, art, previous / play-pause / next, a bar to tap or drag; its own QR sign-in
 *   - a hidden diagnostics page (tap "G's Dash <version>" in the Options header 5 times): the drive
 *     mode field's raw values as the car sends them, the TPMS raw values and the car's units, and
 *     what the head unit's catalog says (diag.js)
 *   - full screen, touch, GPU renderer (app.json "fullscreen": true): the G button opens Options
 *     (Theme, Engine & warm-up, G-meter & session, Spotify & cluster); Theme has the looks as a
 *     gallery (each card drawn once in software into a picture, so the looks' big fonts don't fill the
 *     renderer's shared glyph texture) and the right panel. Shift lights always in the Race colours
 *     (0.6.0 took that setting out). The Drive page's bottom bars are oil and coolant (0.9.0 took the
 *     fuel choice out: no reliable fuel signal for now). No demo data.
 *   - a home-screen widget (app.json startWidget): the G logo, large and centred (widget_logo.js).
 *   - Options > Cluster source (0.8.3, cluster_source.js, setting "clusterSource", default Auto): what the
 *     cluster's centre map area shows - Auto (as before: the logo while G's Dash is open, G's Music over it
 *     while a track plays), Logo (also while G's Dash runs in the background), Music (G's Music's lyrics /
 *     visualizer, the logo when nothing plays), Map (Waze on cluster's CarPlay map) or Stock (the car's own;
 *     Waze on cluster has to be off). Route guidance always shows directions; G's TV only after its own
 *     Cluster button, and it yields to route guidance. The pick is shared with G's Music and G's TV in
 *     /dev/shm/ng-cluster/source.json, written only here (cluster_source.js has the rules).
 *     The logo: the G's Dash logo in the cluster's map area while no
 *     route guidance runs (cluster_logo.js, setting "clusterLogo" for Auto; the guidance from the car's
 *     navigation status and CarPlay's / Android Auto's, 0.7.4; 0.7.5: over Waze's map unless route
 *     guidance runs, shown too when no guidance signal answers; each signal's state on the page), and below it CarPlay's map on the
 *     instrument cluster (cluster.js), on / off, through the separately installed "Waze on cluster"
 *     tool's patch service: off unless the tool is installed and the user turns it on (with a
 *     confirmation); G's Dash stores nothing for it.
 *   - cluster skins (0.8.0, cluster_skin.js, setting "clusterSkin", on by default): with the cluster in
 *     its M / Sport layout (any drive mode), the cluster's own dials redrawn in the G's Dash look (the look switches the skin;
 *     Stock, the stock dials redrawn, from diagnostics), the telltales on top. 0.8.1: driving too - the
 *     speedometer, tachometer, digital speed and gear live from every car sample (car.onSample, 30 Hz at
 *     most); fuel, oil and the ACC / speed-limit / assist area left the car's own; back to stock when a
 *     value is over 300 ms old while moving, or anything is wrong. Options > Refresh cluster drops and makes
 *     again every G's Dash layer in the cluster (the logo takes the map back from the stock map). On the
 *     diagnostics page, parked: the alignment card (a 1 px outline of the measured geometry) and the
 *     Stock redraw.
 *   - HUD (speed, gear, shift lights) (0.9.0's full HUD; 0.8.2 had the lights + gear; hud_shift.js,
 *     setting "hudShift", off by default): while open, the whole HUD in the look's style - the speed in
 *     mph, big, the gearbox's own gear (none in P, unknown or guessed) and a band of shift lights at the
 *     top over the last 2000 rpm before the shift point (a flash from it); any drive mode. No speed limit.
 *     Hidden on values over 300 ms old, no speed signal, demo data or a renderer error, and while G's TV
 *     plays on the HUD (back about 1 s after). The panel and the HUD share one scene: turning it on
 *     turns the cluster skins off, and the other way.
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
const CL = require('./cluster_logo');
const CSRC = require('./cluster_source');
const CS = require('./cluster_skin');
const HS = require('./hud_shift');
const P = require('./px');

const LOOKS = [require('./look_m'), require('./look_gt'), require('./look_digital'), require('./look_simracing'),
    require('./look_lumen'), require('./look_pixel')];
// M Style is the default look, and where any other id lands (0.9.0: Simple, Heritage and Flight went)
const DEFAULT_LOOK = 'm';
const lookOf = (id) => LOOKS.find((l) => l.id === id) || LOOKS.find((l) => l.id === DEFAULT_LOOK);

const MPH = 1.609344;
const TRAIL_MS = 3000;
const OIL_READY_F = 194, COOLANT_READY_F = 176, HYST_F = 4;
const VERSION = '0.9.0';
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
// fixed since 0.6.0 (the setting went): the shift lights' Race colours
const LIGHT_STYLE = 'f1';
const TAPS = 5, TAP_MS = 3000;          // the diagnostics page: taps on the version in the Options header

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        // car data only: no demo feed (opts.demo false), a value not sent shows '--'
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'accel', 'gear', 'drivemode', 'tpms', 'units'], { demo: false });
        L.loadFonts(log);
        // 0.9.0: a saved look that is gone (simple, heritage, flight) or unknown becomes M Style
        const savedLook = settings.get('look');
        if (!LOOKS.some((l) => l.id === savedLook)) {
            log.info('look ' + savedLook + ' is gone: M Style');
            settings.set('look', DEFAULT_LOOK);
        }

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
        // 4 = Cluster source, 5 = Theme (2..5 go back to Options); the
        // bar's Reset moves to the settings page (no bar: the page reaches the screen's bottom)
        let page = 0, armed = 0, gDown = 0, downKey = '';
        // the screen is up (Spotify polls only then; the logo's background path, 0.8.3)
        const visible = () => (ui.isVisible ? ui.isVisible('MAIN') : true);
        const SCR = (id) => HUB.SCREENS.findIndex((x) => x[0] === id);
        let scr = SCR(HUB.HOME);                 // the hub screen (HUB.SCREENS index): Drive, not index 0
        const go = (i) => { scr = i; };
        if (ctx.hideButton) ctx.hideButton('BTN_RESET');
        // the dash again: Back on Options, the G there, the controller pushed left (ctx.onBack), and
        // whenever the screen is left (the HMI's back arrow / BACK closes it; it comes back on the hub)
        const toDash = () => { if (page === 0) return false; if (ask) { ask = null; return true; } page = page >= 2 ? 1 : 0; return true; };
        if (ctx.onBack) ctx.onBack(toDash);
        if (ui.onVisible) ui.onVisible((st, on) => { if (!on) { page = 0; taps = []; ask = null; skinMode = 'skin'; } });
        // the logo in the cluster's map area (cluster_logo.js, setting "clusterLogo"): only while G's Dash
        // is open, the regular logo or (Pixel look) the pixel emblem, its motion only while standing still
        let regImg = null;
        const clogo = new CL.ClusterLogo({ log, app: 'ng_gsdash', images: {
            regular: () => regImg || (regImg = CL.regularImage(Canvas, L.badge, L.badgeWidth)),
            pixel: (o) => CL.pixelImage(P, o),
        } });
        const logoOn = () => settings.get('clusterLogo') !== 'off';
        // the cluster skins (cluster_skin.js, setting "clusterSkin"): any drive mode, parked and driving, the look's;
        // skinMode from the diagnostics page: 'skin', 'align' (the alignment card), 'stock' (the Stock redraw)
        const cskin = new CS.ClusterSkin({ log, app: 'ng_gsdash', load: (f) => PNG.decode(fs.readFileSync(path.join(__dirname, f))) });
        const skinOn = () => settings.get('clusterSkin') !== 'off';
        // the HUD - speed, gear, shift lights (0.9.0; hud_shift.js, setting "hudShift", off by default): the panel and
        // the HUD share one scene, so they and the cluster skins are never on together (one on turns the other off)
        const hud = new HS.HudShift({ log, app: 'ng_gsdash', load: (f) => PNG.decode(fs.readFileSync(path.join(__dirname, f))) });
        const hudOn = () => settings.get('hudShift') === 'on';
        if (hudOn() && skinOn()) settings.set('clusterSkin', 'off');
        let skinMode = 'skin', refreshedAt = -1e15;
        const SPEED_IFACE = 'de.bmw.infotainment.vehicle.Vehicle2';
        // the Cluster source pick (0.8.3, cluster_source.js): setting "clusterSource", shared with G's Music and
        // G's TV in CSRC.SOURCE_DIR (written only here: at start, on a change and on Refresh cluster)
        const srcPick = () => (CSRC.valid(settings.get('clusterSource')) ? settings.get('clusterSource') : CSRC.DEFAULT);
        let srcRev = 0, srcPub = { ok: false, text: '' };
        const publishSource = (why) => {
            srcRev++;
            srcPub = CSRC.publish(srcPick(), srcRev);
            if (srcPub.error) log.warn('cluster source: ' + srcPub.text);
            else log.info('cluster source: ' + srcPick() + ' shared (' + why + ')');
        };
        publishSource('start');
        /** The logo per the pick: Auto as before (open and clusterLogo on), Logo / Music also in the background, Map / Stock none. */
        const clogoUpdate = (open) => {
            const d = car.data(), src = srcPick();
            clogo.update({ on: CSRC.logoWanted(src, open, settings.get('clusterLogo')), enabled: src === 'auto' ? logoOn() : (src === 'logo' || src === 'music'),
                pixel: look().id === 'pixel', parked: L.isNum(d.speed) && d.speed < 1,
                idleText: src === 'auto' ? 'On - while G\'s Dash is open' : 'Off - ' + CSRC.NAMES[src] + ' picked' });
        };
        // in the background (the screen's loop stops when it is hidden): the logo kept per the pick every second
        const bgLogo = setInterval(() => { if (!visible()) clogoUpdate(false); }, 1000);
        if (bgLogo.unref) bgLogo.unref();
        const logoUpdate = (open) => {
            const d = car.data();
            clogoUpdate(open);
            const sub = car.subBy ? car.subBy[SPEED_IFACE] : null;
            cskin.update({ on: !!open && (skinOn() || skinMode !== 'skin'), enabled: skinOn() || skinMode !== 'skin', look: look().id, mode: skinMode, data: d,
                speedAvail: !!(sub && sub.available && !sub.error), gear: L.gearText(d.gear, d.stage), at: car.at || null });
            const redline = num('redline', 6500);
            hud.update({ on: !!open && hudOn() && skinMode === 'skin', enabled: hudOn(), look: look().id, data: d, gear: L.gearText(d.gear, d.stage),
                at: car.at || null, redline, shift: redline - (Number(settings.get('shiftBefore')) || 0) });
        };
        // the skins' live path (0.8.1): every speed / rpm / accel sample straight on, not at the loop's 10 fps
        car.onSample(() => {
            if (cskin.want) { const d = car.data(); cskin.sample(d, car.at || null, L.gearText(d.gear, d.stage)); }
            if (hud.want) { const d = car.data(); hud.sample(d, car.at || null, L.gearText(d.gear, d.stage)); }
        });
        /** Options > Refresh cluster: every G's Dash layer in the cluster dropped and made again */
        const refreshCluster = () => {
            const a = clogo.refresh(), b = cskin.refresh(), c = hud.refresh();
            publishSource('refresh');
            refreshedAt = Date.now();
            log.info('refresh cluster: logo ' + (a ? 'remade' : 'not up') + ', skin ' + (b ? 'remade' : 'not up') + ', hud ' + (c ? 'remade' : 'not up'));
        };
        if (ui.onVisible) ui.onVisible((st, on) => { if (st === 'MAIN') logoUpdate(on); });
        settings.onChange((k) => {
            // one on turns the other off (whichever way it was set: Options or the settings list)
            if (k === 'hudShift' && hudOn() && skinOn()) { settings.set('clusterSkin', 'off'); say('Cluster skins turned off', 'HUD on'); }
            if (k === 'clusterSkin' && skinOn() && hudOn()) { settings.set('hudShift', 'off'); say('HUD turned off', 'Cluster skins on'); }
            if (k === 'clusterSource') publishSource('change');
            if (k === 'clusterSource' || k === 'clusterLogo' || k === 'clusterSkin' || k === 'hudShift' || k === 'look' || k === 'redline' || k === 'shiftBefore') logoUpdate(ui.isVisible ? ui.isVisible('MAIN') : true);
        });
        process.once('exit', () => { clearInterval(bgLogo); clogo.close(); cskin.close(); hud.close(); });
        // route guidance (0.7.4, 0.7.5): the logo steps aside while it runs, and only then (or for G's TV). The stock navigation's guidingState
        // (INACTIVE / CALCULATING_ROUTE / ACTIVE) and the phone's projectedGuidanceActive (CarPlay: Waze
        // or Maps with a route; Android Auto), all app.json "_optional"; read again every GUIDE_POLL_MS
        // in case a change notification is missed. No answer from any: the logo still shows (the page
        // says "route detection unavailable"); each watch's state goes to clogo.guideLink() for the
        // page's "Route: nav .. CarPlay .. AA .." line (n/a: no config or refused; no answer: subscribed,
        // the provider not there), kept up every GUIDE_LINK_MS.
        const GUIDE = [
            ['de.bmw.infotainment.navigation.navigationstatus.NavigationStatus', '1', 'guidingState', 'nav'],
            ['de.bmw.infotainment.a4a.carplay.CarPlayManager', 'CarPlayManagerInst1', 'projectedGuidanceActive', 'carplay'],
            ['de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager', 'AndroidAutoProjectedManagerInst1', 'projectedGuidanceActive', 'aa'],
        ];
        const GUIDE_POLL_MS = 10000, GUIDE_LINK_MS = 2000;
        if (ctx.signals && ctx.signals.watch) GUIDE.forEach((g) => {
            const h = {};
            h[g[2]] = (v) => clogo.guidance(g[3], v);
            ctx.signals.watch(g[0], g[1], h, log, { pollMs: GUIDE_POLL_MS })
                .then((r) => {
                    log.info('guidance ' + g[3] + ': ' + (r.error ? 'unavailable (' + r.error + ')' : r.available ? 'available' : 'subscribed'));
                    const link = () => clogo.guideLink(g[3], r.error ? 'error' : r.available ? 'up' : 'down', r.error ? String(r.error) : '');
                    link();
                    if (!r.error) { const iv = setInterval(link, GUIDE_LINK_MS); if (iv.unref) iv.unref(); }
                })
                .catch((e) => { log.warn('guidance ' + g[3] + ': ' + e); clogo.guideLink(g[3], 'error', String(e && e.message || e)); });
        });
        // settings 0.4.0 had and 0.5.0 dropped (demo, layout, renderer, speedUnit, spotifyPoll, showBadge),
        // 0.6.0's (lights: the Race colours, LIGHT_STYLE; theme) and 0.9.0's (bars: the fuel choice)
        // are app.json "retiredSettings": the kit deletes saved values for them at start (mgu.js Settings)
        /** A press on the G (or Back): shown pressed for a moment, then the page changes. */
        const press = (to, key) => { gDown = Date.now(); downKey = key; setTimeout(() => { page = to; }, 140); };
        const isDown = (key) => downKey === key && Date.now() - gDown < 180;

        // CarPlay's map on the cluster (cluster.js): the patch service's socket only while its page is open, apply /
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
            const vf = { font: u.txt, spacing: u.upper ? u.spacing * 0.6 : 0, literal: true };
            let vs = u.size + 2;
            // o.shrink: a smaller size (down to 15) before the text is cut
            if (o.shrink) while (vs > 15 && cv.textWidth(valueText(u, value), vs, vf) > w - 36) vs--;
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

        /**
         * Options (the G): three columns. Theme: the current look's card and the right panel, a tap
         * opens the Theme page. Engine & warm-up: five stepped rows. G-meter & session, then Spotify &
         * cluster: the g-meter scale, the session peaks' reset (tap twice), the Spotify and Cluster
         * source pages. "G's Dash <version>" in the header: the hidden diagnostics page (TAPS taps).
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
            // 3. G-meter & session; Spotify & cluster
            const x2 = x1 + cw + gap;
            // six rows here (0.8.2): at the usual spacing if the page reaches, else closed up (rows RH3 tall, 6 apart)
            const avail = S.y + S.h - top, roomy = 6 * ROW_H + 5 * ROW_GAP <= avail;
            const RH3 = roomy ? ROW_H : Math.max(48, Math.min(ROW_H, Math.floor((avail - 30) / 6)));
            const s3 = (k) => (roomy ? slot(k) : top + k * (RH3 + 6));
            lbl('G-meter, session & cluster', x2, S.y + 20, 18, t.dim);
            stepRow(cv, S, lk, x2, s3(0), cw, RH3, GSCALE);
            const live = Date.now() - armed < 5000, ry = s3(1);
            card(cv, t, x2, ry, cw, RH3, false);
            rowText(cv, S, lk, x2, ry, cw - 170, RH3, live ? 'Tap again to confirm' : 'Session peaks', live ? 'Reset all peaks?' : 'All g and top peaks', { warn: live });
            const rb = { x: x2 + cw - 156, y: ry + 8, w: 144, h: RH3 - 16 };
            if (live) { cv.roundRect(rb.x, rb.y, rb.w, rb.h, u.radius, L.withAlpha(t.crit || '#ff3b30', 0.3)); cv.strokeRoundRect(rb.x, rb.y, rb.w, rb.h, u.radius, 2, t.crit || '#ff3b30'); }
            else cv.roundRect(rb.x, rb.y, rb.w, rb.h, u.radius, L.withAlpha('#ffffff', 0.08));
            lbl(live ? 'Confirm' : 'Reset', rb.x + rb.w / 2, rb.y + rb.h / 2 + 8, u.size, live ? t.text : t.text, { align: 'center' });
            cv.target(x2, ry, cw, RH3, () => {
                if (Date.now() - armed < 5000) { armed = 0; reset(); log.info('peaks reset'); say('Peaks reset'); } else armed = Date.now();
            }, 'opt:reset', u.radius);
            linkRow(cv, S, lk, x2, s3(2), cw, RH3, 'opt:spotify', 'Spotify', music.statusLine(), () => press(2, 'opt:spotify'));
            // the Cluster source page (0.8.3), and beside it Refresh cluster (0.8.0): every G's Dash layer in the
            // cluster dropped and made again; "Cluster refreshed" for REFRESHED_MS
            const lv = clogo.view(), src = srcPick(), fw = 156, done = Date.now() - refreshedAt < REFRESHED_MS;
            const nc = done ? null : nowCard();
            linkRow(cv, S, lk, x2, s3(3), cw - fw - 12, RH3, 'opt:cluster', 'Cluster source \u00b7 ' + CSRC.NAMES[src], done ? 'Cluster refreshed' : nc.title.replace(/^Now: /, ''),
                () => { ask = null; press(4, 'opt:cluster'); }, done ? HUB.GREEN : nc.notes.some((x) => x[1] === 'warn') ? '#ffb020' : nc.tone === 'ok' ? HUB.GREEN : logoTone(t, lv.kind));
            const fb = { x: x2 + cw - fw, y: s3(3), w: fw, h: RH3 };
            card(cv, t, fb.x, fb.y, fb.w, fb.h, isDown('opt:refresh') || done);
            lbl(done ? 'Refreshed' : 'Refresh', fb.x + fb.w / 2, fb.y + Math.round(RH3 * 0.44), u.size, t.text, { align: 'center' });
            lbl('cluster', fb.x + fb.w / 2, fb.y + Math.round(RH3 * 0.81), Math.round(u.size * 0.72), t.dim, { align: 'center' });
            cv.target(fb.x, fb.y, fb.w, fb.h, () => { gDown = Date.now(); downKey = 'opt:refresh'; refreshCluster(); }, 'opt:refresh', u.radius);
            // the cluster skins and the HUD (speed, gear, shift lights): one on turns the other off
            toggleRow(cv, S, lk, x2, s3(4), cw, RH3, 'Cluster skins', 'cs', skinOn(), cskin.view(), (v) => settings.set('clusterSkin', v));
            toggleRow(cv, S, lk, x2, s3(5), cw, RH3, 'HUD (speed, gear, shift lights)', 'hs', hudOn(), hud.view(), (v) => settings.set('hudShift', v));
        }
        const REFRESHED_MS = 2600;
        /** An Off / On row ("Cluster skins": clusterSkin, "HUD (speed, gear, shift lights)": hudShift) and what it does now. */
        function toggleRow(cv, S, lk, x, y, w, h, title, id, on, sv, set) {
            const t = S.t, u = lk.ui, acc = t.sel || t.accent;
            const tone = on ? logoTone(t, sv.kind) : null;
            cardOf(lk)(cv, t, x, y, w, h, false);
            const bw = 84, bx0 = x + w - 2 * bw - 12;
            rowText(cv, S, lk, x + (tone ? 18 : 0), y, bx0 - x - 12 - (tone ? 18 : 0), h, title, on ? sv.text : 'Off', { shrink: true });
            if (tone) cv.circle(x + 22, y + h - 20, 6, tone);
            [[false, 'Off', 'off'], [true, 'On', 'on']].forEach((b, i) => {
                const bx = bx0 + i * (bw + 6), sel = on === b[0], by = y + 10, bh = h - 20;
                if (sel) { cv.roundRect(bx, by, bw, bh, u.radius, L.withAlpha(acc, 0.22)); cv.strokeRoundRect(bx, by, bw, bh, u.radius, 2, acc); }
                else cv.roundRect(bx, by, bw, bh, u.radius, L.withAlpha('#ffffff', 0.06));
                cv.text(u.upper ? b[1].toUpperCase() : b[1], bx + bw / 2, by + bh / 2 + 9, 24, sel ? t.text : t.dim, { font: u.txt, align: 'center', spacing: u.upper ? u.spacing : 0, literal: true });
                if (!sel) cv.target(bx, by, bw, bh, () => set(b[2]), id + ':' + b[2], u.radius);
            });
        }

        /**
         * Theme: the looks as a gallery of cards, each drawn in its own look (a tap switches at once, the
         * page itself redraws in it), and the right panel on Drive: the g-meter and peaks, or Spotify.
         */
        function themePage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u), card = cardOf(lk), acc = t.sel || t.accent, cur = lk.id;
            header(cv, S, lk, lbl, card, 'Theme', 1);
            const x0 = S.x, top = S.y + 34, cols = 3, g = 14;            // six looks: 3 x 2 (0.9.0)
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
                // the name: at the left, or centred (ui.nameAlign 'center', 0.9.0) on the looks whose swatch is
                // centred (GT, Sim Racing, Lumen); the chosen card's tick (bottom right) still clears it
                const mid = nu.nameAlign === 'center', room = mid ? cw - 2 * 48 : cw - 70;
                const nw = r.textWidth(nm, nsz, nf), fs = nw > room ? Math.max(16, Math.floor(nsz * room / nw)) : nsz;
                r.text(nm, mid ? cw / 2 : 16, ch - 22, fs, lt.text, mid ? Object.assign({ align: 'center' }, nf) : nf);
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
            // 0.8.4: the Cluster renderer's whole refusal for the cluster skins and the HUD (Options shows it short)
            [['Skins', cskin.refusal()], ['HUD', hud.refusal()]].forEach((r) => {
                if (!r[1]) return;
                let rest = r[0] + ' refused: ' + r[1], n = 0;
                while (rest && n < 3) {
                    let cut = rest.length;
                    while (cut > 1 && cv.textWidth(rest.slice(0, cut), 15, { literal: true }) > w - 28) cut--;
                    put(x + 14, y, w - 28, rest.slice(0, cut), t.warn || t.crit, 15); y += 20; rest = rest.slice(cut); n++;
                }
                y += 4;
            });
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
                const rows = Math.floor((top + S.h - 84 - y) / 22);
                out.slice(0, rows).forEach((l) => {
                    cv.text(fitText(cv, l[1], 17, w - 28, l[0] === 'row' ? mono : {}), x + 14, y, 17, l[0] === 'head' ? t.text : l[0] === 'warn' ? (t.warn || t.crit) : t.dim, l[0] === 'row' ? { font: 'num', literal: true } : { literal: true });
                    y += 22;
                });
                if (out.length > rows) put(x + 14, y - 2, w - 28, '+ ' + (out.length - rows) + ' more lines', t.dim, 15);
            }
            // the cluster skins (0.8.0), parked only: the alignment card (to photograph against the stock
            // dials) and the Stock redraw; a second tap goes back to the look
            const d2 = car.data(), parked = L.isNum(d2.speed) && d2.speed < 1 && d2.stage !== 'D' && d2.stage !== 'R';
            const bw2 = (w - 28 - 12) / 2, by2 = top + S.h - 70, bh2 = 56;
            [['align', 'Alignment card'], ['stock', 'Stock redraw']].forEach((b, i) => {
                const bx = x + 14 + i * (bw2 + 12), on = skinMode === b[0];
                if (on) { cv.roundRect(bx, by2, bw2, bh2, u.radius, L.withAlpha(t.sel || t.accent, 0.25)); cv.strokeRoundRect(bx, by2, bw2, bh2, u.radius, 2, t.sel || t.accent); }
                else cv.roundRect(bx, by2, bw2, bh2, u.radius, L.withAlpha('#ffffff', parked ? 0.08 : 0.03));
                cv.text(b[1], bx + bw2 / 2, by2 + 26, 18, parked || on ? t.text : t.dim, { align: 'center', literal: true });
                cv.text(on ? 'on - tap for the look' : parked ? 'parked: tap to show' : 'parked only', bx + bw2 / 2, by2 + 47, 14, t.dim, { align: 'center', literal: true });
                if (on || parked) cv.target(bx, by2, bw2, bh2, () => { skinMode = on ? 'skin' : b[0]; log.info('cluster skin mode: ' + skinMode); }, 'sk:' + b[0], u.radius);
            });
            if (skinMode !== 'skin') cv.text(fitText(cv, 'Cluster: ' + cskin.view().text, 15, w - 28), x + 14, by2 - 8, 15, t.dim, { literal: true });
        }
        /*
         * The Cluster source page (0.8.3): what the cluster's centre map area shows. Five tiles (Auto, Logo,
         * Music, Map, Stock: setting "clusterSource"), the Now card (what is there now and why, warnings),
         * CarPlay's map on the cluster (Waze on cluster): Off / On (the patch service's state, nothing stored
         * here; a change asks first: the confirmation, drawn over the page, the page's own targets left out
         * meanwhile), and on the right the rules and Refresh cluster.
         */
        const SRC_TILES = [
            ['auto', 'As before: switches itself'],
            ['logo', "G's Dash logo"],
            ['music', 'Lyrics / visualizer'],
            ['map', 'Waze / CarPlay map'],
            ['stock', "The car's own"],
        ];
        /** A tile's small picture of the map area (1088 x 480): what the pick puts there. */
        function srcThumb(cv, kind, x, y, w, h, sel) {
            const r = 8;
            if (kind === 'map') {
                cv.roundRect(x, y, w, h, r, '#202830');
                cv.line(x + 8, y + h * 0.72, x + w - 8, y + h * 0.40, 5, '#3a4752');
                cv.line(x + w * 0.30, y + 6, x + w * 0.42, y + h - 6, 4, '#3a4752');
                cv.line(x + w * 0.20, y + h - 8, x + w * 0.55, y + h * 0.55, 6, '#33ccff');
                cv.line(x + w * 0.55, y + h * 0.55, x + w * 0.80, y + h * 0.22, 6, '#33ccff');
                const ax = x + w * 0.24, ay = y + h - 16;
                cv.quad([[ax, ay - 12], [ax + 9, ay + 8], [ax, ay + 3], [ax - 9, ay + 8]], '#ffffff');
            } else if (kind === 'stock') {
                cv.roundRect(x, y, w, h, r, '#0c1726');
                for (let i = 1; i < 5; i++) cv.line(x + 6, y + i * h / 5, x + w - 6, y + i * h / 5 + 6, 2, '#1d3350');
                for (let i = 1; i < 6; i++) cv.line(x + i * w / 6, y + 6, x + i * w / 6 - 8, y + h - 6, 2, '#1d3350');
                cv.line(x + 10, y + h * 0.62, x + w - 10, y + h * 0.48, 5, '#355a86');
                const ax = x + w / 2, ay = y + h * 0.55;
                cv.quad([[ax, ay - 12], [ax + 9, ay + 9], [ax, ay + 4], [ax - 9, ay + 9]], '#e8eef6');
            } else {
                cv.roundRect(x, y, w, h, r, '#000000');
                if (kind === 'logo') {
                    const bh = h * 0.42, bw = L.badgeWidth(bh);
                    L.badge(cv, x + (w - bw) / 2, y + (h + bh) / 2, bh);
                } else if (kind === 'music') {
                    cv.roundRect(x + w * 0.18, y + h * 0.20, w * 0.64, 9, 4, '#ffffff');
                    cv.roundRect(x + w * 0.28, y + h * 0.40, w * 0.44, 6, 3, '#6b7079');
                    const N = 17, g = (w * 0.76) / N;
                    for (let i = 0; i < N; i++) {
                        const bh = h * 0.30 * (0.25 + 0.75 * Math.abs(Math.sin(i * 0.9 + 0.6)));
                        cv.roundRect(x + w * 0.12 + i * g, y + h * 0.74 - bh / 2, g * 0.5, bh, g * 0.25, i < 6 ? '#3ad0ff' : i < 12 ? '#7a6cff' : '#ff4fa3');
                    }
                } else {
                    const bh = h * 0.30, bw = L.badgeWidth(bh);
                    L.badge(cv, x + w * 0.27 - bw / 2, y + (h + bh) / 2, bh);
                    for (let i = 0; i < 6; i++) { const bh2 = h * (0.15 + 0.3 * Math.abs(Math.sin(i * 1.3 + 0.4))); cv.roundRect(x + w * 0.58 + i * 9, y + h / 2 - bh2 / 2, 5, bh2, 2.5, i < 3 ? '#3ad0ff' : '#ff4fa3'); }
                    cv.line(x + w / 2, y + 12, x + w / 2, y + h - 12, 1.5, L.withAlpha('#ffffff', 0.25));
                }
            }
            cv.strokeRoundRect(x, y, w, h, r, 1, L.withAlpha('#ffffff', sel ? 0.35 : 0.16));
        }
        // G's Music's own Cluster setting (its state.json), read at most every MUSIC_READ_MS for the Now card
        let musicSeen = { error: 'missing' }, musicReadAt = -1e15;
        const MUSIC_READ_MS = 2000;
        const musicState = () => {
            const now = Date.now();
            if (now - musicReadAt >= MUSIC_READ_MS) { musicReadAt = now; musicSeen = CSRC.readMusic(); }
            return musicSeen;
        };
        /**
         * The Now card: { title, sub, tone ('ok' | 'wait' | 'off'), notes: [[text, 'warn' | 'dim']] } from the
         * pick, the logo's state, the route guidance and what the renderer says is drawing.
         */
        function nowCard() {
            const src = srcPick(), name = CSRC.NAMES[src], lv = clogo.view(), mv = cmap.view(), notes = [];
            const raw = clogo.guide.nav === true || clogo.guide.carplay === true || clogo.guide.aa === true;
            const guiding = clogo.want ? (clogo.guiding || clogo.rawGuide) : raw;
            const tv = clogo.want && clogo.others.some((l) => l.app === 'ng_tv');
            const musicOn = clogo.want && clogo.under.some((l) => l.app === 'ng_spotify');
            const ms = musicState();
            let r;
            if ((src === 'map' || src === 'stock') && guiding) r = { title: 'Now: directions (route guidance)', sub: src === 'map' ? 'In the map, as the phone sends them' : "The car's own directions", tone: 'ok' };
            else if (src === 'map') r = { title: 'Now: Waze / CarPlay map', sub: "G's Dash and G's Music stay out of the cluster", tone: mv.on === true ? 'ok' : 'wait' };
            else if (src === 'stock') r = { title: "Now: the car's own content", sub: "None of G's apps draw there", tone: mv.on === true ? 'wait' : 'ok' };
            else if (guiding) r = { title: 'Now: directions (route guidance)', sub: 'Back to ' + name + ' when the route ends', tone: 'ok' };
            else if (tv) r = { title: "Now: G's TV", sub: 'Back to ' + name + ' when it stops', tone: 'ok' };
            else if (musicOn && src !== 'logo') r = { title: "Now: G's Music", sub: src === 'music' ? 'The logo when nothing plays' : 'Auto: the logo again when the track stops', tone: 'ok' };
            else if (lv.kind === 'on') {
                const sub = src === 'auto' ? "Auto: G's Music takes over while a track plays; the logo only while G's Dash is open"
                    : src === 'logo' ? "Stays on the logo. G's Music stays out of the cluster."
                        : 'Lyrics / visualizer as soon as a track plays';
                r = { title: src === 'music' ? 'Now: Logo (nothing playing)' : 'Now: Logo', sub, tone: 'ok' };
            } else r = { title: 'Logo: ' + lv.text, sub: src === 'auto' && !logoOn() ? 'Auto with "Logo in cluster" Off (settings list): nothing of ours' : '', tone: lv.kind === 'error' || lv.kind === 'none' ? 'off' : 'wait' };
            if (src === 'music' && ms.cluster === 'off') notes.push(["G's Music's own Cluster setting is Off: it stays out (turn it on in G's Music)", 'warn']);
            else if (src === 'music' && ms.error) notes.push(["G's Music not seen yet: open it once", 'dim']);
            if (src === 'stock') notes.push([mv.on === true ? 'Waze on cluster is On: turn it Off below for the car\'s own map to show'
                : 'The car\'s own map shows only with Waze on cluster Off (below)', mv.on === true ? 'warn' : 'dim']);
            if (src === 'map' && mv.on !== true) notes.push([mv.kind === 'none' ? "Waze on cluster not installed: the car's own map shows" : 'Waze on cluster is not On: the car\'s own map shows', 'dim']);
            if (src === 'logo' || src === 'music') notes.push(['Also in the background while G\'s Dash runs (gone if the head unit ends it)', 'dim']);
            if (srcPub.error) notes.push(["Pick not shared (" + srcPub.text + "): G's Music and G's TV keep their last", 'warn']);
            r.notes = notes;
            return r;
        }
        function clusterPage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u), card = cardOf(lk), acc = t.sel || t.accent;
            const mark = cv.targets ? cv.targets.length : 0;
            header(cv, S, lk, lbl, card, 'Cluster source', 1);
            const v = cmap.view(), x0 = S.x, LW = Math.round(S.w * 0.655), bottom = S.y + S.h, cur = srcPick();
            if (ask && (Date.now() - ask.at > ASK_MS || v.can !== ask.cmd)) ask = null;
            lbl('In the cluster\'s centre (map area)', x0, S.y + 20, 18, t.dim);
            // the five picks
            const n = SRC_TILES.length, gap = 14, tw = (LW - (n - 1) * gap) / n, ty = S.y + 34;
            const pw = tw - 24, ph = Math.round(pw * 480 / 1088), th = ph + 104;
            SRC_TILES.forEach((s2, i) => {
                const bx = x0 + i * (tw + gap), sel = cur === s2[0];
                if (sel) { cv.roundRect(bx, ty, tw, th, u.radius, L.withAlpha(acc, 0.20)); cv.strokeRoundRect(bx, ty, tw, th, u.radius, 3, acc); }
                else card(cv, t, bx, ty, tw, th, isDown('src:' + s2[0]));
                srcThumb(cv, s2[0], bx + 12, ty + 12, pw, ph, sel);
                const nm = CSRC.NAMES[s2[0]];
                cv.text(u.upper ? nm.toUpperCase() : nm, bx + 16, ty + ph + 58, u.size + 8, t.text, { font: u.txt, spacing: u.upper ? u.spacing * 0.6 : 0, literal: true });
                cv.text(fitText(cv, s2[1], 16, tw - 28), bx + 16, ty + ph + 88, 16, sel ? t.text : t.dim, { literal: true });
                if (sel) {
                    const cx = bx + tw - 30, cy = ty + ph + 48;
                    cv.circle(cx, cy, 13, acc);
                    cv.line(cx - 6, cy, cx - 1, cy + 5, 3, t.selText || '#ffffff'); cv.line(cx - 1, cy + 5, cx + 7, cy - 5, 3, t.selText || '#ffffff');
                } else cv.target(bx, ty, tw, th, () => { gDown = Date.now(); downKey = 'src:' + s2[0]; settings.set('clusterSource', s2[0]); }, 'src:' + s2[0], u.radius);
            });
            // what the cluster shows now, and why
            const nc = nowCard(), wh = ROW_H, wy = bottom - wh, sy = ty + th + 14, sh = wy - 14 - sy;
            const tone = nc.tone === 'ok' ? HUB.GREEN : nc.tone === 'wait' ? '#ffb020' : t.dim;
            cv.roundRect(x0, sy, LW, sh, u.radius, L.withAlpha('#ffffff', 0.04));
            cv.strokeRoundRect(x0, sy, LW, sh, u.radius, 1, L.withAlpha('#ffffff', 0.12));
            cv.circle(x0 + 28, sy + 28, 8, tone);
            lbl(fitText(cv, nc.title, 26, LW - 70), x0 + 48, sy + 37, 26, t.text);
            let ly = sy + 66;
            const line = (s2, c, size) => { if (ly > sy + sh - 6) return; cv.text(fitText(cv, s2, size, LW - 48), x0 + 24, ly, size, c, { literal: true }); ly += size + 9; };
            if (nc.sub) line(nc.sub, t.dim, 18);
            nc.notes.forEach((nt) => line(nt[0], nt[1] === 'warn' ? '#ffb020' : t.dim, 17));
            const guideRule = cur === 'map' || cur === 'stock' ? 'Route guidance: the map\'s own directions' : 'Route guidance: directions take over, then ' + CSRC.NAMES[cur];
            line(guideRule + '  \u00b7  ' + clogo.routeLine(), t.dim, 16);
            // CarPlay's map (Waze on cluster): one row, Off / On, a tap on the other asks first
            const vt = v.kind === 'on' ? HUB.GREEN : v.kind === 'pending' || v.kind === 'busy' ? '#ffb020' : v.kind === 'conflict' || v.kind === 'error' ? (t.crit || '#ff3b30') : null;
            card(cv, t, x0, wy, LW, wh, false);
            const bw = 110, bx0 = x0 + LW - 2 * bw - 18;
            rowText(cv, S, lk, x0 + (vt ? 18 : 0), wy, bx0 - x0 - 12 - (vt ? 18 : 0), wh, 'CarPlay map in the cluster (Waze on cluster)', v.value + (v.line ? ' - ' + v.line : ''), { shrink: true });
            if (vt) cv.circle(x0 + 22, wy + wh - 20, 6, vt);
            [[false, 'Off', 'revert'], [true, 'On', 'apply']].forEach((b, i) => {
                const bx = bx0 + i * (bw + 6), on = v.on === b[0], tap = v.can === b[2], by = wy + 10, bh = wh - 20;
                if (on) { cv.roundRect(bx, by, bw, bh, u.radius, L.withAlpha(acc, 0.22)); cv.strokeRoundRect(bx, by, bw, bh, u.radius, 2, acc); }
                else cv.roundRect(bx, by, bw, bh, u.radius, L.withAlpha('#ffffff', 0.06));
                cv.text(u.upper ? b[1].toUpperCase() : b[1], bx + bw / 2, by + bh / 2 + 9, 24, on || tap ? t.text : L.withAlpha(t.dim, 0.55), { font: u.txt, align: 'center', spacing: u.upper ? u.spacing : 0, literal: true });
                if (tap) cv.target(bx, by, bw, bh, () => { ask = { cmd: b[2], at: Date.now() }; }, 'cm:' + b[1].toLowerCase(), u.radius);
            });
            // the rules, and Refresh cluster
            const ix = x0 + LW + 36, iw = S.x + S.w - ix;
            lbl('Rules', ix, S.y + 20, 18, t.dim);
            const INFO = [
                ['Whatever you pick stays put.', t.text],
                ['Route guidance always shows directions', t.text],
                ['(car nav, CarPlay or Android Auto), then', t.text],
                ['the cluster goes back to your pick.', t.text],
                ['', null],
                ["G's TV: only after you tap its Cluster", t.text],
                ['button (parked); it gives way to route', t.text],
                ['guidance, then back to your pick.', t.text],
                ['', null],
                ['Music with nothing playing: the logo.', t.dim],
                ["Shared with G's Music and G's TV.", t.dim],
                ['Needs the Cluster renderer tool (Store).', t.dim],
            ];
            const fh = ROW_H + 8, fy = bottom - fh;
            let iy = S.y + 58;
            INFO.forEach((l) => { if (l[1] && iy < fy - 10) cv.text(fitText(cv, l[0], 21, iw), ix, iy, 21, l[1], { literal: true }); iy += l[0] ? 29 : 12; });
            const done = Date.now() - refreshedAt < REFRESHED_MS;
            card(cv, t, ix, fy, iw, fh, isDown('cs:refresh') || done);
            lbl(done ? 'Cluster refreshed' : 'Refresh cluster', ix + 22, fy + 32, u.size, t.text);
            cv.text('Remakes every G\'s Dash cluster layer', ix + 22, fy + 58, 16, t.dim, { literal: true });
            cv.circle(ix + iw - 40, fy + fh / 2, 16, L.withAlpha('#ffffff', 0.08));
            cv.line(ix + iw - 46, fy + fh / 2 - 6, ix + iw - 40, fy + fh / 2, 2.5, t.text);
            cv.line(ix + iw - 40, fy + fh / 2, ix + iw - 46, fy + fh / 2 + 6, 2.5, t.text);
            cv.target(ix, fy, iw, fh, () => { gDown = Date.now(); downKey = 'cs:refresh'; refreshCluster(); }, 'cs:refresh', u.radius);
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
        /** The logo's state as a colour (null: none): shown green, waiting amber, an error red. */
        function logoTone(t, kind) {
            return kind === 'on' ? HUB.GREEN : kind === 'wait' ? '#ffb020' : kind === 'error' ? (t.crit || '#ff3b30') : null;
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
            logoUpdate(visible());
            if (!cv.own) page = 0;
            autoStep(S);
            const P = Object.assign({}, S, { y: SET_Y, h: reach - SET_Y - 6 });
            // the patch service's socket: open only while the Cluster source page is on screen
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
