'use strict';
/**
 * fuel.js - the fuel level and range for the Drive page's "Bottom bars: Fuel" choice. Car data only:
 * a value the car did not send stays null (shown as '--'), nothing is estimated.
 *
 * Sources (all "_optional" in app.json; from the head unit's interface catalog, NOT yet seen on a car,
 * so every first raw value is logged):
 *   de.bmw.infotainment.lsc.LSCDataSink    .fuelSupply            relativeFuelLevelEstimate -> the %
 *       (UInt16; read as % when <= 100, as 0.1 % once a value above 100 arrives; 65535 = none)
 *   de.bmw.infotainment.KombiIF            .statusRangeTankStatus range (km), the reserve flag
 *       (statusFluidLevelFuelTankSpare AKTIV), fluidLevelFuelTank (litres, only when no % arrives).
 *       Only those three members are read; the struct's other members (the odometer) are never kept or logged.
 *   de.bmw.powertrain.Range                .dataRangeDisplay      dataRangeDisplayTotal in unitRangeDisplay
 *       (KILOMETER / MEILEN), rangeWarningFuelLevel GERING = the car's own low-fuel warning
 * Low fuel: the car's reserve / warning flag when it sends one, else at LOW_PCT %.
 */
const KM_MI = 0.621371, L_GAL = 0.264172, LOW_PCT = 15;
const IFACE = {
    lsc: 'de.bmw.infotainment.lsc.LSCDataSink',
    kombi: 'de.bmw.infotainment.KombiIF',
    range: 'de.bmw.powertrain.Range',
};
const n = (x, max) => (typeof x === 'number' && isFinite(x) && x >= 0 && x <= max ? x : null);
const en = (x, names) => (typeof x === 'number' ? x : typeof x === 'string' ? (names[x.toUpperCase()] !== undefined ? names[x.toUpperCase()] : (/^\d+$/.test(x) ? Number(x) : undefined)) : undefined);

class Fuel {
    constructor() {
        this.v = { pct: null, kombiKm: null, rangeTotal: null, rangeUnit: null, litres: null, reserve: null, warn: null, tenths: false };
        this.at = 0;
    }
    /** LSCDataSink.fuelSupply */
    lsc(v) {
        const r = n(v && v.relativeFuelLevelEstimate, 1000);
        if (r === null) return;
        if (r > 100) this.v.tenths = true;
        this.v.pct = this.v.tenths ? r / 10 : r; this.at = Date.now();
    }
    /** KombiIF.statusRangeTankStatus (only range, the reserve flag and the litres are read) */
    kombi(v) {
        if (!v) return;
        const km = n(v.range, 2500), l = n(v.fluidLevelFuelTank, 254);
        const sp = en(v.statusFluidLevelFuelTankSpare, { NICHT_AKTIV: 0, AKTIV: 1, SIGNAL_UNGUELTIG: 3 });
        this.v.kombiKm = km; this.v.litres = l;
        this.v.reserve = sp === 1 ? true : sp === 0 ? false : null;
        if (km !== null || l !== null || this.v.reserve !== null) this.at = Date.now();
    }
    /** powertrain.Range.dataRangeDisplay */
    range(v) {
        if (!v) return;
        const unit = en(v.unitRangeDisplay, { DEFAULT: 0, KILOMETER: 1, MEILEN: 2, SIGNAL_UNBEFUELLT: 3 });
        const tot = unit === 3 ? null : n(v.dataRangeDisplayTotal, 2500);
        const w = en(v.rangeWarningFuelLevel, { IN_ORDNUNG: 0, GERING: 1, UNBEFUELLT: 3 });
        this.v.rangeTotal = tot; this.v.rangeUnit = unit === 2 ? 'mi' : 'km';
        this.v.warn = w === 1 ? true : w === 0 ? false : null;
        if (tot !== null || this.v.warn !== null) this.at = Date.now();
    }
    /** -> { pct, mi, gal, low, has } (null = not sent) */
    state() {
        const v = this.v;
        const mi = v.rangeTotal !== null ? (v.rangeUnit === 'mi' ? v.rangeTotal : v.rangeTotal * KM_MI) : v.kombiKm !== null ? v.kombiKm * KM_MI : null;
        const pct = v.pct !== null ? Math.max(0, Math.min(100, v.pct)) : null;
        const flag = v.warn !== null || v.reserve !== null ? v.warn === true || v.reserve === true : null;
        const low = flag !== null ? flag : pct !== null ? pct <= LOW_PCT : false;
        return { pct, mi: mi === null ? null : Math.round(mi), gal: pct === null && v.litres !== null ? v.litres * L_GAL : null,
            low, has: pct !== null || mi !== null || v.litres !== null };
    }
    /** subscribe (ctx.signals.watch); raw values logged, the first few per field */
    watch(ctx, log) {
        const seen = {};
        const once = (what, picked) => {
            const k = JSON.stringify(picked), s0 = seen[what] = seen[what] || [];
            if (s0.length < 12 && s0.indexOf(k) < 0) { s0.push(k); log.info('fuel raw ' + what + ': ' + k); }
        };
        const pick = (v, keys) => { const o = {}; keys.forEach((k) => { o[k] = v ? v[k] : undefined; }); return o; };
        const subs = [
            [IFACE.lsc, { fuelSupply: (v) => { once('fuelSupply', pick(v, ['relativeFuelLevelEstimate', 'fuelLevelEstimate'])); this.lsc(v); } }],
            [IFACE.kombi, { statusRangeTankStatus: (v) => { once('statusRangeTankStatus', pick(v, ['range', 'fluidLevelFuelTank', 'statusFluidLevelFuelTankSpare'])); this.kombi(v); } }, { pollMs: 30000 }],
            [IFACE.range, { dataRangeDisplay: (v) => { once('dataRangeDisplay', pick(v, ['dataRangeDisplayTotal', 'unitRangeDisplay', 'rangeWarningFuelLevel'])); this.range(v); } }],
        ];
        subs.forEach((s) => ctx.signals.watch(s[0], '1', s[1], log, s[2])
            .then((r) => log.info('fuel signal ' + s[0].split('.').pop() + (r.error ? ' error: ' + r.error : ' subscribed')),
                (e) => log.warn('fuel signal ' + s[0].split('.').pop() + ': ' + e)));
    }
}
Fuel.LOW_PCT = LOW_PCT;
Fuel.IFACE = IFACE;
module.exports = Fuel;
