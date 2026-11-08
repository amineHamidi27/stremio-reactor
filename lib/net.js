// Requêtes réseau, exécutées dans le service worker (pas de souci de CORS).
async function srFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r;
}

async function srTranslate(text, sl, tl) {
  try {
    const url = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex' +
      '&sl=' + sl + '&tl=' + tl + '&q=' + encodeURIComponent(text);
    const j = await (await srFetch(url)).json();
    let v = Array.isArray(j) ? j[0] : null;
    if (Array.isArray(v)) v = v[0];
    if (typeof v === 'string' && v) return v;
    throw new Error('réponse inattendue');
  } catch (e) {
    const url = 'https://api.mymemory.translated.net/get?langpair=' + sl + '|' + tl +
      '&q=' + encodeURIComponent(text);
    const j = await (await srFetch(url)).json();
    return j.responseData.translatedText;
  }
}

async function srHandle(msg) {
  switch (msg.type) {
    case 'json': return (await srFetch(msg.url)).json();
    case 'text': return (await srFetch(msg.url)).text();
    case 'translate': return srTranslate(msg.text, msg.sl, msg.tl);
    default: throw new Error('message inconnu : ' + msg.type);
  }
}
