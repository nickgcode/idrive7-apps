'use strict';
/**
 * car.js - the common driving signals, scaled, with demo fallback.
 *
 *   const car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear', 'torque'], { demo: false });
 *   car.data()      -> { rpm, speed, gLong, gLat, coolant, oil, gear, torque, driveMode, tyres, demo }
 *   car.onSample(fn)-> fn(data, tMs) on every new speed/rpm/accel sample (also in demo, 20 Hz)
 *   opts.demo false: car data only, never the demo feed (the "demo" setting is not read)
 *
 * Scalings are BMW's own (M Laptimer TypeConverters); an app's app.json
 * "config.scaling" entries override them. The app's app.json "signals" must
 * list the interfaces (see SIGNALS below for the exact entries).
 * Demo: setting "demo" = auto (until the car answers) / on / off.
 * data().stage = the selector position 'P' / 'R' / 'N' / 'D' (gearbox signal), else undefined.
 */
const Sim = require('./sim');

const SCALE = {
    rpm: { factor: 0.25, offset: 0, invalid: 65535 },
    speed: { factor: 0.015625, offset: 0, invalid: 65535 },
    accel: { factor: 0.002, offset: -65, invalid: 65535 },
    temp: { factor: 1, offset: -48, invalid: 255 },
    // 12 bit, 0.5 Nm per bit with 0 Nm at raw 2047 (negative = engine braking), 4095 = 'no value'
    torque: { factor: 0.5, offset: -1023.5, invalid: 65535, invalidFrom: 4095 },
};
const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
// the binding may hand enums over as names or as wire numbers (G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2)
const gearOf = (x) => (typeof x === 'number' ? (x >= 3 && x <= 12 ? x - 2 : x === 1 ? -1 : x === 2 ? 0 : undefined) : GEARS[x]);
// selector position (statusActualStageDrive): names or wire numbers (P = 1, R = 2, N = 3, D = 4);
// the gear field alone can't tell P from N (both N_OR_P)
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
const stageOf = (x) => STAGES[x];
/**
 * DataPowerTrain2.statusGearSelectionDrive: P / R / N and the engaged gear in one enum, names or
 * wire numbers (N = 1, R = 2, P = 3, NP = 4, _1 = 5 ... _9 = 13) -> { stage, gear } or undefined.
 * Some cars never send statusGearboxDrive; this field comes in another event group.
 */
function selectionOf(x) {
    const n = typeof x === 'number' ? x : { N: 1, R: 2, P: 3, NP: 4 }[x] || (/^_\d$/.test(String(x)) ? 4 + Number(String(x).slice(1)) : undefined);
    if (n === 1) return { stage: 'N', gear: 0 };
    if (n === 2) return { stage: 'R', gear: -1 };
    if (n === 3) return { stage: 'P', gear: 0 };
    if (n === 4) return { stage: undefined, gear: 0 };              // N or P, not told apart
    if (n >= 5 && n <= 13) return { stage: 'D', gear: n - 4 };
    return undefined;                                               // initialising / invalid
}

/**
 * The overall drive mode (Driving Experience Control) is FES.statusFESVehicleDynamicSwitchHMI
 * .actualValueModeDrivingExperience, an enum (DrivingExcitementTypes) the binding hands over by
 * name or by wire number. The modes a BMW's switch selects map to the badge; anything else
 * (INITIALISIERUNG, SIGNAL_UNGUELTIG, offroad, PHEV, ...) shows no badge. The struct's
 * requestSwitchDrivingExperience*Display flags say the car shows its own mode pop-up: logged, and
 * a value with one set counts as a change at once.
 */
const MODE_FIELD = 'statusFESVehicleDynamicSwitchHMI', MODE_MEMBER = 'actualValueModeDrivingExperience';
const MODE_ENUM = {
    SPORT_DYNAMIC: 1, SPORT_EXPERT: 2, SPORT_INDIVIDUAL: 3, COMFORT: 4, COMFORT_PLUS: 5, COMFORT_INDIVIDUAL: 6,
    ECO_PRO_EFFICIENT: 7, ECO_PRO_PLUS: 8, ECO_PRO_INDIVIDUAL: 9, ADAPTIVE: 10, INITIALISIERUNG: 0,
};
const MODE_LABEL = { 1: 'SPORT', 2: 'SPORT+', 3: 'INDIVIDUAL', 4: 'COMFORT', 5: 'COMFORT+', 6: 'INDIVIDUAL',
    7: 'ECO PRO', 8: 'ECO PRO+', 9: 'INDIVIDUAL', 10: 'ADAPTIVE' };
