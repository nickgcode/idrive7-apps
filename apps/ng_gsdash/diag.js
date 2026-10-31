'use strict';
/**
 * diag.js - the drive mode diagnostics page's second half: what the head unit's own SOME/IP catalog
 * (/etc/oap/someip/someip-interfaces.json, the file the installer generates every app's interfaces
 * from) says about the drive mode. Read-only, read once when the page is opened, only the lines it
 * shows are kept. Definitions from the catalog, never live values (those come from car.js).
 * Node 8: no ?., no ??, no object spread.
 */
const fs = require('fs');

const CATALOG = '/etc/oap/someip/someip-interfaces.json';
const MAX_BYTES = 48 * 1024 * 1024;     // a bigger file is not parsed (the head unit's memory)
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const FIELDS = ['statusFESVehicleDynamicSwitchHMI'];        // the drive mode G's Dash reads (car.js MODE_FIELD)
const MODEISH = /mode|modus|sport|eco|comfort|komfort|individual|adaptive|dynamic|experience|fes/i;
const VALUEISH = /sport|eco|comfort|komfort|individual|adaptive|race|track/i;

let state = null;     // { status: 'reading' | 'ok' | 'error', error, lines: [[kind, text]] }

/** A datatype as one short line (enum items, struct members), as kit/tools/sigdoc.py prints it. */
function typeText(db, ref, depth) {
    const d = db.datatypes && db.datatypes[ref];
    if (!d) return String(ref);
    if (d.type === 'enum') {
        const items = Object.keys(d.items || {});
        return 'enum(' + items.slice(0, 16).map((k) => k + '=' + d.items[k]).join(', ') + (items.length > 16 ? ', ..' : '') + ')';
    }
    if (d.type === 'typedef') return typeText(db, d.dataRef || d.baseType, depth);
    if (d.type === 'array') return '[' + typeText(db, d.elementDataRef, (depth || 0) + 1) + ']';
    if (d.type === 'struct') return depth > 1 ? 'struct' : '{' + structMembers(db, d).map((m) => m.name).join(', ') + '}';
    return d.type;
}
function structMembers(db, d) {
    let mem = [], dd = d, guard = 0;
    while (dd && guard++ < 8) {
        mem = (dd.members || []).concat(mem);
        dd = dd.extends ? db.datatypes[dd.extends] : null;
    }
    return mem;
}

function extract(db) {
    const lines = [];
    const i = db.interfaces && db.interfaces[FES];
    if (!i) { lines.push(['warn', FES + ': not in the catalog']); return lines; }
    const fields = i.fields || {};
    FIELDS.forEach((f) => {
        const fd = fields[f];
        if (!fd) { lines.push(['head', f + ': not in the catalog']); return; }
        lines.push(['head', f + (fd.getter ? '  get' : '') + (fd.notifier ? '  notify' : '')]);
        const d = db.datatypes && db.datatypes[fd.dataRef];
        if (d && d.type === 'struct') structMembers(db, d).forEach((m) => lines.push(['row', '  ' + m.name + ': ' + typeText(db, m.dataRef, 1)]));
        else lines.push(['row', '  ' + typeText(db, fd.dataRef, 0)]);
    });
    // other FES fields named like a mode, with an enum that has mode-like values
    const other = Object.keys(fields).filter((f) => FIELDS.indexOf(f) < 0 && MODEISH.test(f));
    if (other.length) lines.push(['head', 'Other FES fields named like a mode (not subscribed):']);
    other.slice(0, 24).forEach((f) => lines.push(['row', '  ' + f]));
    // enums anywhere with drive-mode-like value names
    const enums = Object.keys(db.datatypes || {}).filter((k) => {
        const d = db.datatypes[k];
        return d && d.type === 'enum' && MODEISH.test(k) && Object.keys(d.items || {}).some((n) => VALUEISH.test(n));
    });
    if (enums.length) lines.push(['head', 'Mode-like enums in the catalog (' + enums.length + '):']);
    enums.slice(0, 20).forEach((k) => lines.push(['row', '  ' + k + ' ' + typeText(db, k, 0)]));
    return lines;
}

/** Start reading the catalog (once); returns the current state. */
function catalog(log) {
    if (state) return state;
    state = { status: 'reading', error: '', lines: [] };
    fs.stat(CATALOG, (err, st) => {
        if (err) { state = { status: 'error', error: err.code || err.message, lines: [] }; return; }
        if (st.size > MAX_BYTES) { state = { status: 'error', error: 'too big to read here (' + Math.round(st.size / 1048576) + ' MB)', lines: [] }; return; }
        fs.readFile(CATALOG, 'utf8', (e, txt) => {
            if (e) { state = { status: 'error', error: e.code || e.message, lines: [] }; return; }
            try {
                state = { status: 'ok', error: '', lines: extract(JSON.parse(txt)), bytes: st.size };
                if (log) log.info('diagnostics: catalog read, ' + state.lines.length + ' lines');
            } catch (x) { state = { status: 'error', error: 'not readable as JSON (' + x.message + ')', lines: [] }; }
        });
    });
    return state;
}
/** Read it again next time (the page's Reload). */
function reset() { if (state && state.status !== 'reading') state = null; }

module.exports = { catalog, reset, CATALOG, extract };
