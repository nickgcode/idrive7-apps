'use strict';
/**
 * Lyrics from LRCLIB (https://lrclib.net): free, no key, an open database of synced (LRC) and plain
 * lyrics. API: GET /api/get?track_name&artist_name&album_name&duration (seconds) for an exact match,
 * GET /api/search?track_name&artist_name for the fuzzy rest. LRCLIB asks clients to send a
 * User-Agent naming the app, its version and a homepage.
 *
 * Lyrics.get(track) never blocks: it returns what is known for the track ({ state: 'loading' } on the
 * first call, which starts the lookup) and caches the answer per track:
 *   { state: 'synced', lines: [{ t: ms, text }] }      time-coded lines, sorted
 *   { state: 'plain', text: [line, ...] }               lyrics without timing
 *   { state: 'instrumental' } | { state: 'none' }       nothing to show (the app shows its visualizer)
 *   { state: 'undrawable' }                             lyrics in letters the kit's fonts don't have
 *   { state: 'error' }                                  the lookup failed (offline...): tried again later
 *
 * Node 8: no optional chaining, no ??, no object spread.
 */
const querystring = require('querystring');

const HOST = 'lrclib.net';
const CACHE = 40;                  // tracks kept
const RETRY_MS = 30000;            // after a failed lookup (offline, LRCLIB busy)
const DURATION_SLACK = 3;          // s: LRCLIB's own matching tolerance for /api/get is 2 s

/** Parse LRC text: [mm:ss.xx] lines (several stamps per line allowed), [offset:+/-ms]. */
function parseLrc(lrc) {
    const out = [];
    let offset = 0;
    String(lrc || '').split(/\r?\n/).forEach((raw) => {
        const off = /^\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
        if (off) { offset = Number(off[1]) || 0; return; }
        const stamps = [];
        let rest = raw, m;
        const re = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
        while ((m = re.exec(rest))) {
            const frac = m[3] ? Number((m[3] + '00').slice(0, 3)) : 0;
            stamps.push(Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac);
            rest = rest.slice(m[0].length);
        }
        if (!stamps.length) return;
        const text = clean(rest);
        stamps.forEach((t) => out.push({ t, text }));
    });
    // a positive offset means the lyrics come earlier (LRC convention)
    out.forEach((l) => { l.t = Math.max(0, l.t - offset); });
    out.sort((a, b) => a.t - b.t);
    return out;
}

/**
 * One lyric line as shown: trimmed, the music-note marker (an instrumental gap) as an empty line, and
 * folded to the kit's fonts (ASCII and a few signs): curly quotes straight, accents dropped
 * ("Beyonc\u00e9" -> "Beyonce"). Lines that still have other letters (Cyrillic, Korean...) can't be
 * drawn: showable() says so and the app shows its visualizer instead.
 */
const FOLD = { '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u2032': "'", '\u00b4': "'", '`': "'",
    '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u00ab': '"', '\u00bb': '"', '\u00a0': ' ', '\u2009': ' ', '\u200b': '',
    '\u00df': 'ss', '\u00e6': 'ae', '\u00c6': 'AE', '\u0153': 'oe', '\u0152': 'OE', '\u00f8': 'o', '\u00d8': 'O',
    '\u0142': 'l', '\u0141': 'L', '\u0111': 'd', '\u0110': 'D', '\u00a1': '!', '\u00bf': '?', '\u2012': '-', '\u2010': '-', '\u2011': '-' };
