'use strict';
/**
 * The Now Playing page's Cluster button (0.7.0): one tap turns the Cluster setting ("cluster") off, or
 * back on to the last on value (Lyrics + visualizer unless Visualizer only was the last one). The last
 * on value is kept in settings.json ("clusterLast"); the Show setting ("stage") is not touched.
 * G's Dash's Cluster source pick (cluster_source.js) can still keep the cluster for something else:
 * Map, Stock or Logo - then the button shows an amber dot and the toast says what G's Dash shows.
 */
const ON = ['lyrics', 'visualizer'];
const DEFAULT_LAST = 'lyrics';
const LAST_KEY = 'clusterLast';
const LABEL = { off: 'Off', lyrics: 'Lyrics + visualizer', visualizer: 'Visualizer only' };
const BLOCKING = ['map', 'stock', 'logo'];
const NAMES = { map: 'Map', stock: 'Stock', logo: 'Logo' };

function isOn(v) { return ON.indexOf(v) >= 0; }
/** The last on value: the setting itself when it is on, else the saved one, else Lyrics + visualizer. */
function lastOn(cur, saved) { return isOn(cur) ? cur : isOn(saved) ? saved : DEFAULT_LAST; }
/** The source pick that keeps the cluster from G's Music, or ''. */
function blockedBy(pick) { return BLOCKING.indexOf(pick) >= 0 ? pick : ''; }
/** One tap: { value, last, toast }. */
function toggle(cur, saved, pick) {
    const last = lastOn(cur, saved);
    if (isOn(cur)) return { value: 'off', last, toast: 'Cluster: Off' };
    const b = blockedBy(pick);
    return { value: last, last, toast: b ? "Cluster: on, but G's Dash shows " + NAMES[b] : 'Cluster: ' + LABEL[last] };
}

module.exports = { ON, DEFAULT_LAST, LAST_KEY, LABEL, BLOCKING, isOn, lastOn, blockedBy, toggle };
