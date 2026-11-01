'use strict';
/**
 * cluster_skin.js - G's Dash 0.8.1's cluster skins: the instrument cluster's own dials redrawn in the
 * G's Dash look (all seven: Stock, M Style, GT, Digital '84, Sim Racing, Lumen, Pixel; 0.9.0 took Simple,
 * Heritage and Flight out), through the separately installed Cluster renderer tool (the client as cluster_logo.js loads
 * it). While G's Dash is open, the setting "displays" (0.10.0; 0.9.0: "clusterSkin") is Cluster dials and the cluster shows its M / Sport layout
 * (the one measured; 0.8.4: any drive mode, the car coded to that layout in all), parked and (0.8.1) driving: the needles, fills, digital
 * speed and gear follow the live values. Anything else (another layout, no speed signal, values older
 * than LIVE_MS while moving, an error, another app drawing on the panel or the HUD) and the stock dials
 * are back within a second; stale values within LIVE_MS + one pump.
 *
 * Live (0.8.1): main.js hands every car sample over (sample(), from car.onSample) with the signals'
 * own arrival times; changed uniforms go out at once, PUSH_MS (33 ms, 30 Hz) at most, the rest on the
 * next pump. Moving (speed >= PARKED_KMH): speed and rpm both newer than LIVE_MS (300 ms) or the skin
 * hides (the stock dials show), and shows again only after RESHOW_MS of fresh values. Standing still,
 * the 0.8.0 rule (G's Dash's loop newer than STALE_MS): the car sends a signal only when it changes.
 * The speed shown: the true speed (Vehicle2, centre of gravity) * (1 + SPEED_PCT / 100) + SPEED_ADD mph,
 * both 0 for now (no measured basis for an offset; the stock speedometer reads a little over).
 *
 * The layers: two "effect" layers on the "panel" target (1920x720: drawn over the stock gauges and under
 * the stock telltales, which stay on top), one a side, REGION_W x REGION_H at x 0 / 1060, y 24 (the
 * centre, the map area with the G logo or Waze, and the bottom strip are left alone), class "content"
 * at z SKIN_Z (90: under G's TV's 100), never exclusive, never contending (the panel's scene is the
 * HUD's too: never taken from it), never "alert", never the HUD. The art leaves the stock speed-limit
 * box, AUTO H, PARK and the bottom strip out (skin_core.js CUTS). Each layer runs the look's fragment
 * shader (skin_core.fragment) over four assets (skin_core.js header): the field (once a connection),
 * the look's art, band and glyph cells (once a look); per frame only a few uniforms, and only when a
 * value changed (UNIFORM_MS at most).
 *
 * Fail-safe: the layers' alpha is the uniform u_fresh, 0 as the client sets it; a renderer animation
 * holds it at 1 for FRESH_HOLD ms and then takes it to 0 in FRESH_FADE, re-armed every REARM_MS while
 * everything is as it should be. G's Dash stopping, hanging or losing its connection: the skins fade by
 * themselves within REARM_MS + FRESH_HOLD + FRESH_FADE (about 0.3 s), on the cluster's clock. A
 * condition failing: visible 0 at once. 0.11.3 (failsafe.js): re-armed new-first (0.11.2's stop-then-start
 * could draw a frame with u_fresh 0 between the two), the client's u_fresh 1 while shown, 0 only on hiding;
 * shown / hidden / re-arm counters logged at most every 30 s.
 *
 * Modes (the hidden diagnostics page; 'align' and 'stock' parked only): 'skin' (the look), 'align' (the alignment card:
 * a 1 px outline of the measured geometry, to photograph against the stock dials), 'stock' (the Stock
 * redraw, whatever the look). Never throws, never blocks. Node 8: no ?., ?? or object spread.
 */
const SK = require('./skin_core');
const ASSETS = require('./skin_assets');
const META = require('./skin_looks');
const CL = require('./cluster_logo');
const MEM = require('./cluster_memory');
const FS = require('./failsafe');
const MEM_FULL = MEM.MEM_FULL, memoryUsers = MEM.memoryUsers, memoryNote = MEM.memoryNote;

