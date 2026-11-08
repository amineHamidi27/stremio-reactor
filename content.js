(() => {
  'use strict';
  if (window.__srLoaded) return;
  window.__srLoaded = true;

  const ADDON = 'https://opensubtitles-v3.strem.io';
  const MT = -1;       // piste maternelle = traduction automatique
  const NONE = -2;     // pas encore de piste

  let S = Object.assign({}, SR_DEFAULTS);
  const st = {
    video: null,
    key: null,          // identifiant du titre en cours (selon le site)
    tgtTracks: [], natTracks: [],
    tgtIdx: NONE, natIdx: NONE,
    cues: [],           // [{ start, end, text, native }]
    cur: -1,
    offset: 0,          // décalage des sous-titres (s)
    pausedAtCue: -1,
    hoverPaused: false,
    mt: new Map(),      // index de réplique -> traduction auto
    saved: new Set(),   // mots sauvegardés (minuscules)
    loadToken: 0
  };

  // ---------- utilitaires ----------
  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, r => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (r && r.ok) resolve(r.data); else reject(new Error(r ? r.error : 'pas de réponse'));
      });
    });
  }

  // Requête au script page.js (monde MAIN, YouTube et Netflix).
  let reqId = 0;
  const waiting = new Map();
  function page(action, data) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      waiting.set(id, { resolve, reject });
      window.postMessage(Object.assign({ sr: 'req', id, action }, data), '*');
      setTimeout(() => { if (waiting.delete(id)) reject(new Error('la page ne répond pas (recharge-la)')); }, 25000);
    });
  }
  window.addEventListener('message', e => {
    const m = e.data;
    if (e.source !== window || !m) return;
    if (m.sr === 'res' && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.ok) w.resolve(m.data); else w.reject(new Error(m.error));
    }
    if (m.sr === 'event' && m.type === 'nf-tracks' && m.movieId === st.key) loadMedia(st.key);
  });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }

  // ---------- sous-titres ----------
  const TIME_RE = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

  function toSec(h, m, s, ms) {
    return (+h || 0) * 3600 + +m * 60 + +s + +ms.padEnd(3, '0') / 1000;
  }

  function parseSubs(text) {
    const out = [];
    const blocks = text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.split('\n');
      const i = lines.findIndex(l => TIME_RE.test(l));
      if (i < 0) continue;
      const m = lines[i].match(TIME_RE);
      const txt = lines.slice(i + 1).join('\n')
        .replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
      if (txt) out.push({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]), text: txt });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // Format json3 de YouTube.
  function parseJson3(text) {
    const out = [];
    for (const e of JSON.parse(text).events || []) {
      if (!e.segs || e.tStartMs == null) continue;
      const txt = e.segs.map(s => s.utf8 || '').join('').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
      if (txt) out.push({ start: e.tStartMs / 1000, end: (e.tStartMs + (e.dDurationMs || 2000)) / 1000, text: txt });
    }
    out.sort((a, b) => a.start - b.start);
    // les sous-titres automatiques se chevauchent : chaque ligne s'arrête quand la suivante commence
    for (let i = 0; i < out.length - 1; i++) out[i].end = Math.min(out[i].end, out[i + 1].start);
    return out;
  }

  // Format TTML / DFXP de Netflix (temps en « ticks » ou en hh:mm:ss.mmm).
  function parseTTML(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const root = doc.documentElement;
    const tick = +(root.getAttribute('ttp:tickRate') ||
      root.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'tickRate')) || 10000000;
    const time = v => {
      if (!v) return 0;
      if (v.endsWith('t')) return +v.slice(0, -1) / tick;
      const m = v.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
      return m ? m[1] * 3600 + m[2] * 60 + +m[3] : parseFloat(v);
    };
    const textOf = n => n.nodeType === 3 ? n.nodeValue
      : n.localName === 'br' ? '\n' : [...n.childNodes].map(textOf).join('');
    const out = [];
    for (const p of doc.getElementsByTagNameNS('*', 'p')) {
      const txt = textOf(p).trim();
      if (txt) out.push({ start: time(p.getAttribute('begin')), end: time(p.getAttribute('end')), text: txt });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // Durée totale de chevauchement entre deux listes triées, la seconde transformée par t' = a*t + b.
  function overlap(A, B, a, b) {
    let i = 0, j = 0, sum = 0;
    while (i < A.length && j < B.length) {
      const s2 = a * B[j].start + b, e2 = a * B[j].end + b;
      const d = Math.min(A[i].end, e2) - Math.max(A[i].start, s2);
      if (d > 0) sum += d;
      if (A[i].end < e2) i++; else j++;
    }
    return sum;
  }

  // Les deux fichiers viennent souvent de versions différentes du film :
  // on cherche le décalage (et le changement de fréquence d'images) qui les aligne le mieux.
  function bestFit(tgt, nat) {
    let best = { a: 1, b: 0, score: overlap(tgt, nat, 1, 0) };
    for (const a of [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24]) {
      for (let b = -30; b <= 30; b += 0.2) {
        const score = overlap(tgt, nat, a, b);
        if (score > best.score) best = { a, b, score };
      }
    }
    for (let b = best.b - 0.2; b <= best.b + 0.2; b += 0.02) {
      const score = overlap(tgt, nat, best.a, b);
      if (score > best.score) best = { a: best.a, b, score };
    }
    return best;
  }

  // Associe à chaque réplique cible le texte maternel qui la chevauche dans le temps.
  function align(nat) {
    const { a, b } = bestFit(st.cues, nat);
    for (const c of st.cues) {
      c.native = nat.filter(n => a * n.start + b < c.end - 0.1 && a * n.end + b > c.start + 0.1)
        .map(n => n.text).join('\n');
    }
  }

  function lastStarted(t) {
    let lo = 0, hi = st.cues.length - 1, r = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (st.cues[m].start <= t) { r = m; lo = m + 1; } else hi = m - 1;
    }
    return r;
  }

  function findCue(t) {
    const i = lastStarted(t);
    return i >= 0 && t < st.cues[i].end ? i : -1;
  }

  // ---------- route Stremio ----------
  // #/player/<stream>/<transport>/<metaTransport>/<type>/<id>/<videoId>
  function parseRoute() {
    const h = location.hash;
    if (!h.startsWith('#/player')) return null;
    const parts = h.split('?')[0].split('/').map(p => { try { return decodeURIComponent(p); } catch (e) { return p; } });
    let route = null;
    for (let i = 0; i < parts.length - 1; i++) {
      if ((parts[i] === 'movie' || parts[i] === 'series') && /^tt\d+/.test(parts[i + 1])) {
        const vid = parts[i + 2];
        route = { type: parts[i], id: vid && /^tt\d+/.test(vid) ? vid : parts[i + 1] };
      }
    }
    return route;
  }

  // ---------- sites ----------
  // Chaque site dit où est la vidéo, quel titre est en cours (key) et quelles pistes existent.
  // Une piste = { label, load: () => Promise<cues> }.
  const baseLang = c => (c || '').toLowerCase().split(/[-_]/)[0];

  const SITES = {
    stremio: {
      video: () => document.querySelector('video'),
      key() {
        const r = parseRoute();
        return r ? r.type + '/' + r.id : null;
      },
      async tracks(key) {
        const res = await send({ type: 'json', url: ADDON + '/subtitles/' + key + '.json' });
        const subs = res.subtitles || [];
        const mk = s => ({
          label: s.subtitleFileName || s.movieReleaseName || s.id,
          load: async () => parseSubs(await send({ type: 'text', url: s.url }))
        });
        return {
          target: subs.filter(s => SR_LANGS[S.target].subs.includes(s.lang)).map(mk),
          native: subs.filter(s => SR_LANGS[S.native].subs.includes(s.lang)).map(mk)
        };
      }
    },

    youtube: {
      hideOwnSubs: true,
      video: () => document.querySelector('#movie_player video'),
      key() {
        const u = new URL(location.href);
        if (u.pathname === '/watch') return u.searchParams.get('v');
        const m = u.pathname.match(/^\/shorts\/([\w-]+)/);
        return m ? m[1] : null;
      },
      async tracks(videoId) {
        const info = await page('yt-tracks', { videoId });
        if (!info.tracks.length) return { target: [], native: [], note: 'Cette vidéo n\'a pas de sous-titres.' };
        const load = (lang, kind, tlang) => async () => parseJson3(await page('yt-fetch', { videoId, lang, kind, tlang }));
        // pistes d'une langue, sous-titres manuels avant les automatiques
        const of = code => info.tracks.filter(t => baseLang(t.lang) === code)
          .sort((a, b) => (a.kind === 'asr') - (b.kind === 'asr'));
        const src = of(S.target)[0] || info.tracks.find(t => t.kind !== 'asr') || info.tracks[0];
        const target = of(S.target).map(t => ({ label: t.name, load: load(t.lang, t.kind) }));
        if (!target.length) {
          target.push({ label: src.name + ' → ' + SR_LANGS[S.target].name + ' (YouTube)', load: load(src.lang, src.kind, S.target) });
        }
        // La traduction de YouTube garde exactement le même minutage : choix par défaut.
        const native = [{ label: 'Traduction YouTube', load: load(src.lang, src.kind, S.native) }]
          .concat(of(S.native).map(t => ({ label: t.name, load: load(t.lang, t.kind) })));
        return { target, native };
      }
    },

    netflix: {
      hideOwnSubs: true,
      video: () => document.querySelector('video'),
      key() {
        const m = location.pathname.match(/^\/watch\/(\d+)/);
        return m ? m[1] : null;
      },
      async tracks(movieId) {
        const list = await page('nf-tracks', { movieId });
        if (!list) {
          return { target: [], native: [], note: 'Sous-titres Netflix pas encore reçus. Si rien n\'apparaît, recharge la page (F5).' };
        }
        const mk = t => ({
          label: t.label,
          load: async () => {
            const text = await page('nf-fetch', { url: t.url });
            return t.format === 'vtt' ? parseSubs(text) : parseTTML(text);
          }
        });
        return {
          target: list.filter(t => baseLang(t.lang) === S.target).map(mk),
          native: list.filter(t => baseLang(t.lang) === S.native).map(mk)
        };
      },
      // Netflix plante si on modifie video.currentTime : on passe par son lecteur.
      seek: t => page('nf-seek', { time: t })
    }
  };

  const site = /(^|\.)youtube\.com$/.test(location.hostname) ? SITES.youtube
    : /(^|\.)netflix\.com$/.test(location.hostname) ? SITES.netflix : SITES.stremio;

  async function loadMedia(key) {
    const token = ++st.loadToken;
    st.tgtTracks = []; st.natTracks = [];
    st.tgtIdx = NONE; st.natIdx = NONE;
    setCues([]);
    st.offset = 0;
    status('Recherche des sous-titres…');
    try {
      const t = await site.tracks(key);
      if (token !== st.loadToken) return;
      st.tgtTracks = t.target;
      st.natTracks = t.native;
      fillSelects();
      if (!st.tgtTracks.length) {
        status(t.note || 'Aucun sous-titre ' + SR_LANGS[S.target].name + ' trouvé. Charge un fichier .srt (touche T).');
        return;
      }
      await selectTarget(0);
      if (token !== st.loadToken) return;
      await selectNative(st.natTracks.length ? 0 : MT);
    } catch (e) {
      if (token === st.loadToken) status('Erreur : ' + e.message);
    }
  }

  async function selectTarget(i) {
    st.tgtIdx = i;
    status('Chargement des sous-titres ' + SR_LANGS[S.target].name + '…');
    setCues(await st.tgtTracks[i].load());
    if (st.natIdx >= 0) await selectNative(st.natIdx);
    status(st.cues.length + ' répliques chargées.');
  }

  async function selectNative(i) {
    st.natIdx = i;
    st.mt.clear();
    for (const c of st.cues) c.native = undefined;
    if (i >= 0) align(await st.natTracks[i].load());
    fillSelects();
    render(true);
  }

  function setCues(cues) {
    st.cues = cues;
    st.cur = -1;
    st.pausedAtCue = -1;
    st.mt.clear();
    document.documentElement.classList.toggle('sr-on', !!site.hideOwnSubs && cues.length > 0);
    buildTranscript();
    render(true);
  }

  function loadLocalFile(which) {
    const input = el('input');
    input.type = 'file';
    input.accept = '.srt,.vtt,.txt';
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      const cues = parseSubs(await f.text());
      if (which === 'target') {
        st.tgtIdx = NONE;
        setCues(cues);
        status(cues.length + ' répliques chargées depuis ' + f.name);
      } else {
        st.natIdx = NONE;
        align(cues);
        render(true);
      }
      fillSelects();
    };
    input.click();
  }

  // ---------- traduction auto ----------
  function nativeText(i) {
    const c = st.cues[i];
    if (c.native !== undefined) return c.native;
    if (st.natIdx !== MT) return '';
    if (st.mt.has(i)) return st.mt.get(i);
    for (let k = i; k < Math.min(i + 4, st.cues.length); k++) fetchMT(k);
    return '…';
  }

  function fetchMT(i) {
    if (st.mt.has(i)) return;
    st.mt.set(i, '…');
    const cues = st.cues;
    send({ type: 'translate', text: cues[i].text.replace(/\n/g, ' '), sl: S.target, tl: S.native })
      .then(tr => { if (st.cues === cues) { st.mt.set(i, tr); if (st.cur === i) renderNative(); } })
      .catch(() => st.mt.delete(i));
  }

  // ---------- interface ----------
  const overlay = el('div', 'sr-overlay sr-empty');
  const tgtEl = el('div', 'sr-target');
  const natEl = el('div', 'sr-native');
  const badge = el('div', 'sr-badge');
  overlay.append(tgtEl, natEl, badge);

  const pop = el('div', 'sr-pop');
  pop.hidden = true;

  const panel = el('div', 'sr-panel');
  panel.hidden = true;
  // Construit sans innerHTML : YouTube l'interdit (Trusted Types).
  {
    const labeled = (text, child) => { const l = el('label', null, text + ' '); l.append(child); return l; };
    const check = (cls, text) => { const c = el('input', cls); c.type = 'checkbox'; const l = el('label'); l.append(c, ' ' + text); return l; };
    const head = el('div', 'sr-head');
    const close = el('button', 'sr-x', '✕');
    close.title = 'Fermer (T)';
    head.append(el('b', null, 'Stremio Reactor'), close);
    const offset = el('div', 'sr-row', 'Décalage ');
    offset.append(el('button', 'sr-off-m', '−'), el('span', 'sr-off', '0.0 s'), el('button', 'sr-off-p', '+'));
    const checks = el('div', 'sr-row');
    checks.append(check('sr-ck-ap', 'Pause auto'), check('sr-ck-hp', 'Pause au survol'),
      check('sr-ck-nat', 'Traduction'), check('sr-ck-blur', 'Flouter'));
    panel.append(head,
      labeled('Sous-titres appris', el('select', 'sr-sel-tgt')),
      labeled('Sous-titres traduits', el('select', 'sr-sel-nat')),
      offset, checks, el('div', 'sr-status'),
      el('div', 'sr-keys', 'A ◀ réplique · S répéter · D ▶ réplique · Q pause auto · N traduction · [ ] décalage · T panneau'),
      el('div', 'sr-list'));
  }
  const $ = s => panel.querySelector(s);
  const list = $('.sr-list');
  const selTgt = $('.sr-sel-tgt');
  const selNat = $('.sr-sel-nat');

  function status(msg) { $('.sr-status').textContent = msg; }

  function fillSelects() {
    const label = (t, i) => '#' + (i + 1) + ' ' + t.label;
    selTgt.replaceChildren();
    st.tgtTracks.forEach((t, i) => selTgt.add(new Option(label(t, i), i)));
    selTgt.add(new Option('Fichier local…', 'file'));
    selTgt.value = st.tgtIdx >= 0 ? st.tgtIdx : 'file';

    selNat.replaceChildren();
    selNat.add(new Option('Traduction automatique', MT));
    st.natTracks.forEach((t, i) => selNat.add(new Option(label(t, i), i)));
    selNat.add(new Option('Fichier local…', 'file'));
    selNat.value = st.natIdx === NONE ? 'file' : st.natIdx;
  }

  selTgt.onchange = () => selTgt.value === 'file' ? loadLocalFile('target') : selectTarget(+selTgt.value).catch(e => status('Erreur : ' + e.message));
  selNat.onchange = () => selNat.value === 'file' ? loadLocalFile('native') : selectNative(+selNat.value).catch(e => status('Erreur : ' + e.message));
  $('.sr-x').onclick = () => togglePanel();
  $('.sr-off-m').onclick = () => shiftOffset(-0.25);
  $('.sr-off-p').onclick = () => shiftOffset(0.25);
  const bindCk = (sel, key) => {
    const ck = $(sel);
    ck.onchange = () => setSetting(key, ck.checked);
  };
  bindCk('.sr-ck-ap', 'autoPause');
  bindCk('.sr-ck-hp', 'hoverPause');
  bindCk('.sr-ck-nat', 'showNative');
  bindCk('.sr-ck-blur', 'blurNative');

  function setSetting(key, value) {
    S[key] = value;
    chrome.storage.sync.set({ [key]: value });
    applySettings();
  }

  function applySettings() {
    overlay.style.setProperty('--sr-size', S.fontSize + 'px');
    overlay.classList.toggle('sr-hide-native', !S.showNative);
    overlay.classList.toggle('sr-blur', S.blurNative);
    $('.sr-ck-ap').checked = S.autoPause;
    $('.sr-ck-hp').checked = S.hoverPause;
    $('.sr-ck-nat').checked = S.showNative;
    $('.sr-ck-blur').checked = S.blurNative;
    badge.textContent = S.autoPause ? 'pause auto' : '';
  }

  function shiftOffset(d) {
    st.offset = Math.round((st.offset + d) * 100) / 100;
    $('.sr-off').textContent = (st.offset > 0 ? '+' : '') + st.offset.toFixed(2) + ' s';
    flash('Décalage ' + $('.sr-off').textContent);
  }

  let flashTimer;
  function flash(msg) {
    badge.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(applySettings, 1200);
  }

  function buildTranscript() {
    list.replaceChildren();
    st.cues.forEach((c, i) => {
      const row = el('div', 'sr-line');
      row.append(el('span', 'sr-time', fmtTime(c.start)), el('span', null, c.text.replace(/\n/g, ' ')));
      row.onclick = () => seekCue(i);
      list.append(row);
    });
  }

  function render(force) {
    const c = st.cur >= 0 ? st.cues[st.cur] : null;
    overlay.classList.toggle('sr-empty', !c);
    tgtEl.replaceChildren();
    if (c) {
      for (const line of c.text.split('\n')) {
        const div = el('div');
        line.split(/([\p{L}\p{M}\p{N}'’-]+)/u).forEach((tok, k) => {
          if (k % 2 === 0) { if (tok) div.append(tok); return; }
          const w = el('span', 'sr-w', tok);
          if (st.saved.has(tok.toLowerCase())) w.classList.add('sr-saved');
          div.append(w);
        });
        tgtEl.append(div);
      }
    }
    renderNative();
    const prev = list.querySelector('.sr-active');
    if (prev) prev.classList.remove('sr-active');
    const row = list.children[st.cur];
    if (row) {
      row.classList.add('sr-active');
      if (!panel.hidden) list.scrollTop = row.offsetTop - list.clientHeight / 2;
    }
  }

  function renderNative() {
    natEl.textContent = st.cur >= 0 ? nativeText(st.cur) : '';
  }

  // ---------- popup mot ----------
  async function showWord(span) {
    const v = st.video;
    if (v && !v.paused) v.pause();
    st.hoverPaused = false;
    const word = span.textContent;
    const cue = st.cues[st.cur];
    pop.replaceChildren();
    const head = el('div', 'sr-pop-head');
    head.append(el('b', null, word));
    const say = el('button', null, '🔊');
    say.title = 'Prononcer';
    say.onclick = () => {
      const u = new SpeechSynthesisUtterance(word);
      u.lang = S.target;
      speechSynthesis.speak(u);
    };
    head.append(say);
    const tr = el('div', 'sr-pop-tr', '…');
    const save = el('button', 'sr-pop-save', st.saved.has(word.toLowerCase()) ? '★ Déjà sauvegardé' : '☆ Sauvegarder');
    pop.append(head, tr, el('div', 'sr-pop-ctx', cue ? cue.text.replace(/\n/g, ' ') : ''), save);
    pop.hidden = false;

    const r = span.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 300)) + 'px';
    pop.style.bottom = (innerHeight - r.top + 10) + 'px';

    let translation = '';
    try {
      translation = await send({ type: 'translate', text: word, sl: S.target, tl: S.native });
      tr.textContent = translation;
    } catch (e) {
      tr.textContent = 'Traduction indisponible';
    }
    save.onclick = () => saveWord(word, translation, cue, save);
  }

  function saveWord(word, translation, cue, btn) {
    chrome.storage.local.get({ words: [] }, ({ words }) => {
      const key = word.toLowerCase();
      if (!words.some(w => w.word.toLowerCase() === key)) {
        words.push({
          word, translation,
          sentence: cue ? cue.text.replace(/\n/g, ' ') : '',
          sentenceNative: cue && st.cur >= 0 ? nativeText(st.cur).replace(/\n/g, ' ') : '',
          lang: S.target,
          title: document.title,
          media: st.key || '',
          site: location.hostname,
          time: st.video ? Math.floor(st.video.currentTime) : 0,
          savedAt: Date.now()
        });
        chrome.storage.local.set({ words });
      }
      btn.textContent = '★ Sauvegardé';
    });
  }

  function hidePop() { pop.hidden = true; }

  // Les clics sur nos éléments ne doivent pas atteindre le lecteur Stremio.
  for (const node of [overlay, pop, panel]) {
    for (const ev of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel']) {
      node.addEventListener(ev, e => e.stopPropagation());
    }
  }
  tgtEl.addEventListener('click', e => {
    if (e.target.classList.contains('sr-w')) showWord(e.target);
  });
  overlay.addEventListener('mouseenter', () => {
    const v = st.video;
    if (S.hoverPause && v && !v.paused && st.cur >= 0) { v.pause(); st.hoverPaused = true; }
  });
  overlay.addEventListener('mouseleave', () => {
    if (st.hoverPaused && pop.hidden && st.video) st.video.play();
    st.hoverPaused = false;
  });
  document.addEventListener('click', e => { if (!pop.contains(e.target)) hidePop(); });

  // ---------- navigation ----------
  function seekCue(i) {
    const v = st.video;
    if (!v || i < 0 || i >= st.cues.length) return;
    hidePop();
    st.pausedAtCue = -1;
    const t = st.cues[i].start + st.offset + 0.01;
    if (site.seek) site.seek(t).then(() => v.play(), e => status('Erreur : ' + e.message));
    else { v.currentTime = t; v.play(); }
  }

  function curTime() { return st.video.currentTime - st.offset; }

  function prevCue() { seekCue(st.cur >= 0 ? st.cur - 1 : lastStarted(curTime())); }
  function nextCue() { seekCue(lastStarted(curTime()) + 1); }
  function replayCue() { seekCue(st.cur >= 0 ? st.cur : lastStarted(curTime())); }

  function togglePanel() {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) render();
  }

  window.addEventListener('keydown', e => {
    if (!st.video || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const actions = {
      a: prevCue, s: replayCue, d: nextCue,
      q: () => { setSetting('autoPause', !S.autoPause); flash(S.autoPause ? 'Pause auto activée' : 'Pause auto désactivée'); },
      n: () => setSetting('showNative', !S.showNative),
      t: togglePanel,
      '[': () => shiftOffset(-0.25),
      ']': () => shiftOffset(0.25),
      Escape: hidePop
    };
    const fn = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!fn) return;
    if (e.key === 'Escape' && pop.hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    fn();
  }, true);

  // ---------- boucle ----------
  function tick() {
    requestAnimationFrame(tick);
    const v = st.video;
    if (!v || !st.cues.length) return;
    place(v);
    const t = curTime();
    if (S.autoPause && !v.paused && st.cur >= 0 && st.pausedAtCue !== st.cur &&
        t >= st.cues[st.cur].end - 0.08) {
      st.pausedAtCue = st.cur;
      v.pause();
      return;
    }
    if (v.paused && st.cur >= 0) return; // garder la réplique affichée en pause
    const i = findCue(t);
    if (i !== st.cur) { st.cur = i; render(); }
  }

  // Les sous-titres suivent le rectangle de la vidéo (YouTube : la vidéo ne remplit pas l'écran),
  // sans passer sous le panneau quand il est ouvert.
  let lastRect = '';
  function place(v) {
    const r = v.getBoundingClientRect();
    const right = panel.hidden ? r.right : Math.min(r.right, innerWidth - 360);
    const key = r.left + ',' + right + ',' + r.bottom + ',' + r.height;
    if (key === lastRect) return;
    lastRect = key;
    overlay.style.left = (r.left + right) / 2 + 'px';
    overlay.style.bottom = Math.max(0, innerHeight - r.bottom + r.height * 0.09) + 'px';
    overlay.style.maxWidth = Math.max(200, (right - r.left) * 0.9) + 'px';
  }

  function host() {
    const f = document.fullscreenElement;
    return f && f !== document.documentElement && f !== document.body ? f : document.body;
  }

  function mount() {
    const h = host();
    for (const n of [overlay, pop, panel]) if (n.parentNode !== h) h.append(n);
  }

  function onSeeked() {
    st.pausedAtCue = -1;
    st.cur = findCue(curTime());
    render();
  }

  function scan() {
    const key = site.key();
    const v = key ? site.video() : null;
    if (v !== st.video) {
      if (st.video) st.video.removeEventListener('seeked', onSeeked);
      st.video = v;
      if (v) { v.addEventListener('seeked', onSeeked); mount(); }
      else { overlay.remove(); pop.remove(); panel.remove(); }
    }
    if (key && key !== st.key) {
      st.key = key;
      loadMedia(key);
    }
  }

  // ---------- démarrage ----------
  chrome.storage.sync.get(SR_DEFAULTS, s => { S = s; applySettings(); });
  chrome.storage.local.get({ words: [] }, ({ words }) => {
    st.saved = new Set(words.map(w => w.word.toLowerCase()));
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.words) {
      st.saved = new Set((ch.words.newValue || []).map(w => w.word.toLowerCase()));
      render();
    }
    if (area === 'sync') {
      for (const k in ch) S[k] = ch[k].newValue;
      applySettings();
      if ((ch.target || ch.native) && st.key) loadMedia(st.key);
    }
  });
  document.addEventListener('fullscreenchange', () => { if (st.video) mount(); });
  window.addEventListener('hashchange', scan);
  setInterval(scan, 1000);
  scan();
  requestAnimationFrame(tick);
})();