/** an enum value (name, number, or a number as text) -> its wire number, or undefined */
function modeNumber(x) {
    if (typeof x === 'number') return isFinite(x) ? x : undefined;
    if (typeof x !== 'string') return undefined;
    const t = x.trim();
    if (/^\d+$/.test(t)) return Number(t);
    const n = MODE_ENUM[t.toUpperCase()];
    return n === undefined ? undefined : n;
}
/** -> the badge label ('SPORT', 'SPORT+', 'ECO PRO', 'COMFORT', ...) or undefined (no badge) */
function modeOf(x) { const n = modeNumber(x); return n === undefined ? undefined : MODE_LABEL[n]; }
const popupOn = (x) => x === 1 || x === 'KOMBI_LISTE_ANZEIGEN' || x === 'MMI_MINUS_TAFEL_ANZEIGEN';
/** every member of a struct (nested up to 3 deep) -> [path, value] */
function members(v, pre, out, depth) {
    out = out || []; pre = pre || '';
    if (v === null || typeof v !== 'object' || (depth || 0) > 3) { if (pre) out.push([pre, v]); return out; }
    Object.keys(v).forEach((k) => members(v[k], pre ? pre + '.' + k : k, out, (depth || 0) + 1));
    return out;
}
/** the field's value -> { mode, raw, popup } */
function decodeMode(v) {
    const raw = v && typeof v === 'object' ? v[MODE_MEMBER] : v;
    return { mode: modeOf(raw), raw, popup: !!(v && typeof v === 'object' && (popupOn(v.requestSwitchDrivingExperienceInstrumentPackDisplay) || popupOn(v.requestSwitchDrivingExperienceMMIDisplay))) };
}

/*
 * Tyres (TPMS), read only (status fields; chassisControl, the settable one, is never touched). The car
 * sends pressures as 0.1 x raw in its own pressure unit (>= 65532 = no value) and temperatures as its
 * own degrees + 40 (65535 = no value); its units come from Vehicle.statusNewCurrentUnitsStatusExt.
 * Until those are known each unit's plausible tyre pressures lie apart (bar 0.5-6, psi 7-60, kPa 60-600),
 * so only one fits; psi then also means deg F. Scaling from BMW's converters and upstream's car tests,
 * not confirmed on this car: every raw set goes to the log ('tpms raw').
 */
const TYRES = ['FLH', 'FRH', 'RLH', 'RRH'];
const PRESS_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI', BAR: 'BAR', KPA: 'KPA', PSI: 'PSI' }, TEMP_UNITS = { 1: 'C', 2: 'F', C: 'C', F: 'F' };
const TO_PSI = { BAR: 14.5038, KPA: 0.145038, PSI: 1 };
const tyreRaw = (x, bad) => (typeof x === 'number' && isFinite(x) && x < bad ? x : null);

// app.json "signals" entries per group (copy into the app)
const SIGNALS = {
    rpm: ['de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2'],
    temps: ['de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature'],
    speed: ['de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2'],
    accel: ['de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', 'statusLateralAccelerationMassCenter'],
    gear: ['de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive', 'DataPowerTrain2'],
    torque: ['de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2'],
    drivemode: ['de.bmw.infotainment.drivingexcitement.FES', MODE_FIELD],
    // with Vehicle.statusNewCurrentUnitsStatusExt (the car's units), all "rs"; read every 10 s as well
    tpms: ['de.bmw.infotainment.vehicle.TPMS', 'statusTyrePressure', 'statusTyreTemperature', 'statusTargetTyrePressure', 'statusTyresStatus'],
    units: ['de.bmw.infotainment.vehicle.Vehicle', 'statusNewCurrentUnitsStatusExt'],
};

/**
 * Learns the gearbox from rpm/speed ratios (one cluster per gear) so a gear
 * can be shown even when the car doesn't publish statusGearboxDrive.
 */
