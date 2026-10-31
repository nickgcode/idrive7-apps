'use strict';
/**
 * tv_channel.js - what a channel plays now.
 *
 * spelunkr.tv (the default source): https://data.spelunkr.tv/lineup.json lists the channels; a channel's
 * newest version in effect names its manifest (manifests/<channel>/v<n>.json), whose items are videos on
 * the Internet Archive: https://archive.org/download/<id>/<file> (progressive H.264 MP4, no DRM, no
 * sign-in; "moov" is the size of the file's index box). The site's own schedule also interleaves text
 * "bumps" with music and seeded ad breaks; G's TV doesn't: it plays the items in order, back to back,
 * from the version's epoch and start item, so where it is in a programme is close to the site's, not
 * the same.
 *
 * config (app.json "config", or <data>/tv.json overriding it):
 *   lineupUrl   the lineup (default https://data.spelunkr.tv/lineup.json)
 *   channel     the channel id (default "toonertia")
 *   streamUrl   instead of a channel: one MP4 (https) played from its start, looped
 */
const fs = require('fs');
const path = require('path');
const url = require('url');

const DEFAULTS = { lineupUrl: 'https://data.spelunkr.tv/lineup.json', channel: 'toonertia', streamUrl: '' };

function config(spec, dataDir, log) {
    const c = Object.assign({}, DEFAULTS, (spec && spec.config) || {});
    try {
        const own = JSON.parse(fs.readFileSync(path.join(dataDir, 'tv.json'), 'utf8'));
        Object.keys(DEFAULTS).forEach((k) => { if (typeof own[k] === 'string') c[k] = own[k]; });
        if (log) log.info('channel config from tv.json');
    } catch (e) { /* none */ }
    return c;
}

class Channel {
    constructor(net, cfg, log) { this.net = net; this.cfg = cfg; this.log = log; this.items = null; this.name = ''; this.loadedAt = 0; }

    async load() {
        if (this.cfg.streamUrl) {
            if (!/^https:\/\//.test(this.cfg.streamUrl)) throw new Error('streamUrl must be https');
            this.name = 'STREAM';
            const file = decodeURIComponent(url.parse(this.cfg.streamUrl).pathname.split('/').pop() || 'video');
            this.items = [{ href: this.cfg.streamUrl, title: file, year: '', duration: 0, inS: 0, moov: 0 }];
            this.epochMs = Date.now(); this.startIndex = 0; this.single = true;
            this.loadedAt = Date.now();
            return this;
        }
        const lineup = await this.net.json(this.cfg.lineupUrl);
        const ch = (lineup.channels || []).filter((c) => c.id === this.cfg.channel)[0];
        if (!ch) throw new Error('channel "' + this.cfg.channel + '" not in the lineup');
        const now = Date.now();
        const vs = (ch.versions || []).slice().sort((a, b) => a.v - b.v);
        let ver = null;
        vs.forEach((v) => { if ((v.effectiveAtMs || v.epochMs) <= now) ver = v; });
        if (!ver) ver = vs[0];
        if (!ver) throw new Error('channel has no schedule');
        const man = await this.net.json(url.resolve(this.cfg.lineupUrl, ver.manifest));
        this.items = (man.items || []).filter((it) => it && it.id && (it.mp4 || it.file) && it.duration > 0).map((it) => ({
            href: 'https://archive.org/download/' + encodeURIComponent(it.id) + '/' + encodeURIComponent(it.mp4 || it.file),
            title: it.title || it.id, year: it.year || '', duration: it.duration, inS: it.inS || 0, moov: it.moov || 0,
        }));
        if (!this.items.length) throw new Error('channel has no playable items');
        this.name = ch.name || ch.id;
        this.epochMs = ver.epochMs; this.startIndex = Math.min(ver.startIndex || 0, this.items.length - 1);
        this.version = ver.v;
        this.loadedAt = now;
        this.log.info('channel ' + ch.id + ' v' + ver.v + ': ' + this.items.length + ' items');
        return this;
    }

    /** What plays at time ms: { index, item, offset (s into the item's programme) } (looped schedule). */
    at(ms) {
        if (this.single) return { index: 0, item: this.items[0], offset: 0 };
        const total = this.items.reduce((a, it) => a + it.duration, 0);
        let t = ((ms - this.epochMs) / 1000) % total;
        if (t < 0) t += total;
        let i = this.startIndex;
        for (let guard = 0; guard < this.items.length + 1; guard++) {
            const d = this.items[i].duration;
            if (t < d) return { index: i, item: this.items[i], offset: t };
            t -= d; i = (i + 1) % this.items.length;
        }
        return { index: this.startIndex, item: this.items[this.startIndex], offset: 0 };
    }

    next(index) { return this.single ? 0 : (index + 1) % this.items.length; }
}

module.exports = { Channel, config, DEFAULTS };
