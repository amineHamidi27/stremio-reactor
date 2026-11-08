const $ = id => document.getElementById(id);

for (const id of ['target', 'native']) {
  for (const [code, l] of Object.entries(SR_LANGS)) $(id).add(new Option(l.name, code));
}

chrome.storage.sync.get(SR_DEFAULTS, s => {
  for (const [k, v] of Object.entries(s)) {
    const input = $(k);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = v; else input.value = v;
    input.onchange = () => {
      const val = input.type === 'checkbox' ? input.checked
        : input.type === 'number' ? Math.max(14, Math.min(64, +input.value || SR_DEFAULTS[k])) : input.value;
      chrome.storage.sync.set({ [k]: val });
    };
  }
});

function renderWords(words) {
  $('count').textContent = words.length;
  const box = $('words');
  box.replaceChildren();
  if (!words.length) {
    box.innerHTML = '<p class="empty">Clique sur un mot dans les sous-titres pour le sauvegarder.</p>';
    return;
  }
  [...words].reverse().forEach(w => {
    const row = document.createElement('div');
    row.className = 'w';
    const info = document.createElement('div');
    const b = document.createElement('b'); b.textContent = w.word;
    const tr = document.createElement('span'); tr.className = 'tr'; tr.textContent = ' — ' + (w.translation || '');
    const ctx = document.createElement('div'); ctx.className = 'ctx'; ctx.textContent = w.sentence;
    info.append(b, tr, ctx);
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Supprimer';
    del.onclick = () => chrome.storage.local.set({ words: words.filter(x => x !== w) });
    row.append(info, del);
    box.append(row);
  });
}

chrome.storage.local.get({ words: [] }, ({ words }) => renderWords(words));
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.words) renderWords(ch.words.newValue || []);
});

// Format Anki : recto ; verso ; contexte (séparateur tabulation)
$('export').onclick = () => {
  chrome.storage.local.get({ words: [] }, ({ words }) => {
    const clean = s => (s || '').replace(/[\t\n]/g, ' ');
    const tsv = words.map(w => [w.word, w.translation, w.sentence, w.sentenceNative].map(clean).join('\t')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([tsv], { type: 'text/tab-separated-values' }));
    a.download = 'stremio-reactor-anki.txt';
    a.click();
  });
};

$('clear').onclick = () => {
  if (confirm('Supprimer tous les mots sauvegardés ?')) chrome.storage.local.set({ words: [] });
};
