// Addon Stremio « Reactor » : sous-titres doubles (langue apprise + traduction)
// fusionnés en une seule piste, lisible par le lecteur mpv de l'application.
//   node addon/server.js        puis ouvrir http://127.0.0.1:7070
'use strict';
const http = require('http');
const { SR_LANGS } = require('../lib/langs.js');

const PORT = +process.env.PORT || 7070;
const OS = 'https://opensubtitles-v3.strem.io';
const NATIVE_COLOR = '#ffd76a';
const MAX_TRACKS = 3;
const UA = { 'User-Agent': 'Mozilla/5.0 StremioReactor' };

// ---------- cache ----------
const cache = new Map();
function cached(key, fn) {
  if (!cache.has(key)) {
    const p = fn().catch(e => { cache.delete(key); throw e; });
    cache.set(key, p);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

// OpenSubtitles met parfois plus de 10 s à répondre : délai long et nouvelles tentatives.
async function get(url, as = 'text', tries = 3) {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      return await r[as]();
    } catch (e) {
      if (k >= tries) throw new Error((e.cause && e.cause.code) || e.message);
      await new Promise(r => setTimeout(r, 1000 * k));
    }
  }
}

// ---------- sous-titres ----------
const TIME_RE = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
const toSec = (h, m, s, ms) => (+h || 0) * 3600 + +m * 60 + +s + +ms.padEnd(3, '0') / 1000;

function parseSubs(text) {
  const out = [];
  for (const block of text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => TIME_RE.test(l));
    if (i < 0) continue;
    const m = lines[i].match(TIME_RE);
    const txt = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
    if (txt) out.push({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]), text: txt });
  }
  return out.sort((a, b) => a.start - b.start);
}

function fmt(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return p(Math.floor(ms / 3600000)) + ':' + p(Math.floor(ms / 60000) % 60) + ':' +
    p(Math.floor(ms / 1000) % 60) + ',' + p(ms % 1000, 3);
}

