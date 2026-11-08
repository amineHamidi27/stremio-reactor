// Script exécuté dans le contexte de la page (monde MAIN) sur YouTube et Netflix.
// Il voit ce que voit le lecteur du site (réponses des sous-titres, API du lecteur)
// et répond au script de contenu par window.postMessage.
(() => {
  'use strict';
  if (window.__srPage) return;
  window.__srPage = true;

  const isYT = /(^|\.)youtube\.com$/.test(location.hostname);
  const isNF = /(^|\.)netflix\.com$/.test(location.hostname);

  // ---------- YouTube : capter les réponses timedtext du lecteur ----------
  // Les adresses timedtext portent un jeton (pot) à usage unique : les redemander renvoie du vide.
  // On fait donc charger chaque piste par le lecteur lui-même et on garde la réponse qu'il reçoit.
  const ytBodies = {}; // "videoId|lang|kind|tlang" -> texte json3
  const ytKey = (v, lang, kind, tlang) => [v, lang, kind || '', tlang || ''].join('|');

  function noteBody(url, text) {
    try {
      const u = new URL(url, location.href);
      if (u.pathname !== '/api/timedtext' || !text) return;
      const p = u.searchParams;
      ytBodies[ytKey(p.get('v'), p.get('lang'), p.get('kind'), p.get('tlang'))] = text;
    } catch (e) { /* adresse illisible */ }
  }

  if (isYT) {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (String(url).includes('/api/timedtext')) {
        this.addEventListener('load', () => {
          const r = this.response;
          noteBody(url, typeof r === 'string' ? r : r instanceof ArrayBuffer ? new TextDecoder().decode(r)
            : r && typeof r === 'object' ? JSON.stringify(r) : '');
        });
      }
      return open.apply(this, arguments);
    };
    const fetch0 = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : input && input.url;
      const res = fetch0.apply(this, arguments);
      if (url && String(url).includes('/api/timedtext')) {
        res.then(r => r.clone().text()).then(t => noteBody(url, t)).catch(() => {});
      }
      return res;
    };
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ytPlayer = () => {
    const p = document.getElementById('movie_player');
    if (!p || !p.getPlayerResponse) throw new Error('lecteur YouTube introuvable');
    return p;
  };

  async function ytTracks(videoId) {
    const player = ytPlayer();
    let resp;
    for (let i = 0; i < 20; i++) {
      resp = player.getPlayerResponse();
      if (resp && resp.videoDetails && resp.videoDetails.videoId === videoId) break;
      await sleep(250);
    }
    const r = resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer;
    if (!r || !r.captionTracks) return { tracks: [] };
    return {
      tracks: r.captionTracks.map(t => ({
        lang: t.languageCode,
        kind: t.kind || '',
        name: (t.name && (t.name.simpleText || (t.name.runs || []).map(x => x.text).join(''))) || t.languageCode
      }))
    };
  }

  // Une seule demande de piste à la fois : le lecteur n'affiche qu'une piste.
  let ytQueue = Promise.resolve();
  function ytFetch(d) {
    const job = ytQueue.then(() => ytLoad(d));
    ytQueue = job.catch(() => {});
    return job;
  }

  async function ytLoad({ videoId, lang, kind, tlang }) {
    const key = ytKey(videoId, lang, kind, tlang);
    if (ytBodies[key]) return ytBodies[key];
    const player = ytPlayer();
    player.loadModule('captions');
    let list = [];
    for (let i = 0; i < 20 && !list.length; i++) {
      list = player.getOption('captions', 'tracklist') || [];
      if (!list.length) await sleep(250);
    }
    const track = list.find(t => t.languageCode === lang && (t.kind || '') === (kind || '')) ||
      list.find(t => t.languageCode === lang);
    if (!track) throw new Error('piste YouTube introuvable : ' + lang);
    const opt = Object.assign({}, track);
    if (tlang) opt.translationLanguage = { languageCode: tlang };
    for (let attempt = 0; attempt < 2 && !ytBodies[key]; attempt++) {
      // repasser par « aucune piste » force le lecteur à refaire la requête
      if (attempt) { player.setOption('captions', 'track', {}); await sleep(300); }
      player.setOption('captions', 'track', opt);
      for (let i = 0; i < 40 && !ytBodies[key]; i++) await sleep(200);
    }
    if (!ytBodies[key]) throw new Error('YouTube n\'a pas envoyé la piste ' + lang + (tlang ? ' → ' + tlang : ''));
    return ytBodies[key];
  }

  // ---------- Netflix : pistes de sous-titres du manifeste ----------
  const WEBVTT = 'webvtt-lssdh-ios8';
  const nfTracks = {}; // movieId -> [{ lang, label, url, format }]

  if (isNF) {
    // Demander aussi le format WebVTT (texte simple) dans la requête du manifeste.
    const stringify = JSON.stringify;
    JSON.stringify = function (data) {
      try {
        if (data && typeof data.url === 'string' && /manifest/i.test(data.url)) {
          for (const v of Object.values(data)) {
            if (v && Array.isArray(v.profiles) && !v.profiles.includes(WEBVTT)) v.profiles.unshift(WEBVTT);
            if (v && 'showAllSubDubTracks' in v) v.showAllSubDubTracks = true;
          }
        }
      } catch (e) { /* objet inattendu */ }
      return stringify.apply(this, arguments);
    };
    // Lire la réponse du manifeste.
    const parse = JSON.parse;
    JSON.parse = function () {
      const value = parse.apply(this, arguments);
      try {
        const res = value && value.result;
        if (res && res.movieId && Array.isArray(res.timedtexttracks)) {
          nfTracks[res.movieId] = res.timedtexttracks
            .filter(t => !t.isNoneTrack && !t.isForcedNarrative && t.ttDownloadables)
            .map(t => {
              const fmt = [WEBVTT, 'dfxp-ls-sdh', 'simplesdh', 'imsc1.1'].find(f => t.ttDownloadables[f]);
              if (!fmt) return null;
              const d = t.ttDownloadables[fmt];
              const url = d.urls ? d.urls[0].url : d.downloadUrls ? Object.values(d.downloadUrls)[0] : null;
              return url && {
                lang: t.language,
                label: (t.languageDescription || t.language) + (t.rawTrackType === 'closedcaptions' ? ' [CC]' : ''),
                url,
                format: fmt === WEBVTT ? 'vtt' : 'ttml'
              };
            })
            .filter(Boolean);
          window.postMessage({ sr: 'event', type: 'nf-tracks', movieId: String(res.movieId) }, '*');
        }
      } catch (e) { /* manifeste inattendu */ }
      return value;
    };
  }

  function nfPlayer() {
    const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
    return vp.getVideoPlayerBySessionId(vp.getAllPlayerSessionIds()[0]);
  }

  // ---------- pont avec le script de contenu ----------
  const actions = {
    'yt-tracks': d => ytTracks(d.videoId),
    'yt-fetch': d => ytFetch(d),
    'nf-tracks': d => nfTracks[d.movieId] || null,
    'nf-fetch': async d => {
      const r = await fetch(d.url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    },
    // Netflix plante (erreur M7375) si on change video.currentTime directement.
    'nf-seek': d => { nfPlayer().seek(Math.round(d.time * 1000)); }
  };

  window.addEventListener('message', async e => {
    const m = e.data;
    if (e.source !== window || !m || m.sr !== 'req' || !actions[m.action]) return;
    try {
      window.postMessage({ sr: 'res', id: m.id, ok: true, data: await actions[m.action](m) }, '*');
    } catch (err) {
      window.postMessage({ sr: 'res', id: m.id, ok: false, error: String(err && err.message || err) }, '*');
    }
  });
})();
