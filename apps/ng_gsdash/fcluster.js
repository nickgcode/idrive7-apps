'use strict';
/**
 * fcluster.js - G's Dash 0.12.0: the full-screen cluster test (Options > Diagnostics > Full-screen cluster
 * test, TEST): classic twin round dials over the whole cluster panel (fcluster_core.js draws them), through
 * the separately installed Cluster renderer tool (the client as cluster_logo.js loads it). Off by default and
 * never saved: main.js holds the switch in memory only, so it is off again after every app or head unit
 * restart. While on, the cluster skins and the HUD are paused (the panel and the HUD share one scene). Any gear,
 * any speed. It covers the car's own warning lights (telltales) on the panel while shown.
 *
 * The layer: one "effect" layer covering the "panel" target (1920 x 720), class "content" at z FC_Z (90, the
 * skins' place; they are paused), never exclusive, not contending (as the skins), never the alert class,
 * never 7702 / 7703. One asset: fcluster.png as r8 (1024 x 576; the renderer counts it twice, about 1.1 MiB
 * of its shared 16 MiB). Per frame only the uniforms that changed (u_val, u_gear, u_clock), PUSH_MS at most.
 *
 * Hidden (faded to stock over FADE_MS): closed, off, demo data, no speed signal, values older than LIVE_MS
 * while moving (shown again after RESHOW_MS of fresh values), G's Dash's loop older than STALE_MS, another
 * app's layer on the panel or the HUD (back HOLD_MS after it goes), any renderer error; at once on a
 * renderer disconnect or a refused / lost layer. Fail-safe as the skins and HUD (failsafe.js): u_fresh held
 * by a renderer animation re-armed new-first every REARM_MS (never a frame at 0 between a stop and the next
 * start), the client's u_fresh 1 while shown; G's Dash stopping or hanging and it fades by itself within
 * about 0.3 s. Shown / hidden / re-arm counters logged at most every 30 s (failsafe.Diag).
 * Made only after the first status answer, used only once the renderer confirms it (as 0.8.5's skins).
 * Never throws, never blocks. Node 8: no ?., ?? or object spread.
 */
const FC = require('./fcluster_core');
const CL = require('./cluster_logo');
const CS = require('./cluster_skin');
const FS = require('./failsafe');
const MEM = require('./cluster_memory');

const TARGET = 'panel', KLASS = 'content', FC_Z = 90;
const PARKED_KMH = 1;
const POLL_MS = 1000, PUMP_MS = 33, PUSH_MS = 33, REARM_MS = 60, FRESH_HOLD = 200, FRESH_FADE = 40, STALE_MS = 600;
const LIVE_MS = 300, RESHOW_MS = 500, FADE_MS = 150;
const HOLD_MS = 1000, RECONNECT_MS = 8000, LOAD_RETRY_MS = 30000, ERR_RETRIES = 3;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const toBuf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length);

/** '' (may show) or why not, from main.js's state { on, enabled, data, speedAvail, at, night, clock } */
function blocker(s) {
    if (!s || !s.on) return 'closed';
    if (s.enabled === false) return 'off';
    const d = s.data || {};
    if (d.demo) return 'demo data';
    if (s.speedAvail === false || !isNum(d.speed)) return 'no speed signal';
    return '';
}
/** moving: the speed and rpm newer than LIVE_MS (as the skins); parked: no check */
function staleness(s, now) {
    const d = (s && s.data) || {}, at = (s && s.at) || {};
    if (!isNum(d.speed) || d.speed < PARKED_KMH) return '';
    if (!isNum(at.speed) || now - at.speed > LIVE_MS) return 'stale values';
    if (isNum(d.rpm) && (!isNum(at.rpm) || now - at.rpm > LIVE_MS)) return 'stale values';
    return '';
}
/** the shader's uniforms: fcluster_core.values with the speed as the skins show it */
function values(s) {
    const d = (s && s.data) || {};
    return FC.values(Object.assign({}, s || {}, { mph: CS.shownSpeed(d.speed) }));
}

