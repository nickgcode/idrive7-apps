'use strict';
/**
 * music.js - G's Dash's Spotify panel (Drive's right panel, setting "panel": Spotify, and the
 * Showcase screen's centre): what plays, album art, previous / play-pause / next and a progress bar
 * to tap or drag; and the Spotify page (sign-in with the phone's QR code, sign-out).
 *
 * Reuses G's Music's code as it is (app.json "share": spotify.js, signin.js, signin_config.js,
 * qrcodegen.js, jpeg_decoder.js, copied in by kit/tools/build.py). Each app on the head
 * unit runs as its own user with its own data folder, and G's Music's spotify-auth.json is readable
 * by G's Music alone (mode 600), so G's Dash signs in on its own: the same QR code flow, the same
 * relay page and encrypted mailbox (signin_config.js), its own spotify-auth.json in its own data
 * folder. The phone's relay page remembers the Client ID from the first sign-in, so the second is
 * a scan and an Accept. No Client ID in the code.
 *
 * Polls GET /v1/me/player only while the panel, the Showcase or the Spotify page is on screen, every
 * 3 s (as G's Music); after a 429 nothing is sent until Spotify's Retry-After has passed (spotify.js).
 * Not signed in, offline or nothing playing: says so, never a made-up track (no demo data).
 * Node 8: no ?., no ??, no object spread.
 */
const G = require('./kit/gauges');
const record = require('./kit/record');
const Spotify = require('./spotify').Spotify;
const QrSignIn = require('./signin').QrSignIn;
const signinConfig = require('./signin_config');
const qrcodegen = require('./qrcodegen');
const decodeJpeg = require('./jpeg_decoder');

const { withAlpha, clamp } = G;
const ART_ID = 1;                   // pixel image id (record.setImage)
const ART_PX = 256;                 // the artwork's pixels (drawn up to ~240 logical)
const POLL_MS = 3000;               // GET /v1/me/player while shown

function fmt(ms) {
    if (!(ms >= 0)) return '-:--';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
}
function fit(cv, s, size, w, opts) {
    s = String(s || '');
    const o = Object.assign({ literal: true }, opts || {});
    if (cv.textWidth(s, size, o) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cv.textWidth(s.slice(0, mid) + '...', size, o) <= w) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, lo).replace(/\s+$/, '') + '...';
}
/** Bilinear resample to a centre-cropped n x n square, corners rounded r px (as G's Music). */
function squareResample(src, sw, sh, n, r) {
    const side = Math.min(sw, sh), ox = (sw - side) / 2, oy = (sh - side) / 2;
    const out = new Uint8Array(n * n * 4), k = side / n;
    for (let y = 0; y < n; y++) {
        const fy = Math.max(0, Math.min(sh - 1.001, oy + (y + 0.5) * k - 0.5)), y0 = fy | 0, wy = fy - y0;
        for (let x = 0; x < n; x++) {
            const fx = Math.max(0, Math.min(sw - 1.001, ox + (x + 0.5) * k - 0.5)), x0 = fx | 0, wx = fx - x0;
            const a = (y0 * sw + x0) * 4, b = a + 4, c = a + sw * 4, d = c + 4, o = (y * n + x) * 4;
            for (let ch = 0; ch < 3; ch++) out[o + ch] = (src[a + ch] * (1 - wx) + src[b + ch] * wx) * (1 - wy) + (src[c + ch] * (1 - wx) + src[d + ch] * wx) * wy;
            let al = 255;
            const cx = x < r ? r : x >= n - r ? n - r : -1, cy = y < r ? r : y >= n - r ? n - r : -1;
            if (r > 0 && cx >= 0 && cy >= 0) { const dx = x + 0.5 - cx, dy = y + 0.5 - cy; al = Math.round(255 * clamp(r - Math.sqrt(dx * dx + dy * dy) + 0.5, 0, 1)); }
            out[o + 3] = al;
        }
    }
    return out;
}
function pickImage(images) {
    if (!Array.isArray(images) || !images.length) return null;
    const ok = images.filter((im) => im && im.url);
    let best = ok[0] || null;
    ok.forEach((im) => { if ((im.width || 0) >= ART_PX * 0.8 && (im.width || 0) < ((best && best.width) || 1e9)) best = im; });
    return best ? best.url : null;
}
function fromPlayer(j) {
    const it = j && j.item;
    const p = { playing: !!(j && j.is_playing), progress: (j && j.progress_ms) || 0, at: Date.now(), device: j && j.device ? j.device.name : '',
        ad: j && j.currently_playing_type === 'ad', title: '', artist: '', album: '', duration: 0, uri: '', art: null };
    if (it) {
        p.title = it.name || ''; p.duration = it.duration_ms || 0; p.uri = it.uri || '';
        if (it.type === 'episode') { p.artist = it.show ? it.show.name : ''; p.album = it.show ? it.show.publisher : ''; p.art = pickImage(it.images) || (it.show ? pickImage(it.show.images) : null); }
        else { p.artist = (it.artists || []).map((a) => a.name).join(', '); p.album = it.album ? it.album.name : ''; p.art = it.album ? pickImage(it.album.images) : null; }
    }
    return p;
}