const TARGET = 'panel', KLASS = 'content', SKIN_Z = 90;
const SPEED_IFACE = 'de.bmw.infotainment.vehicle.Vehicle2';
// the cluster layout the geometry was measured on (the M / Sport layout); 0.8.4: in every drive mode,
// as the car is coded to show that layout in all of them - the drive mode no longer gates the skins
const LAYOUT = 'SPORT';
const PARKED_KMH = 1;
const POLL_MS = 1000, PUMP_MS = 33, PUSH_MS = 33, REARM_MS = 60, FRESH_HOLD = 200, FRESH_FADE = 40, STALE_MS = 600;
const LIVE_MS = 300, RESHOW_MS = 500;
const SPEED_PCT = 0, SPEED_ADD = 0;                      // the speed shown: true * (1 + PCT / 100) + ADD mph
const HOLD_MS = 3000, RECONNECT_MS = 8000, LOAD_RETRY_MS = 30000, ERR_RETRIES = 3;
/** G's Dash's look ids -> the skin's (skin_looks.js) */
const LOOK_SKIN = { m: 'm', gt: 'gt', digital: 'digital', simracing: 'simracing', lumen: 'lumen', pixel: 'pixel' };

/** Other apps' layers on the panel or the HUD in a status text (same lines as cluster_logo.js reads). */
function panelLayers(text, ownApp) {
    const out = [];
    String(text || '').split('\n').forEach((line) => {
        const m = /^layer (\d+) (\w+) of (\S+) on (\w+), (\w+) z (-?\d+): (\w+)/.exec(line);
        if (!m || (m[4] !== 'panel' && m[4] !== 'hud')) return;
        out.push({ id: +m[1], kind: m[2], app: m[3], target: m[4], klass: m[5], z: +m[6], state: m[7], own: m[3] === ownApp });
    });
    return out;
}

/**
 * Whether the skin may show, from main.js's state: { on, enabled, look, mode, data (car.data()),
 * speedAvail, gear (L.gearText), at ({ speed, rpm }: when each last came, ms) } -> '' (yes) or why not.
 * The look ('skin') parked and driving; the diagnostics' 'align' / 'stock' parked only.
 */
function blocker(s) {
    if (!s || !s.on) return 'closed';
    if (s.enabled === false) return 'off';
    const d = s.data || {};
    if (d.demo) return 'demo data';
    if (!s.speedAvail || !SK.isNum(d.speed)) return 'no speed signal';
    if (s.mode === 'align' || s.mode === 'stock') {
        if (d.speed >= PARKED_KMH) return 'moving';
        if (d.stage === 'D' || d.stage === 'R' || (SK.isNum(d.gear) && (d.gear > 0 || d.gear === -1) && !d.gearGuessed)) return 'in gear';
    }
    return '';
}
/** moving, the values' age: '' or 'stale values' (now: ms, the clock s.at is on) */
function staleness(s, now) {
    const d = (s && s.data) || {}, at = (s && s.at) || {};
    if (!SK.isNum(d.speed) || d.speed < PARKED_KMH) return '';
    if (!SK.isNum(at.speed) || now - at.speed > LIVE_MS) return 'stale values';
    if (!SK.isNum(at.rpm) || now - at.rpm > LIVE_MS) return 'stale values';
    return '';
}
/** the speed as shown, mph, from km/h */
function shownSpeed(kmh) { return SK.isNum(kmh) ? Math.max(0, kmh / 1.609344 * (1 + SPEED_PCT / 100) + SPEED_ADD) : null; }
/**
 * main.js's state -> the shader's values: speed mph (as shown), rpm, gear. A gear only learned from rpm
 * and speed (not the gearbox's) is unknown here: the stock gear shows.
 */
function values(s) {
    const d = (s && s.data) || {};
    let gear = s && s.gear ? String(s.gear) : '-';
    if (d.gearGuessed && /^[0-9]$/.test(gear)) gear = '-';
    return { speed: shownSpeed(d.speed), rpm: SK.isNum(d.rpm) ? d.rpm : null, gear };
}
const toBuf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length);

