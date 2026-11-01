/*
 * G's TV (ng_tv): send a source's name and link from the phone to the car. Static, no secrets: see
 * README.md beside it, and apps/ng_tv/tv_handoff.js (the car's side).
 *
 *   <this page>#v=1&s=<topic>.<key>[&m=e&n=<name>]   from the car's QR code (m=e: rename / new link)
 *   <this page>                                      typed by hand: asks for the car's 6-digit code,
 *                                                    topic + key = PBKDF2-SHA256(code, "ng_tv/code/1", 100000)
 * Sends AES-256-GCM(key, {t:'source', s:<topic>, name, url}) (additional data "ng_tv/1") to
 * https://ntfy.sh/<topic>, then waits for the car's encrypted {t:'got'} and {t:'done', ok}.
 * The car checks everything again; this page's checks only save a wasted trip.
 */
(function () {
  'use strict';
  var MAILBOX = 'https://ntfy.sh';        // keep in step with connect-src in index.html
  var AAD = new TextEncoder().encode('ng_tv/1');
  var CODE_SALT = 'ng_tv/code/1', CODE_ROUNDS = 100000;
  var MAX_NAME = 32, MAX_URL = 2048;
  var WAIT_MS = 10 * 60 * 1000;

  function $(id) { return document.getElementById(id); }
  function show(id) { ['code', 'form', 'busy', 'done', 'fail'].forEach(function (s) { $(s).hidden = s !== id; }); }
  function failWith(text) { $('fail-text').textContent = text; show('fail'); }
  function err(id, text) { $(id).textContent = text; $(id).hidden = !text; }
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
    if (p.length !== 2 || !/^[A-Za-z0-9_-]{16,64}$/.test(p[0])) return null;
    var key;
    try { key = fromB64u(p[1]); } catch (e) { return null; }
    return key.length === 32 ? { topic: p[0], key: key } : null;
  }
  function fromCode(code) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(CODE_SALT), iterations: CODE_ROUNDS }, k, 48 * 8);
    }).then(function (bits) {
      var b = new Uint8Array(bits);
      return { topic: 'ngtvc_' + b64u(b.slice(0, 16)), key: b.slice(16, 48) };
    });
  }
  function cleanName(s) {
    return String(s || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  }
  /** '' when fine, else why not. */
  function urlProblem(s) {
    if (!s) return 'Paste the link to the video file.';
    if (s.length > MAX_URL) return 'That link is too long (at most ' + MAX_URL + ' characters).';
    if (/[\u0000-\u0020\u007f-\u009f]/.test(s)) return 'The link has spaces in it.';
    var u;
    try { u = new URL(s); } catch (e) { return 'That is not a web link.'; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only links starting with https:// or http:// work.';
    if (!u.hostname) return 'That link has no server in it.';
    if (u.username || u.password) return 'Links with a user name or password are not accepted.';
    return '';
  }

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
  function post(topic, body) {
    return fetch(MAILBOX + '/' + topic, { method: 'POST', body: body, cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('mailbox: HTTP ' + r.status); return r.json(); });
  }
  function poll(topic, since) {
    return fetch(MAILBOX + '/' + topic + '/json?poll=1&since=' + encodeURIComponent(since), { cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('mailbox: HTTP ' + r.status); return r.text(); })
      .then(function (t) {
        return t.split('\n').map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } })
          .filter(function (m) { return m && m.event === 'message' && typeof m.message === 'string'; });
      });
  }

  function formPage(st, edit, name) {
    if (edit) {
      $('form-title').textContent = 'Change a source';
      $('form-intro').textContent = 'Change the name, or send a new link. Leave the link empty to keep the one the car has.';
      $('url').placeholder = 'empty: keep the link';
    }
    $('name').value = name || '';
    show('form');
    $('send').onclick = function () {
      var n = cleanName($('name').value), u = $('url').value.trim();
      if (!n) { err('form-err', 'Give it a name.'); return; }
      var why = edit && !u ? '' : urlProblem(u);
      if (why) { err('form-err', why); return; }
      if (!$('ok').checked) { err('form-err', 'Tick the box to confirm you may watch this video.'); return; }
      err('form-err', '');
      $('send').disabled = true;
      send(st, { t: 'source', s: st.topic, v: 1, mode: edit ? 'edit' : 'add', name: n, url: u });
    };
  }

  function send(st, msg) {
    show('busy');
    var sentId = null;
    seal(st.key, msg).then(function (body) {
      var tries = 0;
      function attempt() {
        return post(st.topic, body).catch(function (e) {
          if (++tries >= 4) throw e;
          return sleep(1500 * tries).then(attempt);
        });
      }
      return attempt();
    }).then(function (r) {
      sentId = r && r.id;
      $('busy-title').textContent = 'Waiting for the car…';
      $('busy-text').textContent = 'Sent. The car picks it up within a few seconds while G\'s TV shows the code.';
      var until = Date.now() + WAIT_MS, got = false;
      function loop() {
        if (Date.now() > until) { failWith(got ? 'The car did not save it (no answer).' : 'The car has not picked it up. Is G\'s TV still showing the code, and is the car online?'); return null; }
        return poll(st.topic, sentId || 'all').then(function (list) {
          return Promise.all(list.map(function (m) { return unseal(st.key, m.message).catch(function () { return null; }); }));
        }, function () { return []; }).then(function (ps) {
          for (var i = 0; i < ps.length; i++) {
            var p = ps[i];
            if (!p || p.from !== 'car' || p.s !== st.topic) continue;
            if (p.t === 'got' && !got) {
              got = true;
              $('busy-title').textContent = 'Check the car\'s screen';
              $('busy-text').textContent = 'The car got it and is checking the link. Tap Save on the car to keep it.';
            }
            if (p.t === 'done') {
              if (p.ok) show('done');
              else failWith(typeof p.error === 'string' && p.error ? p.error.slice(0, 200) : 'Cancelled on the car.');
              return null;
            }
          }
          return sleep(3000).then(loop);
        });
      }
      return loop();
    }).catch(function (e) {
      failWith('Could not reach the mailbox (' + (e && e.message ? e.message : e) + '). Check the phone\'s internet and try again.');
    });
  }

  function codePage() {
    show('code');
    $('code-go').onclick = function () {
      var c = $('digits').value.replace(/\D/g, '');
      if (c.length !== 6) { err('code-err', 'The code has 6 digits.'); return; }
      err('code-err', '');
      $('code-go').disabled = true;
      fromCode(c).then(function (st) { formPage(st, false, ''); }, function () { err('code-err', 'This browser cannot do that. Scan the QR code instead.'); $('code-go').disabled = false; });
    };
  }

  window.addEventListener('hashchange', function () { location.reload(); });
  if (!window.crypto || !crypto.subtle) { failWith('This browser cannot encrypt (needs an https page and a current browser).'); return; }
  var h = new URLSearchParams(location.hash.slice(1));
  // the key leaves the address bar and the history once read
  if (location.hash) history.replaceState(null, '', location.origin + location.pathname);
  if (h.get('v') === '1') {
    var st = parseState(h.get('s'));
    if (!st) { failWith('This code is not complete. Scan the code on the car\'s screen again.'); return; }
    var name = '';
    if (h.get('n')) { try { name = cleanName(new TextDecoder().decode(fromB64u(h.get('n')))); } catch (e) { name = ''; } }
    formPage(st, h.get('m') === 'e', name);
  } else {
    codePage();
  }
})();
