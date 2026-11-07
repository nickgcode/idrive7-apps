'use strict';
/**
 * tv_sound_test.js - Settings > Sound > Test sound: ask the car's own media player to play something, to find
 * out whether that is how G's TV can make sound. Unlike the sound check this DOES play: it calls playFile on
 * BMW's generic app player (OapGenericMedia, de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer), which
 * may switch the car's audio source to it. Node 8, no npm modules.
 *
 *   const T = require('./tv_sound_test');
 *   const t = new T.SoundTest(dataDir, log);
 *   await t.next()   -> { n, of, way, what, route, sent, reply, error }
 *
 * On the car (0.6.2) playFile answered { EntError: 'OK' } for every file and the player reported nothing: the
 * player took the file, but nothing joined it to the speakers. RideTube (JustAnotherPU/ridetube, which plays
 * sound through this same player from a root service) first asks the car's audio manager for a connection
 * from the app player's source to the main sink (org.genivi.am.commandinterface.CommandControl, instance '1',
 * connect { sourceID 1046, sinkID 1024 }), plays a complete local AAC .m4a with languageCode 7695972 ('und'),
 * and at the end sends STOP and disconnect { mainConnectionID }. So each try now:
 *   - connects 1046 -> 1024 (once, kept while tries follow each other; G's TV asks for CommandControl "*"
 *     in app.json; whether the car lets an app's own user call it is what this finds out),
 *   - plays the next file: 1. the tone as AAC .m4a in /tmp  2. the same in G's TV's data folder
 *     3. as MP3 in /tmp  4. as WAV in /tmp (tv_tones.js; every copy readable by anyone),
 *   - and 15 s after the last try, sends STOP and disconnects.
 * playFile's arguments are read from the interface config the install generated (signals.loadConfig): the
 * text argument that looks like a location gets the file (playFile on the car: { path: Utf16D, languageCode }),
 * languageCode 7695972, every other argument an empty value.
 *
 * The answer to playFile alone does not say whether anything played, so the player is also listened to: every
 * field and event of the interface is subscribed once (signals.on), the fields with a getter are read just
 * before the call and 15 s after, and every report in between is written with its time. The screen line
 * follows the reports that look like state, position or errors while a test is watched.
 *   <data>/soundtest.txt                 what was sent, the car's answer, the reports, the before / after values
 *   <data>/mediaplayer-interface.json    the whole interface as the install generated it (all methods' inputs
 *                                        and outputs, fields, events), for the next try
 */
const fs = require('fs');
const path = require('path');
const S = require('./kit/signals');

const TONES = require('./tv_tones');

const MP = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
const CC = 'org.genivi.am.commandinterface.CommandControl';
const INSTANCE = 'OapGenericMedia';
const CC_INSTANCE = '1';
const SOURCE_ID = 1046, SINK_ID = 1024;   // the app player's source -> the main sink (RideTube, on the car)
const LANGUAGE = 7695972;                 // 'und' (undetermined), as RideTube sends
const TONE = 'gstv-test-tone';            // + .m4a / .mp3 / .wav
const TMP = '/tmp';
const PLAYER_REPORTS = ['playerState', 'currentItemTime', 'playbackErrorEvent'];   // the ones RideTube follows
const LOCATION = /ur[il]|path|file|location|link|name/i;
const WATCH_MS = 15000;            // reports kept and written for this long after each try
const MAX_NOTES = 400;              // report lines written per try, at most
const KEY = /error|state|status|position|time|current|play|source|active|focus/i;   // reports shown on the screen

/** Two short beeps (660 Hz, then 880 Hz), 16-bit 48 kHz stereo WAV: a Buffer. */
function tone() {
    const rate = 48000, beeps = [[660, 0.0, 0.6], [880, 0.8, 1.4]], len = Math.round(rate * 1.8), data = Buffer.alloc(len * 4);
    for (let i = 0; i < len; i++) {
        const t = i / rate;
        let v = 0;
        beeps.forEach((b) => {
            if (t < b[1] || t >= b[2]) return;
            const fade = Math.min(1, (t - b[1]) / 0.02, (b[2] - t) / 0.02);
            v += Math.sin(2 * Math.PI * b[0] * t) * fade * 0.35;
        });
        const s = Math.round(v * 32767);
        data.writeInt16LE(s, i * 4); data.writeInt16LE(s, i * 4 + 2);
    }
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}

