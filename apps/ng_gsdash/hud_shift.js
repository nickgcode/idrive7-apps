'use strict';
/**
 * hud_shift.js - G's Dash's HUD (0.9.0: the full HUD - speed, gear, shift lights; 0.8.2 had the
 * lights + gear band), through the separately installed Cluster renderer tool (the client as
 * cluster_logo.js loads it). While G's Dash is open and the setting "displays" ("Your look on the car's
 * displays", 0.10.0; 0.9.0: "hudShift") is HUD (one choice with the cluster dials and Neither: the panel
 * and the HUD share one scene) the whole HUD shows, in the look's style (hud_core.js): the
 * speed in mph, big; the gearbox's own gear (R, N, D, 1..9; nothing in P, unknown or guessed); the shift
 * lights over the last RANGE (2000) rpm before the shift point (the redline less "Shift point, before
 * redline") with a flash at about 4 Hz from the shift point. Any drive mode. No speed limit (hud_core TODO).
 *
 * The layer: one "effect" layer covering the "hud" target (800 x 480), class "content" at z HUD_Z (80:
 * under G's TV's HUD video at 100), never exclusive, never the alert class. Contending as G's TV's HUD
 * layer does (the HUD belongs to whoever contends; the panel is not taken). Assets once a look: the
 * style's band panes (hud_shift.png) and the look's big cells (hud_full.png). Per frame only u_lv
 * (fill, mode, gear, mph), and only when it changed, PUSH_MS (33 ms, 30 Hz) at most. The flash is the
 * mode in u_lv, sent by the pump every BLINK_MS while at the shift point.
 *
 * Hidden: closed, off, demo data, no speed signal, values older than LIVE_MS (300 ms) while moving or
 * while the lights run (shown again after RESHOW_MS of fresh values), G's Dash's loop older than
 * STALE_MS, another app's layer on the HUD or the panel (G's TV's video: back HOLD_MS, about 1 s, after
 * it goes), any renderer error. No rpm or no shift point: no lights, the speed and gear still shown.
 * Fail-safe as the cluster skins (failsafe.js): u_fresh held by a renderer animation re-armed every REARM_MS; G's Dash
 * stopping or hanging and the HUD fades by itself within about 0.3 s. 0.11.3: re-armed new-first (no frame with
 * u_fresh 0 between a stop and the next start: the HUD strobed with the stock HUD under it), the client's u_fresh 1
 * while shown, 0 only on hiding; shown / hidden / re-arm counters logged at most every 30 s (failsafe.Diag).
 * Never throws, never blocks. Node 8: no ?., ?? or object spread.
 */
const HC = require('./hud_core');
const CL = require('./cluster_logo');
const ASSETS = require('./skin_assets');
const CS = require('./cluster_skin');
const FS = require('./failsafe');

const TARGET = 'hud', KLASS = 'content', HUD_Z = 80;
const PARKED_KMH = 1;
const POLL_MS = 1000, PUMP_MS = 33, PUSH_MS = 33, REARM_MS = 60, FRESH_HOLD = 200, FRESH_FADE = 40, STALE_MS = 600;
const LIVE_MS = 300, RESHOW_MS = 500;
const HOLD_MS = 1000, RECONNECT_MS = 8000, LOAD_RETRY_MS = 30000, ERR_RETRIES = 3;
const ART = 'hud_shift.png';
const LOOKS = ['m', 'gt', 'digital', 'simracing', 'lumen', 'pixel'], DEFAULT_LOOK = 'm';
const isNum = (v) => typeof v === 'number' && isFinite(v);

/** '' (may show) or why not, from main.js's state { on, enabled, look, data, gear, at, redline, shift } */
function blocker(s) {
    if (!s || !s.on) return 'closed';
    if (s.enabled === false) return 'off';
    const d = s.data || {};
    if (d.demo) return 'demo data';
    if (!isNum(d.speed)) return 'no speed signal';
    return '';
}
/** the values' age: moving, the speed (and rpm when there is one) newer than LIVE_MS; parked with the
 * lights running, the rpm */
