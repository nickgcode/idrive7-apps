'use strict';
/**
 * cluster_source.js - the Cluster source picker's shared state (G's Dash 0.8.3, G's Music 0.6.1, G's TV 0.4.4).
 * G's Dash owns it; G's Music and G's TV get this file through app.json "share" (one copy in git).
 *
 * The pick: what the instrument cluster's centre map area shows, chosen on G's Dash's Cluster source page:
 *   auto   as before 0.8.3: each app decides (the logo while G's Dash is open, G's Music over it while a
 *          track plays, its own Cluster setting deciding)
 *   logo   G's Dash's logo, also while G's Dash runs in the background; G's Music stays out
 *   music  G's Music's lyrics / visualizer (its own Cluster setting: Lyrics + visualizer or Visualizer only;
 *          Off is respected); with nothing playing the logo (it stays up under G's Music's layers)
 *   map    none of our apps' layers: Waze on cluster's CarPlay map, else the car's own
 *   stock  none of our apps' layers: the car's own content (needs Waze on cluster off to show)
 * In every pick route guidance shows directions (our layers hide), and G's TV draws only after its own
 * Cluster button (parked only), yielding to route guidance too; when it stops the pick is back.
 *
 * The file: SOURCE_DIR/source.json (tmpfs, as the apps' other /dev/shm files), written only by G's Dash:
 *   { "v": 1, "source": "logo", "rev": 3, "at": <ms>, "by": "ng_gsdash" }
 * The directory is made 0755 and the file written whole (a temp file 0644, then rename), so a reader never
 * sees half a file. A reader takes it only when the directory and the file are not symlinks, neither is
 * writable by group or others, the file is a regular file owned by the directory's owner, small, parses,
 * v is 1, by is "ng_gsdash" and source is one of SOURCES. Anything else: the reader's last good value,
 * kept in its own settings.json (CACHE_KEY), else "auto". The file is gone after a head-unit restart until
 * G's Dash runs again; the cache keeps the pick meanwhile.
 *
 * G's Music also writes its own Cluster setting to MUSIC_DIR/state.json the same way (its own directory:
 * only one app writes in each), so G's Dash's page can warn when Music is picked but G's Music's is Off.
 *
 * Also the route guidance check G's TV uses (Guidance: the same signals and debounce as the logo's).
 *
 * Never throws. Node 8: no optional chaining, no ?? and no object spread.
 */
const fs = require('fs');
const path = require('path');

const SOURCES = ['auto', 'logo', 'music', 'map', 'stock'];
const NAMES = { auto: 'Auto', logo: 'Logo', music: 'Music', map: 'Map', stock: 'Stock' };
const SOURCE_DIR = process.env.NG_CS_DIR || '/dev/shm/ng-cluster';
const MUSIC_DIR = process.env.NG_CS_MUSIC_DIR || '/dev/shm/ng-cluster-music';
const FILE = 'source.json', MUSIC_FILE = 'state.json';
const WRITER = 'ng_gsdash', MUSIC_WRITER = 'ng_spotify';
const CACHE_KEY = '_clusterSourceSeen';
const MAX_BYTES = 1024;
const DEFAULT = 'auto';

const valid = (s) => SOURCES.indexOf(s) >= 0;
const myUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

/**
 * The directory made (0755) or checked: ours (when we can tell), a real directory, not group / world
 * writable. { ok } or { error, text }.
 */
function ownDir(dir) {
    try { fs.mkdirSync(dir, 0o755); } catch (e) { if (e.code !== 'EEXIST') return { error: 'mkdir', text: 'Cannot make ' + dir + ' (' + e.code + ')' }; }
    let st;
    try { st = fs.lstatSync(dir); } catch (e) { return { error: 'mkdir', text: 'Cannot read ' + dir }; }
    if (!st.isDirectory() || st.isSymbolicLink()) return { error: 'taken', text: dir + ' is not a directory' };
    const uid = myUid();
    if (uid >= 0 && st.uid !== uid) return { error: 'taken', text: dir + ' belongs to another app' };
    if ((st.mode & 0o777) !== 0o755) { try { fs.chmodSync(dir, 0o755); } catch (e) { return { error: 'mode', text: 'Cannot set ' + dir + ' to 0755' }; } }
    return { ok: true };
}

/** obj written whole as dir/name (0644: temp file, then rename). { ok } or { error, text }. */
function writeAtomic(dir, name, obj) {
    const d = ownDir(dir);
    if (!d.ok) return d;
    const file = path.join(dir, name), tmp = path.join(dir, '.' + name + '.' + process.pid + '.tmp');
    try {
        try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
        const fd = fs.openSync(tmp, 'wx', 0o644);
        try { fs.writeSync(fd, JSON.stringify(obj) + '\n'); } finally { fs.closeSync(fd); }
        fs.chmodSync(tmp, 0o644);
        fs.renameSync(tmp, file);
        return { ok: true };
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* gone */ }
        return { error: 'write', text: 'Cannot write ' + file + ' (' + (e.code || e.message) + ')' };
    }
}