/* glyphs (as G's Music) */
function playGlyph(cv, x, y, s, c) { cv.quad([[x + s * 0.18, y], [x + s * 0.18, y + s], [x + s, y + s / 2], [x + s, y + s / 2]], c); }
function pauseGlyph(cv, x, y, s, c) { cv.roundRect(x + s * 0.12, y, s * 0.28, s, 3, c); cv.roundRect(x + s * 0.6, y, s * 0.28, s, 3, c); }
function prevGlyph(cv, cx, cy, s, c) {
    cv.roundRect(cx - s * 0.5, cy - s * 0.42, s * 0.14, s * 0.84, 2, c);
    cv.quad([[cx + s * 0.45, cy - s * 0.42], [cx + s * 0.45, cy + s * 0.42], [cx - s * 0.32, cy], [cx - s * 0.32, cy]], c);
}
function nextGlyph(cv, cx, cy, s, c) {
    cv.roundRect(cx + s * 0.36, cy - s * 0.42, s * 0.14, s * 0.84, 2, c);
    cv.quad([[cx - s * 0.45, cy - s * 0.42], [cx - s * 0.45, cy + s * 0.42], [cx + s * 0.32, cy], [cx + s * 0.32, cy]], c);
}
function noteGlyph(cv, cx, cy, s, c) {
    cv.circle(cx - s * 0.18, cy + s * 0.3, s * 0.16, c);
    cv.fillRect(cx - s * 0.06, cy - s * 0.42, s * 0.08, s * 0.72, c);
    cv.quad([[cx - s * 0.06, cy - s * 0.42], [cx + s * 0.3, cy - s * 0.26], [cx + s * 0.3, cy - s * 0.12], [cx - s * 0.06, cy - s * 0.28]], c);
}

class Music {
    /**
     * opts.shown(): the panel or the Spotify page is on screen now (polling only then);
     * opts.qrShown(): the Spotify page is (the QR code is drawn there); opts.openPage(): show it.
     */
    constructor(ctx, opts) {
        this.ctx = ctx; this.log = ctx.log; this.settings = ctx.settings; this.o = opts;
        this.sp = new Spotify(ctx.dataDir, ctx.log);
        this.qs = new QrSignIn(this.sp, ctx.log, signinConfig);
        this.pb = null; this.status = 'starting'; this.detail = '';
        this.artUrl = ''; this.artReady = false; this.artBusy = false;
        this.nextPoll = 0; this.polling = false; this.toast = null;
        this.qrMode = false; this.qrErrorAt = 0; this.qrPic = null;
        this.band = null; this.scrub = null; this.downKey = ''; this.downAt = 0;
        this.signOutAt = 0;
        this.settings.onChange((k) => { if (k === 'panel' || k === undefined) { this.pb = null; this.artUrl = ''; this.artReady = false; this.nextPoll = 0; } });
        setInterval(() => this._tick(), 500);
    }