/** A type node of a schema: a field may carry its type inline ({ n, t: 'Struct', e }) or nested ({ n, t: {...} }). */
const typeOf = (f) => (f && typeof f.t === 'object' && f.t ? f.t : f);
const kind = (f) => { const x = typeOf(f); return typeof x === 'string' ? x : (x && typeof x.t === 'string' ? x.t : ''); };
/** Text types: 'String', and the car's own 'Utf8D' / 'Utf16D' (dynamic length) and 'Utf8F' / 'Utf16F' (fixed); playFile's path is Utf16D. */
const TEXT = /^(String|Utf\d*[A-Z]?)$/i;

/**
 * The argument struct for a method schema, with `value` in its location-like string (else its first string).
 * { args, into: the dotted name that got value, or '' }
 */
function argsFor(schema, value) {
    const strings = [];
    const blank = (f, name) => {
        const k = kind(f), x = typeOf(f);
        if (TEXT.test(k)) { strings.push(name); return ''; }
        if (k === 'Boolean') return false;
        if (k === 'Struct') { const o = {}; ((x && x.e) || []).forEach((g) => { o[g.n] = blank(g, name ? name + '.' + g.n : g.n); }); return o; }
        if (/Array|Vector|List/i.test(k)) return [];
        if (/Byte\s*Buffer/i.test(k)) return Buffer.alloc(0);
        return 0;                                     // numbers and enumerations
    };
    const args = schema ? blank(schema, '') : {};
    const into = strings.filter((n) => LOCATION.test(n.split('.').pop()))[0] || strings[0] || '';
    if (into) {
        const parts = into.split('.');
        let o = args;
        parts.slice(0, -1).forEach((p) => { o = o[p]; });
        o[parts[parts.length - 1]] = value;
    }
    return { args: args && typeof args === 'object' ? args : {}, into };
}

const short = (v, n) => { let s; try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); } s = s === undefined ? 'nothing' : s; return s.length > n ? s.slice(0, n) + '...' : s; };

