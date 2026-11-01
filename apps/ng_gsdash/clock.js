'use strict';
/**
 * clock.js - the time of day G's Dash shows (Showcase), always H:MM with a colon, 12-hour with AM / PM.
 *
 * Where it comes from, the first that has it:
 *   1. the car: a time of day the car sent (feed(), with the UTC offset it is shown in). No car clock
 *      signal is wired in this build: the Diagnostics page lists the head unit's catalog fields named
 *      like a time or date, so one can be picked from what the car really offers.
 *   2. the head unit: its system clock (the car keeps it set) in the head unit's own time zone (TZ, else
 *      /etc/localtime: what Node's Date reads).
 * A car time older than CAR_STALE_MS (or one that makes no sense) is not used: the head unit's again.
 * The stopwatch-style session clocks (lib.js clock(): m:ss.t) are not time of day and stay as they are.
 *
 * Node 8: no ?., no ??, no object spread.
 */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CAR_STALE_MS = 120000;
const MIN_MS = Date.UTC(2020, 0, 1);          // a car time before this is unset (a fresh unit's 1970 / 2000)

/** 12-hour H:MM (always a colon, minutes two digits) and AM / PM from hours 0..23 and minutes. */
function hm12(h24, m) {
    const h = ((h24 % 12) + 12) % 12 || 12, mm = Math.max(0, Math.min(59, m | 0));
    return { time: h + ':' + (mm < 10 ? '0' : '') + mm, ampm: h24 % 24 < 12 ? 'AM' : 'PM' };
}
/** Wall-clock parts of instant ms shown at offsetMin minutes east of UTC. */
function partsAt(ms, offsetMin) {
    const d = new Date(ms + offsetMin * 60000);
    return { h: d.getUTCHours(), m: d.getUTCMinutes(), dow: d.getUTCDay(), mon: d.getUTCMonth(), day: d.getUTCDate() };
}
/** { time, ampm, date } for wall-clock parts. */
function text(p) {
    const c = hm12(p.h, p.m);
    return { time: c.time, ampm: c.ampm, date: DAYS[p.dow] + ' \u00b7 ' + MONTHS[p.mon] + ' ' + p.day };
}
/** The head unit's own zone (Node's Date: TZ, else /etc/localtime), in minutes east of UTC at ms. */
const localOffset = (ms) => -new Date(ms).getTimezoneOffset();

class Clock {
    /** opts.offset(ms): the head unit's zone (tests); default localOffset */
    constructor(opts) {
        const o = opts || {};
        this.offset = o.offset || localOffset;
        this.car = null;              // { ms, offsetMin, at }: the car's time of day as last sent
    }
    /** A time from the car: ms (UTC instant), offsetMin (its zone, minutes east of UTC), at (when received, Date.now()). */
    feed(ms, offsetMin, at) {
        if (typeof ms !== 'number' || !isFinite(ms) || ms < MIN_MS || typeof offsetMin !== 'number' || !isFinite(offsetMin) || Math.abs(offsetMin) > 14 * 60) { this.car = null; return false; }
        this.car = { ms, offsetMin, at: typeof at === 'number' ? at : Date.now() };
        return true;
    }
    /** { time, ampm, date, source: 'car' | 'head unit', offsetMin } at now (Date.now()). */
    now(now) {
        const t = typeof now === 'number' ? now : Date.now(), c = this.car;
        if (c && t - c.at >= 0 && t - c.at < CAR_STALE_MS) {
            return Object.assign(text(partsAt(c.ms + (t - c.at), c.offsetMin)), { source: 'car', offsetMin: c.offsetMin });
        }
        const off = this.offset(t);
        return Object.assign(text(partsAt(t, off)), { source: 'head unit', offsetMin: off });
    }
    /** One line for Diagnostics. */
    line(now) {
        const c = this.now(now), o = c.offsetMin, s = o < 0 ? '-' : '+', a = Math.abs(o);
        return 'Clock: ' + c.time + ' ' + c.ampm + ' from the ' + c.source + ' (UTC' + s + Math.floor(a / 60) + (a % 60 ? ':' + (a % 60 < 10 ? '0' : '') + (a % 60) : '') + ')';
    }
}

module.exports = { Clock, hm12, partsAt, text, localOffset, CAR_STALE_MS, DAYS, MONTHS };
