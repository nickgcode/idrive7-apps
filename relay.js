/*
 * Spotify sign-in relay for G's Music (ng_spotify). Static, no secrets: see README.md beside it.
 *
 * 1. Opened from the car's QR code:  <this page>#v=1&s=<state>&c=<PKCE challenge>[&id=<client id>]
 *    -> asks for the client ID once (unless the car sent it), then goes to Spotify's authorize page
 *       with redirect_uri = this page and the car's state and challenge (the verifier stays in the car).
 * 2. Opened by Spotify:  <this page>?code=...&state=...  (or ?error=...&state=...)
 *    -> state = <topic>.<key>[.<mailbox>]: encrypts {code, client_id, redirect_uri} with the key
 *       (AES-256-GCM, additional data "ng_spotify/1"), posts it to <mailbox>/<topic>, then waits for
 *       the car's encrypted "done".
 *    The mailbox must be one of MAILBOXES (only https://ntfy.sh): a code naming any other server is
 *    refused, so a crafted code cannot send the sign-in elsewhere. index.html's CSP connect-src matches.
 */
(function () {
  'use strict';
  var DEFAULT_MAILBOX = 'https://ntfy.sh';
  var MAILBOXES = ['https://ntfy.sh'];   // keep in step with connect-src in index.html
  var AUTHORIZE = 'https://accounts.spotify.com/authorize';
  var SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read user-library-modify';
  var AAD = new TextEncoder().encode('ng_spotify/1');
  var CID_KEY = 'ng_spotify.client_id';
  var WAIT_MS = 90000;

  function $(id) { return document.getElementById(id); }
  function show(id) {
    ['start', 'busy', 'ok', 'fail', 'info'].forEach(function (s) { $(s).hidden = s !== id; });
  }
  function failWith(text) { $('fail-text').textContent = text; show('fail'); }
  function b64u(bytes) {
    var s = ''; bytes = new Uint8Array(bytes);
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64u(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var b = atob(s), out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function parseState(state) {
    var p = String(state || '').split('.');
    if (p.length < 2 || p.length > 3 || !/^[A-Za-z0-9_-]{16,64}$/.test(p[0])) return null;
    var key;
    try { key = fromB64u(p[1]); } catch (e) { return null; }
    if (key.length !== 32) return null;
    var mb = DEFAULT_MAILBOX;
    if (p[2]) { try { mb = new TextDecoder().decode(fromB64u(p[2])); } catch (e) { return null; } }
    mb = mb.replace(/\/+$/, '');
    if (MAILBOXES.indexOf(mb) < 0) return null;
    return { topic: p[0], key: key, mailbox: mb };
  }
  function validCid(s) { return /^[0-9a-zA-Z]{16,64}$/.test(s || ''); }
  function store(kind) {
    try { var s = window[kind]; s.setItem('ngsp.t', '1'); s.removeItem('ngsp.t'); return s; } catch (e) { return null; }
  }
  var local = store('localStorage'), session = store('sessionStorage');

  function importKey(raw) { return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
  function seal(raw, obj) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return importKey(raw).then(function (k) {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: AAD, tagLength: 128 }, k, new TextEncoder().encode(JSON.stringify(obj)));
    }).then(function (ct) {
      var all = new Uint8Array(12 + ct.byteLength);
      all.set(iv, 0); all.set(new Uint8Array(ct), 12);
      return b64u(all);
    });
  }
  function unseal(raw, text) {
    var b = fromB64u(String(text).trim());
    return importKey(raw).then(function (k) {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: AAD, tagLength: 128 }, k, b.slice(12));
    }).then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function post(mb, topic, body) {
    return fetch(mb + '/' + topic, { method: 'POST', body: body, cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('mailbox: HTTP ' + r.status); return r.json(); });
  }
  function poll(mb, topic, since) {
    return fetch(mb + '/' + topic + '/json?poll=1&since=' + encodeURIComponent(since), { cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('mailbox: HTTP ' + r.status); return r.text(); })
      .then(function (t) {
        return t.split('\n').map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } })
          .filter(function (m) { return m && m.event === 'message' && typeof m.message === 'string'; });
      });
  }

  /* ---- 1. from the car's QR code ---- */
  function startPage(h, here) {
    var st = parseState(h.get('s')), challenge = h.get('c') || '', carCid = h.get('id') || '';
    if (!st || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) { failWith('This code is not complete. Scan the code on the car\'s screen again.'); return; }
    var known = validCid(carCid);
    $('cid-ask').hidden = known; $('cid-known').hidden = !known;
    if (known) $('cid-full').textContent = carCid;
    else if (local && local.getItem(CID_KEY)) $('cid').value = local.getItem(CID_KEY);
    show('start');
    $('go').onclick = function () {
      var cid = known ? carCid : $('cid').value.trim();
      if (!validCid(cid)) { $('start-err').textContent = 'That does not look like a Client ID (letters and digits, usually 32).'; $('start-err').hidden = false; return; }
      if (!known && local) { if ($('remember').checked) local.setItem(CID_KEY, cid); else local.removeItem(CID_KEY); }
      if (session) session.setItem('ngsp.' + st.topic, JSON.stringify({ cid: cid }));
      $('go').disabled = true;
      location.assign(AUTHORIZE + '?' + new URLSearchParams({
        response_type: 'code', client_id: cid, redirect_uri: here, state: h.get('s'), scope: SCOPES,
        code_challenge_method: 'S256', code_challenge: challenge
      }).toString());
    };
  }

  /* ---- 2. back from Spotify ---- */
  function callbackPage(q, here) {
    var st = parseState(q.get('state'));
    if (!st) { failWith('Spotify sent back an unknown sign-in. Scan the code on the car again.'); return; }
    var saved = null;
    try { saved = JSON.parse((session && session.getItem('ngsp.' + st.topic)) || 'null'); } catch (e) { saved = null; }
    var cid = (saved && saved.cid) || (local && local.getItem(CID_KEY)) || '';
    var msg = q.get('code') ? { t: 'code', s: st.topic, code: q.get('code'), client_id: cid, redirect_uri: here }
                            : { t: 'error', s: st.topic, error: q.get('error') || 'no code' };
    show('busy');
    var sentId = null;
    seal(st.key, msg).then(function (body) {
      var tries = 0;
      function attempt() {
        return post(st.mailbox, st.topic, body).catch(function (e) {
          if (++tries >= 4) throw e;
          return sleep(1500 * tries).then(attempt);
        });
      }
      return attempt();
    }).then(function (r) {
      if (session) session.removeItem('ngsp.' + st.topic);
      sentId = r && r.id;
      if (msg.t === 'error') { failWith(msg.error === 'access_denied' ? 'You cancelled the sign-in. The car shows it too.' : 'Spotify said: ' + msg.error); return; }
      $('busy-title').textContent = 'Waiting for the car…';
      $('busy-text').textContent = 'Sent. The car checks every few seconds while G\'s Music shows the code.';
      var until = Date.now() + WAIT_MS;
      function loop() {
        if (Date.now() > until) {
          failWith('The car has not answered yet. If G\'s Music still shows the code, wait: it picks the sign-in up when it is online again (for up to 10 minutes after the code appeared).');
          return null;
        }
        return poll(st.mailbox, st.topic, sentId || 'all').then(function (list) {
          return Promise.all(list.map(function (m) { return unseal(st.key, m.message).catch(function () { return null; }); }));
        }, function () { return []; }).then(function (ps) {
          for (var i = 0; i < ps.length; i++) {
            var p = ps[i];
            if (p && p.from === 'car' && p.t === 'done' && p.s === st.topic) {
              if (p.ok) show('ok'); else failWith('The car could not finish: ' + (p.error || 'unknown error'));
              return null;
            }
          }
          return sleep(2500).then(loop);
        });
      }
      return loop();
    }).catch(function (e) {
      failWith('Could not reach the mailbox (' + (e && e.message ? e.message : e) + '). Check the phone\'s internet and scan the code again.');
    });
  }

  // a new code scanned into a tab already on this page only changes the fragment: start over
  window.addEventListener('hashchange', function () { location.reload(); });
  var here = location.origin + location.pathname;
  var q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
  if (!window.crypto || !crypto.subtle) { failWith('This browser cannot encrypt (needs an https page and a current browser).'); return; }
  if (q.has('state')) {
    history.replaceState(null, '', here);        // the code leaves the address bar and the history
    callbackPage(q, here);
  } else if (h.get('v') === '1') {
    startPage(h, here);
  } else {
    show('info');
  }
})();