class SoundTest {
    constructor(dataDir, log) {
        this.dataDir = dataDir; this.log = log;
        this.n = 0; this.busy = false; this.proxy = null; this.last = null;
        this.report = path.join(dataDir, 'soundtest.txt');
        this.def = null; this.names = null; this.listening = false;
        this.latest = {};                   // field / event -> { at, v } (the newest report)
        this.watch = null;                  // { until, since, notes, seen: { name: count } } while a try is watched
        this.cc = null; this.connId = null; this.routeTimer = null; this.heardCount = 0;
    }
    /**
     * Join the app player to the speakers (once; kept while tries follow each other): 'connected (id N)',
     * 'already connected (id N)' or why not. Never throws: playFile is tried either way.
     */
    async _route() {
        if (this.routeTimer) { clearTimeout(this.routeTimer); this.routeTimer = null; }
        if (this.connId !== null) return 'still connected (id ' + this.connId + ')';
        try {
            if (!this.cc) {
                const p = await S.proxy(CC, CC_INSTANCE);
                let up = false;
                await S.onAvailable(p, (a) => { up = up || a; }).catch(() => {});
                const until = Date.now() + 6000;
                while (!up && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
                if (!up) { try { if (p.shutdown) await p.shutdown(); } catch (e) { /* gone */ } throw new Error('the audio manager did not answer'); }
                this.cc = p;
            }
            const r = await S.call(this.cc, 'connect', { sourceID: SOURCE_ID, sinkID: SINK_ID }, 5000);
            this._note('audio route: connect ' + SOURCE_ID + ' -> ' + SINK_ID + ': ' + short(r, 300));
            const err = r && r.amError;
            if (!r || (err !== 'E_OK' && err !== 'E_ALREADY_EXISTS' && err !== 0)) return 'refused (' + short(err === undefined ? r : err, 60) + ')';
            this.connId = r.mainConnectionID === undefined || r.mainConnectionID === null ? -1 : r.mainConnectionID;
            return (err === 'E_ALREADY_EXISTS' ? 'already connected' : 'connected') + ' (id ' + this.connId + ')';
        } catch (e) {
            const m = String((e && e.message) || e);
            this._note('audio route: ' + m);
            return /no SOME\/IP config/.test(m) ? 'not available to G\'s TV (no audio-manager interface)' : 'failed (' + short(m, 80) + ')';
        }
    }
    /** STOP the player and let the speakers go (after the last try's watch). */
    async _release() {
        this.routeTimer = null;
        if (this.proxy) {
            try { this._note('stop: ' + short(await S.call(this.proxy, 'sendButtonEvent', { button: 'STOP', action: 'PRESS' }, 3000), 200)); }
            catch (e) { this._note('stop failed: ' + ((e && e.message) || e)); }
        }
        const id = this.connId;
        this.connId = null;
        if (id === null || !this.cc) return;
        try {
            if (id === -1) throw new Error('no connection id');
            this._note('audio route: disconnect ' + id + ': ' + short(await S.call(this.cc, 'disconnect', { mainConnectionID: id }, 5000), 200));
        } catch (e) {
            this._note('audio route: disconnect failed (' + ((e && e.message) || e) + '); sweeping source ' + SOURCE_ID);
            try {
                const list = await new Promise((resolve, reject) => setImmediate(() => this.cc.getValue('listOfMainConnections', 3000).then(resolve, reject)));
                for (const c of (Array.isArray(list) ? list : []).filter((x) => x && x.sourceID === SOURCE_ID)) {
                    this._note('audio route: disconnect ' + c.mainConnectionID + ': ' + short(await S.call(this.cc, 'disconnect', { mainConnectionID: c.mainConnectionID }, 5000).catch((e2) => String(e2)), 200));
                }
            } catch (e2) { this._note('audio route: sweep failed: ' + ((e2 && e2.message) || e2)); }
        }
    }
    /** The interface as the install generated it, and its field / event names: { fields: [{ name, getter }], events: [] }. */
    _interface() {
        if (this.def) return this.def;
        this.def = S.loadConfig(MP);
        const keys = (o) => (Array.isArray(o) ? o.map((x) => (x && (x.name || x.n)) || String(x)) : o && typeof o === 'object' ? Object.keys(o) : []);
        const fo = this.def.fields || this.def.attributes || {};
        this.names = {
            fields: keys(fo).map((name) => ({ name, getter: !!(fo[name] && fo[name].getter) || Array.isArray(fo) })),
            events: keys(this.def.events || this.def.broadcasts),
        };
        try { fs.writeFileSync(path.join(this.dataDir, 'mediaplayer-interface.json'), JSON.stringify(this.def, null, 1)); } catch (e) { this.log.warn('sound test: interface not saved (' + e.message + ')'); }
        this._note('interface: ' + Object.keys(this.def.methods || {}).length + ' methods, fields ' + this.names.fields.map((f) => f.name + (f.getter ? '' : ' (no getter)')).join(', ') +
            '; events ' + (this.names.events.join(', ') || 'none') + ' (all of it in mediaplayer-interface.json)');
        return this.def;
    }
    /** A report from the player: kept as the newest value, and written while a try is watched. */
    _heard(name, v) {
        const now = Date.now();
        this.latest[name] = { at: now, v };
        this.heardCount++;
        const w = this.watch;
        if (!w || now > w.until) return;
        w.seen[name] = (w.seen[name] || 0) + 1;
        if (w.notes++ < MAX_NOTES) this._note('  +' + ((now - w.since) / 1000).toFixed(1) + ' s ' + name + ' = ' + short(v, 500));
        else if (w.notes === MAX_NOTES + 1) this._note('  (more reports not written)');
    }
    /** Subscribe once to every field and event of the player. */
    async _listen(p) {
        if (this.listening) return;
        this.listening = true;
        const all = this.names.fields.map((f) => f.name).concat(this.names.events);
        PLAYER_REPORTS.forEach((n) => { if (all.indexOf(n) < 0) all.push(n); });
        let ok = 0;
        const failed = [];
        for (const name of all) {
            try { await S.on(p, name, (v) => this._heard(name, v), this.log); ok++; } catch (e) { failed.push(name + ' (' + short(String((e && e.message) || e), 60) + ')'); }
        }
        this.listened = ok; this.listenOf = all.length;
        this._note('listening to ' + ok + ' of ' + all.length + ' fields and events' + (failed.length ? '; not: ' + failed.join(', ') : ''));
    }
    /** Read every field with a getter: { name: value or 'error: ...' }. */
    async _readAll(p) {
        const out = {};
        for (const f of this.names.fields) {
            if (!f.getter) continue;
            try { out[f.name] = await new Promise((resolve, reject) => setImmediate(() => p.getValue(f.name, 3000).then(resolve, reject))); }
            catch (e) { out[f.name] = 'error: ' + ((e && e.message) || e); }
        }
        return out;
    }
    _note(line) { try { fs.appendFileSync(this.report, new Date().toISOString() + ' ' + line + '\n'); } catch (e) { /* not saved */ } }
    /** The tone as .m4a, .mp3 and .wav, in /tmp and in the data folder, readable by anyone. */
    _files() {
        const bufs = { m4a: Buffer.from(TONES.m4a, 'base64'), mp3: Buffer.from(TONES.mp3, 'base64'), wav: tone() };
        [TMP, this.dataDir].forEach((d) => Object.keys(bufs).forEach((k) => {
            const f = path.join(d, TONE + '.' + k);
            try { fs.writeFileSync(f, bufs[k]); fs.chmodSync(f, 0o644); } catch (e) { this.log.warn('sound test: ' + f + ' not written (' + e.message + ')'); }
        }));
    }
    /** The ways to try, in order: [{ way, what }]. */
    ways() {
        return [
            { way: 'AAC tone in /tmp', what: path.join(TMP, TONE + '.m4a') },
            { way: 'AAC tone in the data folder', what: path.join(this.dataDir, TONE + '.m4a') },
            { way: 'MP3 tone in /tmp', what: path.join(TMP, TONE + '.mp3') },
            { way: 'WAV tone in /tmp', what: path.join(TMP, TONE + '.wav') },
        ];
    }
    /** playFile's inputs and outputs from this app's interface config. */
    schema() {
        let def;
        try { def = this._interface(); } catch (e) { return { error: e.message }; }
        const m = (def.methods || {}).playFile;
        return { playFile: m ? m.schema || null : undefined, ret: m ? m.retSchema || null : null };
    }
    async _proxy() {
        if (this.proxy) return this.proxy;
        if (!S.hasNative()) throw new Error('no SOME/IP here (not on the car)');
        const p = await S.proxy(MP, INSTANCE);
        let up = false;
        await S.onAvailable(p, (a) => { up = up || a; }).catch(() => {});
        const until = Date.now() + 6000;
        while (!up && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
        if (!up) { try { if (p.shutdown) await p.shutdown(); } catch (e) { /* gone */ } throw new Error(INSTANCE + ' did not answer'); }
        this.proxy = p;
        return p;
    }
    /** Try the next way: { n, of, way, what, into, sent, reply, error }. */
    async next(opts) {
        if (this.busy) return this.last;
        this.busy = true;
        const ways = this.ways(), i = this.n % ways.length, w = ways[i];
        this.n++;
        const r = { n: i + 1, of: ways.length, way: w.way, what: w.what, into: '', route: '', sent: false, reply: null, error: '' };
        try {
            this._files();
            const sc = this.schema();
            if (sc.error) throw new Error(sc.error);
            if (sc.playFile === undefined) throw new Error('playFile is not in the media-player interface');
            const a = argsFor(sc.playFile, w.what);
            if (a.args && Object.prototype.hasOwnProperty.call(a.args, 'languageCode')) a.args.languageCode = LANGUAGE;
            r.into = a.into;
            if (!a.into) throw new Error('playFile has no text argument for the file: ' + short(sc.playFile, 200));
            const p = await this._proxy();
            await this._listen(p);
            r.route = await this._route();
            this._note('try ' + r.n + ': audio route ' + r.route);
            const before = await this._readAll(p);
            this._note('try ' + r.n + ' (' + w.way + '): before ' + short(before, 3000));
            this._note('try ' + r.n + ': playFile ' + short(a.args, 600) + ' (it answers ' + short(sc.ret, 200) + ')');
            const since = Date.now();
            this.watch = { until: since + WATCH_MS, since, notes: 0, seen: {}, n: r.n, before };
            r.sent = true; r.since = since;
            r.reply = await S.call(p, 'playFile', a.args, 8000);
            this._note('try ' + r.n + ': answer after ' + ((Date.now() - since) / 1000).toFixed(1) + ' s: ' + short(r.reply, 600));
            this._after(p, this.watch);
        } catch (e) {
            r.error = String((e && e.message) || e);
            this._note('try ' + r.n + ' (' + w.way + '): ' + (r.sent ? 'call failed: ' : 'not sent: ') + r.error);
            if (r.sent && this.proxy) this._after(this.proxy, this.watch);
        }
        // the speakers are let go once the last try's watch is over (a new try in time keeps them)
        if (this.connId !== null) {
            if (this.routeTimer) clearTimeout(this.routeTimer);
            this.routeTimer = setTimeout(() => { this._release().catch(() => {}); }, WATCH_MS + 1000);
        }
        this.log.info('sound test ' + r.n + '/' + r.of + ' (' + r.way + '): ' + (r.error ? (r.sent ? 'failed: ' : 'not sent: ') + r.error : 'sent, answer ' + short(r.reply, 200)));
        this.busy = false;
        this.last = r;
        return r;
    }
    /** WATCH_MS after the call: the fields read again, and what changed, written. */
    _after(p, w) {
        if (!w) return;
        setTimeout(() => {
            this._readAll(p).then((after) => {
                const changed = Object.keys(after).filter((k) => short(after[k], 2000) !== short(w.before[k], 2000));
                this._note('try ' + w.n + ': after ' + (WATCH_MS / 1000) + ' s, ' + w.notes + ' reports (' + (Object.keys(w.seen).map((k) => k + ' x' + w.seen[k]).join(', ') || 'none') +
                    '); fields changed: ' + (changed.map((k) => k + ' = ' + short(after[k], 300)).join('; ') || 'none'));
                w.changed = changed;
                w.done = true;
            }, (e) => { this._note('try ' + w.n + ': reading after failed: ' + e); w.done = true; });
        }, Math.max(0, w.until - Date.now()));
    }
    /** The player's reports for the screen: those that look like state, position or errors, newest first. */
    _reports(w) {
        const names = Object.keys(this.latest).filter((k) => this.latest[k].at >= w.since);
        const pick = names.filter((k) => KEY.test(k)).concat(names.filter((k) => !KEY.test(k)))
            .sort((a, b) => (KEY.test(b) - KEY.test(a)) || this.latest[b].at - this.latest[a].at).slice(0, 3);
        return pick.map((k) => k + ' ' + short(this.latest[k].v, 70)).join('; ');
    }
    /** The line for the screen, live: the last try, then what the player has reported since. */
    text() {
        const r = this.last;
        if (!r) return '';
        const head = 'Test ' + r.n + ' of ' + r.of + ' (' + r.way + '): ';
        if (!r.sent) return head + 'not sent - ' + r.error;
        const ans = (r.route ? 'speakers ' + r.route + '; ' : '') + (r.error ? 'the call failed - ' + r.error : 'played, the car answered ' + short(r.reply, 60));
        const w = this.watch && this.watch.since === r.since ? this.watch : null;
        if (!w) return head + ans;
        const heard = this._reports(w);
        const tail = heard ? ' Player: ' + heard + '.' : w.done ? ' The player reported nothing (listening to ' + (this.listened || 0) + ' of ' + (this.listenOf || 0) + ' reports, ' + this.heardCount + ' heard since start).' : ' Listening to the player...';
        const end = w.done ? (w.changed && w.changed.length ? ' Changed: ' + w.changed.slice(0, 4).join(', ') + '.' : '') + ' Heard it? If not, tap for the next way.' : '';
        return head + ans + '.' + tail + end;
    }
    /** One line for the screen (the result alone, without the player's reports). */
    static line(r) {
        if (!r) return '';
        const head = 'Test ' + r.n + ' of ' + r.of + ' (' + r.way + '): ';
        if (!r.sent) return head + 'not sent - ' + r.error;
        if (r.error) return head + 'the call failed - ' + r.error;
        return head + 'sent; the car answered ' + short(r.reply, 160) + '. Heard it? If not, tap Test sound for the next way.';
    }
    close() {
        if (this.connId !== null) this._release().catch(() => {});
        const p = this.proxy; this.proxy = null; try { if (p && p.shutdown) p.shutdown(); } catch (e) { /* gone */ }
    }
}

module.exports = { SoundTest, tone, argsFor, TONE, TEXT };
