'use strict';
/**
 * failsafe.js - G's Dash 0.11.3: the cluster skins' and the HUD's fail-safe (cluster_skin.js, hud_shift.js)
 * and their rate-limited diagnostics.
 *
 * The layers' alpha is the uniform u_fresh. A renderer animation holds it at 1 for FRESH_HOLD ms and
 * takes it to 0 in FRESH_FADE ("loop 0: holds the last", cluster-render PROTOCOL.md Animations), re-armed
 * every REARM_MS while all is well: G's Dash hanging, the layer fades by itself on the renderer's clock.
 *
 * 0.11.2 and before re-armed with `stop` then `animate`. The renderer's `stop` puts the property back to
 * what the client set (src/layer.cpp Layer::stop -> restore), and the client set u_fresh 0; the two
 * messages are applied one at a time, so a flush between them drew a frame with u_fresh 0: the layer
 * transparent for a frame up to every 60 ms - on the car, the HUD strobing with the stock HUD under it.
 * Now:
 *   - the new animation starts first, the old one is stopped after it (never a moment with none);
 *   - the client's own u_fresh is 1 while shown (fresh values), so a `stop`'s restore lands on 1;
 *   - u_fresh 0 (and visible 0) only on hiding: real staleness, no update, an error, closing.
 * Never throws. Node 8: no ?., ?? or object spread.
 */
const STATS_MS = 30000;          // one diagnostics line at most this often (only when something counted)
const TRANSITION_BURST = 6;      // shown / hidden lines logged one by one in a window, then only counted

const freshKeys = (hold, fade) => '0:1 ' + hold + ':1 ' + (hold + fade) + ':0';

/** the client's own u_fresh (what a renderer `stop` restores): sent only on a change */
function setBase(cr, L, v) {
    if (!L || !L.ref || L.base === v) return;
    try { cr.uniform(L.ref, 'u_fresh', [v]); L.base = v; } catch (e) { /* gone */ }
}

/** a new hold-then-fade animation first, then the previous one stopped; refused: the previous one kept */
function rearm(cr, L, hold, fade) {
    if (!L || !L.ref) return false;
    let a = 0;
    try { a = cr.animate(L.ref, { property: 'uniform', name: 'u_fresh', keys: freshKeys(hold, fade), loop: false, interp: 'linear' }) || 0; } catch (e) { a = 0; }
    if (!a) return false;
    const old = L.anim;
    L.anim = a;
    if (old && old !== a && typeof cr.stop === 'function') { try { cr.stop(L.ref, old); } catch (e) { /* gone */ } }
    return true;
}

/**
 * Rate-limited counters for the log: shown / hidden transitions (the first TRANSITION_BURST of a window
 * one by one, the rest counted), re-arms, the longest gap between re-arms while shown, stale hides. One
 * line per STATS_MS at most, and only when something happened.
 */
class Diag {
    constructor(log, tag, now) {
        this.log = log; this.tag = tag; this.now = now;
        this.at = now(); this.lines = 0; this.quiet = 0;
        this.shows = 0; this.hides = 0; this.why = {}; this.rearms = 0; this.gap = 0; this.lastRearm = -1;
        this.staleHides = 0;
        this.total = { shows: 0, hides: 0, rearms: 0, staleHides: 0, quiet: 0 };
    }
    shown(text) { this.shows++; this.total.shows++; this._line(text); this.lastRearm = -1; }
    hidden(why, text) { this.hides++; this.total.hides++; this.why[why] = (this.why[why] || 0) + 1; this._line(text); this.lastRearm = -1; }
    stale() { this.staleHides++; this.total.staleHides++; }
    rearmed() {
        const t = this.now();
        if (this.lastRearm >= 0 && t - this.lastRearm > this.gap) this.gap = t - this.lastRearm;
        this.lastRearm = t; this.rearms++; this.total.rearms++;
    }
    _line(text) {
        if (this.lines < TRANSITION_BURST) { this.lines++; this.log.info(text); } else { this.quiet++; this.total.quiet++; }
    }
    /** from the poll: the window's line, if due (or force: closing) and anything counted */
    tick(force) {
        const t = this.now();
        if (!force && t - this.at < STATS_MS) return null;
        let line = null;
        if (this.shows || this.hides || this.rearms || this.staleHides) {
            const why = Object.keys(this.why).map((k) => k + ' ' + this.why[k]).join(', ');
            line = this.tag + ': last ' + Math.round((t - this.at) / 1000) + ' s: shown ' + this.shows + ', hidden ' + this.hides +
                (why ? ' (' + why + ')' : '') + ', rearms ' + this.rearms + (this.gap ? ' (longest gap ' + this.gap + ' ms)' : '') +
                ', stale hides ' + this.staleHides + (this.quiet ? ', ' + this.quiet + ' shown/hidden lines not logged' : '');
            this.log.info(line);
        }
        this.at = t; this.lines = 0; this.quiet = 0;
        this.shows = 0; this.hides = 0; this.why = {}; this.rearms = 0; this.gap = 0; this.staleHides = 0;
        return line;
    }
}

module.exports = { setBase, rearm, freshKeys, Diag, STATS_MS, TRANSITION_BURST };