/**
 * dir/name read and checked (see the header): { obj, mtime } or { error: 'missing' | 'untrusted' | 'bad', text }.
 * check(obj): true when its values are fine.
 */
function readChecked(dir, name, writer, check) {
    const file = path.join(dir, name);
    let ds, fsx;
    try { ds = fs.lstatSync(dir); } catch (e) { return { error: 'missing', text: 'No shared file yet' }; }
    try { fsx = fs.lstatSync(file); } catch (e) { return { error: 'missing', text: 'No shared file yet' }; }
    if (!ds.isDirectory() || ds.isSymbolicLink() || (ds.mode & 0o022)) return { error: 'untrusted', text: 'Shared folder not trusted' };
    if (!fsx.isFile() || fsx.isSymbolicLink() || (fsx.mode & 0o022) || fsx.uid !== ds.uid) return { error: 'untrusted', text: 'Shared file not trusted' };
    if (fsx.size > MAX_BYTES) return { error: 'bad', text: 'Shared file too big' };
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { error: 'bad', text: 'Shared file unreadable' }; }
    if (!obj || typeof obj !== 'object' || obj.v !== 1 || obj.by !== writer || !check(obj)) return { error: 'bad', text: 'Shared file not understood' };
    return { obj, mtime: fsx.mtime.getTime(), size: fsx.size };
}

/* ----- the pick (G's Dash writes, everyone reads) ----- */

/** G's Dash: publish the pick. rev: a counter (any number). { ok } or { error, text }. */
function publish(source, rev, opts) {
    const o = opts || {};
    if (!valid(source)) return { error: 'value', text: 'Unknown source ' + source };
    return writeAtomic(o.dir || SOURCE_DIR, FILE, { v: 1, source, rev: rev | 0, at: (o.now || Date.now)(), by: WRITER });
}
/** The pick as the file says it: { source, rev, at } or { error, text }. */
function readSource(opts) {
    const o = opts || {};
    const r = readChecked(o.dir || SOURCE_DIR, FILE, WRITER, (x) => valid(x.source));
    if (r.error) return r;
    return { source: r.obj.source, rev: r.obj.rev | 0, at: +r.obj.at || 0, mtime: r.mtime };
}

/**
 * A reader (G's Music, G's TV): the pick, re-read only when the file changed, the last good value kept in
 * the app's settings (CACHE_KEY), else DEFAULT. opts: settings ({ get, set }), log, dir, now.
 * get() -> { source, from: 'file' | 'cache' | 'default', error, text }.
 */
class SourceReader {
    constructor(opts) {
        const o = opts || {};
        this.o = o;
        this.settings = o.settings || null;
        this.log = o.log || { info() {}, warn() {} };
        this.key = '';            // the file's identity last read (mtime + size), '' none
        this.cur = null;          // the last get()
        this.lastErr = '';
    }
    _cached() { const v = this.settings ? this.settings.get(CACHE_KEY) : null; return valid(v) ? v : ''; }
    get() {
        const o = this.o, dir = o.dir || SOURCE_DIR;
        let st = null;
        try { st = fs.lstatSync(path.join(dir, FILE)); } catch (e) { st = null; }
        const key = st ? st.mtime.getTime() + ':' + st.size + ':' + st.mode + ':' + st.uid : '';
        if (this.cur && key && key === this.key && this.cur.from === 'file') return this.cur;
        this.key = key;
        const r = readSource({ dir });
        let out;
        if (!r.error) {
            out = { source: r.source, from: 'file', error: '', text: '' };
            if (this.settings && this.settings.get(CACHE_KEY) !== r.source) { try { this.settings.set(CACHE_KEY, r.source); } catch (e) { /* read-only */ } }
        } else {
            const c = this._cached();
            out = { source: c || DEFAULT, from: c ? 'cache' : 'default', error: r.error, text: r.text };
        }
        if (out.error !== this.lastErr) {
            this.lastErr = out.error;
            if (out.error === 'untrusted' || out.error === 'bad') this.log.warn('cluster source: ' + out.text + ' - using ' + out.source + ' (' + out.from + ')');
            else if (out.error === 'missing') this.log.info('cluster source: no shared file - using ' + out.source + ' (' + out.from + ')');
        }
        if (!this.cur || this.cur.source !== out.source) this.log.info('cluster source: ' + out.source + ' (' + out.from + ')');
        this.cur = out;
        return out;
    }
}

/* ----- G's Music's own Cluster setting (G's Music writes, G's Dash reads) ----- */