class ClusterSkin {
    /**
     * opts: log, app ('ng_gsdash'), load(file) -> { w, h, data } (a decoded PNG of the app's), client /
     * sock / testing (tests), now(), timers ({ setInterval, clearInterval }).
     */
    constructor(opts) {
        const o = opts || {};
        this.o = o;
        this.log = o.log || { info() {}, warn() {} };
        this.app = o.app || 'ng_gsdash';
        this.now = o.now || Date.now;
        this.T = o.timers || { setInterval, clearInterval };
        this.st = null; this.stAt = -1e15; this.want = false; this.why = 'closed';
        this.err = null; this.errAt = -1e15;
        this.cache = { id: '', tex: null };
        this.fieldTex = null;                          // 0.11.2: the field's atlases (decoded once)
        this.stats = { connects: 0, layers: 0, assets: 0, bytes: 0, uniforms: 0, rearms: 0, drops: 0, refreshes: 0, samples: 0, pushes: 0, staleHides: 0, shows: 0, hides: 0 };
        this.staleAt = -1e15; this.lastPush = -1e15;
        this.diag = new FS.Diag(this.log, 'cluster skin', this.now);   // 0.11.3: rate-limited counters
        this._reset();
    }
    _reset() {
        this.cr = null; this.ready = false; this.polled = false;
        this.field = null;                        // { L, R } asset refs, once a connection
        this.cur = null;                          // { id, assets: [...], L: { ref, anim, sent }, R }
        this.visible = false; this.lastRearm = -1e15; this.lastPump = -1e15;
        this.others = []; this.busyAt = -1e15; this.layerErr = ''; this.lastErr = ''; this.errCount = 0; this.refused = ''; this.noEffect = false;
        this.asked = 0; this.answered = 0;            // 0.8.5: status asks and answers, this connection
        this.healed = false;                          // 0.8.5: a lost layer made again once already
        this.statusText = ''; this.memRetried = false; this.memUsers = [];   // 0.11.2: the last status; memory full
        this.poll = null; this.pump = null; this.downAt = this.now();
    }

    /**
     * From G's Dash's loop (and its visibility / setting handlers): { on (open, the setting on), enabled,
     * look (the G's Dash look id), mode ('skin' | 'align' | 'stock'), data, speedAvail, gear, at }.
     */
    update(s) {
        // what sample() brought in since stays (it is newer than or the same as the loop's)
        const prev = this.st;
        this.st = Object.assign({}, s || {});
        if (prev && prev.at && (!this.st.at || this.st.at === prev.at)) this.st.at = prev.at;
        this.stAt = this.now();
        const on = !!(s && s.on && s.enabled !== false);
        if (!on) { if (this.cr) this._off(); this.want = false; this.why = blocker(s); return; }
        this.want = true;
        if (!this.cr) this._connect();
        this._apply();
    }
    /**
     * A car sample (car.onSample: speed, rpm, accel), straight away: data (car.data()), at ({ speed,
     * rpm }), gear (L.gearText). Changed uniforms out now, PUSH_MS apart at most (the pump sends the
     * rest); a condition failing hides at once.
     */
    sample(data, at, gear) {
        if (!this.st || !this.want) return;
        this.stats.samples++;
        this.st.data = data || this.st.data;
        if (at) this.st.at = { speed: at.speed, rpm: at.rpm };
        if (gear !== undefined) this.st.gear = gear;
        if (!this.cr || !this.ready || !this.polled) return;
        // hidden: shown again only if the layers are made (making them is update()'s, at the loop's pace)
        if (!this.visible) { if (this.cur) this._apply(); return; }
        if (this._why()) { this._apply(); return; }
        if (!this.cur || !this.cur.ok) return;
        if (this.now() - this.lastPush >= PUSH_MS) this._uniforms(false);
    }
    lookId() {
        const s = this.st || {};
        if (s.mode === 'align') return 'align';
        if (s.mode === 'stock') return 'stock';
        return LOOK_SKIN[s.look] || 'm';          // M Style: the default look (0.9.0)
    }