function staleness(s, now) {
    const d = (s && s.data) || {}, at = (s && s.at) || {};
    const moving = !isNum(d.speed) || d.speed >= PARKED_KMH;
    const running = isNum(d.rpm) && isNum(s && s.shift) && d.rpm >= s.shift - HC.RANGE;
    if (!moving && !running) return '';
    if (moving && (!isNum(at.speed) || now - at.speed > LIVE_MS)) return 'stale values';
    if (isNum(d.rpm) && (!isNum(at.rpm) || now - at.rpm > LIVE_MS)) return 'stale values';
    return '';
}
/** the HUD's values: { lit, mode, gear, mph } (hud_core.frame), the gear the gearbox's only */
function values(s, now) {
    const d = (s && s.data) || {};
    return HC.frame({ rpm: d.rpm, shift: s && s.shift, gear: s && s.gear, guessed: !!d.gearGuessed, kmh: d.speed }, now);
}
const toBuf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length);

class HudShift {
    /** opts: log, app, load(file) -> { w, h, data }, client / sock / testing (tests), now(), timers */
    constructor(opts) {
        const o = opts || {};
        this.o = o;
        this.log = o.log || { info() {}, warn() {} };
        this.app = o.app || 'ng_gsdash';
        this.now = o.now || Date.now;
        this.T = o.timers || { setInterval, clearInterval };
        this.st = null; this.stAt = -1e15; this.want = false; this.why = 'closed';
        this.err = null; this.errAt = -1e15;
        this.art = null;                                    // the decoded hud_shift.png
        this.big = null;                                    // { id, img }: the look's big cells (hud_full.png)
        this.stats = { connects: 0, layers: 0, assets: 0, bytes: 0, uniforms: 0, rearms: 0, drops: 0, refreshes: 0, samples: 0, pushes: 0, staleHides: 0, shows: 0, hides: 0 };
        this.staleAt = -1e15; this.lastPush = -1e15;
        this.diag = new FS.Diag(this.log, 'hud shift', this.now);   // 0.11.3: rate-limited counters
        this._reset();
    }
    _reset() {
        this.cr = null; this.ready = false; this.polled = false;
        this.cur = null;                                    // { id, style, assets, ref, anim, sent }
        this.visible = false; this.lastRearm = -1e15;
        this.others = []; this.busyAt = -1e15; this.layerErr = ''; this.lastErr = ''; this.errCount = 0; this.refused = ''; this.noEffect = false;
        this.asked = 0; this.answered = 0; this.healed = false;   // 0.8.5: as the skins (cluster_skin.js)
        this.hudState = ''; this.hudHolder = ''; this.hudReason = ''; this.layerState = ''; this.poll = null; this.pump = null; this.downAt = this.now();
    }

