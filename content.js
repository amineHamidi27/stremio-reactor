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
    route: null,        // { type, id } du titre en cours
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

  async function loadRoute(route) {
    const token = ++st.loadToken;
    st.tgtTracks = []; st.natTracks = [];
    st.tgtIdx = NONE; st.natIdx = NONE;
    setCues([]);
    st.offset = 0;
    status('Recherche des sous-titres…');
    try {
      const res = await send({ type: 'json', url: ADDON + '/subtitles/' + route.type + '/' + route.id + '.json' });
      if (token !== st.loadToken) return;
      const subs = res.subtitles || [];
      st.tgtTracks = subs.filter(s => SR_LANGS[S.target].subs.includes(s.lang));
      st.natTracks = subs.filter(s => SR_LANGS[S.native].subs.includes(s.lang));
      fillSelects();
      if (!st.tgtTracks.length) {
        status('Aucun sous-titre ' + SR_LANGS[S.target].name + ' trouvé. Charge un fichier .srt (touche T).');
        return;
      }
      await selectTarget(0);
      await selectNative(st.natTracks.length ? 0 : MT);
    } catch (e) {
      if (token === st.loadToken) status('Erreur : ' + e.message);
    }
  }

  async function selectTarget(i) {
    st.tgtIdx = i;
    status('Chargement des sous-titres ' + SR_LANGS[S.target].name + '…');
    const text = await send({ type: 'text', url: st.tgtTracks[i].url });
    setCues(parseSubs(text));
    if (st.natIdx >= 0) await selectNative(st.natIdx);
    status(st.cues.length + ' répliques chargées.');
  }

  async function selectNative(i) {
    st.natIdx = i;
    st.mt.clear();
    for (const c of st.cues) c.native = undefined;
    if (i >= 0) {
      const text = await send({ type: 'text', url: st.natTracks[i].url });
      align(parseSubs(text));
    }
    fillSelects();
    render(true);
  }

  function setCues(cues) {
    st.cues = cues;
    st.cur = -1;
    st.pausedAtCue = -1;
    st.mt.clear();
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
  panel.innerHTML = `
    <div class="sr-head"><b>Stremio Reactor</b><button class="sr-x" title="Fermer (T)">✕</button></div>
    <label>Sous-titres appris <select class="sr-sel-tgt"></select></label>
    <label>Sous-titres traduits <select class="sr-sel-nat"></select></label>
    <div class="sr-row">Décalage
      <button class="sr-off-m">−</button><span class="sr-off">0.0 s</span><button class="sr-off-p">+</button>
    </div>
    <div class="sr-row">
      <label><input type="checkbox" class="sr-ck-ap"> Pause auto</label>
      <label><input type="checkbox" class="sr-ck-hp"> Pause au survol</label>
      <label><input type="checkbox" class="sr-ck-nat"> Traduction</label>
      <label><input type="checkbox" class="sr-ck-blur"> Flouter</label>
    </div>
    <div class="sr-status"></div>
    <div class="sr-keys">A ◀ réplique · S répéter · D ▶ réplique · Q pause auto · N traduction · [ ] décalage · T panneau</div>
    <div class="sr-list"></div>`;
  const $ = s => panel.querySelector(s);
  const list = $('.sr-list');
  const selTgt = $('.sr-sel-tgt');
  const selNat = $('.sr-sel-nat');

  function status(msg) { $('.sr-status').textContent = msg; }

  function fillSelects() {
    const label = (t, i) => '#' + (i + 1) + ' ' + (t.subtitleFileName || t.movieReleaseName || t.id);
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
    pop.innerHTML = '';
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
          media: st.route ? st.route.id : '',
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
    v.currentTime = st.cues[i].start + st.offset + 0.01;
    v.play();
  }

  function curTime() { return st.video.currentTime - st.offset; }

  function prevCue() { seekCue(st.cur >= 0 ? st.cur - 1 : lastStarted(curTime())); }
  function nextCue() { seekCue(lastStarted(curTime()) + 1); }
  function replayCue() { seekCue(st.cur >= 0 ? st.cur : lastStarted(curTime())); }

  function togglePanel() {
    panel.hidden = !panel.hidden;
    overlay.classList.toggle('sr-with-panel', !panel.hidden);
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
    const v = document.querySelector('video');
    if (v !== st.video) {
      if (st.video) st.video.removeEventListener('seeked', onSeeked);
      st.video = v;
      if (v) { v.addEventListener('seeked', onSeeked); mount(); }
      else { overlay.remove(); pop.remove(); panel.remove(); }
    }
    const route = parseRoute();
    if (route && (!st.route || route.id !== st.route.id)) {
      st.route = route;
      loadRoute(route);
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
      if ((ch.target || ch.native) && st.route) loadRoute(st.route);
    }
  });
  document.addEventListener('fullscreenchange', () => { if (st.video) mount(); });
  window.addEventListener('hashchange', scan);
  setInterval(scan, 1000);
  scan();
  requestAnimationFrame(tick);
})();