    _connect() {
        const now = this.now();
        if (this.err && now - this.errAt < LOAD_RETRY_MS) return;
        const c = CL.loadClient(this.o);
        if (c.error) {
            if (!this.err || this.err.error !== c.error) this.log.warn('cluster skin: ' + c.text);
            this.err = c; this.errAt = now;
            return;
        }
        this.err = null;
        const cr = this.cr = new c.ClusterRender(this.app, c.sock);
        this.stats.connects++;
        cr.on('ready', () => {
            if (this.cr !== cr) return;
            this.ready = true; this.asked = 0; this.answered = 0;
            this.log.info('cluster skin: connected');
            this._ask();
            // 0.8.5: the client replayed our layers on connecting (before this): in use again only once the
            // service's answer to this ask says none of them was refused
            if (this.cur) this._unconfirm(this.cur);
        });
        cr.on('disconnected', () => {
            if (this.cr !== cr) return;
            // the service removes a closed client's layers; the dead-man fades ours meanwhile. Made again
            // whole on the next connection (the client's own reconnect, or ours after RECONNECT_MS).
            this.ready = false; this.polled = false; this.downAt = this.now();
            this.asked = 0; this.answered = 0;
            // 0.8.5: hidden in the client's copy (the replay makes them hidden); nothing in use until confirmed
            if (this.cur) {
                ['L', 'R'].forEach((s) => { if (this.cur[s]) { try { cr.set(this.cur[s].ref, { visible: false }); } catch (e) { /* gone */ } FS.setBase(cr, this.cur[s], 0); } });
                this.cur.ok = false;
            }
            if (this.visible) this.diag.hidden('disconnected', 'cluster skin: disconnected'); else this.log.info('cluster skin: disconnected');
            this.visible = false;
        });
        cr.on('layer', (ref, state, reason) => {
            if (this.cr !== cr || !this.cur || !this.cur.ok) return;
            if ((this.cur.L && ref === this.cur.L.ref) || (this.cur.R && ref === this.cur.R.ref)) {
                if (state === 'error') { this.layerErr = reason || 'error'; this.lastErr = 'layer: ' + (reason || 'error'); this.log.warn('cluster skin: layer error' + (reason ? ' (' + reason + ')' : '')); this._hide('layer error'); }
            }
        });
        cr.on('refused', (op, ref, reason) => this._refused(cr, op, ref, reason));
        cr.on('status', (text) => {
            if (this.cr !== cr) return;
            const now = this.now();
            this.statusText = String(text || '');
            const others = panelLayers(text, this.app).filter((l) => !l.own && (l.state === 'shown' || l.state === 'waiting' || l.state === 'suspended'));
            if (others.length) this.busyAt = now;
            const was = this.others.map((l) => l.app).join(','), is = others.map((l) => l.app).join(',');
            if (was !== is) this.log.info('cluster skin: panel ' + (is ? 'in use by ' + is : 'free of other apps'));
            this.others = others;
            this.polled = true;
            this.answered++;
            // 0.8.5: the service answers in order: every refusal of what was sent before the ask came first
            if (this.cur && !this.cur.ok && this.answered >= this.cur.until) this._confirm();
            this._apply();
        });
        this.downAt = this.now();
        this.poll = this.T.setInterval(() => this._tick(), POLL_MS);
        this.pump = this.T.setInterval(() => this._pump(), PUMP_MS);
        try { cr.connect(); } catch (e) { this.log.warn('cluster skin: connect ' + e.message); }
    }
    _ask() { if (this.cr && this.ready) { try { this.cr.status(); this.asked++; } catch (e) { /* next poll */ } } }
    /** ours: one of the look's layers or assets, or the field's */
    _ours(ref) {
        const c = this.cur;
        if (!ref) return false;
        if (c && ((c.L && ref === c.L.ref) || (c.R && ref === c.R.ref) || c.assets.indexOf(ref) >= 0)) return true;
        return !!(this.field && (ref === this.field.L || ref === this.field.R));
    }
    /**
     * 0.8.5: the service refused an op. While the look is not confirmed: the first refusal is kept (the
     * root: "layer: effect did not compile"; what follows it, "no such layer", is only its echo) and the
     * confirmation drops and reports it. Once confirmed, a "no such layer" / "no such asset" is a layer
     * lost under us: made again once, then reported. A refused drop is only noted (the ref is gone).
     */
    _refused(cr, op, ref, reason) {
        if (this.cr !== cr) return;
        const r = (op || '?') + ': ' + (reason || '?');
        this.refused = r;
        if (op === 'drop' || !this._ours(ref)) { this.log.info('cluster skin: refused ' + r + (op === 'drop' ? '' : ' (not in use)')); return; }
        this.log.warn('cluster skin: refused ' + r);
        const c = this.cur;
        if (c && !c.ok) { if (!c.err) c.err = r; return; }
        if (/^no such (layer|asset)$/.test(String(reason || ''))) {
            if (!this.healed) {
                this.healed = true;
                this.log.warn('cluster skin: the renderer lost a layer (' + r + '): made again');
                this._dropLook(); this._dropField();
                this._apply();
                return;
            }
        }
        // stock, retried by the poll (ERR_RETRIES); a layer lost again after its one remake: reported, kept
        // stock until Options > Refresh cluster
        if (this.healed && /^no such (layer|asset)$/.test(String(reason || ''))) this.errCount = ERR_RETRIES;
        this.layerErr = r; this.lastErr = r;
        if (MEM_FULL.test(r)) this.memUsers = memoryUsers(this.statusText, this.app);
        this._hide('refused');
        this._dropLook(); this._dropField();
    }
    /** made (or replayed): not in use until the service's answer to this ask */
    _unconfirm(c) { c.ok = false; c.err = ''; c.until = this.asked; }
    /** the answer came: refused (the first reason, dropped, retried) or in use (bound, then shown) */
    _confirm() {
        const c = this.cur, cr = this.cr;
        if (c.err) {
            this.log.warn('cluster skin: ' + c.id + ' refused (' + c.err + ')');
            this._dropLook(); this._dropField();
            if (MEM_FULL.test(c.err)) {
                // 0.11.2: the renderer's memory is shared by every app: ours freed first (the drops go before
                // anything new), then made again once at once; refused again, reported with who holds it
                const users = memoryUsers(this.statusText, this.app);
                this.memUsers = users;
                this.log.warn('cluster skin: the renderer\'s pixel memory is full' + (users.length ? ' - also in use by ' + memoryNote(users) : ''));
                if (!this.memRetried) {
                    this.memRetried = true;
                    this.log.info('cluster skin: our assets freed, making the skin again once');
                    return;                                  // the status handler's _apply() makes it again
                }
                this.layerErr = c.err; this.lastErr = c.err + (users.length ? ' - also in use by ' + memoryNote(users) : '');
                return;
            }
            this.layerErr = c.err; this.lastErr = c.err;
            return;
        }
        c.ok = true; this.memRetried = false;
        ['L', 'R'].forEach((s) => {
            const L = c[s];
            if (L.bound) return;                         // a replay: the client sent the binds again
            cr.bind(L.ref, 'u_field', this.field[s]); cr.bind(L.ref, 'u_art', L.art); cr.bind(L.ref, 'u_band', L.band); cr.bind(L.ref, 'u_glyph', L.glyph);
            L.base = -1; FS.setBase(cr, L, 0);
            L.bound = true;
        });
        this.log.info('cluster skin: ' + c.id + ' confirmed by the renderer');
    }
    _dropField() {
        if (this.field && this.cr) { ['L', 'R'].forEach((s) => { try { this.cr.drop(this.field[s]); this.stats.drops++; } catch (e) { /* gone */ } }); }
        this.field = null;
    }
    _tick() {
        if (!this.want || !this.cr) return;
        this.diag.tick();
        if (!this.ready) {
            if (this.now() - this.downAt >= RECONNECT_MS) this._restart('not connected for ' + Math.round((this.now() - this.downAt) / 1000) + ' s');
            return;
        }
        this._ask();
        if (this.layerErr && this.errCount < ERR_RETRIES) {
            this.errCount++; this.layerErr = '';
            this.log.info('cluster skin: making the layers again (' + this.errCount + ' of ' + ERR_RETRIES + ')');
            this._dropLook();
            this._apply();
        }
    }