class GearGuess {
    constructor() { this.cl = []; }
    feed(rpm, kmh) {
        if (!(rpm > 1100 && kmh > 8)) return null;
        const k = rpm / kmh;
        let c = this.cl.find((x) => Math.abs(x.k - k) / x.k < 0.05);
        if (!c) { if (this.cl.length > 24) this.cl.sort((a, b) => b.n - a.n).pop(); c = { k, n: 0 }; this.cl.push(c); }
        c.n++; c.k += (k - c.k) / Math.min(c.n, 50);
        const gears = this.cl.filter((x) => x.n > 30).sort((a, b) => b.k - a.k);
        const i = gears.findIndex((x) => Math.abs(x.k - k) / x.k < 0.05);
        return i < 0 ? null : i + 1;
    }
}

class Car {
    constructor(ctx, groups, opts) {
        this.ctx = ctx; this.log = ctx.log; this.opts = opts || {};
        const over = (ctx.spec.config && ctx.spec.config.scaling) || {};
        this.S = Object.assign({}, SCALE, over);
        this.live = {}; this.lastCar = 0; this.listeners = [];
        this.modeDiag = {}; this.subBy = {}; this.tyreRaw = {}; this.units = { press: null, temp: null, psiSeen: false };    // drivemode group: field -> latest raw (car only); iface -> its subscription
        this.sim = new Sim(); this.simData = this.sim.sample();
        this.demoActive = false; this.guess = new GearGuess();
        const sc = (k, raw) => {
            const c = this.S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid || (c.invalidFrom !== undefined && raw >= c.invalidFrom)) return null;
            return raw * c.factor + (c.offset || 0);
        };
        const put = (k, v, tick) => {
            if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return;
            this.live[k] = v; this.lastCar = Date.now();
            // learned gear while driving; nothing at a standstill - the guess can't tell P, N or D
            // there, and "N" shown in park or in D was wrong
            if (k === 'rpm' || k === 'speed') { const g = this.guess.feed(this.live.rpm, this.live.speed); if (g !== null || this.live.speed < 3) this.guessed = this.live.speed < 3 ? undefined : g; }
            if (tick && !this.demoActive) this._emit(this.live, this.lastCar);
        };
        const watches = {};
        const pollOf = {};
        const add = (iface, field, fn, pollMs) => { (watches[iface] = watches[iface] || {})[field] = fn; if (pollMs) pollOf[iface] = pollMs; };
        if (groups.includes('rpm')) add('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', (v) => put('rpm', sc('rpm', v.actualValueRPMEngineCrankshaft), true));
        if (groups.includes('temps')) add('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', (v) => { put('coolant', sc('temp', v.temperatureEngineDrive)); put('oil', sc('temp', v.temperatureEngineOilDrive)); });
        if (groups.includes('speed')) add('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', (v) => put('speed', sc('speed', v.speedVehicleCentreOfGravity), true));
        if (groups.includes('accel')) {
            add('de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', (v) => { const a = sc('accel', v.longitudinalAccelerationCentreOfGravity); put('gLong', a === null ? null : a / 9.80665, true); });
            add('de.bmw.infotainment.vehicle.CDS2', 'statusLateralAccelerationMassCenter', (v) => { const a = sc('accel', v.lateralAccelerationCentreOfGravity); put('gLat', a === null ? null : a / 9.80665); });
        }
        if (groups.includes('gear')) {
            add('de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive', (v) => {
                const g = gearOf(v.statusActualGearDrive), s = stageOf(v.statusActualStageDrive);
                if (s !== undefined) put('stage', s);
                if (g !== undefined) put('gear', g);
            });
            const selSeen = [];
            add('de.bmw.infrastructure.VehicleInformation', 'DataPowerTrain2', (v) => {
                const raw = v && v.statusGearSelectionDrive, sel = selectionOf(raw);
                if (selSeen.length < 12 && selSeen.indexOf(String(raw)) < 0) { selSeen.push(String(raw)); this.log.info('gear selection: ' + JSON.stringify(raw)); }
                if (!sel) return;
                if (sel.stage !== undefined) put('stage', sel.stage);
                put('gear', sel.gear);
            });
        }
        // negative torque (engine braking while the rpm falls) counts as 0
        if (groups.includes('torque')) add('de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2', (v) => { const tq = sc('torque', v.actualValueTorqueCrankshaft); put('torque', tq === null ? null : Math.max(0, tq)); });
        if (groups.includes('drivemode')) {
            const seen = [];
            let full = 0;
            add(SIGNALS.drivemode[0], MODE_FIELD, (v) => {
                const d = decodeMode(v), was = this.modeDiag[MODE_FIELD];
                // the latest value as received, for a diagnostics page (driveModeDiag): car data only
                this.modeDiag[MODE_FIELD] = { at: Date.now(), count: (was ? was.count : 0) + 1, members: members(v).slice(0, 48),
                    mode: d.mode, raw: d.raw, popup: d.popup, from: MODE_MEMBER };
                // raw logging, capped: the whole value twice, then each new raw mode value / pop-up state
                if (full < 2) { full++; this.log.info('drive mode raw ' + MODE_FIELD + ': ' + JSON.stringify(v)); }
                const sig = JSON.stringify([d.raw, d.popup]);
                if (seen.length < 32 && seen.indexOf(sig) < 0) { seen.push(sig); this.log.info('drive mode raw ' + MODE_MEMBER + ' = ' + JSON.stringify(d.raw) + (d.popup ? ' (car shows its mode pop-up)' : '') + ' -> ' + (d.mode || 'no badge')); }
                if (d.mode === this.live.driveMode && !d.popup) return;
                if (d.mode !== this.live.driveMode) this.log.info('drive mode: ' + (d.mode || 'none') + ' (raw ' + JSON.stringify(d.raw) + ')');
                if (d.mode) { put('driveMode', d.mode); this.live.driveModeAt = Date.now(); } else delete this.live.driveMode;
            });
        }
        if (groups.includes('tpms')) {
            const T = SIGNALS.tpms[0], seen = {};
            const logRaw = (what, vals) => {
                const k = JSON.stringify(vals), s0 = seen[what] = seen[what] || [];
                if (s0.length < 40 && s0.indexOf(k) < 0) { s0.push(k); this.log.info('tpms raw ' + what + ': ' + k + ' (units: pressure ' + (this.units.press || '?') + ', temperature ' + (this.units.temp || '?') + ')'); }
            };
            const tyres = () => (this.live.tyres = this.live.tyres || { p: {}, t: {}, target: {}, at: 0, status: null });
            // a pressure in psi, or null; t: true for the target pressures
            const psi = (raw) => {
                const r = tyreRaw(raw, 65532);
                if (r === null) return null;
                const v = r * 0.1, k = TO_PSI[this.units.press];
                let out;
                if (k) out = v * k;
                else if (v >= 0.5 && v <= 6) out = v * 14.5038;
                else if (v >= 7 && v < 60) { this.units.psiSeen = true; out = v; }
                else if (v >= 60 && v <= 600) out = v * 0.145038;
                else return null;
                return out >= 0 && out <= 90 ? out : null;
            };
            const degF = (raw) => {
                const r = tyreRaw(raw, 65535);
                if (r === null) return null;
                const v = r - 40, f = this.units.temp ? this.units.temp === 'F' : this.units.psiSeen;
                const out = f ? v : v * 9 / 5 + 32;
                return out >= -40 && out <= 300 ? out : null;
            };
            const four = (v, pre, fn, into, what) => {
                const vals = TYRES.map((p) => (v ? v[pre + p] : undefined));
                logRaw(what, vals);
                if (v && vals.every((x) => x === undefined)) logRaw(what + ' members', Object.keys(v));
                const ty = tyres();
                let any = false;
                TYRES.forEach((p, i) => { const x = fn(vals[i]); ty[into][p] = x; if (x !== null) any = true; });
                ty.raw = ty.raw || {}; ty.raw[what] = vals;
                if (any) { ty.at = Date.now(); this.lastCar = Date.now(); }
            };
            add(T, 'statusTyrePressure', (v) => four(v, 'actualValuePressureTyre', psi, 'p', 'pressure'), 10000);
            add(T, 'statusTyreTemperature', (v) => four(v, 'actualValueTemperatureTyre', degF, 't', 'temperature'), 10000);
            add(T, 'statusTargetTyrePressure', (v) => four(v, 'targetPressureTyre', psi, 'target', 'target pressure'), 10000);
            add(T, 'statusTyresStatus', (v) => { logRaw('status', v); tyres().status = v || null; }, 10000);
        }
        if (groups.includes('units')) {
            add(SIGNALS.units[0], SIGNALS.units[1], (v) => {
                const press = PRESS_UNITS[v && v.unitOfMeasurementAirPressure] || null, temp = TEMP_UNITS[v && v.unitOfMeasurementTemperature] || null;
                this.units.time = v ? v.unitOfMeasurementTime : undefined;
                if (press === this.units.press && temp === this.units.temp) return;
                this.units.press = press; this.units.temp = temp;
                this.log.info('car units: pressure ' + (press || '?') + ', temperature ' + (temp || '?') + ' (raw ' + JSON.stringify([v && v.unitOfMeasurementAirPressure, v && v.unitOfMeasurementTemperature]) + ')');
            }, 10000);
        }
        // a parked car sends nothing new for minutes (fields are notified on change), so "no data for
        // a while" doesn't mean "no car": once a signal's provider is there, stay on live data
        this.subs = [];
        this.t0 = Date.now();
        Object.keys(watches).forEach((iface) => ctx.signals.watch(iface, '1', watches[iface], this.log, pollOf[iface] ? { pollMs: pollOf[iface] } : undefined)
            .then((s) => { this.subs.push(s); this.subBy[iface] = s; this.log.info('signal ' + iface.split('.').pop() + (s.error ? ' error: ' + s.error : ' subscribed')); }));