class FullCluster {
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
        this.atlas = null;                                  // fcluster.png as r8
        this.stats = { connects: 0, layers: 0, assets: 0, bytes: 0, uniforms: 0, rearms: 0, drops: 0, refreshes: 0, samples: 0, pushes: 0, staleHides: 0, shows: 0, hides: 0, fades: 0 };
        this.staleAt = -1e15; this.lastPush = -1e15;
        this.diag = new FS.Diag(this.log, 'full-screen cluster', this.now);
        this._reset();
    }
    _reset() {
        this.cr = null; this.ready = false; this.polled = false;
        this.cur = null;                                    // { ref, asset, anim, base, sent, ok, bound }
        this.visible = false; this.fadeAt = 0; this.lastRearm = -1e15;
        this.others = []; this.busyAt = -1e15; this.layerErr = ''; this.lastErr = ''; this.errCount = 0; this.refused = ''; this.noEffect = false;
        this.asked = 0; this.answered = 0; this.healed = false;
        this.statusText = ''; this.memRetried = false; this.memUsers = [];
        this.layerState = ''; this.poll = null; this.pump = null; this.downAt = this.now();
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
    /** a car sample straight away: data, at ({ speed, rpm }) */
    sample(data, at) {
        if (!this.st || !this.want) return;
        this.stats.samples++;
        this.st.data = data || this.st.data;
        if (at) this.st.at = { speed: at.speed, rpm: at.rpm };
        if (!this.cr || !this.ready || !this.polled) return;
        if (!this.visible) { if (this.cur) this._apply(); return; }
        if (this._why()) { this._apply(); return; }
        if (!this.cur || !this.cur.ok) return;
        if (this.now() - this.lastPush >= PUSH_MS) this._uniforms(false);
    }

    _connect() {
        const now = this.now();
        if (this.err && now - this.errAt < LOAD_RETRY_MS) return;
        const c = CL.loadClient(this.o);
        if (c.error) {
            if (!this.err || this.err.error !== c.error) this.log.warn('full-screen cluster: ' + c.text);
            this.err = c; this.errAt = now;
            return;
        }
        this.err = null;
        const cr = this.cr = new c.ClusterRender(this.app, c.sock);
        this.stats.connects++;
        cr.on('ready', () => {
            if (this.cr !== cr) return;
            this.ready = true; this.asked = 0; this.answered = 0;
            this.log.info('full-screen cluster: connected');
            this._ask();
            if (this.cur) this._unconfirm(this.cur);       // the client's replay, confirmed by this ask
        });
        cr.on('disconnected', () => {
            if (this.cr !== cr) return;
            this.ready = false; this.polled = false; this.downAt = this.now();
            this.asked = 0; this.answered = 0;
            if (this.cur) { try { cr.set(this.cur.ref, { visible: false }); } catch (e) { /* gone */ } FS.setBase(cr, this.cur, 0); this.cur.ok = false; }
            if (this.visible || this.fadeAt) this.diag.hidden('disconnected', 'full-screen cluster: disconnected'); else this.log.info('full-screen cluster: disconnected');
            this.visible = false; this.fadeAt = 0;
        });
        cr.on('layer', (ref, state, reason) => {
            if (this.cr !== cr || !this.cur || !this.cur.ok || ref !== this.cur.ref) return;
            this.layerState = state || '';
            if (state === 'error') { this.layerErr = reason || 'error'; this.lastErr = 'layer: ' + (reason || 'error'); this.log.warn('full-screen cluster: layer error' + (reason ? ' (' + reason + ')' : '')); this._hide('layer error', true); }
        });
        cr.on('refused', (op, ref, reason) => this._refused(cr, op, ref, reason));
        cr.on('status', (text) => {
            if (this.cr !== cr) return;
            const now = this.now();
            this.statusText = String(text || '');
            const others = CS.panelLayers(text, this.app).filter((l) => !l.own && (l.state === 'shown' || l.state === 'waiting' || l.state === 'suspended'));
            if (others.length) this.busyAt = now;
            const was = this.others.map((l) => l.app).join(','), is = others.map((l) => l.app).join(',');
            if (was !== is) this.log.info('full-screen cluster: panel ' + (is ? 'in use by ' + is : 'free of other apps'));
            this.others = others;
            this.polled = true;
            this.answered++;
            if (this.cur && !this.cur.ok && this.answered >= this.cur.until) this._confirm();
            this._apply();
        });
        this.downAt = this.now();
        this.poll = this.T.setInterval(() => this._tick(), POLL_MS);
        this.pump = this.T.setInterval(() => this._pump(), PUMP_MS);
        try { cr.connect(); } catch (e) { this.log.warn('full-screen cluster: connect ' + e.message); }
    }
    _ask() { if (this.cr && this.ready) { try { this.cr.status(); this.asked++; } catch (e) { /* next poll */ } } }
    /** as the skins / HUD: unconfirmed, the first refusal kept; confirmed, a lost layer made again once */
    _refused(cr, op, ref, reason) {
        if (this.cr !== cr) return;
        const r = (op || '?') + ': ' + (reason || '?'), c = this.cur;
        this.refused = r;
        const ours = !!(c && ref && (ref === c.ref || ref === c.asset));
        if (op === 'drop' || !ours) { this.log.info('full-screen cluster: refused ' + r + (op === 'drop' ? '' : ' (not in use)')); return; }
        this.log.warn('full-screen cluster: refused ' + r);
        if (!c.ok) { if (!c.err) c.err = r; return; }
        const lost = /^no such (layer|asset)$/.test(String(reason || ''));
        if (lost && !this.healed) {
            this.healed = true;
            this.log.warn('full-screen cluster: the renderer lost the layer (' + r + '): made again');
            this._drop(); this._apply();
            return;
        }
        if (lost) this.errCount = ERR_RETRIES;
        this.layerErr = r; this.lastErr = r;
        this._hide('refused', true); this._drop();
    }
    _unconfirm(c) { c.ok = false; c.err = ''; c.until = this.asked; }
    _confirm() {
        const c = this.cur, cr = this.cr;
        if (c.err) {
            this.log.warn('full-screen cluster: refused (' + c.err + ')');
            this._drop();
            if (MEM.MEM_FULL.test(c.err)) {
                // the renderer's 16 MiB is every app's: ours freed, made again once, then reported with who holds it
                const users = MEM.memoryUsers(this.statusText, this.app);
                this.memUsers = users;
                this.log.warn('full-screen cluster: the renderer\'s pixel memory is full' + (users.length ? ' - also in use by ' + MEM.memoryNote(users) : ''));
                if (!this.memRetried) { this.memRetried = true; return; }
                this.layerErr = c.err; this.lastErr = c.err + (users.length ? ' - also in use by ' + MEM.memoryNote(users) : '');
                return;
            }
            this.layerErr = c.err; this.lastErr = c.err;
            return;
        }
        c.ok = true; this.memRetried = false;
        if (!c.bound) { cr.bind(c.ref, 'u_lab', c.asset); c.base = -1; FS.setBase(cr, c, 0); c.bound = true; }
        this.log.info('full-screen cluster: confirmed by the renderer');
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
            this.log.info('full-screen cluster: making the layer again (' + this.errCount + ' of ' + ERR_RETRIES + ')');
            this._drop();
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
        if (this.others.length) return 'panel in use';
        if (now - this.busyAt < HOLD_MS) return 'panel in use';
        if (this.layerErr || this.noEffect) return 'renderer error';
        if (this.cur && !this.cur.ok) return 'making';
        return '';
    }
    _apply() {
        if (!this.want || !this.cr || !this.ready || !this.polled) return;
        const why = this._why();
        this.why = why;
        if (why) { this._hide(why); return; }
        if (!this.cur) {
            let ok = false;
            try { ok = this._make(); } catch (e) { this.log.warn('full-screen cluster: ' + (e.stack || e)); this.layerErr = 'make: ' + e.message; }
            if (!ok) { this._hide('assets'); return; }
        }
        if (!this.cur.ok) { this.why = 'making'; return; }
        if (!this.visible) {
            // u_fresh 1 as the client's own first (a renderer stop restores to it), the values, then the animation
            FS.setBase(this.cr, this.cur, 1);
            this._uniforms(true);
            this.stats.shows++; this.diag.shown('full-screen cluster: shown');
            this._rearm();
            if (!this.fadeAt) this.cr.set(this.cur.ref, { visible: true });   // fading out: still visible
            this.visible = true; this.fadeAt = 0;
        }
    }
    /** hidden: faded to stock over FADE_MS (then made invisible by the pump), or at once (now) */
    _hide(why, now) {
        if (!this.visible || !this.cur || !this.cur.ok || !this.cr) {
            if (now && this.fadeAt && this.cur && this.cr) { try { this.cr.set(this.cur.ref, { visible: false }); } catch (e) { /* gone */ } this.fadeAt = 0; }
            this.visible = false; return;
        }
        if (now) { try { this.cr.set(this.cur.ref, { visible: false }); } catch (e) { /* gone */ } this.fadeAt = 0; }
        else {
            // a short fade from 1 (new-first, as the re-arm), the client's value 0 behind it
            FS.rearm(this.cr, this.cur, 1, FADE_MS);
            this.fadeAt = this.now(); this.stats.fades++;
        }
        FS.setBase(this.cr, this.cur, 0);
        this.visible = false;
        this.stats.hides++; this.diag.hidden(why, 'full-screen cluster: hidden (' + why + ')');
    }
    _pump() {
        if (!this.want || !this.cr || !this.ready) return;
        if (this.fadeAt && !this.visible && this.now() - this.fadeAt >= FADE_MS + PUMP_MS) {
            try { if (this.cur) this.cr.set(this.cur.ref, { visible: false }); } catch (e) { /* gone */ }
            this.fadeAt = 0;
        }
        if (this._why()) { if (this.visible) this._apply(); return; }
        if (!this.visible) { if (this.cur || this.polled) this._apply(); if (!this.visible) return; }
        if (!this.cur || !this.cur.ok) return;
        if (this.now() - this.lastPush >= PUSH_MS - 2) this._uniforms(false);
        if (this.now() - this.lastRearm >= REARM_MS) this._rearm();
    }
    _rearm() {
        FS.rearm(this.cr, this.cur, FRESH_HOLD, FRESH_FADE);
        this.lastRearm = this.now(); this.stats.rearms++; this.diag.rearmed();
    }
    _uniforms(all) {
        const v = values(this.st), c = this.cur;
        if (!c.sent) c.sent = {};
        let n = 0;
        ['u_val', 'u_gear', 'u_clock'].forEach((k) => {
            const key = v[k].join(',');
            if (!all && c.sent[k] === key) return;
            c.sent[k] = key;
            this.cr.uniform(c.ref, k, v[k]); this.stats.uniforms++; n++;
        });
        if (n) { this.lastPush = this.now(); this.stats.pushes++; }
    }

    /** the atlas and the layer (hidden). false: could not. */
    _make() {
        const cr = this.cr;
        if (['effect', 'asset', 'bind', 'uniform', 'animate'].some((k) => typeof cr[k] !== 'function')) {
            if (!this.noEffect) this.log.warn('full-screen cluster: this Cluster renderer has no effect layers');
            this.noEffect = true; return false;
        }
        try {
            if (!this.atlas) { const img = this.o.load(FC.ATLAS.file); this.atlas = { w: img.w, h: img.h, data: FC.r8(img) }; }
        } catch (e) { this.log.warn('full-screen cluster: ' + FC.ATLAS.file + ': ' + e.message); return false; }
        const A = this.atlas;
        const asset = cr.asset({ target: TARGET, format: 'r8', w: A.w, h: A.h, sampling: 'bilinear' });
        if (!asset) { this.log.warn('full-screen cluster: asset refused by the client'); return false; }
        cr.pixels(asset, null, toBuf(A.data));
        this.stats.assets++; this.stats.bytes += A.data.length;
        const cur = { ref: 0, asset, anim: 0, base: -1, sent: null, ok: false, bound: false };
        this.layerState = 'new';
        const ref = cr.effect({ target: TARGET, klass: KLASS, z: FC_Z, exclusive: false, contend: false, visible: false,
            x: 0, y: 0, w: FC.W, h: FC.H, fs: FC.fragment() });
        if (!ref) { this.log.warn('full-screen cluster: effect layer refused by the client'); try { cr.drop(asset); } catch (e) { /* gone */ } return false; }
        cur.ref = ref;
        this.stats.layers++;
        this.cur = cur; this.visible = false; this.fadeAt = 0;
        this._ask(); this._unconfirm(cur);
        this.log.info('full-screen cluster: made (' + A.w + 'x' + A.h + ' r8, ' + Math.round(A.data.length / 1024) + ' KB)');
        return true;
    }
    _drop() {
        const cr = this.cr, c = this.cur;
        this.cur = null; this.visible = false; this.fadeAt = 0;
        if (!cr || !c) return;
        if (c.ref) { try { cr.drop(c.ref); this.stats.drops++; } catch (e) { /* gone */ } }
        if (c.asset) { try { cr.drop(c.asset); this.stats.drops++; } catch (e) { /* gone */ } }
    }

    _restart(why) {
        this.log.info('full-screen cluster: reconnecting (' + why + ')');
        this._off();
        if (this.want) { this._connect(); this._apply(); }
    }
    /** Options > Refresh cluster */
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
        this.diag.tick(true);
        if (this.poll) this.T.clearInterval(this.poll);
        if (this.pump) this.T.clearInterval(this.pump);
        if (this.cr) {
            this._drop();
            try { this.cr.close(); } catch (e) { /* gone */ }
            this.log.info('full-screen cluster: off');
        }
        this._reset();
    }
    close() { this._off(); this.want = false; this.atlas = null; }

    /** The Options line: { kind: 'on' | 'wait' | 'off' | 'none' | 'error', text } */
    view() {
        const s = this.st || {};
        if (s.enabled === false || !this.want && !this.err) return { kind: 'off', text: 'Off' };
        if (this.err) return { kind: 'none', text: SHORT_ERR[this.err.error] || this.err.text };
        if (!this.cr || !this.ready || !this.polled) return { kind: 'wait', text: 'Connecting to renderer' };
        if (this.noEffect) return { kind: 'none', text: 'Update Cluster renderer' };
        const why = this.why || this._why();
        if (!why && this.visible) return { kind: 'on', text: 'Shown - classic round dials' };
        if (why === 'renderer error' && this.lastErr) {
            if (MEM.MEM_FULL.test(this.lastErr)) return { kind: 'error', text: 'Cluster memory full' + (this.memUsers.length ? ' - ' + this.memUsers.map((u) => u.name).join(', ') : '') };
            return { kind: 'error', text: 'Refused: ' + String(this.lastErr).replace(/^[a-z?]+: /, '') };
        }
        const TXT = { 'stale values': 'Hidden - signal delayed', 'no speed signal': 'Hidden - no speed signal', 'demo data': 'Hidden - demo data',
            'panel in use': 'Waiting - cluster panel in use', 'renderer error': 'Renderer refused it', assets: 'Failed to load', making: 'Making the dials',
            'no update': 'Hidden', closed: 'On - with G\'s Dash open' };
        return { kind: why === 'renderer error' || why === 'assets' ? 'error' : 'wait', text: TXT[why] || 'Hidden' };
    }
    refusal() { return this.lastErr || ''; }
}
const SHORT_ERR = { missing: 'Needs Cluster renderer', noclient: 'Update Cluster renderer', untrusted: 'Renderer not trusted', load: 'Renderer failed to load' };

module.exports = { FullCluster, blocker, staleness, values, TARGET, KLASS, FC_Z, PARKED_KMH,
    POLL_MS, PUMP_MS, PUSH_MS, REARM_MS, FRESH_HOLD, FRESH_FADE, STALE_MS, LIVE_MS, RESHOW_MS, FADE_MS, HOLD_MS };