    /** '' if the skin may show now, else why not (the Options line says it). */
    _why() {
        const now = this.now();
        const b = blocker(this.st);
        if (b) return b;
        if (now - this.stAt > STALE_MS) return 'no update';
        if (staleness(this.st, now)) {
            if (this.visible) { this.stats.staleHides++; this.diag.stale(); }
            this.staleAt = now; return 'stale values';
        }
        if (now - this.staleAt < RESHOW_MS) return 'stale values';
        if (this.others.length) return 'panel in use';
        if (now - this.busyAt < HOLD_MS) return 'panel in use';
        if (this.layerErr || this.noEffect) return 'renderer error';
        if (this.cur && !this.cur.ok && this.cur.id === this.lookId()) return 'making';
        return '';
    }
    _apply() {
        if (!this.want || !this.cr || !this.ready || !this.polled) return;
        const why = this._why();
        this.why = why;
        if (why) { this._hide(why); return; }
        const id = this.lookId();
        if (!this.cur || this.cur.id !== id) {
            let ok = false;
            try { ok = this._make(id); } catch (e) { this.log.warn('cluster skin: ' + (e.stack || e)); this.layerErr = 'make: ' + e.message; }
            if (!ok) { this._hide('assets'); return; }
        }
        if (!this.cur.ok) { this.why = 'making'; return; }   // 0.8.5: nothing to it before the service confirms it
        if (!this.visible) {
            // 0.11.3: u_fresh 1 as the client's own first (a renderer stop restores to it), then the animation
            ['L', 'R'].forEach((s) => FS.setBase(this.cr, this.cur[s], 1));
            this._uniforms(true);
            this.stats.shows++; this.diag.shown('cluster skin: ' + id + ' shown');
            this._rearm();
            ['L', 'R'].forEach((s) => { this.cr.set(this.cur[s].ref, { visible: true }); });
            this.visible = true;
        }
    }
    _hide(why) {
        if (!this.visible || !this.cur || !this.cur.ok || !this.cr) { this.visible = false; return; }
        ['L', 'R'].forEach((s) => { try { this.cr.set(this.cur[s].ref, { visible: false }); } catch (e) { /* gone */ } });
        ['L', 'R'].forEach((s) => FS.setBase(this.cr, this.cur[s], 0));   // 0.11.3: back to 0 only on hiding
        this.visible = false;
        this.stats.hides++; this.diag.hidden(why, 'cluster skin: hidden (' + why + ')');
    }
    /** Every PUMP_MS while connected: conditions again (so a stale loop hides it), uniforms, the dead-man. */
    _pump() {
        if (!this.want || !this.cr || !this.ready) return;
        if (this._why()) { if (this.visible) this._apply(); return; }
        if (!this.visible) { if (this.cur) this._apply(); if (!this.visible) return; }
        if (!this.cur || !this.cur.ok) return;
        if (this.now() - this.lastPush >= PUSH_MS - 2) this._uniforms(false);
        if (this.now() - this.lastRearm >= REARM_MS) this._rearm();
    }
    /** u_fresh: 1 for FRESH_HOLD ms, then down to 0 in FRESH_FADE, on the renderer's clock; replaced each
     * time - 0.11.3: the new animation first, the old one stopped after it (failsafe.js) */
    _rearm() {
        ['L', 'R'].forEach((s) => FS.rearm(this.cr, this.cur[s], FRESH_HOLD, FRESH_FADE));
        this.lastRearm = this.now(); this.stats.rearms++; this.diag.rearmed();
    }
    _uniforms(all) {
        const v = values(this.st), meta = this.cur.meta;
        let sent = 0;
        ['L', 'R'].forEach((s) => {
            const L = this.cur[s], u = SK.uniforms(meta, s, v);
            Object.keys(u).forEach((k) => {
                const key = u[k].join(',');
                if (!all && L.sent[k] === key) return;
                L.sent[k] = key;
                this.cr.uniform(L.ref, k, u[k]); this.stats.uniforms++; sent++;
            });
        });
        this.lastPump = this.now();
        if (sent) { this.lastPush = this.lastPump; this.stats.pushes++; }
    }