function clean(s) {
    return fold(String(s || '').replace(/[\u266a\u266b\u266c\u2669]/g, '')).replace(/\s+/g, ' ').trim();
}
/** Text folded to the kit's fonts (as clean(), spacing kept): for titles and names too. */
function fold(s) {
    s = String(s || '');
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* no ICU: as is */ }
    s = s.replace(/[\u2018\u2019\u201a\u201b\u2032\u00b4`\u201c\u201d\u201e\u00ab\u00bb\u00a0\u2009\u200b\u00df\u00e6\u00c6\u0153\u0152\u00f8\u00d8\u0142\u0141\u0111\u0110\u00a1\u00bf\u2012\u2010\u2011]/g, (c) => FOLD[c]);
    return s;
}
/** Every character in the kit's Latin fonts (kit/runtime/fonts: ASCII and a few signs). */
const DRAWABLE = /^[\x20-\x7e\u00b0\u00b1\u00b2\u00b3\u00b7\u00d7\u03bc\u2013\u2014\u2026\u20ac]*$/;
/** Whether an entry's lyrics can be drawn (nearly every line in the fonts). */
function showable(entry) {
    const lines = entry.lines ? entry.lines.map((l) => l.text) : entry.text || [];
    const real = lines.filter(Boolean);
    if (!real.length) return false;
    return real.filter((l) => DRAWABLE.test(l)).length >= real.length * 0.9;
}

function norm(s) { return String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ').trim(); }

/**
 * The title without what Spotify adds for versions ("Song - Remastered 2011", "Song (feat. X)"), which
 * LRCLIB usually files under the plain title.
 */
function baseTitle(t) {
    return String(t || '')
        .replace(/\s+-\s+[^-]*\b(remaster(ed)?|version|edit|mix|live|mono|stereo|deluxe|anniversary|single|bonus|acoustic|demo)\b.*$/i, '')
        .replace(/\s*[([](feat\.?|ft\.?|with)\s[^)\]]*[)\]]/ig, '')
        .trim() || String(t || '');
}

/** The first artist (Spotify lists every artist; LRCLIB usually has the main one). */
function mainArtist(track) { return track.artist1 || String(track.artist || '').split(', ')[0]; }

/** An LRCLIB record -> our cache entry. */
function entryOf(rec) {
    if (!rec) return { state: 'none' };
    if (rec.instrumental) return { state: 'instrumental' };
    if (rec.syncedLyrics) {
        const lines = parseLrc(rec.syncedLyrics);
        if (lines.some((l) => l.text)) return showable({ lines }) ? { state: 'synced', lines } : { state: 'undrawable' };
    }
    if (rec.plainLyrics) {
        const text = String(rec.plainLyrics).split(/\r?\n/).map(clean);
        while (text.length && !text[0]) text.shift();
        if (text.some(Boolean)) return showable({ text }) ? { state: 'plain', text } : { state: 'undrawable' };
    }
    return { state: 'none' };
}

class Lyrics {
    /**
     * request(method, host, path, headers) -> Promise<{ status, body: Buffer }> (Spotify.request: the
     * uplink's DNS and CA). ua: the User-Agent LRCLIB asks for.
     */
    constructor(request, log, ua) {
        this.request = request;
        this.log = log;
        this.ua = ua;
        this.cache = new Map();      // key -> entry (insertion order = age)
        this.busy = new Map();       // key -> started (ms)
    }

    static key(track) { return track.uri || [track.title, track.artist, track.album, Math.round((track.duration || 0) / 1000)].join('|'); }

    /** What is known for track (see above); starts a lookup when nothing is. */
    get(track) {
        if (!track || !track.title) return { state: 'none' };
        const k = Lyrics.key(track);
        const e = this.cache.get(k);
        if (e && !(e.state === 'error' && Date.now() - e.at > RETRY_MS)) return e;
        if (!this.busy.has(k)) {
            this.busy.set(k, Date.now());
            this._lookup(track).then((v) => this._put(k, v), (err) => {
                this.log.warn('lyrics: ' + (err.code || '') + ' ' + err.message);
                this._put(k, { state: 'error', at: Date.now() });
            }).then(() => this.busy.delete(k));
        }
        return e || { state: 'loading' };
    }

    /** Put a known entry (demo lyrics). */
    set(track, entry) { this._put(Lyrics.key(track), entry); }

    _put(k, v) {
        this.cache.delete(k);
        this.cache.set(k, v);
        while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value);
    }

    async _json(path) {
        const r = await this.request('GET', HOST, path, { 'User-Agent': this.ua, Accept: 'application/json' });
        if (r.status === 404) return null;
        if (r.status !== 200) { const e = new Error('LRCLIB HTTP ' + r.status); e.status = r.status; throw e; }
        return JSON.parse(r.body.toString('utf8'));
    }

    async _lookup(track) {
        const artist = mainArtist(track), secs = Math.round((track.duration || 0) / 1000);
        const titles = [track.title];
        if (baseTitle(track.title) !== track.title) titles.push(baseTitle(track.title));
        const useful = (r) => r && (r.syncedLyrics || r.plainLyrics || r.instrumental);
        let rec = null;
        for (let i = 0; i < titles.length && !useful(rec) && secs > 0; i++) {
            const q = querystring.stringify({ track_name: titles[i], artist_name: artist, album_name: track.album || '', duration: secs });
            try { rec = await this._json('/api/get?' + q); } catch (e) {
                // a 5xx (LRCLIB busy, or not found upstream): the search may still answer
                if (!(e.status >= 500)) throw e;
            }
        }
        if (!useful(rec)) {
            const list = await this._json('/api/search?' + querystring.stringify({ track_name: titles[titles.length - 1], artist_name: artist }));
            const best = Lyrics.pick(Array.isArray(list) ? list : [], track);
            if (best) rec = best;
        }
        const v = entryOf(rec);
        this.log.info('lyrics: ' + v.state + (v.lines ? ' (' + v.lines.length + ' lines)' : ''));
        return v;
    }

    /** The best search hit: same title and artist, duration within a few seconds, synced first. */
    static pick(list, track) {
        const title = norm(baseTitle(track.title)), artist = norm(mainArtist(track)), secs = (track.duration || 0) / 1000;
        const ok = list.filter((r) => r && norm(baseTitle(r.trackName)) === title
            && (!artist || norm(r.artistName).indexOf(artist) >= 0 || artist.indexOf(norm(r.artistName)) >= 0)
            && (!secs || !r.duration || Math.abs(r.duration - secs) <= DURATION_SLACK));
        const score = (r) => (r.syncedLyrics ? 2 : r.plainLyrics ? 1 : r.instrumental ? 0.5 : 0);
        ok.sort((a, b) => score(b) - score(a));
        return ok[0] || null;
    }
}

/** The index of the line playing at ms (-1 before the first). */
function lineAt(lines, ms) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].t <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}

module.exports = { Lyrics, parseLrc, lineAt, entryOf, baseTitle, showable, clean, fold };