const MUSIC_SETTINGS = ['off', 'lyrics', 'visualizer'];
function publishMusic(setting, opts) {
    const o = opts || {};
    if (MUSIC_SETTINGS.indexOf(setting) < 0) return { error: 'value', text: 'Unknown setting ' + setting };
    return writeAtomic(o.dir || MUSIC_DIR, MUSIC_FILE, { v: 1, cluster: setting, at: (o.now || Date.now)(), by: MUSIC_WRITER });
}
/** { cluster: 'off' | 'lyrics' | 'visualizer', at } or { error, text } (missing: G's Music not seen). */
function readMusic(opts) {
    const o = opts || {};
    const r = readChecked(o.dir || MUSIC_DIR, MUSIC_FILE, MUSIC_WRITER, (x) => MUSIC_SETTINGS.indexOf(x.cluster) >= 0);
    if (r.error) return r;
    return { cluster: r.obj.cluster, at: +r.obj.at || 0 };
}

/* ----- route guidance, debounced (G's TV 0.4.4; the same signals and timing as the logo's and G's Music's) ----- */

/** The watches: [interface, instance, member, src]. */
const GUIDE_SIGNALS = [
    ['de.bmw.infotainment.navigation.navigationstatus.NavigationStatus', '1', 'guidingState', 'nav'],
    ['de.bmw.infotainment.a4a.carplay.CarPlayManager', 'CarPlayManagerInst1', 'projectedGuidanceActive', 'carplay'],
    ['de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager', 'AndroidAutoProjectedManagerInst1', 'projectedGuidanceActive', 'aa'],
];
const GUIDE_ON_MS = 1000, GUIDE_OFF_MS = 3000;
/** A raw signal value as true (guiding) / false / null (not understood): nav guidingState ACTIVE (2), else a boolean. */
function guideValue(src, v) {
    if (v && typeof v === 'object') {
        const k = Object.keys(v).find((x) => typeof v[x] === 'number' || typeof v[x] === 'boolean' || typeof v[x] === 'string');
        return k === undefined ? null : guideValue(src, v[k]);
    }
    if (src === 'nav') {
        if (typeof v === 'number') return v === 2;
        if (typeof v === 'string') return /^(\d+|[A-Z_]+)$/i.test(v) ? (v === '2' || /^active$/i.test(v)) : null;
        return null;
    }
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return /^(true|1)$/i.test(v) ? true : /^(false|0)$/i.test(v) ? false : null;
    return null;
}
/**
 * Route guidance from any of the signals, debounced: on for GUIDE_ON_MS -> guiding, off for GUIDE_OFF_MS -> not.
 * set(src, raw) from the watches, tick() -> guiding (call it often: every 250 ms). opts: now, log, tag.
 */
class Guidance {
    constructor(opts) {
        const o = opts || {};
        this.now = o.now || Date.now;
        this.log = o.log || { info() {}, warn() {} };
        this.tag = o.tag || 'route guidance';
        this.guide = { nav: null, carplay: null, aa: null };
        this.raw = false; this.since = this.now(); this.guiding = false;
    }
    set(src, v) {
        if (!Object.prototype.hasOwnProperty.call(this.guide, src)) return;
        const g = guideValue(src, v);
        if (g === null) { this.log.info(this.tag + ': ' + src + ' value not understood: ' + JSON.stringify(v)); return; }
        if (this.guide[src] !== g) this.log.info(this.tag + ': ' + src + ' ' + (g ? 'active' : 'off'));
        this.guide[src] = g;
    }
    tick() {
        const now = this.now(), raw = this.guide.nav === true || this.guide.carplay === true || this.guide.aa === true;
        if (raw !== this.raw) { this.raw = raw; this.since = now; }
        if (raw && !this.guiding && now - this.since >= GUIDE_ON_MS) this.guiding = true;
        if (!raw && this.guiding && now - this.since >= GUIDE_OFF_MS) this.guiding = false;
        return this.guiding;
    }
}

/* ----- the rules, in one place (the apps and the tests use these) ----- */

/** Whether G's Dash's logo layer is wanted: pick, open (its screen up), logoSetting ('on' | 'off', Auto only). */
function logoWanted(source, open, logoSetting) {
    if (source === 'logo' || source === 'music') return true;       // also in the background
    if (source === 'auto') return !!open && logoSetting !== 'off';  // as before 0.8.3
    return false;                                                   // map, stock
}
/** Whether G's Music may draw (its own setting still decides what and whether: Off is respected). */
function musicAllowed(source) { return source === 'auto' || source === 'music'; }

module.exports = { SOURCES, NAMES, SOURCE_DIR, MUSIC_DIR, FILE, MUSIC_FILE, WRITER, MUSIC_WRITER, CACHE_KEY, DEFAULT, MAX_BYTES,
    valid, publish, readSource, SourceReader, publishMusic, readMusic, logoWanted, musicAllowed, writeAtomic, readChecked,
    GUIDE_SIGNALS, GUIDE_ON_MS, GUIDE_OFF_MS, guideValue, Guidance };
