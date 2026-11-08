// Langues proposées : code ISO 639-1 (traduction) -> codes utilisés par OpenSubtitles (ISO 639-2)
var SR_LANGS = {
  en: { name: 'Anglais', subs: ['eng'] },
  fr: { name: 'Français', subs: ['fre', 'fra'] },
  es: { name: 'Espagnol', subs: ['spa', 'spn', 'ea'] },
  de: { name: 'Allemand', subs: ['ger', 'deu'] },
  it: { name: 'Italien', subs: ['ita'] },
  pt: { name: 'Portugais', subs: ['por', 'pob'] },
  ar: { name: 'Arabe', subs: ['ara'] },
  ru: { name: 'Russe', subs: ['rus'] },
  tr: { name: 'Turc', subs: ['tur'] },
  nl: { name: 'Néerlandais', subs: ['dut', 'nld'] },
  pl: { name: 'Polonais', subs: ['pol'] },
  ja: { name: 'Japonais', subs: ['jpn'] },
  ko: { name: 'Coréen', subs: ['kor'] },
  zh: { name: 'Chinois', subs: ['chi', 'zho', 'zht', 'ze'] }
};

var SR_DEFAULTS = {
  target: 'en',      // langue apprise
  native: 'fr',      // langue maternelle
  autoPause: false,
  hoverPause: true,
  showNative: true,
  blurNative: false,
  fontSize: 30
};

// Utilisable aussi par l'addon Node
if (typeof module !== 'undefined') module.exports = { SR_LANGS, SR_DEFAULTS };