    say(text, ms) { this.toast = { text: text, until: Date.now() + (ms || 3500) }; }
    every() { return POLL_MS; }
    connected() { return this.status === 'ok' || this.status === 'idle'; }
    /** Something to show: a track (playing or paused) from a signed-in Spotify. */
    hasTrack() { return !!this.pb && this.connected(); }
    signedIn() { return this.status === 'ok' || this.status === 'idle' || this.status === 'offline' || this.status === 'error'; }
    /** Sign out: forget G's Dash's own Spotify sign-in (its spotify-auth.json; G's Music keeps its own). */
    signOut() {
        try { require('fs').unlinkSync(this.sp.authFile); } catch (e) { if (e.code !== 'ENOENT') { this.say('Could not sign out: ' + e.message); return; } }
        this.sp.auth = null; this.sp.authMtime = 0; this.sp.dead = null;
        this.pb = null; this.artUrl = ''; this.artReady = false; this.status = 'noauth'; this.detail = '';
        this.log.info('spotify: signed out');
        this.say('Signed out of Spotify');
    }

    _tick() {
        const shown = this.o.shown();
        if (shown && Date.now() >= this.nextPoll) { this.nextPoll = Date.now() + this.every(); this.poll(); }
        if (this.o.qrShown()) this._qrStep(); else if (this.qs.phase === 'waiting') { this.qs.cancel(); this.qrMode = false; }
    }