// Durée totale de chevauchement entre deux listes triées, la seconde transformée par t' = a*t + b.
function overlap(A, B, a, b) {
  let i = 0, j = 0, sum = 0;
  while (i < A.length && j < B.length) {
    const s1 = A[i].start, e1 = A[i].end, s2 = a * B[j].start + b, e2 = a * B[j].end + b;
    const d = Math.min(e1, e2) - Math.max(s1, s2);
    if (d > 0) sum += d;
    if (e1 < e2) i++; else j++;
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

// Traduction automatique par paquets de lignes (le service garde les retours à la ligne).
async function translateAll(lines, sl, tl) {
  const out = new Array(lines.length);
  const chunks = [];
  for (let i = 0, size = 0, start = 0; i <= lines.length; i++) {
    if (i === lines.length || size + lines[i].length > 3000) {
      if (i > start) chunks.push([start, i]);
      start = i; size = 0;
    }
    if (i < lines.length) size += lines[i].length + 1;
  }
  const translate = async q => {
    const r = await fetch('https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=' + sl + '&tl=' + tl, {
      method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(q)
    });
    if (!r.ok) throw new Error('traduction HTTP ' + r.status);
    let v = (await r.json())[0];
    return Array.isArray(v) ? v[0] : v;
  };
  // Chaque ligne est numérotée « [i] » : si le traducteur fusionne des lignes
  // (fréquent vers l'arabe), on retraduit seulement celles qui manquent, par moitiés.
  const digits = s => s.replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x6f0);
  const run = async (idxs, depth) => {
    let res;
    try {
      res = await translate(idxs.map(i => '[' + i + '] ' + lines[i]).join('\n'));
    } catch (e) {
      if (depth >= 3) return;
      await new Promise(r => setTimeout(r, 1000));
      return run(idxs, depth + 1);
    }
    for (const line of digits(res).split('\n')) {
      const m = /^\s*[\[\]](\d+)[\[\]]\s*(.*)$/.exec(line);
      if (m && idxs.includes(+m[1])) out[+m[1]] = m[2].trim();
    }
    const missing = idxs.filter(i => out[i] === undefined);
    if (missing.length && depth < 3) {
      const half = Math.ceil(missing.length / 2);
      await run(missing.slice(0, half), depth + 1);
      if (missing.length > 1) await run(missing.slice(half), depth + 1);
    }
  };
  for (let k = 0; k < chunks.length; k += 3) {
    await Promise.all(chunks.slice(k, k + 3).map(([s, e]) => run(Array.from({ length: e - s }, (_, n) => s + n), 0)));
  }
  return out;
}

async function buildDual(tgtUrl, natUrl, sl, tl) {
  const tgt = parseSubs(await cached('t:' + tgtUrl, () => get(tgtUrl)));
  if (natUrl === 'mt') {
    const tr = await translateAll(tgt.map(c => c.text.replace(/\n/g, ' ')), sl, tl);
    tgt.forEach((c, i) => { c.native = tr[i] || ''; });
  } else {
    const nat = parseSubs(await cached('t:' + natUrl, () => get(natUrl)));
    const { a, b } = bestFit(tgt, nat);
    for (const c of tgt) {
      c.native = nat.filter(n => a * n.start + b < c.end - 0.1 && a * n.end + b > c.start + 0.1)
        .map(n => n.text.replace(/\n/g, ' ')).join(' ');
    }
  }
  return tgt.map((c, i) => {
    const nat = c.native ? '\n<font color="' + NATIVE_COLOR + '">' + c.native + '</font>' : '';
    return (i + 1) + '\n' + fmt(c.start) + ' --> ' + fmt(c.end) + '\n' + c.text + nat + '\n';
  }).join('\n');
}

// ---------- protocole Stremio ----------
function parseCfg(s) {
  const m = /^([a-z]{2})-([a-z]{2})$/.exec(s || '');
  return m && SR_LANGS[m[1]] && SR_LANGS[m[2]] ? { cfg: s, sl: m[1], tl: m[2] } : null;
}

function manifest({ sl, tl }) {
  return {
    id: 'local.stremio-reactor.' + sl + '-' + tl,
    version: '0.1.0',
    name: 'Reactor ' + sl.toUpperCase() + '+' + tl.toUpperCase(),
    description: 'Sous-titres doubles ' + SR_LANGS[sl].name + ' + ' + SR_LANGS[tl].name + ' pour apprendre les langues.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true }
  };
}

async function subtitles({ cfg, sl, tl }, type, id, extra, base) {
  // extra (videoHash, filename…) aide OpenSubtitles à choisir des sous-titres de la bonne version ;
  // ses valeurs doivent être réencodées (espaces, crochets dans le nom du fichier).
  const enc = extra ? '/' + extra.split('&').map(kv => {
    const [k, ...v] = kv.split('=');
    return k + '=' + encodeURIComponent(v.join('='));
  }).join('&') : '';
  const listFor = async e => {
    const url = OS + '/subtitles/' + type + '/' + encodeURIComponent(id).replace(/%3A/g, ':') + e + '.json';
    return (await cached('l:' + url, () => get(url, 'json'))).subtitles || [];
  };
  const list = await listFor(enc).catch(() => listFor(''));
  const tgt = list.filter(s => SR_LANGS[sl].subs.includes(s.lang)).slice(0, MAX_TRACKS);
  const nat = list.find(s => SR_LANGS[tl].subs.includes(s.lang));
  const label = sl.toUpperCase() + '+' + tl.toUpperCase();
  const link = (t, n) => base + '/' + cfg + '/dual.srt?t=' + encodeURIComponent(t.url) + '&n=' + encodeURIComponent(n);
  const subs = [];
  tgt.forEach((t, i) => {
    if (nat) subs.push({ id: 'reactor-' + i, url: link(t, nat.url), lang: label + ' ' + (i + 1) });
  });
  if (tgt[0]) subs.push({ id: 'reactor-mt', url: link(tgt[0], 'mt'), lang: label + ' auto' });
  return { subtitles: subs, cacheMaxAge: 3600 };
}

// ---------- page d'accueil ----------
function landing() {
  const opts = sel => Object.entries(SR_LANGS)
    .map(([c, l]) => '<option value="' + c + '"' + (c === sel ? ' selected' : '') + '>' + l.name + '</option>').join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Stremio Reactor</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141414;color:#ddd;font:15px system-ui,sans-serif}
 main{width:min(420px,92vw)} h1{color:#e50914;margin:0 0 6px} p{color:#999}
 label{display:flex;justify-content:space-between;align-items:center;margin:12px 0}
 select{background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:4px;padding:6px}
 a.btn{display:block;text-align:center;background:#e50914;color:#fff;text-decoration:none;padding:12px;border-radius:6px;margin:18px 0 8px;font-weight:600}
 code{display:block;background:#222;padding:8px;border-radius:4px;word-break:break-all;color:#ffd76a;user-select:all}
</style></head><body><main>
<h1>Stremio Reactor</h1><p>Sous-titres doubles dans l'application Stremio.</p>
<label>J'apprends <select id="sl">${opts('en')}</select></label>
<label>Ma langue <select id="tl">${opts('fr')}</select></label>
<a class="btn" id="copy" href="#">Copier l'adresse de l'addon</a>
<p>Puis dans Stremio → Addons, colle-la dans la barre de recherche et clique sur Installer.
(Le lien stremio:// ne marche pas pour un addon local : Stremio le transforme en https et perd le port.)</p><code id="url"></code>
</main><script>
 const upd=()=>{url.textContent=location.origin+'/'+sl.value+'-'+tl.value+'/manifest.json';copy.textContent="Copier l'adresse de l'addon";};
 copy.onclick=e=>{e.preventDefault();navigator.clipboard.writeText(url.textContent).then(()=>copy.textContent='Adresse copiée ✓');};
 sl.onchange=tl.onchange=upd;upd();
</script></body></html>`;
}

// ---------- serveur ----------
function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*'
  });
  res.end(body);
}
const json = (res, obj) => send(res, 200, JSON.stringify(obj), 'application/json; charset=utf-8');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const base = 'http://' + (req.headers.host || '127.0.0.1:' + PORT);
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (!parts.length || parts[0] === 'configure' || parts[1] === 'configure') return send(res, 200, landing(), 'text/html; charset=utf-8');
    // /manifest.json et /subtitles/... sans configuration = en-fr
    const conf = parseCfg(parts[0]) || parseCfg('en-fr');
    if (parseCfg(parts[0])) parts.shift();
    if (parts[0] === 'manifest.json') return json(res, manifest(conf));
    if (parts[0] === 'subtitles' && parts.length >= 3) {
      const last = parts.length - 1;
      parts[last] = parts[last].replace(/\.json$/, '');
      const [, type, id, extra] = parts;
      return json(res, await subtitles(conf, type, id, extra, base));
    }
    if (parts[0] === 'dual.srt') {
      const t = u.searchParams.get('t'), n = u.searchParams.get('n');
      if (!t || !n) return send(res, 400, 'paramètres manquants', 'text/plain');
      const srt = await cached('d:' + conf.cfg + t + '|' + n, () => buildDual(t, n, conf.sl, conf.tl));
      return send(res, 200, srt, 'application/x-subrip; charset=utf-8');
    }
    send(res, 404, 'introuvable', 'text/plain');
  } catch (e) {
    console.error(req.url, e.message);
    send(res, 502, 'Erreur : ' + e.message, 'text/plain; charset=utf-8');
  }
}).listen(PORT, '127.0.0.1', () => console.log('Stremio Reactor : http://127.0.0.1:' + PORT));