    /** The look's assets and two layers (hidden); the old look's go after. false: could not. */
    _make(id) {
        const cr = this.cr, meta = META.looks[id];
        if (!meta) return false;
        // an older Cluster renderer tool: no effect layers; the skins stay off (the logo is not affected)
        if (['effect', 'asset', 'bind', 'uniform', 'animate'].some((k) => typeof cr[k] !== 'function')) {
            if (!this.noEffect) this.log.warn('cluster skin: this Cluster renderer has no effect layers');
            this.noEffect = true; return false;
        }
        let tex;
        try {
            // 0.11.2: tiled (skin_assets.js pack): the same texels in under half the renderer's memory
            if (this.cache.id !== id) { this.cache = { id, tex: ASSETS.packLook(ASSETS.slice(meta, this.o.load(meta.file))) }; }
            tex = this.cache.tex;
            if (!this.fieldTex) this.fieldTex = ASSETS.packField(ASSETS.sliceField(this.o.load(META.field.file)));
            if (!this.field) {
                const f = this.fieldTex, refs = {};
                ['L', 'R'].forEach((s) => { refs[s] = this._asset(f[s]); });
                if (!refs.L || !refs.R) { ['L', 'R'].forEach((s) => { if (refs[s]) { try { cr.drop(refs[s]); } catch (e) { /* gone */ } } }); return false; }
                this.field = refs;
            }
        } catch (e) { this.log.warn('cluster skin: ' + id + ' assets: ' + e.message); return false; }
        // 0.8.4: the old look's assets go first - both looks at once do not fit the renderer's pixel memory
        const old = this.cur;
        if (old) { this._dropAll(old); this.cur = null; this.visible = false; }
        const cur = { id, meta, assets: [] };
        for (let i = 0; i < 2; i++) {
            const s = i ? 'R' : 'L', S = SK.SIDES[s];
            const art = this._asset(tex.art[s]), band = this._asset(tex.band[s]), glyph = this._asset(tex.glyph[s]);
            [art, band, glyph].forEach((r) => { if (r) cur.assets.push(r); });
            if (!art || !band || !glyph) { this._dropAll(cur); return false; }
            const ref = cr.effect({ target: TARGET, klass: KLASS, z: SKIN_Z, exclusive: false, contend: false, visible: false,
                x: S.x, y: S.y, w: S.w, h: S.h, fs: SK.fragment(meta, s, ASSETS.dimsOf(tex, this.fieldTex, s)) });
            if (!ref) { this.log.warn('cluster skin: effect layer refused by the client'); this._dropAll(cur); return false; }
            // 0.8.5: bound (and its uniforms sent) only once the service confirms the layer and its assets:
            // 0.8.4 sent them at once, to a layer the service had refused ("no such layer")
            cur[s] = { ref, anim: 0, sent: {}, art, band, glyph, bound: false, base: -1 };
            this.stats.layers++;
        }
        this.cur = cur; this.visible = false;
        this._ask(); this._unconfirm(cur);
        this.log.info('cluster skin: ' + id + ' made (' + Math.round(this.stats.bytes / 1024) + ' KB sent this run)');
        return true;
    }
    _asset(t) {
        const ref = this.cr.asset({ target: TARGET, format: 'rgba8', w: t.w, h: t.h, sampling: 'nearest' });
        if (!ref) { this.log.warn('cluster skin: asset ' + t.w + 'x' + t.h + ' refused by the client'); return 0; }
        this.cr.pixels(ref, null, toBuf(t.data));
        this.stats.assets++; this.stats.bytes += t.data.length;
        return ref;
    }
    /** layers first (a bound asset is not dropped), then their assets */
    _dropAll(cur) {
        const cr = this.cr;
        if (!cr || !cur) return;
        ['L', 'R'].forEach((s) => { if (cur[s] && cur[s].ref) { try { cr.drop(cur[s].ref); this.stats.drops++; } catch (e) { /* gone */ } } });
        cur.assets.forEach((r) => { try { cr.drop(r); this.stats.drops++; } catch (e) { /* gone */ } });
    }
    _dropLook() { if (this.cur) { this._dropAll(this.cur); this.cur = null; this.visible = false; } }

