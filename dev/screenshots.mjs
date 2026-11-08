// Captures d'écran pour le README, via Chrome headless (protocole DevTools).
// Prérequis : python3 dev/server.py et l'addon (port 7070) lancés.
//   node dev/screenshots.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = new URL('../docs/', import.meta.url).pathname;
const PORT = 9333;
mkdirSync(OUT, { recursive: true });

const chrome = spawn('google-chrome', [
  '--headless=new', '--remote-debugging-port=' + PORT, '--window-size=1280,720',
  '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=' + join(tmpdir(), 'sr-shots-' + process.pid), 'about:blank'
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());
process.on('uncaughtException', e => { console.error(e); process.exit(1); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50 && !targets; i++) {
  await sleep(200);
  targets = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json()).catch(() => null);
}
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const cdp = (method, params = {}) => new Promise(r => {
  const id = ++seq;
  pending.set(id, r);
  ws.send(JSON.stringify({ id, method, params }));
});
const js = async expr => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const shot = async name => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + name, Buffer.from(r.result.data, 'base64'));
  console.log('docs/' + name);
};
const go = async url => { await cdp('Page.navigate', { url }); await sleep(4000); };

await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

// 1. Extension : double sous-titres + bulle d'un mot
await go('http://127.0.0.1:8765/dev/test.html?v=demo.mp4#/player/a/b/c/movie/tt0111161/tt0111161');
await js(`localStorage.clear(); (async () => {
  for (let i = 0; i < 120 && !/répliques/.test(document.querySelector('.sr-status').textContent); i++)
    await new Promise(r => setTimeout(r, 500));
  await new Promise(r => setTimeout(r, 1500)); // piste traduite
  const v = document.querySelector('video'); v.controls = false;
  v.currentTime = 134.5;
  await new Promise(r => v.addEventListener('seeked', r, { once: true })); await v.play();
  await new Promise(r => setTimeout(r, 1500)); v.pause();
})()`);
await sleep(7000);
await js(`[...document.querySelectorAll('.sr-w')].find(w => w.textContent === 'grant').click()`);
await sleep(7000);
await shot('extension-mot.png');

// 2. Extension : panneau transcript
await js(`document.querySelector('.sr-pop').hidden = true;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }))`);
await sleep(800);
await shot('extension-panneau.png');

// 3. Page d'installation de l'addon
await go('http://127.0.0.1:7070/');
await shot('addon-installation.png');

ws.close();
chrome.kill();