    update(s) {
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
    /** a car sample straight away: data, at ({ speed, rpm }), gear (L.gearText) */
    sample(data, at, gear) {
        if (!this.st || !this.want) return;
        this.stats.samples++;
        this.st.data = data || this.st.data;
        if (at) this.st.at = { speed: at.speed, rpm: at.rpm };
        if (gear !== undefined) this.st.gear = gear;
        if (!this.cr || !this.ready || !this.polled) return;
        if (!this.visible) { if (this.cur) this._apply(); return; }
        if (this._why()) { this._apply(); return; }
        if (!this.cur || !this.cur.ok) return;
        if (this.now() - this.lastPush >= PUSH_MS) this._uniforms(false);
    }
    lookId() { const s = this.st || {}; return LOOKS.indexOf(s.look) >= 0 ? s.look : DEFAULT_LOOK; }

    _connect() {
        const now = this.now();
        if (this.err && now - this.errAt < LOAD_RETRY_MS) return;
        const c = CL.loadClient(this.o);
        if (c.error) {
            if (!this.err || this.err.error !== c.error) this.log.warn('hud shift: ' + c.text);
            this.err = c; this.errAt = now;
            return;
        }
        this.err = null;
        const cr = this.cr = new c.ClusterRender(this.app, c.sock);
        this.stats.connects++;
        cr.on('ready', () => {
            if (this.cr !== cr) return;
            this.ready = true; this.asked = 0; this.answered = 0;
            this.log.info('hud shift: connected');
            this._ask();
            if (this.cur) this._unconfirm(this.cur);       // 0.8.5: the client's replay, confirmed by this ask
        });
        cr.on('disconnected', () => {
            if (this.cr !== cr) return;
            this.ready = false; this.polled = false; this.downAt = this.now();
            this.asked = 0; this.answered = 0;
            if (this.cur) { try { cr.set(this.cur.ref, { visible: false }); } catch (e) { /* gone */ } FS.setBase(cr, this.cur, 0); this.cur.ok = false; }
            if (this.visible) this.diag.hidden('disconnected', 'hud shift: disconnected'); else this.log.info('hud shift: disconnected');
            this.visible = false;
        });
        cr.on('layer', (ref, state, reason) => {
            if (this.cr !== cr || !this.cur || !this.cur.ok || ref !== this.cur.ref) return;
            this.layerState = state || '';
            if (state === 'error') { this.layerErr = reason || 'error'; this.lastErr = 'layer: ' + (reason || 'error'); this.log.warn('hud shift: layer error' + (reason ? ' (' + reason + ')' : '')); this._hide('layer error'); }
        });
        cr.on('refused', (op, ref, reason) => this._refused(cr, op, ref, reason));
        cr.on('target', (name, state, holder, reason) => {
            if (this.cr !== cr || name !== TARGET) return;
            if (state !== this.hudState || (holder || '') !== this.hudHolder) this.log.info('hud shift: hud ' + state + (holder ? ' holder ' + holder : '') + (reason ? ' (' + reason + ')' : ''));
            this.hudState = state || ''; this.hudHolder = holder || ''; this.hudReason = reason || '';
        });
        cr.on('status', (text) => {
            if (this.cr !== cr) return;
            const now = this.now();
            const others = CS.panelLayers(text, this.app).filter((l) => !l.own && (l.state === 'shown' || l.state === 'waiting' || l.state === 'suspended'));
            if (others.length) this.busyAt = now;
            const was = this.others.map((l) => l.app).join(','), is = others.map((l) => l.app).join(',');
            if (was !== is) this.log.info('hud shift: hud ' + (is ? 'in use by ' + is : 'free of other apps'));
            this.others = others;
            this.polled = true;
            this.answered++;
            if (this.cur && !this.cur.ok && this.answered >= this.cur.until) this._confirm();
            this._apply();
        });
        this.downAt = this.now();
        this.poll = this.T.setInterval(() => this._tick(), POLL_MS);
        this.pump = this.T.setInterval(() => this._pump(), PUMP_MS);
        try { cr.connect(); } catch (e) { this.log.warn('hud shift: connect ' + e.message); }
    }
    _ask() { if (this.cr && this.ready) { try { this.cr.status(); this.asked++; } catch (e) { /* next poll */ } } }
    /**
     * 0.8.5 (as cluster_skin.js): unconfirmed, the first refusal is kept and reported (not the "no such
     * layer" echoes after it); confirmed, a "no such layer" / "no such asset" is a lost layer, made again
     * once, then reported. A refused drop is only noted.
     */
    _refused(cr, op, ref, reason) {
        if (this.cr !== cr) return;
        const r = (op || '?') + ': ' + (reason || '?'), c = this.cur;
        this.refused = r;
        const ours = !!(c && ref && (ref === c.ref || c.assets.indexOf(ref) >= 0));
        if (op === 'drop' || !ours) { this.log.info('hud shift: refused ' + r + (op === 'drop' ? '' : ' (not in use)')); return; }
        this.log.warn('hud shift: refused ' + r);
        if (!c.ok) { if (!c.err) c.err = r; return; }
        const lost = /^no such (layer|asset)$/.test(String(reason || ''));
        if (lost && !this.healed) {
            this.healed = true;
            this.log.warn('hud shift: the renderer lost the layer (' + r + '): made again');
            this._dropLook(); this._apply();
            return;
        }
        if (lost) this.errCount = ERR_RETRIES;              // lost again: reported until Refresh cluster
        this.layerErr = r; this.lastErr = r;
        this._hide('refused'); this._dropLook();
    }
    _unconfirm(c) { c.ok = false; c.err = ''; c.until = this.asked; }
    _confirm() {
        const c = this.cur, cr = this.cr;
        if (c.err) {
            this.layerErr = c.err; this.lastErr = c.err;
            this.log.warn('hud shift: ' + c.id + ' refused (' + c.err + ')');
            this._dropLook();
            return;
        }
        c.ok = true;
        if (!c.bound) { cr.bind(c.ref, 'u_hud', c.a); cr.bind(c.ref, 'u_big', c.g); c.base = -1; FS.setBase(cr, c, 0); c.bound = true; }
        this.log.info('hud shift: ' + c.id + ' confirmed by the renderer');
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
            this.log.info('hud shift: making the layer again (' + this.errCount + ' of ' + ERR_RETRIES + ')');
            this._dropLook();
            this._apply();
        }
    }

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
        if (this.others.length) return 'hud in use';
        if (now - this.busyAt < HOLD_MS) return 'hud in use';
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
            try { ok = this._make(id); } catch (e) { this.log.warn('hud shift: ' + (e.stack || e)); this.layerErr = 'make: ' + e.message; }
            if (!ok) { this._hide('assets'); return; }
        }
        if (!this.cur.ok) { this.why = 'making'; return; }   // 0.8.5: nothing to it before the service confirms it
        if (!this.visible) {
            // 0.11.3: u_fresh 1 as the client's own first (a renderer stop restores to it), then the animation
            FS.setBase(this.cr, this.cur, 1);
            this._uniforms(true);
            this.stats.shows++; this.diag.shown('hud shift: ' + id + ' shown');
            this._rearm();
            this.cr.set(this.cur.ref, { visible: true });
            this.visible = true;
        }
    }
    _hide(why) {
        if (!this.visible || !this.cur || !this.cur.ok || !this.cr) { this.visible = false; return; }
        try { this.cr.set(this.cur.ref, { visible: false }); } catch (e) { /* gone */ }
        FS.setBase(this.cr, this.cur, 0);                  // 0.11.3: back to 0 only on hiding
        this.visible = false;
        this.stats.hides++; this.diag.hidden(why, 'hud shift: hidden (' + why + ')');
    }
    _pump() {
        if (!this.want || !this.cr || !this.ready) return;
        if (this._why()) { if (this.visible) this._apply(); return; }
        if (!this.visible) { if (this.cur) this._apply(); if (!this.visible) return; }
        if (!this.cur || !this.cur.ok) return;
        if (this.now() - this.lastPush >= PUSH_MS - 2) this._uniforms(false);
        if (this.now() - this.lastRearm >= REARM_MS) this._rearm();
    }
    /** 0.11.3: the new animation first, the old one stopped after it (failsafe.js) */
    _rearm() {
        FS.rearm(this.cr, this.cur, FRESH_HOLD, FRESH_FADE);
        this.lastRearm = this.now(); this.stats.rearms++; this.diag.rearmed();
    }
    _uniforms(all) {
        const v = values(this.st, this.now());
        const u = [v.lit, v.mode, v.gear, v.mph], key = u.join(',');
        if (!all && this.cur.sent === key) return;
        this.cur.sent = key;
        this.cr.uniform(this.cur.ref, 'u_lv', u); this.stats.uniforms++;
        this.lastPush = this.now(); this.stats.pushes++;
    }

    /** The look's assets and layer (hidden), the old look's dropped first. false: could not. */
    _make(id) {
        const cr = this.cr;
        if (['effect', 'asset', 'bind', 'uniform', 'animate'].some((k) => typeof cr[k] !== 'function')) {
            if (!this.noEffect) this.log.warn('hud shift: this Cluster renderer has no effect layers');
            this.noEffect = true; return false;
        }
        const style = HC.styleOf(id), big = HC.bigOf(id);
        if (!big) return false;
        let pane, cells;
        try {
            if (!this.art) this.art = this.o.load(ART);
            const r = HC.paneRect(style);
            pane = ASSETS.crop(this.art, r.x, r.y, r.w, r.h);
            // one look's block at a time (hud_full.png is decoded, cropped and let go)
            if (!this.big || this.big.id !== id) this.big = { id, img: ASSETS.crop(this.o.load(big.file), big.x, big.y, big.w, big.h) };
            cells = this.big.img;
        } catch (e) { this.log.warn('hud shift: ' + id + ' assets: ' + e.message); return false; }
        // the old look's assets go first: two looks' would not fit the renderer's pixel memory with the logo
        const old = this.cur;
        if (old) { this._dropAll(old); this.cur = null; this.visible = false; }
        const cur = { id, style, assets: [], ref: 0, anim: 0, sent: '', base: -1 };
        const a = this._asset(pane, 'nearest'), g = this._asset(cells, big.sampling);
        [a, g].forEach((r) => { if (r) cur.assets.push(r); });
        if (!a || !g) { this._dropAll(cur); return false; }
        const B = HC.HUD;
        // 0.8.4: made visible at once, as G's TV's HUD video is (it wants the HUD from its first
        // message; u_fresh 0 keeps it clear until the first values)
        this.layerState = 'new';
        const ref = cr.effect({ target: TARGET, klass: KLASS, z: HUD_Z, exclusive: false, contend: true, visible: true,
            x: 0, y: 0, w: B.w, h: B.h, fs: HC.fragment(style, big) });
        if (!ref) { this.log.warn('hud shift: effect layer refused by the client'); this._dropAll(cur); return false; }
        cur.ref = ref;
        // 0.8.5: bound and its uniforms sent once the service confirms it (0.8.4 sent them at once)
        cur.a = a; cur.g = g; cur.bound = false;
        this.stats.layers++;
        this.cur = cur; this.visible = false;
        this._ask(); this._unconfirm(cur);
        this.log.info('hud shift: ' + id + ' (' + style + ') made (' + Math.round(this.stats.bytes / 1024) + ' KB sent this run)');
        return true;
    }
    _asset(t, sampling) {
        const ref = this.cr.asset({ target: TARGET, format: 'rgba8', w: t.w, h: t.h, sampling });
        if (!ref) { this.log.warn('hud shift: asset ' + t.w + 'x' + t.h + ' refused by the client'); return 0; }
        this.cr.pixels(ref, null, toBuf(t.data));
        this.stats.assets++; this.stats.bytes += t.data.length;
        return ref;
    }
    _dropAll(cur) {
        const cr = this.cr;
        if (!cr || !cur) return;
        if (cur.ref) { try { cr.drop(cur.ref); this.stats.drops++; } catch (e) { /* gone */ } }
        cur.assets.forEach((r) => { try { cr.drop(r); this.stats.drops++; } catch (e) { /* gone */ } });
    }
    _dropLook() { if (this.cur) { this._dropAll(this.cur); this.cur = null; this.visible = false; } }

    _restart(why) {
        this.log.info('hud shift: reconnecting (' + why + ')');
        this._off();
        if (this.want) { this._connect(); this._apply(); }
    }
    /** Options > Refresh cluster: the layer and assets dropped and made again on a new connection */
    refresh() {
        this.stats.refreshes++;
        this.errCount = 0; this.layerErr = '';
        if (!this.want) return false;
        const had = !!this.cr;
        this.err = null; this.noEffect = false;
        this._restart('refresh');
        return had;
    }
    _off() {
        this.diag.tick(true);                              // 0.11.3: the window's counters, if any
        if (this.poll) this.T.clearInterval(this.poll);
        if (this.pump) this.T.clearInterval(this.pump);
        if (this.cr) {
            this._dropLook();
            try { this.cr.close(); } catch (e) { /* gone */ }
            this.log.info('hud shift: off');
        }
        this._reset();
    }
    close() { this._off(); this.want = false; this.art = null; this.big = null; }

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
            // as G's TV's HUD status: the layer or the target shown counts first
            if (this.layerState === 'shown' || this.hudState === 'shown' || this.hudState === 'lingering') return { kind: 'on', text: 'Shown on the HUD' };
            if (this.hudState === 'unavailable') return { kind: 'none', text: 'HUD unavailable' };
            if (/scene id/.test(this.hudReason)) return { kind: 'wait', text: 'Waiting - cluster panel shares the HUD' };
            if (this.hudState === 'parked' || this.hudState === 'waiting') {
                // the car's own HUD content in front: the renderer leaves it unless its hud_take_over_stock is on
                return { kind: 'wait', text: this.hudHolder === 'foreign' ? 'Waiting - another program holds the HUD' : 'Waiting - turn on HUD takeover (renderer setting)' };
            }
            return { kind: 'wait', text: 'Asking for the HUD' };
        }
        const TXT = { 'stale values': 'Hidden - signal delayed', 'no speed signal': 'Hidden - no speed signal', 'demo data': 'Hidden - demo data',
            'hud in use': 'Waiting - HUD in use', 'renderer error': 'Renderer refused the HUD', assets: 'HUD failed to load', making: 'Making the HUD',
            'no update': 'Hidden' };
        if (why === 'renderer error' && !this.noEffect && this.lastErr) return { kind: 'error', text: 'Refused: ' + String(this.lastErr).replace(/^[a-z?]+: /, '') };
        return { kind: why === 'renderer error' || why === 'assets' ? 'error' : 'wait', text: TXT[why] || 'Hidden' };
    }
    /** the whole refusal (the diagnostics page): '' when none */
    refusal() { return this.lastErr || ''; }
}
const SHORT_ERR = { missing: 'Needs Cluster renderer', noclient: 'Update Cluster renderer', untrusted: 'Renderer not trusted', load: 'Renderer failed to load' };

module.exports = { HudShift, blocker, staleness, values, LOOKS, DEFAULT_LOOK, TARGET, KLASS, HUD_Z, PARKED_KMH,
    POLL_MS, PUMP_MS, PUSH_MS, REARM_MS, FRESH_HOLD, FRESH_FADE, STALE_MS, LIVE_MS, RESHOW_MS, HOLD_MS, ART };