    _restart(why) {
        this.log.info('cluster skin: reconnecting (' + why + ')');
        this._off();
        if (this.want) { this._connect(); this._apply(); }
    }
    /** Options > Refresh cluster: every layer and asset dropped and made again on a new connection. */
    refresh() {
        this.stats.refreshes++;
        this.errCount = 0; this.layerErr = '';
        if (!this.want) return false;
        const had = !!this.cr;
        this.err = null; this.noEffect = false;            // a tool installed since: tried again at once
        this._restart('refresh');
        return had;
    }
    _off() {
        const cr = this.cr;
        this.diag.tick(true);                              // 0.11.3: the window's counters, if any
        if (this.poll) this.T.clearInterval(this.poll);
        if (this.pump) this.T.clearInterval(this.pump);
        if (cr) {
            this._dropLook();
            this._dropField();
            try { cr.close(); } catch (e) { /* gone */ }
            this.log.info('cluster skin: off');
        }
        this._reset();
    }
    close() { this._off(); this.want = false; this.cache = { id: '', tex: null }; this.fieldTex = null; }

    /** The Options line: { kind: 'on' | 'wait' | 'off' | 'none' | 'error', text } */
    view() {
        const s = this.st || {};
        if (s.enabled === false) return { kind: 'off', text: 'Off' };
        if (this.err) return { kind: 'none', text: SHORT_ERR[this.err.error] || this.err.text };
        if (!this.want) return { kind: 'off', text: 'On - with G\'s Dash open' };
        if (!this.cr || !this.ready || !this.polled) return { kind: 'wait', text: 'Connecting to renderer' };
        if (this.noEffect) return { kind: 'none', text: 'Update Cluster renderer' };
        const why = this.why || this._why();
        if (!why && this.visible) {
            const n = this.cur ? META.looks[this.cur.id].name : '';
            return { kind: 'on', text: 'Shown - ' + n };
        }
        const TXT = { moving: 'Stock while driving', 'stale values': 'Stock - signal delayed', 'in gear': 'Stock while in gear',
            'no speed signal': 'Stock - no speed signal', 'demo data': 'Stock - demo data', 'panel in use': 'Waiting - panel in use',
            'renderer error': 'Renderer refused the skin', assets: 'Skin failed to load', 'no update': 'Stock', making: 'Making the skin' };
        if (why === 'renderer error' && !this.noEffect && this.lastErr && MEM_FULL.test(this.lastErr)) {
            const names = (this.memUsers || []).map((u) => u.name);
            return { kind: 'error', text: 'Cluster memory full' + (names.length ? ' - ' + names.join(', ') : '') };
        }
        if (why === 'renderer error' && !this.noEffect && this.lastErr) return { kind: 'error', text: 'Refused: ' + shortReason(this.lastErr) };
        return { kind: why === 'renderer error' || why === 'assets' ? 'error' : 'wait', text: TXT[why] || 'Stock' };
    }
    /** the whole refusal (the diagnostics page): '' when none */
    refusal() { return this.lastErr || ''; 
    }
}
/** a refusal for the Options line: the service's reason without the op ("asset: ", "layer: ") */
function shortReason(r) { return String(r || '').replace(/^[a-z?]+: /, ''); }
const SHORT_ERR = { missing: 'Needs Cluster renderer', noclient: 'Update Cluster renderer', untrusted: 'Renderer not trusted', load: 'Renderer failed to load' };

module.exports = { shortReason, ClusterSkin, blocker, staleness, values, shownSpeed, panelLayers, LOOK_SKIN, TARGET, KLASS, SKIN_Z, LAYOUT, PARKED_KMH,
    POLL_MS, PUMP_MS, PUSH_MS, REARM_MS, FRESH_HOLD, FRESH_FADE, STALE_MS, LIVE_MS, RESHOW_MS, HOLD_MS, SPEED_PCT, SPEED_ADD };
