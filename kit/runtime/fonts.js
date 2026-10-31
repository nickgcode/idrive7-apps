'use strict';
/**
 * fonts.js - loads the pre-baked glyph atlases (kit/runtime/fonts/*.json,
 * made by kit/tools/bake_fonts.py) and picks the best size for a request.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, 'fonts');
const families = Object.create(null);

function family(name) {
    if (families[name] !== undefined) return families[name];
    let fam = null;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
        fam = j.sizes.map((s) => ({
            size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
            glyphs: s.glyphs, _alpha: s.alpha, alpha: null, family: name, cacheKey: j.cacheKey || '',
        }));
    } catch (e) { fam = null; }
    families[name] = fam;
    return fam;
}

/** Smallest baked size >= requested (downscaling looks better), else largest. */
function get(name, size, text) {
    // A shared CJK atlas avoids duplicating hundreds of glyphs in every numeric size.
    if (text && /[\u3000-\u9fff\uff00-\uffef]/.test(text)) name = 'cjk';
    const fam = family(name) || family('label');
    if (!fam) return null;
    let best = null;
    for (const f of fam) if (f.size >= size && (!best || f.size < best.size)) best = f;
    if (!best) best = fam[fam.length - 1];
    if (!best.alpha) best.alpha = zlib.inflateSync(Buffer.from(best._alpha, 'base64'));
    return best;
}

function measure(f, s) {
    let w = 0;
    for (const ch of s) { const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63]; if (g) w += g[6]; }
    return w;
}

/**
 * An app's own font (an atlas in the same format, e.g. read from its data pack): text drawn with
 * { font: name } uses it. Names must not clash with the kit's (label, bold, num, light, gear, cjk).
 */
function register(name, j) {
    if (!j || !Array.isArray(j.sizes) || !j.sizes.length) return false;
    families[name] = j.sizes.map((s) => ({
        size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
        glyphs: s.glyphs, _alpha: s.alpha, alpha: null, family: name, cacheKey: j.cacheKey || '',
    }));
    return true;
}

/** Every baked size of a family (the same objects get() returns), or []. */
function sizes(name) { return family(name) || []; }
/** The atlas pixels of a size from sizes() (inflated on first use, as get() does). */
function ready(f) { if (f && !f.alpha) f.alpha = zlib.inflateSync(Buffer.from(f._alpha, 'base64')); return f; }

module.exports = { get, measure, register, sizes, ready };
