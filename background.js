importScripts('lib/net.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  srHandle(msg).then(
    data => sendResponse({ ok: true, data }),
    err => sendResponse({ ok: false, error: String(err && err.message || err) })
  );
  return true; // réponse asynchrone
});