    setArt(buf, url) {
        try {
            const im = decodeJpeg(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 48 });
            record.setImage(ART_ID, ART_PX, ART_PX, squareResample(im.data, im.width, im.height, ART_PX, Math.round(ART_PX * 0.04)));
            this.artUrl = url; this.artReady = true;
        } catch (e) { this.log.warn('artwork: ' + e.message); this.artUrl = url; this.artReady = false; }
    }
    async loadArt(url) {
        if (!url) { this.artUrl = ''; this.artReady = false; return; }
        if (url === this.artUrl || this.artBusy) return;
        this.artBusy = true;
        try { this.setArt(await this.sp.image(url), url); } catch (e) { this.log.warn('artwork: ' + e.message); this.artUrl = url; this.artReady = false; }
        this.artBusy = false;
    }

    errStatus(e) {
        if (e.code === 'NOAUTH') return 'noauth';
        if (e.code === 'REAUTH') return 'reauth';
        if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ESERVFAIL|ECONNRESET/.test(e.code || e.message)) return 'offline';
        return 'error';
    }
    async poll() {
        if (this.polling) return;
        if (!this.sp.loadAuth()) { this.status = 'noauth'; this.detail = this.sp.authError || ''; this.pb = null; return; }
        this.polling = true;
        try {
            const j = await this.sp.player();
            if (!j) { this.status = 'idle'; this.pb = null; this.detail = ''; }
            else { this.pb = fromPlayer(j); this.status = 'ok'; this.detail = ''; this.loadArt(this.pb.art); }
        } catch (e) {
            if (e.code !== 'RATE') { this.status = this.errStatus(e); this.detail = e.message; if (this.status !== 'ok' && this.status !== 'idle') this.pb = null; }
            this.log.warn('spotify: ' + (e.code || '') + ' ' + e.message);
        }
        this.polling = false;
    }

    /* ----- sign-in with the phone (signin.js): only while the Spotify page shows the code ----- */
    knownClientId() {
        if (this.sp.auth && this.sp.auth.client_id) return this.sp.auth.client_id;
        try { const a = JSON.parse(require('fs').readFileSync(this.sp.authFile, 'utf8')); return a && typeof a.client_id === 'string' ? a.client_id : ''; } catch (e) { return ''; }
    }
    wantQr() { return this.qs.configured() && (this.qrMode || this.status === 'noauth' || this.status === 'reauth'); }
    _qrStep() {
        const qs = this.qs;
        if (!this.wantQr()) { if (qs.phase === 'waiting' && !this.qrMode) qs.cancel(); return; }
        if (qs.phase === 'error') { if (!this.qrErrorAt) this.qrErrorAt = Date.now(); if (Date.now() - this.qrErrorAt < 20000) return; }
        if (qs.phase === 'off' || qs.phase === 'error' || (qs.phase === 'waiting' && qs.expired()) || qs.phase === 'done') {
            if (qs.phase === 'done' && Date.now() - qs.doneAt < 10000) return;
            this.qrErrorAt = 0; qs.start(this.knownClientId());
        }
        qs.tick().then((ok) => {
            if (!ok) return;
            this.qrMode = false; this.status = 'starting'; this.detail = '';
            this.say('Signed in to Spotify', 4000);
            this.nextPoll = 0; this.poll();
        }, (e) => this.log.warn('phone sign-in: ' + e.message));
    }

    /* ----- controls ----- */
    position() {
        const pb = this.pb;
        if (!pb) return 0;
        const p = pb.progress + (pb.playing ? Date.now() - pb.at : 0);
        return pb.duration ? Math.min(pb.duration, p) : p;
    }
    async run(what, fn, local) {
        if (this.status !== 'ok' && this.status !== 'idle') { this.say(this.status === 'noauth' ? 'Not signed in to Spotify' : this.status === 'offline' ? 'No internet (phone / Wi-Fi uplink)' : 'Spotify: ' + (this.detail || this.status)); return; }
        try { await fn(); if (this.pb && local) local(); } catch (e) {
            this.log.warn(what + ': ' + (e.code || '') + ' ' + e.message);
            if (e.status === 403) this.say('Spotify Premium is needed for ' + what);
            else if (e.status === 404) this.say('No active Spotify device: start playing on your phone');
            else if (e.code === 'RATE') this.say('Spotify: too many requests, try again in a moment');
            else this.say(what + ' failed: ' + e.message);
        }
        this.nextPoll = Date.now() + 600;
    }
    togglePlay() {
        const pb = this.pb, playing = !!(pb && pb.playing);
        return this.run(playing ? 'pause' : 'play', () => (playing ? this.sp.pause() : this.sp.play()), () => { pb.progress = this.position(); pb.at = Date.now(); pb.playing = !playing; });
    }
    skip(dir) { return this.run(dir > 0 ? 'next' : 'previous', () => (dir > 0 ? this.sp.next() : this.sp.previous()), () => { this.pb.progress = 0; this.pb.at = Date.now(); }); }
    seekTo(ms) {
        const pb = this.pb;
        if (!pb || !pb.duration) return;
        ms = Math.max(0, Math.min(pb.duration - 1000, Math.round(ms)));
        return this.run('seek', () => this.sp.seek(ms), () => { pb.progress = ms; pb.at = Date.now(); });
    }

    /**
     * A raw touch on the page (ctx.onTouch): a finger that goes down on the progress bar drags its
     * knob, and on lifting Spotify seeks there (one request, not one per move). true = taken.
     */
    touch(phase, x, y) {
        const b = this.band;
        if (phase === 1) {
            this.scrub = null;
            if (!b || !this.pb || !this.pb.duration || x < b.x - 20 || x > b.x + b.w + 20 || y < b.y0 || y > b.y1) return false;
            this.scrub = { f: clamp((x - b.x) / b.w, 0, 1) };
            return true;
        }
        if (!this.scrub) return false;
        if (b) this.scrub.f = clamp((x - b.x) / b.w, 0, 1);
        if (phase === 3) { const f = this.scrub.f; this.scrub = null; if (this.pb && this.pb.duration) this.seekTo(f * this.pb.duration); }
        return true;
    }

    /** One line for the settings row. */
    statusLine() {
        return this.status === 'noauth' ? 'Sign in' : this.status === 'reauth' ? 'Sign in again'
            : this.status === 'offline' ? 'No internet' : this.status === 'error' ? 'Not answering' : this.status === 'starting' ? (this.sp.auth || require('fs').existsSync(this.sp.authFile) ? 'Signed in' : 'Sign in')
                : this.pb && this.pb.device ? 'On ' + this.pb.device : 'Signed in';
    }

    _press(key, fn) { return () => { this.downKey = key; this.downAt = Date.now(); return fn(); }; }
    _isDown(key) { return this.downKey === key && Date.now() - this.downAt < 220; }
    /** A touch button: the look's own card style, a finger's slop around it (own mode only). */
    _button(cv, t, lk, key, x, y, w, h, fn) {
        const down = this._isDown(key), r = lk.ui.radius;
        if (lk.card) lk.card(cv, t, x, y, w, h, down);
        else {
            cv.roundRect(x, y, w, h, r, down ? withAlpha(t.sel || t.accent, 0.3) : withAlpha('#ffffff', 0.06));
            cv.strokeRoundRect(x, y, w, h, r, down ? 2 : 1, down ? t.sel || t.accent : withAlpha('#ffffff', 0.14));
        }
        if (cv.own && cv.target) cv.target(x - 6, y - 6, w + 12, h + 12, this._press(key, fn), key, r);
    }

    /**
     * The panel in R ({ x, y, w, h }, page px), the G button's rect g kept clear. lk: the look (ui
     * fonts, card style, lk.panelPlate for its own plate).
     */
    panel(cv, S, lk, R, g) {
        const t = S.t, u = lk.ui, acc = t.accent2 || t.accent, own = !!cv.own;
        const lbl = (s, x, y, size, c, o) => cv.text(u.upper ? String(s).toUpperCase() : s, x, y, size, c, Object.assign({ font: u.lbl || u.txt, spacing: u.upper ? u.spacing : 0, literal: true }, o || {}));
        if (lk.panelPlate) lk.panelPlate(cv, t, R.x, R.y, R.w, R.h);
        else {
            cv.roundRect(R.x, R.y, R.w, R.h, u.radius, withAlpha('#ffffff', 0.035));
            cv.strokeRoundRect(R.x, R.y, R.w, R.h, u.radius, 1, withAlpha('#ffffff', 0.12));
        }
        this.band = null;
        const pad = 16, x = R.x + pad, y = R.y + pad, w = R.w - 2 * pad, h = R.h - 2 * pad;
        const pb = this.pb, st = this.status, hasTrack = !!pb && this.connected();
        const top = y + 30;
        // three arrangements: tall (art over the bar and the controls), row (art beside everything),
        // short (a wide strip: one text line, the bar with its times inline, the controls under it)
        const short = h < 230;
        const cH = short ? Math.round(clamp(h - 76, 50, 92)) : Math.round(clamp(h * 0.26, 70, 92)), cY = y + h - cH;
        const bY = short ? y + 46 : cY - 60;
        const tall = !short && bY - 8 - top >= 112;
        const s = Math.round(short ? Math.min(h, w * 0.26) : tall ? Math.min(bY - 8 - top, w * 0.4) : Math.min(h - 30, w * 0.34));
        const ax = x, ay = short ? y : top, cx0 = tall ? x : x + s + 16, tx = tall ? x + s + 18 : cx0;
        let cR = x + w;
        if (g && g.y < cY + cH && g.y + g.h > cY && g.x < cR + pad) cR = Math.min(cR, g.x - 14);
        // header: SPOTIFY, the state / device on the right
        lbl('Spotify', short ? tx : x, y + 15, 16, acc);
        const right = pb ? (pb.playing ? 'Playing' : 'Paused') + (pb.device ? ' · ' + pb.device : '') : '';
        if (right) lbl(fit(cv, u.upper ? right.toUpperCase() : right, 16, w * 0.5, { font: u.lbl || u.txt }), x + w, y + 15, 16, t.dim, { align: 'right' });
        // art (or a note when there's none)
        if (hasTrack && this.artReady) cv.image(ART_ID, ax, ay, s, s);
        else {
            cv.roundRect(ax, ay, s, s, Math.max(4, u.radius), withAlpha('#ffffff', 0.06));
            noteGlyph(cv, ax + s / 2, ay + s / 2, s * 0.42, withAlpha(t.text, 0.22));
        }
        const textW = x + w - tx;
        const line = (str, yy, size, c, bold) => cv.text(fit(cv, str, size, textW, bold ? { font: 'bold' } : {}), tx, yy, size, c, { font: bold ? 'bold' : undefined, literal: true });
        const head = hasTrack ? (pb.ad ? 'Advertisement' : pb.title || 'Unknown track')
            : st === 'idle' ? 'Nothing playing' : st === 'noauth' ? 'Not signed in' : st === 'reauth' ? 'Sign in again'
                : st === 'offline' ? 'No internet' : st === 'error' ? 'Spotify not answering' : 'Connecting...';
        const sub = hasTrack ? pb.artist : st === 'idle' ? 'Start Spotify on your phone, or tap Play'
            : st === 'noauth' || st === 'reauth' ? (own ? 'Scan a QR code with your phone' : 'Full screen layout: G > Spotify')
                : st === 'offline' ? 'Phone hotspot / Wi-Fi uplink' : st === 'error' ? this.detail || 'Trying again' : 'Checking your Spotify';
        if (short) {
            const hw = cv.textWidth(fit(cv, head, 22, textW * 0.62, { font: 'bold' }), 22, { font: 'bold' });
            line(head, y + 40, 22, t.text, true);
            if (sub) cv.text(fit(cv, sub, 18, textW - hw - 16), tx + hw + 16, y + 40, 18, hasTrack ? t.text : t.dim, { literal: true });
        } else {
            const big = tall ? 30 : 26, ty = top + (tall ? Math.min(40, s * 0.3) : 26);
            line(head, ty, big, t.text, true);
            line(sub, ty + big + 6, Math.round(big * (hasTrack ? 0.72 : 0.66)), hasTrack ? t.text : t.dim);
            if (tall && hasTrack && s > 120) line(pb.album, ty + big * 1.75 + 14, Math.round(big * 0.6), t.dim);
        }
        if (this.toast && Date.now() < this.toast.until) {
            const ty2 = Math.max(y, y + h - cH - 40);
            cv.roundRect(x, ty2, w, 34, 17, '#000000e0');
            cv.text(fit(cv, this.toast.text, 18, w - 28), x + w / 2, ty2 + 23, 18, '#ffffff', { align: 'center', literal: true });
        }
        // signed out / offline: one wide button where the bar and the controls go
        if (!hasTrack && st !== 'idle') {
            if (!own) return;
            const bw = cR - cx0, bh = short ? cH : Math.min(cH + 20, cY + cH - bY), by = cY + cH - bh;
            const signIn = st === 'noauth' || st === 'reauth';
            this._button(cv, t, lk, signIn ? 'sp:signin' : 'sp:retry', cx0, by, bw, bh, signIn ? () => this.o.openPage() : () => { this.nextPoll = 0; return this.poll(); });
            lbl(signIn ? 'Sign in with phone' : 'Try again', cx0 + bw / 2, by + bh / 2 + 8, 22, t.text, { align: 'center' });
            return;
        }
        // progress: the knob follows a dragging finger (touch); times under the bar (inline when short)
        const dur = pb ? pb.duration || 0 : 0, pos = this.scrub && dur ? this.scrub.f * dur : this.position();
        const f = dur ? clamp(pos / dur, 0, 1) : 0, th = 8;
        const tf = { font: u.num || 'num', literal: true };
        const bx = short ? cx0 + 66 : cx0 + 6, bw = short ? (x + w) - 74 - bx : (x + w) - 6 - bx, by = short ? bY + 6 : bY + 12;
        cv.roundRect(bx, by, bw, th, th / 2, t.track || withAlpha('#ffffff', 0.15));
        if (f > 0) cv.roundRect(bx, by, Math.max(th, bw * f), th, th / 2, pb && pb.playing ? acc : t.dim);
        if (dur) cv.circle(bx + bw * f, by + th / 2, this.scrub ? 17 : 11, this.scrub ? acc : '#ffffff');
        if (dur) {
            if (short) {
                cv.text(fmt(pos), bx - 16, by + 11, 18, t.dim, Object.assign({ align: 'right' }, tf));
                cv.text('-' + fmt(dur - pos), bx + bw + 16, by + 11, 18, t.dim, tf);
            } else {
                cv.text(fmt(pos), bx, by + 40, 20, t.dim, tf);
                cv.text('-' + fmt(dur - pos), bx + bw, by + 40, 20, t.dim, Object.assign({ align: 'right' }, tf));
            }
            if (own) this.band = { x: bx, w: bw, y0: by - 26, y1: Math.min(cY - 2, by + 34) };
        }
        // previous, play / pause, next
        const gap = 12, cw = (cR - cx0 - gap * 2) / 3;
        const gc = pb ? t.text : t.dim, gs = Math.min(40, cH * 0.46);
        [['sp:prev', () => this.skip(-1)], ['sp:play', () => this.togglePlay()], ['sp:next', () => this.skip(1)]].forEach((b, i) => {
            const bx2 = cx0 + i * (cw + gap), mx = bx2 + cw / 2, my = cY + cH / 2;
            this._button(cv, t, lk, b[0], bx2, cY, cw, cH, b[1]);
            if (i === 0) prevGlyph(cv, mx, my, gs, gc);
            else if (i === 2) nextGlyph(cv, mx, my, gs, gc);
            else {
                cv.circle(mx, my, gs * 0.95, acc);
                const ink = t.selText || '#000000';
                if (pb && pb.playing) pauseGlyph(cv, mx - gs * 0.38, my - gs * 0.38, gs * 0.76, ink);
                else playGlyph(cv, mx - gs * 0.34, my - gs * 0.4, gs * 0.8, ink);
            }
        });
    }

    /**
     * The Spotify page (full screen, from Settings or the panel's Sign in): the QR code when it's
     * needed, what to do, the state, and the refresh rate. A = { x, y, w, h } below the page's header.
     */
    page(cv, S, lk, A) {
        const t = S.t, u = lk.ui, acc = t.accent2 || t.accent, qs = this.qs;
        const lbl = (s, x, y, size, c, o) => cv.text(u.upper ? String(s).toUpperCase() : s, x, y, size, c, Object.assign({ font: u.lbl || u.txt, spacing: u.upper ? u.spacing : 0, literal: true }, o || {}));
        const showQr = this.wantQr() && qs.s;
        const side = Math.min(A.h, 400), X = A.x + side + 40, W = A.x + A.w - X;
        if (showQr) {
            const s = qs.s;
            if (!this.qrPic || this.qrPic.url !== s.url) this.qrPic = { url: s.url, qr: qrcodegen.QrCode.encodeText(s.url, qrcodegen.QrCode.Ecc.MEDIUM) };
            const qr = this.qrPic.qr, n = qr.size + 8, pl = cv.place, k = pl ? pl.scale : 1;
            const box = { x: A.x, y: A.y, s: side };
            const dev = { x: box.x * k + (pl ? pl.ox : 0), y: box.y * k + (pl ? pl.oy : 0), s: box.s * k };
            const px = Math.max(2, Math.floor(dev.s / n)), sd = n * px;
            cv.roundRect(box.x, box.y, box.s, box.s, 12, '#ffffff');
            if (pl) cv.xf(1, 0, 0);
            const ux = pl ? Math.round(dev.x + (dev.s - sd) / 2) : Math.round(box.x + (box.s - sd) / 2), uy = pl ? Math.round(dev.y + (dev.s - sd) / 2) : Math.round(box.y + (box.s - sd) / 2);
            for (let yy = 0; yy < qr.size; yy++) {
                let run = -1;
                for (let xx = 0; xx <= qr.size; xx++) {
                    const dark = xx < qr.size && qr.getModule(xx, yy);
                    if (dark && run < 0) run = xx;
                    if (!dark && run >= 0) { cv.fillRect(ux + (4 + run) * px, uy + (4 + yy) * px, (xx - run) * px, px, '#000000'); run = -1; }
                }
            }
            if (pl) cv.xf();
        } else {
            cv.roundRect(A.x, A.y, side, side, Math.max(6, u.radius), withAlpha('#ffffff', 0.05));
            if (this.connected() && this.pb && this.artReady) cv.image(ART_ID, A.x + 20, A.y + 20, side - 40, side - 40);
            else noteGlyph(cv, A.x + side / 2, A.y + side / 2, side * 0.4, withAlpha(t.text, 0.2));
        }
        const st = this.status;
        const head = showQr ? (st === 'reauth' ? 'Spotify sign-in needs renewing' : st === 'noauth' ? 'Sign in to Spotify' : 'Sign in again with your phone')
            : st === 'noauth' && !qs.configured() ? 'Phone sign-in is not set up'
                : st === 'offline' ? 'No internet connection' : st === 'error' ? 'Spotify is not answering' : st === 'starting' ? 'Connecting...'
                    : 'Signed in to Spotify';
        cv.text(fit(cv, head, 40, W, { font: 'bold' }), X, A.y + 44, 40, t.text, { font: 'bold', literal: true });
        let y = A.y + 96;
        const say = (num, str, c, size) => {
            size = size || 24;
            if (num) { cv.circle(X + 16, y - 8, 16, withAlpha(acc, 0.2)); cv.text(num, X + 16, y, 20, acc, { font: 'bold', align: 'center', literal: true }); }
            cv.text(fit(cv, str, size, W - 48), X + (num ? 46 : 0), y, size, c || t.text, { literal: true });
            y += size + 18;
        };
        if (showQr) {
            say('1', 'Scan this code with your phone\'s camera.');
            say('2', 'Sign in to Spotify on the phone and accept.');
            say('3', 'G\'s Dash finishes the sign-in by itself.');
            const mm = Math.floor(qs.left() / 60000), ss = Math.floor(qs.left() / 1000) % 60;
            if (qs.phase === 'exchanging') say('', 'Phone answered: signing in...', acc);
            else if (qs.phase === 'done') say('', 'Signed in.', acc);
            else if (qs.phase === 'error') say('', qs.message, t.warn || t.crit);
            else say('', 'Waiting for the phone' + (qs.message ? ' (' + qs.message + ')' : '') + '   new code in ' + mm + ':' + (ss < 10 ? '0' : '') + ss, t.dim, 20);
            say('', 'G\'s Dash keeps its own sign-in (apps can\'t read each other\'s files).', t.dim, 18);
            say('', 'Your phone remembers the Client ID from G\'s Music\'s sign-in.', t.dim, 18);
        } else if (st === 'ok' || st === 'idle') {
            say('', this.pb ? (this.pb.title || 'Unknown track') + (this.pb.artist ? ' - ' + this.pb.artist : '') : 'Nothing playing right now', t.text);
            say('', this.pb && this.pb.device ? 'Playing on ' + this.pb.device : 'Start Spotify on your phone or any device.', t.dim, 20);
            say('', 'The Showcase screen shows it, and Drive with Settings > Right panel: Spotify.', t.dim, 20);
        } else if (st === 'offline') {
            say('', 'G\'s Dash talks to Spotify over the internet (mgu-uplink).', t.dim, 20);
            say('1', 'Turn on the phone\'s hotspot or the Wi-Fi uplink in the Store.', t.text, 22);
            say('2', 'Check that G\'s Dash may use the internet (Store > mgu-uplink).', t.text, 22);
        } else {
            if (this.detail) say('', this.detail, t.dim, 20);
            if (!qs.configured()) say('', 'signin_config.js has no relay page set.', t.dim, 20);
        }
        // buttons along the bottom
        const bh = 76, by = A.y + A.h - bh, gap = 16, bw = (W - 2 * gap) / 3;
        const btn = (i, key, text, fn) => {
            const bx = X + i * (bw + gap);
            this._button(cv, t, lk, key, bx, by, bw, bh, fn);
            lbl(fit(cv, text, 20, bw - 24, { font: u.lbl || u.txt }), bx + bw / 2, by + bh / 2 + 7, 20, t.text, { align: 'center' });
        };
        if (showQr) btn(0, 'pg:new', 'New code', () => { this.qrErrorAt = 0; qs.start(this.knownClientId()); this.say('New sign-in code'); });
        else btn(0, 'pg:retry', 'Check now', () => { this.nextPoll = 0; return this.poll(); });
        if (this.qrMode) btn(1, 'pg:cancel', 'Cancel sign-in', () => { this.qrMode = false; qs.cancel(); });
        else btn(1, 'pg:signin', st === 'noauth' || st === 'reauth' ? 'Reload sign-in' : 'Sign in again', () => {
            if (st === 'noauth' || st === 'reauth') { this.sp.auth = null; this.sp.authMtime = 0; this.sp.dead = null; this.nextPoll = 0; return this.poll(); }
            if (!qs.configured()) { this.say('Phone sign-in is not set up (signin_config.js)'); return; }
            this.qrMode = true; this.qrErrorAt = 0; qs.start(this.knownClientId());
        });
        // sign out: a second tap within 5 s confirms (G's Dash's own sign-in only)
        const armed = Date.now() - this.signOutAt < 5000, can = !!this.sp.auth || this.signedIn();
        if (can) btn(2, 'pg:signout', armed ? 'Tap again to sign out' : 'Sign out', () => {
            if (Date.now() - this.signOutAt < 5000) { this.signOutAt = 0; this.signOut(); } else this.signOutAt = Date.now();
        });
        if (this.toast && Date.now() < this.toast.until) cv.text(fit(cv, this.toast.text, 20, W), X, by - 18, 20, acc, { literal: true });
    }
}

module.exports = { Music, fmt };
