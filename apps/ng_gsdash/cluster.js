'use strict';
/**
 * cluster.js - G's Dash's CarPlay map in the cluster (on the Cluster logo page): a small client for the patch service of the
 * separately installed "Waze on cluster" tool (robertnisipeanu/idrive-apps, installed from the Store).
 * That tool does all the work as root: it patches CarPlay so it sends its instrument-cluster map,
 * and draws it on the cluster. G's Dash only asks it, over the tool's documented line protocol, for
 * its state, and to turn the map on or off when the user confirms. Written for G's Dash from the
 * tool's documentation; it contains none of the tool's code. Written against Waze on cluster 0.7.1
 * (works with 0.6.3 and later): its patch-service states busy, starting, unavailable, patched,
 * original, error and unknown, and its reasons (an unpatchable build, a backup that is not pristine).
 *
 * What it reads (nothing stored by G's Dash: the patch service is the only truth):
 *   - passive, files only (the settings row): whether the tool is there, the "change waits for the
 *     next head-unit start" marker, and the map renderer's status file
 *   - the patch socket (only while the Cluster logo page is open): one JSON object per line;
 *     G's Dash sends {"cmd":"status"}, and {"cmd":"apply",...} / {"cmd":"revert"} after a confirmation.
 *     It never sends anything else (no reboot, no logs, no capture).
 *
 * Never throws, never blocks: every socket or file problem becomes a state on the page. Connects
 * time out, replies time out, a line too long or not JSON is dropped. Node 8: no ?., ?? or spread.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const SHM = process.env.NG_WOC_SHM || '/dev/shm/waze-on-cluster';     // (env: the emulator's stub only)
const RUN = process.env.NG_WOC_RUN || '/run/waze-on-cluster';
const OPT = process.env.NG_WOC_OPT || '/var/opt/waze-on-cluster';
const PATCH_SOCK = path.join(SHM, 'patch.sock');
const PENDING = path.join(SHM, 'activation-pending');
const RENDER_STATUS = path.join(RUN, 'status.json');
const TOOL_DIR = path.join(OPT, 'current');
// what the tool's own app asks for: the high cluster panel, the map from CarPlay's AVB stream
const APPLY = { cmd: 'apply', panel: 'high', mode: 'avb' };
const CONNECT_MS = 3000, REPLY_MS = 5000, OP_MS = 30000, RETRY_MS = 3000, FILES_MS = 1000;
const MAX_LINE = 64 * 1024, STALE_MS = 15000;

const str = (v, n) => (typeof v === 'string' ? (v.length > (n || 160) ? v.slice(0, n || 160) + '...' : v) : '');

class ClusterMap {
    /** @param log the kit's log; opts.now: a clock (tests) */
    constructor(log, opts) {
        this.log = log || { info() {}, warn() {} };
        this.now = (opts && opts.now) || Date.now;
        this.files = { tool: false, sock: false, pending: null, render: null, renderAge: 0, at: 0 };
        this.patch = null;          // the last status from the patch service (sanitised)
        this.problem = null;        // why the patch service could not be asked: text
        this.sock = null; this.buf = ''; this.wanted = false;
        this.op = null;             // { cmd, at } while an apply / revert waits for its answer
        this.note = '';             // what the last apply / revert said (CarPlay restarted / deferred)
        this.timers = { retry: null, reply: null, op: null, connect: null };
        this.stats = { connects: 0, sent: [] };       // (diagnostics and tests)
    }

    /* ---------- files (passive: no socket) ---------- */
    readFiles() {
        const f = this.files, now = this.now();
        if (now - f.at < FILES_MS / 2) return f;
        f.at = now;
        const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };
        const isSock = (p) => { try { return fs.statSync(p).isSocket(); } catch (e) { return false; } };
        const json = (p, n) => {
            try { const s = fs.readFileSync(p, 'utf8'); if (s.length > n) return null; const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; }
        };
        f.sock = isSock(PATCH_SOCK);
        f.tool = f.sock || exists(TOOL_DIR) || exists(PENDING);
        f.pending = null;
        if (exists(PENDING)) {
            const m = json(PENDING, 4096) || {};
            f.pending = m.action === 'revert' ? 'revert' : 'apply';
        }
        f.render = json(RENDER_STATUS, 16384);
        try { f.renderAge = f.render ? now - fs.statSync(RENDER_STATUS).mtime.getTime() : 0; } catch (e) { f.renderAge = 0; }
        return f;
    }

    /* ---------- the patch socket (only while the page is open) ---------- */
    /** The Cluster logo page is shown: ask the patch service for its state (and keep asking). */
    open() {
        if (this.wanted) return;
        this.wanted = true; this.problem = null; this.note = '';
        this._connect();
    }
    /** The page is gone: close the socket, stop every timer. A running apply / revert is the service's. */
    close() {
        if (!this.wanted && !this.sock) return;
        this.wanted = false;
        Object.keys(this.timers).forEach((k) => { if (this.timers[k]) { clearTimeout(this.timers[k]); this.timers[k] = null; } });
        this._drop();
        this.op = null;
    }
    _drop() {
        const s = this.sock; this.sock = null; this.buf = '';
        if (s) { try { s.removeAllListeners('data'); s.removeAllListeners('close'); s.destroy(); } catch (e) { /* gone */ } }
    }
    _later() {
        if (!this.wanted || this.timers.retry) return;
        this.timers.retry = setTimeout(() => { this.timers.retry = null; if (this.wanted && !this.sock) this._connect(); }, RETRY_MS);
    }
    _connect() {
        if (!this.wanted || this.sock) return;
        const f = this.readFiles();
        if (!f.sock) {
            this.problem = f.tool ? (f.pending ? null : 'Patch service not running') : null;
            this.patch = null;
            this._later();
            return;
        }
        let s;
        try { s = net.createConnection(PATCH_SOCK); } catch (e) { this._fail(e); return; }
        this.sock = s; this.stats.connects++;
        s.setEncoding('utf8');
        this.timers.connect = setTimeout(() => { this.timers.connect = null; if (this.sock === s) this._fail(new Error('no answer (connect timed out)')); }, CONNECT_MS);
        s.on('connect', () => {
            if (this.timers.connect) { clearTimeout(this.timers.connect); this.timers.connect = null; }
            if (this.sock !== s) return;
            this._send({ cmd: 'status' });
            this._expect(REPLY_MS);
        });
        s.on('data', (d) => { if (this.sock === s) this._data(d); });
        s.on('error', (e) => { if (this.sock === s) this._fail(e); });
        s.on('close', () => { if (this.sock === s) this._fail(new Error('connection closed')); });
    }
    _fail(e) {
        const code = e && e.code;
        this.problem = code === 'ENOENT' ? 'Patch service not running'
            : code === 'ECONNREFUSED' ? 'Patch service not running (restart may be needed)'
                : code === 'EACCES' || code === 'EPERM' ? "No access to the patch service (G's Dash is not in its group)"
                    : 'Patch service: ' + str((e && e.message) || String(e), 80);
        this.patch = null;          // what it said before is no longer known
        if (this.timers.reply) { clearTimeout(this.timers.reply); this.timers.reply = null; }
        if (this.timers.connect) { clearTimeout(this.timers.connect); this.timers.connect = null; }
        if (this.op) { this.note = (this.op.cmd === 'apply' ? 'Turning on' : 'Turning off') + ': lost the patch service before it answered'; this.op = null; }
        if (this.timers.op) { clearTimeout(this.timers.op); this.timers.op = null; }
        this._drop();
        this._later();
    }
    _send(o) {
        if (!this.sock) return false;
        try { this.sock.write(JSON.stringify(o) + '\n'); this.stats.sent.push(o.cmd); if (this.stats.sent.length > 50) this.stats.sent.shift(); return true; } catch (e) { this._fail(e); return false; }
    }
    _expect(ms) {
        if (this.timers.reply) clearTimeout(this.timers.reply);
        this.timers.reply = setTimeout(() => { this.timers.reply = null; if (this.sock) this._fail(new Error('no reply (timed out)')); }, ms);
    }
    _data(d) {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
            if (line.length <= MAX_LINE) this._line(line);
        }
        // a line that never ends: drop what came so far, keep reading
        if (this.buf.length > MAX_LINE) this.buf = '';
    }
    _line(line) {
        let m;
        try { m = JSON.parse(line); } catch (e) { return; }                 // not JSON: ignored
        if (!m || typeof m !== 'object' || Array.isArray(m) || m.ev !== 'status') return;    // logs, captures, ...: not ours
        if (typeof m.state !== 'string') return;
        const st = {
            state: str(m.state, 20), reason: str(m.reason), conflict: str(m.conflict), carplay: str(m.carplay, 20),
            pending: m.pending === 'apply' || m.pending === 'revert' ? m.pending : null,
            mode: str(m.mode, 10), panel: str(m.panel, 10), res: str(m.res, 20), at: this.now(),
        };
        this.patch = st; this.problem = null;
        if (this.timers.reply) { clearTimeout(this.timers.reply); this.timers.reply = null; }
        if (this.op && st.state !== 'busy') {
            const what = this.op.cmd === 'apply' ? 'Turned on' : 'Turned off';
            this.note = st.state === 'error' ? '' : st.carplay === 'restarted' ? what + ': CarPlay restarted'
                : st.carplay === 'deferred' || st.pending ? what + ': takes effect at the next head-unit start' : what;
            this.log.info('cluster map: ' + this.op.cmd + ' answered: ' + st.state + (st.carplay ? ' (CarPlay ' + st.carplay + ')' : '') + (st.reason ? ' ' + st.reason : ''));
            this.op = null;
            if (this.timers.op) { clearTimeout(this.timers.op); this.timers.op = null; }
        }
    }

    /**
     * Turn the map on ('apply') or off ('revert'). Only after the user confirmed it (main.js).
     * Returns false (and says why on the page) when it cannot be sent now.
     */
    request(cmd) {
        if (cmd !== 'apply' && cmd !== 'revert') return false;
        if (!this.sock || !this.patch || this.op) { this.note = this.op ? 'Still waiting for the last change' : 'Patch service unavailable: try again'; return false; }
        const ok = this._send(cmd === 'apply' ? APPLY : { cmd: 'revert' });
        if (!ok) return false;
        this.log.info('cluster map: ' + cmd + ' sent (confirmed)');
        this.op = { cmd, at: this.now() }; this.note = '';
        if (this.timers.reply) { clearTimeout(this.timers.reply); this.timers.reply = null; }
        this.timers.op = setTimeout(() => {
            this.timers.op = null;
            if (!this.op) return;
            this.note = (this.op.cmd === 'apply' ? 'Turning on' : 'Turning off') + ': no answer yet, asking again';
            this.op = null;
            this._send({ cmd: 'status' }); this._expect(REPLY_MS);
        }, OP_MS);
        return true;
    }

    /* ---------- what the page and the row show ---------- */
    /**
     * kind: none | checking | off | on | pending | busy | conflict | error;
     * on: what the switch shows (true / false / null: neither); can: the op a tap may ask for, else null;
     * value: a short text (the settings row); line: the status line; render: the map's line ('' when not on).
     */
    view() {
        const f = this.readFiles(), p = this.patch;
        const V = (kind, on, can, value, line) => ({ kind, on, can, value, line: line || '', render: kind === 'on' ? this.renderLine() : '', note: this.note });
        if (this.op) return V('busy', this.op.cmd === 'apply', null, this.op.cmd === 'apply' ? 'Turning on...' : 'Turning off...', 'Waiting for the patch service');
        if (!this.wanted) {
            // the settings row: files only
            if (!f.tool) return V('none', null, null, 'Not installed', 'Needs Waze on cluster from the Store');
            if (f.pending) return V('pending', f.pending === 'apply', null, f.pending === 'apply' ? 'On after restart' : 'Off after restart', 'Restart the head unit to finish');
            return V('checking', null, null, 'Installed', 'Open to see its state');
        }
        if (!f.tool && !p) return V('none', null, null, 'Not installed', 'Install Waze on cluster from the Store (source robertnisipeanu/idrive-apps)');
        if (!p) {
            if (f.pending && !f.sock) return V('pending', f.pending === 'apply', null, f.pending === 'apply' ? 'On after restart' : 'Off after restart', 'Restart the head unit to finish');
            if (this.problem) return V('error', null, null, 'Unavailable', this.problem);
            return V('checking', null, null, 'Checking...', 'Asking the patch service');
        }
        const why = p.reason ? ': ' + p.reason : '';
        if (p.state === 'starting') return V('busy', null, null, 'Starting', 'Patch service starting' + why);
        if (p.state === 'unavailable') return V('error', null, null, 'Unavailable', 'Patch service unavailable' + why);
        if (p.state === 'busy') return V('busy', null, null, 'Busy', 'The patch service is busy' + why);
        if (p.conflict) return V('conflict', null, null, 'Not supported', 'Not supported on this head unit: ' + p.conflict);
        const pend = p.pending || (p.state === 'unknown' && p.carplay === 'deferred' ? (f.pending || 'apply') : null);
        if (pend) return V('pending', pend === 'apply', pend === 'apply' ? 'revert' : 'apply', pend === 'apply' ? 'On after restart' : 'Off after restart', 'Restart the head unit to finish');
        if (p.state === 'patched') return V('on', true, 'revert', 'On', 'CarPlay patched' + (p.mode ? ' (' + p.mode + (p.res ? ', ' + p.res : '') + ')' : '') + why);
        if (p.state === 'original') return V('off', false, 'apply', 'Off', 'CarPlay as stock' + why);
        if (p.state === 'error') return V('error', null, null, 'Error', 'The patch service reports an error' + why);
        return V('error', null, null, 'Unknown', 'Unknown state' + (p.state !== 'unknown' ? ' "' + p.state + '"' : '') + why);
    }
    /** The map renderer's status file, as one line. */
    renderLine() {
        const f = this.files, r = f.render;
        if (!r) return 'Map: renderer not running';
        if (f.renderAge > STALE_MS) return 'Map: renderer not running (last status ' + Math.round(f.renderAge / 1000) + ' s ago)';
        const st = str(r.state, 20), why = str(r.reason, 100);
        if (st === 'showing') return 'Map: showing on the cluster';
        if (st === 'idle') return 'Map: waiting for CarPlay' + (why ? ' (' + why + ')' : '');
        if (st === 'starting') return 'Map: starting';
        if (st === 'frozen') return 'Map: frozen, reconnect CarPlay';
        if (st === 'error') return 'Map: error' + (why ? ': ' + why : '');
        return 'Map: ' + (st || 'unknown');
    }
}

module.exports = { ClusterMap, PATHS: { PATCH_SOCK, PENDING, RENDER_STATUS, TOOL_DIR }, APPLY };