        // demo feed (20 Hz) - also keeps the sim warm so switching is seamless. On a busy or
        // slow CPU the timer fires late; replay every missed 50 ms step (up to 3 s) with its own
        // timestamp, so timers, dyno and brake maths see the same data on any machine.
        let simT = Date.now();
        if (this.opts.demo !== false) setInterval(() => {
            const now = Date.now();
            if (now - simT > 3000) simT = now - 3000;
            const d = this._wantDemo();
            if (d !== this.demoActive) { this.demoActive = d; this.log.info(d ? 'demo data on' : 'live car data'); this.listeners.forEach((l) => l.reset && l.reset()); }
            while (simT + 50 <= now) {
                simT += 50;
                this.simData = this.sim.sample(simT);
                if (d) this._emit(this.simData, simT);
            }
        }, 50);
    }

    /** Has the car answered: a value arrived, or a signal's provider is available. */
    carPresent() { return this.lastCar > 0 || this.subs.some((s) => s.available); }

    _wantDemo() {
        if (this.opts.demo === false) return false;
        const m = this.ctx.settings.get('demo');
        return m === 'on' || (m !== 'off' && !this.carPresent() && Date.now() - this.t0 > 5000);
    }

    data() {
        const src = this.demoActive ? this.simData : this.live;
        const d = Object.assign({}, src, { demo: this.demoActive });
        if (d.gear === undefined && !this.demoActive) { d.gear = this.guessed; d.gearGuessed = true; }
        return d;
    }

    /**
     * The drive mode group's state for a diagnostics page: the interface's subscription and, per field,
     * the latest value the car sent ({ at, count, members [[path, value]], mode, from, conflict }, or
     * null: nothing received). Never demo data: the demo feed does not touch it.
     */
    driveModeDiag() {
        const iface = SIGNALS.drivemode[0], s = this.subBy[iface];
        const fields = {};
        fields[MODE_FIELD] = this.modeDiag[MODE_FIELD] || null;
        return { iface, sub: s ? { error: s.error || null, available: !!s.available } : null, fields, mode: this.live.driveMode || null };
    }

    /** The tyre group's state for a diagnostics page: subscription, units, the raw values last received. */
    tyreDiag() {
        const s = this.subBy[SIGNALS.tpms[0]], ty = this.live.tyres;
        return { sub: s ? { error: s.error || null, available: !!s.available } : null, units: this.units, raw: ty && ty.raw ? ty.raw : null, at: ty ? ty.at : 0, status: ty ? ty.status : null };
    }

    /** fn(data, tMs) per sample; fn.reset() (optional) when the source switches live<->demo. */
    onSample(fn, reset) { this.listeners.push({ fn, reset }); }

    _emit(d, t) {
        const data = Object.assign({}, d, { demo: this.demoActive });
        this.listeners.forEach((l) => { try { l.fn(data, t); } catch (e) { this.log.warn('sample: ' + e); } });
    }
}

Car.SIGNALS = SIGNALS;
Car.decodeMode = decodeMode;
Car.modeOf = modeOf;
Car.MODE_FIELD = MODE_FIELD;
Car.members = members;
Car.GearGuess = GearGuess;
Car.selectionOf = selectionOf;
module.exports = Car;
