'use strict';
/**
 * cluster_memory.js - G's Dash 0.11.2: the cluster renderer's pixel memory (cluster-render 0.2.2,
 * src/compositor.cpp): one budget of 16 MiB (CompositorLimits pixel_bytes) for every app's pixels together.
 * An asset counts w x h x (r8 1 | rgba8 4) twice ("its pixels and a rectangle scratch"), an image layer
 * iw x ih x 4 twice, a video w x (h + h / 2) x 4 (+ w / 4 x h / 4 x 8 with pan_blocks), an effect nothing.
 * Anything that would pass the budget is refused: "the service's pixel memory is full".
 * Node 8.
 */
const LIMIT = 16 * 1024 * 1024;
const asset = (w, h, r8) => w * h * (r8 ? 1 : 4) * 2;
const image = (w, h) => w * h * 4 * 2;
const video = (w, h, pan) => w * (h + Math.floor(h / 2)) * 4 + (pan ? Math.floor(w / 4) * Math.floor(h / 4) * 8 : 0);

/** 0.11.2: the renderer's refusal when its pixel memory (16 MiB for every app together) is used up */
const MEM_FULL = /pixel memory is full/;
const APP_NAMES = { ng_spotify: 'G\'s Music', ng_tv: 'G\'s TV', ng_gsdash: 'G\'s Dash' };
/**
 * 0.11.2: who else holds the cluster renderer's pixel memory, from a status text: its "asset N fmt WxH of APP
 * on TARGET" and "layer N kind of APP on TARGET, ..." lines -> [{ name, what: ['map video', ...], bytes }]
 * (bytes: the assets' as the renderer counts them, twice; a layer's size is not in the status). Our own
 * skin (ownApp's panel assets and layers) is left out; ownApp's others are its logo (map) or HUD (hud).
 */
function memoryUsers(text, ownApp) {
    const by = {}, order = [];
    const get = (app, target) => {
        const own = app === ownApp;
        const name = own ? (target === 'map' ? 'G\'s Dash logo' : target === 'hud' ? 'G\'s Dash HUD' : 'G\'s Dash')
            : /waze/i.test(app) ? 'Waze' : (APP_NAMES[app] || app);
        if (!by[name]) { by[name] = { name, what: [], bytes: 0, n: {} }; order.push(name); }
        return by[name];
    };
    String(text || '').split('\n').forEach((line) => {
        let m = /^asset \d+ (r8|rgba8) (\d+)x(\d+) of (\S+) on (\w+)/.exec(line);
        if (m) {
            if (m[4] === ownApp && m[5] === 'panel') return;
            const u = get(m[4], m[5]);
            u.bytes += (+m[2]) * (+m[3]) * (m[1] === 'r8' ? 1 : 4) * 2;
            const k = m[5] + ' asset';
            u.n[k] = (u.n[k] || 0) + 1;
            return;
        }
        m = /^layer \d+ (\w+) of (\S+) on (\w+),/.exec(line);
        if (!m || (m[2] === ownApp && m[3] === 'panel') || m[1] === 'effect') return;
        const u = get(m[2], m[3]), k = m[3] + ' ' + m[1];
        u.n[k] = (u.n[k] || 0) + 1;
    });
    return order.map((name) => {
        const u = by[name];
        u.what = Object.keys(u.n).map((k) => (u.n[k] > 1 ? u.n[k] + ' ' + k + 's' : k));
        delete u.n;
        return u;
    });
}
/** "Waze (map video), G's Music (2 map images)" or '' */
function memoryNote(users) {
    return (users || []).map((u) => u.name + (u.what.length ? ' (' + u.what.join(', ') + ')' : '')).join(', ');
}

module.exports = { LIMIT, asset, image, video, MEM_FULL, APP_NAMES, memoryUsers, memoryNote };
