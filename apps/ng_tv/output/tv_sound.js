'use strict';
/**
 * tv_sound.js - G's TV's sound, through the car's own media player (experimental, 0.7.0). Node 8, no npm modules.
 *
 *   const snd = new Sound({ net, dataDir, log });
 *   snd.on('clock', (t) => player.follow(t));      // the picture follows the sound's clock
 *   setInterval(() => snd.follow({ on, playing, hard, href, audio, pos: () => player.now() }), 250);
 *   snd.status() -> { state, text }; snd.close()
 *
 * How (what RideTube, JustAnotherPU/ridetube, does from a root service, and what Test sound found an app may call):
 *   - the speakers: the car's audio manager joins the generic app player's source to the main sink
 *     (org.genivi.am.commandinterface.CommandControl '1', connect { sourceID 1046, sinkID 1024 });
 *   - the sound: the player (MediaPlayer 'OapGenericMedia') plays a complete local file
 *     (playFile { path, languageCode 7695972 }); a setTime before its first time report is dropped, so the
 *     place is set after it; PAUSE answers OK and plays on, so a pause is STOP, and after a STOP the player
 *     ignores playFile and PLAY: a resume is a new connection and playFile again;
 *   - the file: the programme's own AAC, cut into .m4a files (tv_m4a.js): FIRST_S from where the picture is
 *     (a quick start), then 3x longer each (60 s, 180 s) up to WINDOW_S, each fetched while the one before plays. A programme's audio is hundreds of small
 *     pieces between the video's, so they come many byte ranges to a request (tv_net.js ranges(): the sound's
 *     own bytes only, about 130 kbit/s);
 *   - the clock: the player reports currentItemTime { elapsed, total } (ms); the picture follows it (main.js
 *     player.follow); a jump of the picture (a seek, a resume elsewhere) starts the sound again there.
 * The car switching to another source (the radio, the phone) stops the player: the sound then stays off
 * until the viewer presses Play again or the programme changes, instead of fighting for the speakers.
 * Ring lines start 'sound: '.
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const S = require('./kit/signals');
const W = require('./tv_m4a');

const MP = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
const CC = 'org.genivi.am.commandinterface.CommandControl';
const INSTANCE = 'OapGenericMedia', CC_INSTANCE = '1';
const SOURCE_ID = 1046, SINK_ID = 1024, LANGUAGE = 7695972;
const FIRST_S = 20;          // the first file: from where the picture is, short so the sound starts soon
const WINDOW_S = 300;        // the files after it grow 3x each (60 s, 180 s) up to this, so each is fetched well before it plays
const BATCH = 200;           // byte ranges per request
const JUMP_S = 3;            // picture and sound further apart: the sound starts again where the picture is
const SOFT_MS = 2000;        // the picture buffering this long: the sound stops too
const RETRY_MS = 20000;      // after an error, the sound tries again this much later
const KEEP = 3;              // .m4a files kept (the playing one, the next, one before)

const short = (v, n) => { let s; try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); } s = s === undefined ? 'nothing' : s; return s.length > (n || 200) ? s.slice(0, n || 200) + '...' : s; };
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const blocked = (m) => Object.assign(new Error(m), { blocked: true });

class Sound extends EventEmitter {
    constructor(opts) {
        super();
        this.net = opts.net; this.dataDir = opts.dataDir; this.log = opts.log;
        this.state = 'off'; this.text = ''; this.gen = 0; this.busy = false;
        this.cur = null;             // { href, audio, id }
        this.win = null;             // the window playing: { i0, i1, t0, t1, file }
        this.nextWin = null; this.fetchingNext = null; this.files = [];
        this.mp = null; this.cc = null; this.connId = null; this.releasing = null;
        this.lastTick = null; this.tickWaiter = null; this.settle = null; this.sawPlay = false; this.stopping = false;
        this.blockedWhy = ''; this.retryAt = 0; this.yielded = ''; this.softSince = 0; this.dir = null;
    }

    _set(state, text) {
        if (state === this.state && text === this.text) return;
        this.state = state; this.text = text || '';
        this.log.info('sound: ' + state + (text ? ' (' + text + ')' : ''));
        this.emit('state', state, this.text);
    }
    active() { return /^(starting|playing|waiting)$/.test(this.state); }
    status() {
        const T = {
            off: 'Off (Settings > Sound)', idle: 'On - plays with the picture', starting: 'Starting...', playing: 'On - the car\'s speakers',
            waiting: 'Loading more sound...', held: 'Paused with the picture', yielded: 'Stopped: the car switched to another source. Play brings it back',
            none: 'This programme has no sound track', unavailable: 'Not available: ' + this.blockedWhy, error: 'Error: ' + this.text + ' (trying again)',
        };
        return { state: this.state, text: T[this.state] || this.text };
    }
    /** Where the sound is, in the programme's seconds, or null. */
    audioNow() {
        const t = this.lastTick, w = this.win;
        if (!t || !w) return null;
        return w.t0 + (t.elapsed + (this.state === 'playing' ? Date.now() - t.at : 0)) / 1000;
    }

    /**
     * What the picture does, a few times a second. o: { on (the setting), playing (the picture plays), hard (stopped
     * for good: not parked, paused, left), href, audio (tv_mp4's v.audio), pos() (the picture's time, s) }.
     */
    follow(o) {
        if (!o.on) { if (this.state !== 'off') { this._halt('off'); this._dropFiles(); this.cur = null; } return; }
        if (this.state === 'off') this._set('idle', '');
        if (this.blockedWhy) return;
        if (!o.playing) {
            this.yielded = this.yielded && o.hard ? '' : this.yielded;     // a pause or stop by the viewer forgives the car's
            if (!this.active()) return;
            if (o.hard) { this._halt('held'); return; }
            if (!this.softSince) this.softSince = Date.now();
            if (Date.now() - this.softSince > SOFT_MS) this._halt('held');
            return;
        }
        this.softSince = 0;
        if (!o.audio) { if (this.state !== 'none') { this._halt('none'); } return; }
        this.pos = o.pos;
        if (this.yielded && this.yielded !== o.href) this.yielded = '';
        if (this.yielded || this.busy || Date.now() < this.retryAt) return;
        if (!this.active() || !this.cur || this.cur.href !== o.href) { this._start(o.href, o.audio, 'start'); return; }
        const at = this.audioNow();
        if (this.state === 'playing' && at !== null && Math.abs(at - o.pos()) > JUMP_S) {
            this.log.info('sound: the picture is at ' + o.pos().toFixed(1) + ' s, the sound at ' + at.toFixed(1) + ' s - starting again there');
            this._start(o.href, o.audio, 'jump');
        }
    }

    /* ----- the car's player and the speakers ----- */
    async _ensure() {
        if (!S.hasNative()) throw blocked('no SOME/IP here (not on the car)');
        if (!this.mp) {
            const p = await S.proxy(MP, INSTANCE);
            if (!(await this._up(p))) throw new Error('the car\'s media player did not answer');
            for (const name of ['playerState', 'currentItemTime', 'playbackErrorEvent']) {
                try { await S.on(p, name, (v) => this._report(name, v), this.log); } catch (e) { this.log.warn('sound: no ' + name + ' (' + ((e && e.message) || e) + ')'); }
            }
            this.mp = p;
        }
        if (!this.cc) {
            let p;
            try { p = await S.proxy(CC, CC_INSTANCE); } catch (e) {
                throw /no SOME\/IP config/.test(String(e && e.message)) ? blocked('the car gives G\'s TV no audio-manager interface') : e;
            }
            if (!(await this._up(p))) throw new Error('the car\'s audio manager did not answer');
            this.cc = p;
        }
    }
    async _up(p) {
        let up = false;
        await S.onAvailable(p, (a) => { up = up || a; }).catch(() => {});
        const until = Date.now() + 6000;
        while (!up && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
        return up;
    }
    async _connect() {
        if (this.releasing) await this.releasing;
        if (this.connId !== null) await this._release();
        const r = await S.call(this.cc, 'connect', { sourceID: SOURCE_ID, sinkID: SINK_ID }, 5000);
        this.log.info('sound: speakers connect ' + short(r));
        const err = r && r.amError;
        if (!r || (err !== 'E_OK' && err !== 'E_ALREADY_EXISTS' && err !== 0)) throw blocked('the car refused the speakers (' + short(err === undefined ? r : err, 60) + ')');
        this.connId = r.mainConnectionID === undefined || r.mainConnectionID === null ? -1 : r.mainConnectionID;
    }
    /** STOP the player and let the speakers go. */
    _release() {
        if (this.releasing) return this.releasing;
        const id = this.connId;
        this.connId = null;
        if (id === null) return Promise.resolve();
        this.releasing = (async () => {
            this.stopping = true;
            try { if (this.mp) await S.call(this.mp, 'sendButtonEvent', { button: 'STOP', action: 'PRESS' }, 3000); } catch (e) { this.log.warn('sound: STOP ' + ((e && e.message) || e)); }
            try {
                if (id === -1) throw new Error('no connection id');
                this.log.info('sound: speakers disconnect ' + short(await S.call(this.cc, 'disconnect', { mainConnectionID: id }, 5000)));
            } catch (e) {
                this.log.warn('sound: disconnect ' + ((e && e.message) || e) + ' - sweeping source ' + SOURCE_ID);
                try {
                    const list = await new Promise((resolve, reject) => setImmediate(() => this.cc.getValue('listOfMainConnections', 3000).then(resolve, reject)));
                    for (const c of (Array.isArray(list) ? list : []).filter((x) => x && x.sourceID === SOURCE_ID)) {
                        await S.call(this.cc, 'disconnect', { mainConnectionID: c.mainConnectionID }, 5000).catch(() => {});
                    }
                } catch (e2) { this.log.warn('sound: sweep ' + ((e2 && e2.message) || e2)); }
            }
            setTimeout(() => { this.stopping = false; }, 1500);     // the STOP's own report
        })().then(() => { this.releasing = null; }, () => { this.releasing = null; });
        return this.releasing;
    }
    async _play(w) {
        this.win = w; this.lastTick = null; this.settle = null; this.sawPlay = false;
        const r = await S.call(this.mp, 'playFile', { path: w.file, languageCode: LANGUAGE }, 5000);
        if (!r || r.EntError !== 'OK') throw new Error('the player answered ' + short(r, 80));
    }
    _firstTick(ms) {
        return new Promise((resolve) => {
            const done = () => { clearTimeout(timer); this.tickWaiter = null; resolve(); };
            const timer = setTimeout(done, ms);
            this.tickWaiter = done;
        });
    }
    _report(name, v) {
        if (name === 'currentItemTime') {
            if (!v || typeof v.elapsed !== 'number' || !(v.total > 1)) return;      // { elapsed 0, total 1 } right after playFile
            if (this.tickWaiter) this.tickWaiter();
            if (this.settle && Date.now() < this.settle.until && v.elapsed < this.settle.ms - 2000) return;   // before our setTime landed
            if (this.win && Math.abs(v.total - (this.win.t1 - this.win.t0) * 1000) > 1500) return;             // the file before's, late
            this.lastTick = { elapsed: v.elapsed, total: v.total, at: Date.now() };
            if (this.state !== 'playing' || !this.win) return;
            this.emit('clock', this.win.t0 + v.elapsed / 1000);
            if (v.total - v.elapsed < 400) this._switch();
        } else if (name === 'playerState') {
            if (v === 'PLAYER_STATE_PLAY') { this.sawPlay = true; return; }
            if (v !== 'PLAYER_STATE_STOP' || !this.sawPlay || this.stopping || this.state !== 'playing') return;
            this.sawPlay = false;
            const t = this.lastTick;
            if (t && t.total - t.elapsed < 4000) { this._switch(); return; }        // the file's end
            // stopped mid-file and not by us: the car went to another source
            this.log.info('sound: the player stopped at ' + (t ? t.elapsed : '?') + ' ms - the car switched source; off until Play');
            this.yielded = this.cur ? this.cur.href : '';
            this._halt('yielded');
        } else if (name === 'playbackErrorEvent') {
            if (!this.active()) return;
            this._fail(new Error('the car could not play it: ' + short(v, 80)));
        }
    }

    /* ----- the files ----- */
    _folder() {
        if (this.dir) return this.dir;
        for (const d of ['/tmp/gstv-sound', path.join(this.dataDir, 'sound')]) {
            try { fs.mkdirSync(d); } catch (e) { /* there */ }
            try { fs.chmodSync(d, 0o755); fs.accessSync(d, fs.constants.W_OK); this.dir = d; return d; } catch (e) { /* next */ }
        }
        throw new Error('no folder to write the sound to');
    }
    /** Fetch window w's audio and write it as an .m4a: w with its file. */
    async _make(w, gen) {
        const a = this.cur.audio, href = this.cur.href, rs = W.runs(a, w), bodies = [];
        for (let k = 0; k < rs.length; k += BATCH) {
            bodies.push.apply(bodies, await this.net.ranges(href, rs.slice(k, k + BATCH)));
            if (gen !== undefined && gen !== this.gen && !(this.cur && this.cur.href === href)) throw new Error('superseded');
        }
        const buf = W.build(a, w, bodies);
        const file = path.join(this._folder(), 'gstv-' + this.cur.id + '-' + w.i0 + '-' + w.i1 + '.m4a');
        await new Promise((resolve, reject) => fs.writeFile(file, buf, (e) => (e ? reject(e) : resolve())));
        try { fs.chmodSync(file, 0o644); } catch (e) { /* as it is */ }
        const out = Object.assign({}, w, { file });
        this.files = this.files.filter((f) => f.file !== file).concat([out]);
        this._prune();
        this.log.info('sound: ' + path.basename(file) + ' ' + (w.t1 - w.t0).toFixed(0) + ' s, ' + Math.round(buf.length / 1024) + ' KB, ' + rs.length + ' ranges');
        return out;
    }
    _prune() {
        const keep = (f) => (this.win && f.file === this.win.file) || (this.nextWin && f.file === this.nextWin.file);
        while (this.files.length > KEEP) {
            const i = this.files.findIndex((f) => !keep(f));
            if (i < 0) break;
            const f = this.files.splice(i, 1)[0];
            fs.unlink(f.file, () => {});
        }
    }
    _dropFiles() {
        this.files.forEach((f) => fs.unlink(f.file, () => {}));
        this.files = []; this.win = null; this.nextWin = null; this.fetchingNext = null;
    }
    /** A file already made that holds time t (with room to play), or null. */
    _madeAt(t) { return this.files.filter((f) => f.t0 <= t && t < f.t1 - 2)[0] || null; }
    _prefetch() {
        if (this.nextWin || this.fetchingNext || !this.win || !this.cur) return;
        const w = W.after(this.cur.audio, this.win, Math.min(WINDOW_S, Math.max(FIRST_S, (this.win.t1 - this.win.t0) * 3)));
        if (!w) return;
        const href = this.cur.href;
        const have = this.files.filter((f) => f.i0 === w.i0)[0];
        if (have) { this.nextWin = have; return; }
        this.fetchingNext = this._make(w).then((x) => {
            this.fetchingNext = null;
            if (!this.cur || this.cur.href !== href) return;
            this.nextWin = x;
            if (this.state === 'waiting') this._start(href, this.cur.audio, 'more sound');
        }, (e) => {
            this.fetchingNext = null;
            this.log.warn('sound: the next file: ' + ((e && e.message) || e));
            if (this.state === 'waiting') this._fail(e);
        });
    }

    /* ----- playing ----- */
    async _start(href, audio, why) {
        const gen = ++this.gen;
        this.busy = true;
        this._set('starting', why);
        // superseded or stopped meanwhile: a connection made by this start goes, unless a newer start took over
        const gone = () => { if (gen === this.gen) return false; if (!this.active()) this._release(); return true; };
        try {
            if (!this.cur || this.cur.href !== href) { this._dropFiles(); this.cur = { href, audio, id: hash(href) }; }
            await this._ensure();
            if (gone()) return;
            let w = this._madeAt(this.pos());
            if (!w) w = await this._make(W.windowAt(audio, this.pos(), FIRST_S), gen);
            if (gone()) return;
            await this._connect();
            if (gone()) return;
            if (this.nextWin && this.nextWin.file === w.file) this.nextWin = null;
            await this._play(w);
            await this._firstTick(3000);
            if (gone()) return;
            const into = this.pos() - w.t0;
            if (into > 0.3 && into < w.t1 - w.t0 - 1) {
                const ms = Math.round(into * 1000);
                this.settle = { ms, until: Date.now() + 3000 };
                this.lastTick = null;      // the report before the jump says nothing about after it (follow() would start again)
                await S.call(this.mp, 'setTime', { newTimeElapsed: ms }, 3000).catch((e) => this.log.warn('sound: setTime ' + ((e && e.message) || e)));
            }
            if (gone()) return;
            this.retryAt = 0;
            this._set('playing', path.basename(w.file) + ' from ' + into.toFixed(1) + ' s');
            this._prefetch();
        } catch (e) {
            if (gen === this.gen) this._fail(e);
        } finally {
            if (gen === this.gen) this.busy = false;
        }
    }
    /** The playing file is at its end: the next one on the same connection, or wait for it. */
    _switch() {
        if (this.switching) return;
        const nx = this.nextWin, gen = this.gen;
        if (!nx) {
            if (this.win && this.cur && W.after(this.cur.audio, this.win, FIRST_S) === null) { this.log.info('sound: the programme\'s sound ended'); this._halt('idle'); return; }
            this._set('waiting', '');
            this._prefetch();
            return;
        }
        this.switching = true;
        this.nextWin = null;
        this._play(nx).then(() => {
            if (gen !== this.gen) return;
            this._set('playing', path.basename(nx.file));
            this._prefetch(); this._prune();
        }, (e) => { if (gen === this.gen) this._fail(e); }).then(() => { this.switching = false; });
    }
    _halt(state) {
        this.gen++; this.busy = false;
        if (this.tickWaiter) this.tickWaiter();
        this._release();
        this.lastTick = null;
        this._set(state, '');
    }
    _fail(e) {
        const m = String((e && e.message) || e);
        if (m === 'superseded') return;
        this.log.warn('sound: ' + m);
        if (e && e.blocked) { this.blockedWhy = m; this._halt('unavailable'); return; }
        this.retryAt = Date.now() + RETRY_MS;
        this.gen++; this.busy = false;
        this._release();
        this._set('error', m);
    }
    /** Stop for ms (Test sound uses the same source and connection meanwhile). */
    quiet(ms) { if (this.active()) this._halt('held'); this.retryAt = Date.now() + ms; }
    /** The setting switched on again, or Check again: a blocked sound may try again. */
    reset() { this.blockedWhy = ''; this.retryAt = 0; this.yielded = ''; if (this.state === 'unavailable' || this.state === 'error') this._set('idle', ''); }
    close() {
        this._halt('off');
        this._dropFiles();
        [this.mp, this.cc].forEach((p) => { try { if (p && p.shutdown) p.shutdown(); } catch (e) { /* gone */ } });
        this.mp = null; this.cc = null;
    }
}

module.exports = { Sound, FIRST_S, WINDOW_S };
