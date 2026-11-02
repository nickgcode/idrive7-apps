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
 *     (accel / brake / lateral), oil and coolant in colour zones (0.11.0, lib.js TEMP_ZONES: blue cold,
     green normal, red too hot); always mph and degrees F
 *   - looks (setting "look", look_*.js): each its own layout, type, gauges and tab style -
 *     M Style (the default; 0.11.0: Carbon Grid), GT, Digital '84, Sim Racing, Lumen, Pixel (0.7.0). 0.9.0 took Simple, Heritage
 *     and Flight out: a saved one of those opens as M Style (migrated at start)
 *   - setting "panel": Spotify instead of the g-meter (music.js, G's Music's code shared in by the
 *     build): what plays, art, previous / play-pause / next, a bar to tap or drag; its own QR sign-in
 *   - Options > Diagnostics (0.10.0: a plain entry, the 5-tap gesture went): Cluster - the tools'
 *     versions, the logo / skins / HUD state, the renderer's refusals, Waze on cluster's state, Refresh
 *     cluster, the alignment card and Stock redraw, the clock's source; Car data - the drive mode field's
 *     raw values as the car sends them, the TPMS raw values and the car's units, and what the head unit's
 *     catalog says (diag.js, also its time / date fields)
 *   - full screen, touch, GPU renderer (app.json "fullscreen": true): the G button opens Options
 *     (0.10.0: Theme, Cluster & HUD, Driving, Spotify, Diagnostics; every Options page has a Dash button
 *     at the top right back to the dash, the sub pages also "< Options"); Theme has the looks as a
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
 *   - favourite looks (0.10.0, prefs.js; saved as "favLooks"): a star on each Theme card; with two or
 *     more, a tap on the gear (0.11.0: the gear only) on Drive switches to the next one (a toast says which). Not on a
 *     swipe or a moving finger, never while the shift lights build or flash. Looks that went drop out.
 *   - Showcase (0.11.0, hub.js): the look's own flowing waves (waves.js, drawn here, no picture files), the car
 *     on a soft floor shadow, a big clock and the date (or, setting "showcase": Spotify while it has a track,
 *     the frosted now-playing card under a smaller clock), the G mark and the logo straight on the waves.
 *     showcase_car.png / showcase_logo.png are shown as they are: pictures.js scales them smoothly, bleeds
 *     their edges (no fringes) and, where the renderer shows RGBA opaque (an upstream one), composites them
 *     over the waves itself (kit Recorder.pictures says which path).
 *   - Spotify's controls (0.11.0, music.js): no boxes; 96-120 px targets 24 px apart or more, a filled
 *     play / pause circle, a soft disc pressed (stepped on Pixel), quiet targets (no kit press flash, a
 *     round controller ring); a 6 px seek bar with its times.
 *   - every clock H:MM with a colon (0.10.0, clock.js): Showcase's 12-hour clock from the head unit's
 *     clock in its own zone (the car keeps it set); a car time once a signal for it is known (Diagnostics
 *     lists the catalog's time / date fields). The session clocks are stopwatches: m:ss.t.
 *   - Your look on the car's displays (0.10.0, setting "displays", Options > Cluster & HUD): Cluster
 *     dials (the skins, the default), HUD or Neither - one at a time (they share one display layer).
 *     0.9.0's two settings (clusterSkin, hudShift) are moved over once at start (prefs.js).
 *   - cluster skins (0.8.0, cluster_skin.js, "displays" Cluster dials): with the cluster in
 *     its M / Sport layout (any drive mode), the cluster's own dials redrawn in the G's Dash look (the look switches the skin;
 *     Stock, the stock dials redrawn, from diagnostics), the telltales on top. 0.8.1: driving too - the
 *     speedometer, tachometer, digital speed and gear live from every car sample (car.onSample, 30 Hz at
 *     most); fuel, oil and the ACC / speed-limit / assist area left the car's own; back to stock when a
 *     value is over 300 ms old while moving, or anything is wrong. Diagnostics > Refresh cluster drops and makes
 *     again every G's Dash layer in the cluster (the logo takes the map back from the stock map). On the
 *     diagnostics page, parked: the alignment card (a 1 px outline of the measured geometry) and the
 *     Stock redraw.
 *   - HUD (speed, gear, shift lights) (0.9.0's full HUD; 0.8.2 had the lights + gear; hud_shift.js,
 *     "displays" HUD): while open, the whole HUD in the look's style - the speed in
 *     mph, big, the gearbox's own gear (none in P, unknown or guessed) and a band of shift lights at the
 *     top over the last 2000 rpm before the shift point (a flash from it); any drive mode. No speed limit.
 *     Hidden on values over 300 ms old, no speed signal, demo data or a renderer error, and while G's TV
 *     plays on the HUD (back about 1 s after). The panel and the HUD share one scene: one at a time.
 *   - Full-screen cluster test (0.12.0, fcluster.js / fcluster_core.js, Options > Diagnostics, TEST): classic
 *     twin round dials over the whole cluster panel (1920 x 720), any gear or speed; covers the car's warning
 *     lights while on. Off by default and never saved (fcTest lives in memory only). The skins and the HUD
 *     are paused while it is on; it fades to stock on late values or anything wrong.
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
const { Waves, W: WAVE_W, base: waveBase } = require('./waves');
const { Pictures } = require('./pictures');
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
const FCL = require('./fcluster');
const P = require('./px');
const PREFS = require('./prefs');
const CLOCK = require('./clock');

const LOOKS = [require('./look_m'), require('./look_gt'), require('./look_digital'), require('./look_simracing'),
    require('./look_lumen'), require('./look_pixel')];
// M Style is the default look, and where any other id lands (0.9.0: Simple, Heritage and Flight went)
const DEFAULT_LOOK = 'm';
const lookOf = (id) => LOOKS.find((l) => l.id === id) || LOOKS.find((l) => l.id === DEFAULT_LOOK);

const MPH = 1.609344;
const TRAIL_MS = 3000;
const OIL_READY_F = 194, COOLANT_READY_F = 176, HYST_F = 4;
const VERSION = '0.12.1';
// Warm-up: the rev limit is COLD_RPM at or below COLD_F oil, rising (250 rpm steps) to WARM_REDLINE at
// the "oil temp for full revs" setting. Auto-jump: AUTO_MS after READY it opens Drive.
const COLD_RPM = 4000, COLD_F = 104, WARM_REDLINE = 6000, OIL_FULL_F = 180, AUTO_MS = 5000;
const HIST_MS = 20000, HIST_N = 80, ENV_N = 48;                  // G-force: last 20 s, the peak envelope
const SWIPE_START = 40, SWIPE_GO = 110, HOLD_MS = 700, HOLD_SLOP = 24;
const IMG = { car: 0x6701, logo: 0x6702, card: 0x6710, wave: 0x6740 };   // record.setImage ids (cards: + look index; wave: Showcase)
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
const STAR = '#ffc93a';                 // the favourite looks' star
const DASH_W = 250;                     // the Dash button (top right of every Options page)

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
        // 0.10.0: 0.9.0's "clusterSkin" / "hudShift" become "displays" (Cluster dials / HUD / Neither), once.
        // They are not app.json retiredSettings (the kit would delete them before this could read them).
        const dm = PREFS.migrateDisplays(settings.values);
        if (dm.migrated) {
            PREFS.OLD_KEYS.forEach((k) => { delete settings.values[k]; });
            log.info('displays: ' + dm.value + ' (from 0.9.0\'s settings)');
            settings.set('displays', dm.value);
        } else if (settings.get('displays') !== dm.value) settings.set('displays', dm.value);
        // favourite looks (prefs.js): kept outside the settings list, looks that went drop out
        const favs = () => PREFS.parseFavs(settings.get(PREFS.FAV_KEY), LOOKS.map((l) => l.id));
        const clock = new CLOCK.Clock();

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

        // the page: 0 = the hub (screen scr: HUB.SCREENS), 1 = Options (the G), 2 = Spotify, 3 = Diagnostics,
        // 4 = Cluster & HUD, 5 = Theme, 6 = Driving (2..6 go back to Options; Dash on each: the hub); the
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
        if (ui.onVisible) ui.onVisible((st, on) => { if (!on) { page = 0; ask = null; skinMode = 'skin'; } });
        // the logo in the cluster's map area (cluster_logo.js, setting "clusterLogo"): only while G's Dash
        // is open, the regular logo or (Pixel look) the pixel emblem, its motion only while standing still
        let regImg = null;
        const clogo = new CL.ClusterLogo({ log, app: 'ng_gsdash', images: {
            regular: () => regImg || (regImg = CL.regularImage(Canvas, L.badge, L.badgeWidth)),
            pixel: (o) => CL.pixelImage(P, o),
        } });
        const logoOn = () => settings.get('clusterLogo') !== 'off';
        // your look on the car's displays (0.10.0, setting "displays"): the cluster skins (Cluster dials), the
        // HUD, or Neither - one at a time, the panel and the HUD share one scene (prefs.js)
        const displays = () => (PREFS.validDisplay(settings.get('displays')) ? settings.get('displays') : PREFS.DEFAULT_DISPLAY);
        // the cluster skins (cluster_skin.js, "displays" skin): any drive mode, parked and driving, the look's;
        // skinMode from the diagnostics page: 'skin', 'align' (the alignment card), 'stock' (the Stock redraw)
        const cskin = new CS.ClusterSkin({ log, app: 'ng_gsdash', load: (f) => PNG.decode(fs.readFileSync(path.join(__dirname, f))) });
        const skinOn = () => displays() === 'skin';
        // the HUD - speed, gear, shift lights (0.9.0; hud_shift.js, "displays" hud)
        const hud = new HS.HudShift({ log, app: 'ng_gsdash', load: (f) => PNG.decode(fs.readFileSync(path.join(__dirname, f))) });
        const hudOn = () => displays() === 'hud';
        let skinMode = 'skin', refreshedAt = -1e15;
        // 0.12.0: Diagnostics > Full-screen cluster test (TEST): classic round dials over the whole cluster panel
        // (fcluster.js). Off by default and held here only - never a setting, never saved: off again after every
        // app or head unit restart. While on, the cluster skins and the HUD are paused (they share the scene).
        let fcTest = false;
        const fcl = new FCL.FullCluster({ log, app: 'ng_gsdash', load: (f) => PNG.decode(fs.readFileSync(path.join(__dirname, f))) });
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
            const speedAvail = !!(sub && sub.available && !sub.error);
            // 0.12.0: the full-screen cluster test pauses the skins and the HUD (closed for them while it is on)
            cskin.update({ on: !!open && !fcTest && (skinOn() || skinMode !== 'skin'), enabled: skinOn() || skinMode !== 'skin', look: look().id, mode: skinMode, data: d,
                speedAvail, gear: L.gearText(d.gear, d.stage), at: car.at || null });
            const redline = num('redline', 6500);
            hud.update({ on: !!open && !fcTest && hudOn() && skinMode === 'skin', enabled: hudOn(), look: look().id, data: d, gear: L.gearText(d.gear, d.stage),
                at: car.at || null, redline, shift: redline - (Number(settings.get('shiftBefore')) || 0) });
            // any gear, any speed; night: G's Dash has no day / night signal from the car (no look switches), so day
            fcl.update({ on: !!open && fcTest, enabled: fcTest, data: d, speedAvail, at: car.at || null, night: false, clock: clock.now() });
        };
        // the skins' live path (0.8.1): every speed / rpm / accel sample straight on, not at the loop's 10 fps
        car.onSample(() => {
            if (cskin.want) { const d = car.data(); cskin.sample(d, car.at || null, L.gearText(d.gear, d.stage)); }
            if (hud.want) { const d = car.data(); hud.sample(d, car.at || null, L.gearText(d.gear, d.stage)); }
            if (fcl.want) fcl.sample(car.data(), car.at || null);
        });
        /** Diagnostics > Refresh cluster: every G's Dash layer in the cluster dropped and made again */
        const refreshCluster = () => {
            const a = clogo.refresh(), b = cskin.refresh(), c = hud.refresh(), f = fcl.refresh();
            publishSource('refresh');
            refreshedAt = Date.now();
            log.info('refresh cluster: logo ' + (a ? 'remade' : 'not up') + ', skin ' + (b ? 'remade' : 'not up') + ', hud ' + (c ? 'remade' : 'not up') + (f ? ', full-screen test remade' : ''));
        };
        if (ui.onVisible) ui.onVisible((st, on) => { if (st === 'MAIN') logoUpdate(on); });
        settings.onChange((k) => {
            if (k === 'clusterSource') publishSource('change');
            if (k === 'clusterSource' || k === 'clusterLogo' || k === 'displays' || k === 'look' || k === 'redline' || k === 'shiftBefore') logoUpdate(ui.isVisible ? ui.isVisible('MAIN') : true);
        });
        process.once('exit', () => { clearInterval(bgLogo); clogo.close(); cskin.close(); hud.close(); fcl.close(); });
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
        // Showcase shows (0.11.0): Spotify while it has a track (else the clock), or the clock only
        const showcaseMusic = () => settings.get('showcase') !== 'clock';
        let ownNow = false;
        const musicOnHub = () => {
            const id = HUB.SCREENS[scr][0];
            // G-force (0.11.1) always shows its g readouts on the right, never Spotify
            return (id === 'showcase' && showcaseMusic()) || (panelOn() && id === 'drive' && !!look().panelRect);
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
        // tg: the hub's last gesture as the favourite looks' tap sees it ({ moved: furthest px from the start,
        // swiped }), kept after the finger lifts: the kit fires a target after this handler's phase 3
        let sw = null, tg = null, toastMsg = null, autoJump = null, userSwiped = false, coldChecked = false, holdT = null;
        const say = (text, sub) => { toastMsg = { text, sub: sub || '', at: Date.now() }; };
        const endHold = () => { if (holdT) { clearTimeout(holdT); holdT = null; } };
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            if (page !== 0) { sw = null; tg = null; endHold(); return false; }
            if (phase === 1) tg = { x0: x, y0: y, moved: 0, swiped: false };
            else if (tg) tg.moved = Math.max(tg.moved, Math.abs(x - tg.x0), Math.abs(y - tg.y0));
            if (musicOnHub() && music.touch(phase, x, y)) { sw = null; if (tg) tg.swiped = true; endHold(); return true; }
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
                if (tg && (sw.on || sw.held)) tg.swiped = true;
                return sw.on || sw.held;
            }
            // phase 3
            const was = sw; sw = null; endHold();
            if (tg && (was.on || was.held)) tg.swiped = true;
            if (was.on && Math.abs(dx) > SWIPE_GO) {
                const to = Math.max(0, Math.min(HUB.SCREENS.length - 1, scr + (dx < 0 ? 1 : -1)));
                if (to !== scr) { go(to); userSwiped = true; autoJump = null; }
            }
            return was.on || was.held;
        });
        /*
         * Favourite looks on Drive (0.10.0; 0.11.0: the gear only): a still tap on the gear (S.zones.gear) goes to the
         * next favourite, with a toast for LOOK_TOAST_MS; fewer than two favourites: a hint how to add them.
         * Ignored on a swipe or a moving finger (PREFS.stillTap) and while the shift lights build or flash.
         */
        const LOOK_TOAST_MS = PREFS.TOAST_MS;
        let lookToast = null;                // { lines, at, hint }
        const favTap = (S) => {
            if (!PREFS.stillTap(tg)) return;
            const d = car.data(), redline = num('redline', 6500), shift = redline - (Number(settings.get('shiftBefore')) || 0);
            if (PREFS.nearShift({ rpm: d.rpm, shift, range: 2000, strobe: L.isNum(d.rpm) && d.rpm >= shift })) return;
            const nx = PREFS.nextFav(favs(), look().id);
            if (!nx) { lookToast = { lines: PREFS.HINT, at: Date.now(), hint: true }; return; }
            settings.set('look', nx.id);
            log.info('look ' + nx.id + ' (favourite ' + nx.i + ' of ' + nx.n + ')');
            lookToast = { lines: PREFS.favToast(lookOf(nx.id).name, nx.i, nx.n), at: Date.now(), hint: false };
        };

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
                oil: { f: oil, thr: oilThr, ok: warm('oil', oil, oilThr), kind: 'oil' },
                cool: { f: cool, thr: coolThr, ok: warm('coolant', cool, coolThr), kind: 'coolant' },
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

        /**
         * A page's header row. Sub pages (backTo 1): "< Options" at the left, then the page's name; Options
         * itself: its name at the left. Every Options page (0.10.0): the Dash button at the top right, lit in
         * the look's accent (the G and DASH; back to the dash), the version dim to its left.
         */
        function header(cv, S, lk, lbl, card, title, backTo) {
            const t = S.t, u = lk.ui, by = HEAD_Y, cy = by + HEAD_H / 2;
            let tx = S.x;
            if (backTo) {
                const bx = S.x, bw = 210;
                card(cv, t, bx, by, bw, HEAD_H, isDown('back'));
                cv.line(bx + 36, cy - 11, bx + 24, cy, 3, t.text);
                cv.line(bx + 24, cy, bx + 36, cy + 11, 3, t.text);
                cv.text(u.upper ? 'OPTIONS' : 'Options', bx + 52, cy + 9, u.size + 4, t.text, { font: u.txt, spacing: u.upper ? u.spacing : 0, literal: true });
                cv.target(bx, by, bw, HEAD_H, () => press(backTo, 'back'), 'back', u.radius);
                tx = bx + bw + 32;
            }
            lbl(title || 'Options', tx, cy + 11, 30, t.text);
            const dr = { x: S.x + S.w - DASH_W, y: by, w: DASH_W, h: HEAD_H };
            lbl("G's Dash " + VERSION, dr.x - 24, cy + 7, 16, t.dim, { align: 'right' });
            dashButton(cv, t, lk, card, dr, isDown('dash'));
            cv.target(dr.x, dr.y, dr.w, dr.h, () => press(0, 'dash'), 'dash', u.radius);
        }
        /** The Dash button: the look's card, lit; the G badge and DASH. */
        function dashButton(cv, t, lk, card, r, down) {
            const u = lk.ui, acc = t.sel || t.accent;
            card(cv, t, r.x, r.y, r.w, r.h, true);
            if (down) cv.roundRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6, u.radius, L.withAlpha(acc, 0.3));
            const bh = 30, bw = L.badgeWidth(bh), f = { font: u.txt, spacing: u.upper ? u.spacing : 2, literal: true };
            const lw = cv.textWidth('DASH', u.size + 6, f), x = r.x + (r.w - bw - 18 - lw) / 2;
            L.badge(cv, x, r.y + (r.h + bh) / 2, bh, lk.badgeLetter);
            cv.text('DASH', x + bw + 18, r.y + r.h / 2 + 10, u.size + 6, t.text, f);
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
        /** A small glyph for an Options entry (theme, cluster, engine, g, spotify, diag). */
        function entryIcon(cv, kind, cx, cy, c, acc) {
            if (kind === 'theme') { cv.arc(cx, cy, 24, 28, 200, 540, c); cv.line(cx, cy, cx + 14, cy - 12, 3, acc); cv.circle(cx, cy, 4, c); }
            else if (kind === 'cluster') {
                cv.arc(cx - 15, cy - 4, 13, 16, 0, 360, c); cv.arc(cx + 15, cy - 4, 13, 16, 0, 360, c);
                cv.line(cx - 15, cy - 4, cx - 9, cy - 11, 2.5, acc); cv.line(cx + 15, cy - 4, cx + 21, cy - 11, 2.5, acc);
                cv.roundRect(cx - 12, cy + 17, 24, 4, 2, acc);
            } else if (kind === 'engine') {
                cv.roundRect(cx - 5, cy - 24, 10, 34, 5, c); cv.circle(cx, cy + 14, 10, c); cv.circle(cx, cy + 14, 5, acc); cv.roundRect(cx - 2, cy - 6, 4, 18, 2, acc);
                [-16, -8, 0].forEach((d) => cv.line(cx + 10, cy + d, cx + 17, cy + d, 2, c));
            } else if (kind === 'g') { cv.arc(cx, cy, 24, 26, 0, 360, c); cv.arc(cx, cy, 11, 13, 0, 360, c); cv.circle(cx + 8, cy - 6, 6, acc); }
            else if (kind === 'spotify') [[-12, 30], [0, 44], [12, 22]].forEach((b) => cv.roundRect(cx + b[0] - 4, cy - b[1] / 2, 8, b[1], 4, c));
            else if (kind === 'diag') { cv.arc(cx, cy, 13, 15.5, 0, 360, c); cv.roundRect(cx - 1.5, cy - 7, 3, 9, 1.5, c); cv.circle(cx, cy + 6, 2, c); }
        }
        /** An Options entry: icon, title, one value line (tone: a dot before it), chevron; a tap opens page `to`. */
        function entry(cv, S, lk, x, y, w, h, key, icon, title, value, to, tone) {
            const t = S.t, u = lk.ui, acc = t.sel || t.accent;
            cardOf(lk)(cv, t, x, y, w, h, isDown(key));
            entryIcon(cv, icon, x + 50, y + h / 2, t.text, acc);
            const tx = x + 96, mw = w - 96 - 52, tf = { font: u.txt, spacing: u.upper ? u.spacing * 0.6 : 0, literal: true };
            cv.text(fitText(cv, valueText(u, title), u.size + 6, mw, tf), tx, y + h / 2 - 4, u.size + 6, t.text, tf);
            let vx = tx;
            if (tone) { cv.circle(tx + 6, y + h / 2 + 22, 6, tone); vx += 20; }
            cv.text(fitText(cv, value, 19, mw - (vx - tx)), vx, y + h / 2 + 29, 19, t.dim, { literal: true });
            chevron(cv, x + w - 28, y + h / 2, 10, t.dim);
            cv.target(x, y, w, h, () => press(to, key), key, u.radius);
        }
        const displaysLine = () => ({ skin: 'Cluster dials', hud: 'HUD', none: 'Neither' })[displays()];
        const engineLine = () => { const r = num('redline', 6500); return 'Redline ' + r + ' \u00b7 shift ' + (r - (Number(settings.get('shiftBefore')) || 0)) + ' rpm'; };
        const gLine = () => 'Scale ' + (Number(settings.get('gScale')) || 1.5).toFixed(1) + ' g \u00b7 reset peaks';
        /** Something of ours in the cluster / HUD that should work does not: the renderer is missing or says no. */
        const clusterTrouble = () => {
            const bad = (v) => v.kind === 'none' || v.kind === 'error';
            return bad(clogo.view()) || (skinOn() && bad(cskin.view())) || (hudOn() && bad(hud.view()));
        };

        /**
         * Options (the G), 0.10.0. Left, "Look & displays": the Theme card (the look's own card, its name and
         * right panel; Change look opens Theme) and Cluster & HUD under it. Right: Driving (Engine & warm-up,
         * G-meter & session: both the Driving page), Music (Spotify) and a small Diagnostics entry.
         */
        function optionsPage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u), card = cardOf(lk), acc = t.sel || t.accent;
            header(cv, S, lk, lbl, card, 'Options');
            const top = S.y + 34, gap = 32, lw = Math.round(S.w * 0.56), x0 = S.x, bottom = S.y + S.h;
            lbl('Look & displays', x0, S.y + 20, 18, t.dim);
            cv.roundRect(x0, top, lw, bottom - top, u.radius, L.withAlpha('#ffffff', 0.025));
            cv.strokeRoundRect(x0, top, lw, bottom - top, u.radius, 1, L.withAlpha('#ffffff', 0.10));
            // Theme
            const hx = x0 + 14, hy = top + 14, hw = lw - 28, hh = TILE_H + 28, down = isDown('opt:theme');
            card(cv, t, hx, hy, hw, hh, down);
            const im = cardImage(lk, LOOKS.indexOf(lk), TILE_W, TILE_H, cv.textScale || 1);
            if (im) cv.image(im, hx + 14, hy + 14, TILE_W, TILE_H);
            cv.strokeRoundRect(hx + 14, hy + 14, TILE_W, TILE_H, 10, 1, L.withAlpha('#ffffff', 0.12));
            const tx = hx + 14 + TILE_W + 32, mw = hx + hw - 60 - tx, tf = { font: u.txt, spacing: u.upper ? u.spacing * 0.6 : 0, literal: true };
            lbl('Theme', tx, hy + 48, Math.round(u.size * 0.8), t.dim);
            cv.text(fitText(cv, valueText(u, lk.name), u.size + 16, mw, tf), tx, hy + 98, u.size + 16, t.text, tf);
            cv.text(fitText(cv, 'Right panel: ' + (panelOn() ? 'Spotify' : 'G-meter'), 20, mw), tx, hy + 138, 20, t.dim, { literal: true });
            cv.roundRect(tx, hy + hh - 62, 260, 44, u.radius, L.withAlpha(acc, down ? 0.34 : 0.18));
            lbl('Change look', tx + 18, hy + hh - 33, u.size, t.text);
            chevron(cv, tx + 236, hy + hh - 40, 8, t.text);
            chevron(cv, hx + hw - 28, hy + hh / 2, 10, t.dim);
            cv.target(hx, hy, hw, hh, () => press(5, 'opt:theme'), 'opt:theme', u.radius);
            // Cluster & HUD: the source and your look on the car's displays (amber: something needs attention)
            const cy = hy + hh + 14, ch = bottom - 14 - cy;
            entry(cv, S, lk, hx, cy, hw, ch, 'opt:cluster', 'cluster', 'Cluster & HUD', 'Source ' + CSRC.NAMES[srcPick()] + ' \u00b7 ' + displaysLine(), 4,
                clusterTrouble() ? '#ffb020' : null);
            // right: Driving, Music, Diagnostics
            const rx = x0 + lw + gap, rw = S.x + S.w - rx, eh = 100, eg = 16, dh = 56;
            lbl('Driving', rx, S.y + 20, 18, t.dim);
            entry(cv, S, lk, rx, top, rw, eh, 'opt:engine', 'engine', 'Engine & warm-up', engineLine(), 6);
            entry(cv, S, lk, rx, top + eh + eg, rw, eh, 'opt:g', 'g', 'G-meter & session', gLine(), 6);
            const sy = top + 2 * (eh + eg) + 22, dy = bottom - dh;
            lbl('Music', rx, sy - 10, 18, t.dim);
            entry(cv, S, lk, rx, sy, rw, Math.min(eh, dy - 14 - sy), 'opt:spotify', 'spotify', 'Spotify', music.statusLine(), 2);
            // Diagnostics: small and quiet, plainly labelled
            const dd = isDown('opt:diag');
            cv.roundRect(rx, dy, rw, dh, u.radius, L.withAlpha('#ffffff', dd ? 0.10 : 0.03));
            cv.strokeRoundRect(rx, dy, rw, dh, u.radius, 1, L.withAlpha('#ffffff', 0.10));
            entryIcon(cv, 'diag', rx + 32, dy + dh / 2, t.dim, t.dim);
            lbl('Diagnostics', rx + 62, dy + dh / 2 + 7, Math.round(u.size * 0.85), t.dim);
            cv.text('Tools, cluster, car data', rx + rw - 48, dy + dh / 2 + 6, 16, L.withAlpha(t.dim, 0.8), { align: 'right', literal: true });
            chevron(cv, rx + rw - 24, dy + dh / 2, 8, t.dim);
            cv.target(rx, dy, rw, dh, () => { DIAG.reset(); press(3, 'opt:diag'); }, 'opt:diag', u.radius);
        }
        const REFRESHED_MS = 2600;
        /** A plain row that opens a page (a label and a chevron). */
        function linkMini(cv, S, lk, x, y, w, h, key, label, fn) {
            const t = S.t, u = lk.ui;
            cardOf(lk)(cv, t, x, y, w, h, isDown(key));
            lblOf(cv, u)(label, x + 20, y + h / 2 + 7, u.size, t.text);
            chevron(cv, x + w - 26, y + h / 2, 9, t.dim);
            cv.target(x, y, w, h, fn, key, u.radius);
        }
        /** A five-point star at (cx, cy), radius r: filled (a favourite) or outlined. */
        function star(cv, cx, cy, r, on, c) {
            const pts = [];
            for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
            if (on) { for (let i = 0; i < 5; i++) cv.quad([[cx, cy], pts[(2 * i + 9) % 10], pts[2 * i], pts[2 * i + 1]], c); }
            else if (cv.polyline) cv.polyline(pts.concat([pts[0]]), 2.5, c);
        }

        /**
         * Driving (0.10.0): Engine & warm-up (five stepped rows) and G-meter & session (the scale, the session
         * peaks' reset: tap twice).
         */
        function drivingPage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u), card = cardOf(lk);
            header(cv, S, lk, lbl, card, 'Driving', 1);
            const top = S.y + 34, gap = 32, cw = (S.w - gap) / 2, slot = (k) => top + k * (ROW_H + ROW_GAP);
            lbl('Engine & warm-up', S.x, S.y + 20, 18, t.dim);
            ENGINE.forEach((r, k) => stepRow(cv, S, lk, S.x, slot(k), cw, ROW_H, r));
            const x2 = S.x + cw + gap;
            lbl('G-meter & session', x2, S.y + 20, 18, t.dim);
            stepRow(cv, S, lk, x2, slot(0), cw, ROW_H, GSCALE);
            const live = Date.now() - armed < 5000, ry = slot(1);
            card(cv, t, x2, ry, cw, ROW_H, false);
            rowText(cv, S, lk, x2, ry, cw - 170, ROW_H, live ? 'Tap again to confirm' : 'Session peaks', live ? 'Reset all peaks?' : 'All g and top peaks', { warn: live });
            const rb = { x: x2 + cw - 156, y: ry + 8, w: 144, h: ROW_H - 16 };
            if (live) { cv.roundRect(rb.x, rb.y, rb.w, rb.h, u.radius, L.withAlpha(t.crit || '#ff3b30', 0.3)); cv.strokeRoundRect(rb.x, rb.y, rb.w, rb.h, u.radius, 2, t.crit || '#ff3b30'); }
            else cv.roundRect(rb.x, rb.y, rb.w, rb.h, u.radius, L.withAlpha('#ffffff', 0.08));
            lbl(live ? 'Confirm' : 'Reset', rb.x + rb.w / 2, rb.y + rb.h / 2 + 8, u.size, t.text, { align: 'center' });
            cv.target(x2, ry, cw, ROW_H, () => {
                if (Date.now() - armed < 5000) { armed = 0; reset(); log.info('peaks reset'); say('Peaks reset'); } else armed = Date.now();
            }, 'opt:reset', u.radius);
            cv.text(fitText(cv, 'Hold a finger on the G-force screen to reset there too.', 17, cw), x2, slot(2) + 30, 17, t.dim, { literal: true });
        }

        /**
         * Theme: the looks as a gallery of cards, each drawn in its own look (a tap switches at once, the
         * page itself redraws in it), and the right panel on Drive: the g-meter and peaks, or Spotify.
         * 0.10.0: a star on each card (its own 64 x 64 target, top right) makes it a favourite; the
         * favourites' column says how they switch on Drive; Cluster & HUD at its foot.
         */
        function themePage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u), card = cardOf(lk), acc = t.sel || t.accent, cur = lk.id;
            header(cv, S, lk, lbl, card, 'Theme', 1);
            const x0 = S.x, top = S.y + 34, cols = 3, g = 14;            // six looks: 3 x 2 (0.9.0)
            const fl = favs(), ids = LOOKS.map((l) => l.id);
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
                // the favourite star: its target first (the first target that matches wins)
                const fav = fl.indexOf(l.id) >= 0, sx = cx + TILE_W - 30, sy = cy + 30;
                cv.circle(sx, sy, 22, L.withAlpha('#000000', 0.55));
                if (!fav) cv.arc(sx, sy, 21, 22.5, 0, 360, L.withAlpha('#ffffff', 0.25));
                star(cv, sx, sy, 14, fav, fav ? STAR : L.withAlpha('#ffffff', 0.8));
                cv.target(sx - 32, sy - 32, 64, 64, () => {
                    settings.set(PREFS.FAV_KEY, PREFS.serializeFavs(PREFS.toggleFav(favs(), l.id, ids)));
                    log.info('favourite looks: ' + (settings.get(PREFS.FAV_KEY) || 'none'));
                }, 'fav:' + l.id, 32);
                cv.target(cx, cy, TILE_W, TILE_H, () => { settings.set('look', l.id); }, 'look:' + l.id, 10);
            });
            // the right panel: two choices, the current one lit
            const px = x0 + cols * TILE_W + (cols - 1) * g + 40, fcw = 400, pw = S.x + S.w - px - fcw - 32, ph = 84;
            lbl('Right panel on Drive', px, S.y + 20, 18, t.dim);
            [['g', 'G-meter', 'Live g-meter and session peaks'], ['spotify', 'Spotify', 'What plays, with touch controls']].forEach((o, i) => {
                const oy = top + i * (ph + g), on = (panelOn() ? 'spotify' : 'g') === o[0];
                if (on) { cv.roundRect(px, oy, pw, ph, u.radius, L.withAlpha(acc, 0.22)); cv.strokeRoundRect(px, oy, pw, ph, u.radius, 3, acc); } else card(cv, t, px, oy, pw, ph, false);
                // a small glyph: rings for the g-meter, three bars for Spotify
                const gx = px + 48, gy = oy + ph / 2, c = on ? t.text : t.dim;
                if (o[0] === 'g') { cv.arc(gx, gy, 28, 30, 0, 360, c); cv.arc(gx, gy, 13, 15, 0, 360, c); cv.circle(gx + 9, gy - 6, 6, on ? acc : c); }
                else [[-14, 34], [0, 50], [14, 26]].forEach((b) => cv.roundRect(gx + b[0] - 4, gy - b[1] / 2, 8, b[1], 4, c));
                lbl(o[1], px + 96, oy + 40, u.size + 4, t.text);
                cv.text(fitText(cv, o[2], 17, pw - 112), px + 96, oy + 66, 17, t.dim, { literal: true });
                cv.target(px, oy, pw, ph, () => settings.set('panel', o[0]), 'panel:' + o[0], u.radius);
            });
            // Showcase shows (0.11.0): Spotify while it plays (else the clock), or the clock only
            const ny = top + 2 * ph + g + 22, sh = 56, sw = (pw - g) / 2;
            lbl('Showcase shows', px, ny + 6, 18, t.dim);
            [['spotify', 'Spotify when playing', '(else the clock)'], ['clock', 'Clock only', '']].forEach((o, i) => {
                const ox = px + i * (sw + g), oy = ny + 20, on = (showcaseMusic() ? 'spotify' : 'clock') === o[0];
                if (on) { cv.roundRect(ox, oy, sw, sh, u.radius, L.withAlpha(acc, 0.22)); cv.strokeRoundRect(ox, oy, sw, sh, u.radius, 3, acc); } else card(cv, t, ox, oy, sw, sh, false);
                cv.text(fitText(cv, o[1], 20, sw - 24), ox + 14, oy + (o[2] ? sh / 2 - 2 : sh / 2 + 7), 20, on ? t.text : t.dim, { literal: true });
                if (o[2]) cv.text(fitText(cv, o[2], 16, sw - 24), ox + 14, oy + sh / 2 + 18, 16, t.dim, { literal: true });
                cv.target(ox, oy, sw, sh, () => settings.set('showcase', o[0]), 'showcase:' + o[0], u.radius);
            });
            showcaseBgRow(cv, S, lk, px, ny + 20 + sh + 14, pw, Math.min(76, S.y + S.h - (ny + 20 + sh + 14) - 26));
            // favourite looks: their own column, and Cluster & HUD at its foot
            const fx = px + pw + 32, fh = 2 * 112 + g, tf = { font: u.txt, spacing: u.upper ? u.spacing * 0.6 : 0, literal: true };
            lbl('Favourite looks', fx, S.y + 20, 18, t.dim);
            card(cv, t, fx, top, fcw, fh, false);
            star(cv, fx + 34, top + 44, 14, true, STAR);
            const names = fl.map((id) => lookOf(id).name).join(' + ') || 'None yet';
            cv.text(fitText(cv, valueText(u, names), u.size + 4, fcw - 76, tf), fx + 60, top + 53, u.size + 4, t.text, tf);
            ['Tap the gear on Drive to', 'switch between them.', '', 'Star a look (top-right of its', 'card) to add it; 2 or more.'].forEach((l2, k) => {
                if (l2 && top + 100 + k * 26 < top + fh - 8) cv.text(fitText(cv, l2, 18, fcw - 48), fx + 24, top + 100 + k * 26, 18, k < 2 ? t.text : t.dim, { literal: true });
            });
            linkMini(cv, S, lk, fx, S.y + S.h - 64, fcw, 64, 'th:cluster', 'Cluster & HUD', () => { ask = null; press(4, 'th:cluster'); });
        }

        /**
         * Showcase background (0.11.0, prefs.js BG_*): the waves' brightness, 100 % down to 15 %, with - and +
         * (each the row's height, 76 page px wide) and between them a live preview: the current look's
         * waves as darkened on Showcase, the percent over them. Darkens the waves only.
         */
        function showcaseBgRow(cv, S, lk, x, y, w, h) {
            const t = S.t, u = lk.ui, acc = t.sel || t.accent, v = PREFS.bgLevel(settings.get(PREFS.BG_KEY)), bw = 76;
            cv.text(valueText(u, 'Showcase background'), x, y + 12, 18, t.dim, { font: u.lbl || u.txt, spacing: u.upper ? u.spacing : 0, literal: true });
            const ry = y + 22, pvx = x + bw + 10, pvw = w - 2 * (bw + 10);
            // the preview: the same picture Showcase draws (drawn on here if it isn't there yet), the same darkening
            const WH = S.y + S.h + 6, ready = SC.waves.step(lk.id, Math.round(WAVE_W * WH / 1600), 20);
            if (ready) cv.image(IMG.wave, pvx, ry, pvw, h); else cv.fillRect(pvx, ry, pvw, h, waveBase(lk.id));
            if (v < 100) cv.fillRect(pvx, ry, pvw, h, L.withAlpha('#000000', 1 - v / 100));
            cv.strokeRoundRect(pvx, ry, pvw, h, 6, 1, L.withAlpha('#ffffff', 0.18));
            // the level: a thin bar along the preview's foot, the percent in the middle
            cv.fillRect(pvx + 10, ry + h - 10, pvw - 20, 4, L.withAlpha('#ffffff', 0.18));
            cv.fillRect(pvx + 10, ry + h - 10, Math.round((pvw - 20) * v / 100), 4, acc);
            cv.text(v + ' %', pvx + pvw / 2, ry + h / 2 + 6, 22, '#ffffff', { align: 'center', font: u.num, literal: true });
            [[-1, x], [1, x + w - bw]].forEach((b) => {
                const to = PREFS.bgStep(v, b[0]), k2 = 'bg:' + (b[0] < 0 ? '-' : '+'), bx = b[1], cx = bx + bw / 2, cy = ry + h / 2;
                const down = isDown(k2);
                cardOf(lk)(cv, t, bx, ry, bw, h, down);
                const c = to !== null ? t.text : L.withAlpha(t.dim, 0.4);
                cv.line(cx - 12, cy, cx + 12, cy, 3, c);
                if (b[0] > 0) cv.line(cx, cy - 12, cx, cy + 12, 3, c);
                if (to !== null) cv.target(bx, ry, bw, h, () => { gDown = Date.now(); downKey = k2; settings.set(PREFS.BG_KEY, to); }, k2, u.radius);
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

        /*
         * The installed tools' versions (0.10.0, Diagnostics): the store installs a tool as /var/opt/<tool>/current
         * -> versions/<version>; read again every TOOL_READ_MS.
         */
        const TOOLS = [['cluster-render', 'Cluster renderer'], ['waze-on-cluster', 'Waze on cluster']];
        const TOOL_READ_MS = 5000;
        let toolSeen = null, toolAt = -1e15;
        function toolVersion(id) {
            const dir = path.join('/var/opt', id), cur = path.join(dir, 'current');
            try {
                const m = /versions\/([^/]+)\/?$/.exec(fs.readlinkSync(cur));
                if (m) return m[1];
            } catch (e) { /* not a link */ }
            for (const f of ['component.json', 'app.json']) {
                try { const v = JSON.parse(fs.readFileSync(path.join(cur, f), 'utf8')).version; if (v) return String(v); } catch (e) { /* none */ }
            }
            return fs.existsSync(dir) ? 'installed' : 'not installed';
        }
        const tools = () => {
            const now = Date.now();
            if (now - toolAt >= TOOL_READ_MS) { toolAt = now; toolSeen = TOOLS.map((x) => [x[1], toolVersion(x[0])]); }
            return toolSeen;
        };
        let diagView = 'cluster';           // Diagnostics: 'cluster' or 'car'
        /**
         * Diagnostics (Options > Diagnostics). Two views, picked at the top. Cluster: the tools and their
         * versions, what the logo / skins / HUD are doing and the renderer's whole refusals, Waze on cluster's
         * state, Refresh cluster, the clock's source; parked, the alignment card and the Stock redraw. Car
         * data: per drive mode field what the car last sent (raw), TPMS raw, and the head unit's catalog
         * (diag.js). Car data only: no demo, no guesses; a field that sent nothing says so.
         */
        function diagPage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u), acc = t.sel || t.accent;
            header(cv, S, lk, lbl, cardOf(lk), 'Diagnostics', 1);
            // the view switch, in the header row after the title
            const sx0 = S.x + 210 + 32 + cv.textWidth(u.upper ? 'DIAGNOSTICS' : 'Diagnostics', 30, { font: u.lbl || u.txt, spacing: u.upper ? u.spacing : 0, literal: true }) + 40;
            [['cluster', 'Cluster'], ['car', 'Car data']].forEach((v, i) => {
                const bw = 180, bx = sx0 + i * (bw + 8), on = diagView === v[0];
                if (on) { cv.roundRect(bx, HEAD_Y + 6, bw, HEAD_H - 12, u.radius, L.withAlpha(acc, 0.22)); cv.strokeRoundRect(bx, HEAD_Y + 6, bw, HEAD_H - 12, u.radius, 2, acc); }
                else cv.roundRect(bx, HEAD_Y + 6, bw, HEAD_H - 12, u.radius, L.withAlpha('#ffffff', 0.06));
                lbl(v[1], bx + bw / 2, HEAD_Y + HEAD_H / 2 + 8, u.size, on ? t.text : t.dim, { align: 'center' });
                if (!on) cv.target(bx, HEAD_Y, bw, HEAD_H, () => { diagView = v[0]; }, 'dv:' + v[0], u.radius);
            });
            if (diagView === 'car') carDiag(cv, S, lk); else clusterDiag(cv, S, lk);
        }
        function diagBox(cv, x, y, w, h) { cv.roundRect(x, y, w, h, 8, L.withAlpha('#000000', 0.55)); cv.strokeRoundRect(x, y, w, h, 8, 1, L.withAlpha('#ffffff', 0.16)); }
        /** Long text in lines of width w (at most n), cut at spaces where it can. */
        function wrapLines(cv, s, size, w, n) {
            const out = [];
            let rest = String(s);
            while (rest && out.length < n) {
                let cut = rest.length;
                while (cut > 1 && cv.textWidth(rest.slice(0, cut), size, { literal: true }) > w) { const sp = rest.lastIndexOf(' ', cut - 1); cut = sp > 0 ? sp : cut - 1; }
                out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^ +/, '');
            }
            if (rest && out.length) out[out.length - 1] = fitText(cv, out[out.length - 1] + ' ' + rest, size, w);
            return out;
        }
        function clusterDiag(cv, S, lk) {
            const t = S.t, u = lk.ui, top = S.y, colW = (S.w - 2 * 16) / 3, F = 18, LH = 26;
            const head = (s, x, y) => cv.text(s, x, y, 19, t.accent2 || t.accent, { font: 'bold', literal: true });
            const put = (x, y, w, s, c, size) => cv.text(fitText(cv, s, size || F, w), x, y, size || F, c || t.text, { literal: true });
            // 1. tools and what each part does now
            let x = S.x, w = colW, y = top + 30;
            diagBox(cv, x, top, w, S.h);
            head('Tools', x + 14, y); y += 28;
            tools().forEach((tv) => { put(x + 14, y, w - 28, tv[0] + ': ' + tv[1], tv[1] === 'not installed' ? '#ffb020' : t.text); y += LH; });
            y += 10; head('Now', x + 14, y); y += 28;
            const paused = { kind: 'pending', text: 'Paused (full-screen cluster test)' };
            const parts = [['Logo', clogo.view()], ['Skins', fcTest ? paused : skinOn() ? cskin.view() : { kind: 'off', text: 'Off (' + displaysLine() + ')' }],
                ['HUD', fcTest ? paused : hudOn() ? hud.view() : { kind: 'off', text: 'Off (' + displaysLine() + ')' }]];
            if (fcTest) parts.push(['Full-screen', fcl.view()]);
            parts.forEach((p) => {
                const tone = logoTone(t, p[1].kind);
                if (tone) cv.circle(x + 20, y - 6, 5, tone);
                wrapLines(cv, p[0] + ': ' + p[1].text, F, w - 48, 2).forEach((l) => { put(x + 32, y, w - 46, l, t.text); y += LH - 2; });
                y += 2;
            });
            put(x + 14, y, w - 28, 'Source: ' + CSRC.NAMES[srcPick()] + (srcPub.error ? ' (not shared: ' + srcPub.text + ')' : ' (shared)'), srcPub.error ? '#ffb020' : t.dim); y += LH;
            put(x + 14, y, w - 28, clogo.routeLine(), t.dim, 16); y += LH + 8;
            head('Clock', x + 14, y); y += 28;
            put(x + 14, y, w - 28, clock.line(), t.text); y += LH;
            put(x + 14, y, w - 28, 'No car clock signal wired: the head unit\'s clock', t.dim, 16); y += 22;
            put(x + 14, y, w - 28, 'Catalog time / date fields: Car data view', t.dim, 16);
            // 2. Waze on cluster, Refresh cluster
            x = S.x + colW + 16; y = top + 30;
            diagBox(cv, x, top, w, S.h);
            head('Waze on cluster', x + 14, y); y += 28;
            const v = cmap.view();
            const vt = v.kind === 'on' ? HUB.GREEN : v.kind === 'pending' || v.kind === 'busy' ? '#ffb020' : v.kind === 'conflict' || v.kind === 'error' ? (t.crit || '#ff3b30') : null;
            if (vt) cv.circle(x + 20, y - 6, 5, vt);
            put(x + (vt ? 32 : 14), y, w - 46, v.value, t.text, 20); y += LH + 2;
            [v.line, v.render, v.note].filter(Boolean).forEach((s2) => wrapLines(cv, s2, 16, w - 28, 3).forEach((l) => { put(x + 14, y, w - 28, l, t.dim, 16); y += 22; }));
            const fh = 92, fy = top + S.h - 14 - fh, done = Date.now() - refreshedAt < REFRESHED_MS;
            cv.roundRect(x + 14, fy, w - 28, fh, u.radius, L.withAlpha(t.sel || t.accent, done ? 0.30 : 0.16));
            cv.strokeRoundRect(x + 14, fy, w - 28, fh, u.radius, 2, t.sel || t.accent);
            const ax = x + 14 + 44, ay = fy + fh / 2;
            cv.arc(ax, ay, 15, 18, 40, 330, t.text);
            cv.quad([[ax + 14, ay - 18], [ax + 22, ay - 4], [ax + 6, ay - 6], [ax + 10, ay - 10]], t.text);
            lblOf(cv, u)(done ? 'Cluster refreshed' : 'Refresh cluster', x + 14 + 82, ay - 2, u.size + 2, t.text);
            put(x + 14 + 82, ay + 24, w - 28 - 96, done ? 'Every G\'s Dash layer remade' : 'Remakes the logo, skins and HUD layers', t.dim, 16);
            cv.target(x + 14, fy, w - 28, fh, () => { gDown = Date.now(); downKey = 'dg:refresh'; refreshCluster(); }, 'dg:refresh', u.radius);
            // 3. the renderer's refusals; parked: the alignment card and the Stock redraw
            x = S.x + 2 * (colW + 16); y = top + 30;
            diagBox(cv, x, top, w, S.h);
            head('Renderer refusals', x + 14, y); y += 28;
            const ref = [['Skins', cskin.refusal()], ['HUD', hud.refusal()], ['Full-screen test', fcl.refusal()]].filter((r) => r[1]);
            if (!ref.length) { put(x + 14, y, w - 28, 'None', t.dim); y += LH; }
            ref.forEach((r) => { wrapLines(cv, r[0] + ' refused: ' + r[1], 15, w - 28, 4).forEach((l) => { put(x + 14, y, w - 28, l, t.warn || t.crit, 15); y += 20; }); y += 6; });
            // 0.12.0: the full-screen cluster test (TEST): off by default, never saved, any gear or speed
            {
                const fh3 = 150, fy3 = top + S.h - 70 - 40 - 26 - fh3, x3 = x + 14, w3 = w - 28, acc3 = t.sel || t.accent;
                cv.roundRect(x3, fy3, w3, fh3, u.radius, L.withAlpha(fcTest ? acc3 : '#ffffff', fcTest ? 0.18 : 0.05));
                cv.strokeRoundRect(x3, fy3, w3, fh3, u.radius, fcTest ? 2 : 1, fcTest ? acc3 : L.withAlpha('#ffffff', 0.16));
                cv.text('Full-screen cluster test', x3 + 16, fy3 + 34, 20, t.text, { font: 'bold', literal: true });
                cv.text('TEST', x3 + 16 + cv.textWidth('Full-screen cluster test', 20, { font: 'bold', literal: true }) + 12, fy3 + 33, 13, '#ffb020', { font: 'bold', literal: true });
                const sw = 66, sh = 34, sx = x3 + w3 - 16 - sw, sy = fy3 + 14;
                cv.roundRect(sx, sy, sw, sh, sh / 2, fcTest ? acc3 : L.withAlpha('#ffffff', 0.18));
                cv.circle(fcTest ? sx + sw - sh / 2 : sx + sh / 2, sy + sh / 2, sh / 2 - 4, '#ffffff');
                const ls = [fcTest ? 'On: classic round dials over the whole cluster panel.' : 'Off. Classic round dials over the whole cluster panel.',
                    'Covers the car\'s warning lights while on.',
                    'Pauses the skins and HUD. Off again after a restart.'];
                ls.forEach((l, i) => put(x3 + 16, fy3 + 70 + i * 24, w3 - 32, l, i === 1 ? '#ffb020' : i ? t.dim : t.text, 16));
                cv.target(x3, fy3, w3, fh3, () => {
                    fcTest = !fcTest;
                    log.info('full-screen cluster test: ' + (fcTest ? 'on (the skins and HUD paused)' : 'off'));
                    logoUpdate(visible());
                }, 'dg:fctest', u.radius);
            }
            const d2 = car.data(), parked = L.isNum(d2.speed) && d2.speed < 1 && d2.stage !== 'D' && d2.stage !== 'R';
            const bw2 = (w - 28 - 12) / 2, by2 = top + S.h - 70, bh2 = 56;
            head('Cluster skins (parked)', x + 14, by2 - 40);
            [['align', 'Alignment card'], ['stock', 'Stock redraw']].forEach((b, i) => {
                const bx = x + 14 + i * (bw2 + 12), on = skinMode === b[0];
                if (on) { cv.roundRect(bx, by2, bw2, bh2, u.radius, L.withAlpha(t.sel || t.accent, 0.25)); cv.strokeRoundRect(bx, by2, bw2, bh2, u.radius, 2, t.sel || t.accent); }
                else cv.roundRect(bx, by2, bw2, bh2, u.radius, L.withAlpha('#ffffff', parked ? 0.08 : 0.03));
                cv.text(b[1], bx + bw2 / 2, by2 + 26, 18, parked || on ? t.text : t.dim, { align: 'center', literal: true });
                cv.text(on ? 'on - tap for the look' : parked ? 'parked: tap to show' : 'parked only', bx + bw2 / 2, by2 + 47, 14, t.dim, { align: 'center', literal: true });
                if (on || parked) cv.target(bx, by2, bw2, bh2, () => { skinMode = on ? 'skin' : b[0]; log.info('cluster skin mode: ' + skinMode); }, 'sk:' + b[0], u.radius);
            });
            if (skinMode !== 'skin') put(x + 14, by2 - 66, w - 28, 'Cluster: ' + cskin.view().text, t.dim, 15);
        }
        function carDiag(cv, S, lk) {
            const t = S.t;
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
                const rows = Math.floor((top + S.h - 30 - y) / 22);
                out.slice(0, rows).forEach((l) => {
                    cv.text(fitText(cv, l[1], 17, w - 28, l[0] === 'row' ? mono : {}), x + 14, y, 17, l[0] === 'head' ? t.text : l[0] === 'warn' ? (t.warn || t.crit) : t.dim, l[0] === 'row' ? { font: 'num', literal: true } : { literal: true });
                    y += 22;
                });
                if (out.length > rows) put(x + 14, y - 2, w - 28, '+ ' + (out.length - rows) + ' more lines', t.dim, 15);
            }
        }
        // the Cluster & HUD page's five picks of the cluster's centre (0.8.3, cluster_source.js)
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
        /**
         * Cluster & HUD (0.10.0). Left: what the cluster's centre map area shows - the five picks (setting
         * "clusterSource"), the Now card (what is there now and why, the rules at its foot; one amber line to
         * Diagnostics only when something is wrong), and CarPlay's map in the cluster Off / On only when Waze
         * on cluster is installed (a change asks first: the confirmation over the page, the page's own targets
         * left out meanwhile). Right: your look on the car's displays (setting "displays"): Cluster dials, HUD
         * or Neither, and what it does now. The renderer's state, Waze's install state and Refresh cluster
         * are on Diagnostics.
         */
        function clusterPage(cv, S, lk) {
            const t = S.t, u = lk.ui, lbl = lblOf(cv, u), card = cardOf(lk), acc = t.sel || t.accent;
            const mark = cv.targets ? cv.targets.length : 0;
            header(cv, S, lk, lbl, card, 'Cluster & HUD', 1);
            const v = cmap.view(), x0 = S.x, LW = Math.round(S.w * 0.655), bottom = S.y + S.h, cur = srcPick(), top = S.y + 34;
            if (ask && (Date.now() - ask.at > ASK_MS || v.can !== ask.cmd)) ask = null;
            lbl('In the cluster\'s centre (map area)', x0, S.y + 20, 18, t.dim);
            // the five picks
            const n = SRC_TILES.length, gap = 12, tw = (LW - (n - 1) * gap) / n, th = 166;
            const pw = tw - 20, ph = Math.min(Math.round(pw * 480 / 1088), th - 76), tf = { font: u.txt, spacing: u.upper ? u.spacing * 0.6 : 0, literal: true };
            SRC_TILES.forEach((s2, i) => {
                const bx = x0 + i * (tw + gap), sel = cur === s2[0];
                if (sel) { cv.roundRect(bx, top, tw, th, u.radius, L.withAlpha(acc, 0.20)); cv.strokeRoundRect(bx, top, tw, th, u.radius, 3, acc); }
                else card(cv, t, bx, top, tw, th, isDown('src:' + s2[0]));
                srcThumb(cv, s2[0], bx + 10, top + 10, pw, ph, sel);
                const nm = CSRC.NAMES[s2[0]];
                cv.text(fitText(cv, valueText(u, nm), u.size + 4, tw - 60, tf), bx + 14, top + ph + 44, u.size + 4, t.text, tf);
                cv.text(fitText(cv, s2[1], 15, tw - 24), bx + 14, top + ph + 68, 15, sel ? t.text : t.dim, { literal: true });
                if (sel) {
                    const cx = bx + tw - 26, cy = top + ph + 36;
                    cv.circle(cx, cy, 12, acc);
                    cv.line(cx - 6, cy, cx - 1, cy + 5, 3, t.selText || '#ffffff'); cv.line(cx - 1, cy + 5, cx + 7, cy - 5, 3, t.selText || '#ffffff');
                } else cv.target(bx, top, tw, th, () => { gDown = Date.now(); downKey = 'src:' + s2[0]; settings.set('clusterSource', s2[0]); }, 'src:' + s2[0], u.radius);
            });
            // CarPlay's map (Waze on cluster): only when the tool is installed
            const waze = v.kind !== 'none' && v.kind !== 'checking', mh = 84;
            // what the cluster shows now, and why; the rules at the foot
            const nc = nowCard(), sy = top + th + 14, sh = bottom - (waze ? mh + 14 : 0) - sy;
            const tone = nc.tone === 'ok' ? HUB.GREEN : nc.tone === 'wait' ? '#ffb020' : t.dim;
            cv.roundRect(x0, sy, LW, sh, u.radius, L.withAlpha('#ffffff', 0.04));
            cv.strokeRoundRect(x0, sy, LW, sh, u.radius, 1, L.withAlpha('#ffffff', 0.12));
            cv.circle(x0 + 26, sy + 27, 8, tone);
            lbl(fitText(cv, nc.title, 24, LW - 70), x0 + 46, sy + 36, 24, t.text);
            const RULES = ['Your pick stays put. Route guidance always shows directions, then back to your pick.',
                "G's TV only after its own Cluster button (parked). Shared with G's Music and G's TV."];
            const ruleY = sy + sh - 18 - (RULES.length - 1) * 24;
            let ly = sy + 64;
            const line = (s2, c) => { if (ly > ruleY - 30) return; cv.text(fitText(cv, s2, 17, LW - 44), x0 + 22, ly, 17, c, { literal: true }); ly += 26; };
            if (nc.sub) line(nc.sub, t.dim);
            nc.notes.forEach((nt) => line(nt[0], nt[1] === 'warn' ? '#ffb020' : t.dim));
            if (clusterTrouble()) line('Something needs attention: details in Options > Diagnostics', '#ffb020');
            RULES.forEach((r2, k) => cv.text(fitText(cv, r2, 15, LW - 44), x0 + 22, ruleY + k * 24, 15, L.withAlpha(t.dim, 0.9), { literal: true }));
            if (waze) {
                const wy = bottom - mh, vt = v.kind === 'on' ? HUB.GREEN : v.kind === 'pending' || v.kind === 'busy' ? '#ffb020' : v.kind === 'conflict' || v.kind === 'error' ? (t.crit || '#ff3b30') : null;
                card(cv, t, x0, wy, LW, mh, false);
                const bw = 110, bx0 = x0 + LW - 2 * bw - 18;
                rowText(cv, S, lk, x0 + (vt ? 18 : 0), wy, bx0 - x0 - 12 - (vt ? 18 : 0), mh, 'CarPlay map in the cluster (Waze on cluster)', v.value, { shrink: true });
                if (vt) cv.circle(x0 + 22, wy + mh - 20, 6, vt);
                [[false, 'Off', 'revert'], [true, 'On', 'apply']].forEach((b, i) => {
                    const bx = bx0 + i * (bw + 6), on = v.on === b[0], tap = v.can === b[2], by = wy + (mh - 56) / 2, bh = 56;
                    if (on) { cv.roundRect(bx, by, bw, bh, u.radius, L.withAlpha(acc, 0.22)); cv.strokeRoundRect(bx, by, bw, bh, u.radius, 2, acc); }
                    else cv.roundRect(bx, by, bw, bh, u.radius, L.withAlpha('#ffffff', 0.06));
                    cv.text(u.upper ? b[1].toUpperCase() : b[1], bx + bw / 2, by + bh / 2 + 9, 24, on || tap ? t.text : L.withAlpha(t.dim, 0.55), { font: u.txt, align: 'center', spacing: u.upper ? u.spacing : 0, literal: true });
                    if (tap) cv.target(bx, by, bw, bh, () => { ask = { cmd: b[2], at: Date.now() }; }, 'cm:' + b[1].toLowerCase(), u.radius);
                });
            }
            // your look on the car's displays: one of three
            const rx = x0 + LW + 32, rw = S.x + S.w - rx, dcur = displays();
            lbl('Your look on the car\'s displays', rx, S.y + 20, 18, t.dim);
            const oh = 76, og = 10;
            PREFS.DISPLAYS.forEach((o, i) => {
                const oy = top + i * (oh + og), on = dcur === o[0];
                if (on) { cv.roundRect(rx, oy, rw, oh, u.radius, L.withAlpha(acc, 0.22)); cv.strokeRoundRect(rx, oy, rw, oh, u.radius, 2.5, acc); }
                else card(cv, t, rx, oy, rw, oh, isDown('disp:' + o[0]));
                cv.arc(rx + 30, oy + oh / 2, 11, 13, 0, 360, on ? acc : t.dim);
                if (on) cv.circle(rx + 30, oy + oh / 2, 6, acc);
                cv.text(fitText(cv, valueText(u, o[1]), u.size + 2, rw - 70, tf), rx + 58, oy + 34, u.size + 2, on ? t.text : t.dim, tf);
                cv.text(fitText(cv, o[2], 16, rw - 70), rx + 58, oy + 60, 16, t.dim, { literal: true });
                if (!on) cv.target(rx, oy, rw, oh, () => { gDown = Date.now(); downKey = 'disp:' + o[0]; settings.set('displays', o[0]); log.info('displays: ' + o[0]); }, 'disp:' + o[0], u.radius);
            });
            const st = fcTest && dcur !== 'none' ? { kind: 'pending', text: 'Paused (full-screen cluster test)' } : dcur === 'skin' ? cskin.view() : dcur === 'hud' ? hud.view() : null, dy = top + 3 * (oh + og) + 18;
            if (st) { cv.circle(rx + 7, dy - 6, 6, logoTone(t, st.kind) || t.dim); cv.text(fitText(cv, st.text, 17, rw - 22), rx + 22, dy, 17, t.text, { literal: true }); }
            else cv.text(fitText(cv, "Nothing of ours on the dials or HUD", 17, rw), rx, dy, 17, t.dim, { literal: true });
            cv.text(fitText(cv, 'One at a time: they share one display layer.', 15, rw), rx, dy + 26, 15, t.dim, { literal: true });
            linkMini(cv, S, lk, rx, bottom - 64, rw, 64, 'cs:diag', 'Diagnostics', () => { DIAG.reset(); press(3, 'cs:diag'); });
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

        // the Showcase pictures (app root PNGs, copied next to main.js by the build, never changed): decoded
        // once; pictures.js prepares their pixels for the size and the renderer path they show on (0.11.0)
        const src = { car: null, logo: null };
        [['car', 'showcase_car.png'], ['logo', 'showcase_logo.png']].forEach((p) => {
            try { src[p[0]] = PNG.decode(fs.readFileSync(path.join(__dirname, p[1]))); } catch (e) { log.warn('showcase picture ' + p[1] + ': ' + e.message); }
        });
        const SC = {
            src, ids: IMG, waveW: WAVE_W, base: waveBase, music: true,
            waves: new Waves((w, h, d) => { record.setImage(IMG.wave, w, h, d); }),
            pics: new Pictures((id, w, h, d) => { record.setImage(id, w, h, d); }),
        };
        let gRectNow = null;
        /**
         * Drive's favourite looks (0.10.0): the gear (the look's S.zones.gear) takes a tap (favTap), after the
         * look's own targets (its session clock wins where they meet); the toast (the look now, or the hint)
         * under the speed's unit. 0.11.0: the gear only - a tap on the speed does nothing - and no stars on
         * Drive (favourites are starred on Theme).
         */
        function favDrive(cv, S, lk) {
            const z = S.zones;
            if (!z) return;
            const u = lk.ui;
            // 0.11.0: the gear only (the speed no longer switches), and no stars on the dash
            if (z.gear) cv.target(z.gear.x, z.gear.y, z.gear.w, z.gear.h, () => favTap(S), 'favlook:gear', 0);
            if (!lookToast) return;
            const age = Date.now() - lookToast.at;
            if (age > LOOK_TOAST_MS || age < 0 || !z.toast) { if (age > LOOK_TOAST_MS) lookToast = null; return; }
            const f = { font: u.txt, spacing: u.upper ? u.spacing * 0.6 : 0, literal: true };
            const a = valueText(u, lookToast.lines[0]), b = lookToast.lines[1] || '';
            const aw = cv.textWidth(a, 24, f), bw = b ? cv.textWidth(b, 17, { literal: true }) : 0;
            const w = Math.min(S.w - 20, 34 + aw + (b ? 24 + bw : 0) + 34), h = 52;
            const x = Math.max(S.x + 10, Math.min(S.x + S.w - 10 - w, z.toast.x - w / 2)), y = z.toast.y;
            cv.roundRect(x, y, w, h, h / 2, L.withAlpha('#000000', 0.82));
            cv.strokeRoundRect(x, y, w, h, h / 2, 2, STAR);
            cv.text(a, x + 34, y + h / 2 + 9, 24, '#ffffff', f);
            if (b) cv.text(b, x + 34 + aw + 24, y + h / 2 + 7, 17, '#c8ced8', { literal: true });
        }
        log.info(clock.line() + ' (Showcase, 12-hour H:MM)');

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
            // the patch service's socket: open only while Cluster & HUD or Diagnostics is on screen
            if ((page === 4 || page === 3) && visible()) cmap.open(); else { cmap.close(); ask = null; }
            if (page === 1) optionsPage(cv, P, lk);
            else if (page === 2) spotifyPage(cv, P, lk);
            else if (page === 4) clusterPage(cv, P, lk);
            else if (page === 5) themePage(cv, P, lk);
            else if (page === 3) diagPage(cv, P, lk);
            else if (page === 6) drivingPage(cv, P, lk);
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
                    S.zones = null;
                    lk.draw(cv, S);
                    if (S.panel === 'spotify') music.panel(cv, S, lk, lk.panelRect(S), HUB.dotsBox(gr, HUB.SCREENS.length));
                    if (cv.own) favDrive(cv, S, lk);
                } else if (id === 'showcase') { SC.music = showcaseMusic(); SC.dim = PREFS.bgLevel(settings.get(PREFS.BG_KEY)); HUB.showcase(cv, st, S, music, lk, gr, SC, clock.now(S.now)); }
                else if (id === 'warmup') HUB.warmup(cv, st, Object.assign({}, S, { redline: WARM_REDLINE, maxRpm: Math.max(7000, S.maxRpm) }), warmModel(S));
                else if (id === 'gforce') HUB.gforce(cv, st, S, gModel(S));
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
