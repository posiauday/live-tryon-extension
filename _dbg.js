const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const root = process.cwd();
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
});
srv.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tryon-ext-'));
  for (const d of ['background', 'content', 'camera', 'src']) fs.cpSync(path.join(root, d), path.join(tmp, d), { recursive: true });
  fs.cpSync(path.join(root, 'vendor'), path.join(tmp, 'vendor'), { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); m.host_permissions.push('http://127.0.0.1/*'); fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(m));
  const c = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${tmp}`, `--load-extension=${tmp}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  let [w] = c.serviceWorkers(); if (!w) w = await c.waitForEvent('serviceworker');
  const p = await c.newPage();
  p.on('console', (m) => console.log('PAGE:', m.text().slice(0, 200)));
  await p.goto(base + '/tests/fixtures/shop.html');
  await w.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' }); await togglePanel(t); });
  await p.waitForTimeout(3500);
  const frame = p.frames().find((f) => f.url().startsWith('chrome-extension://'));
  console.log('frame', frame && frame.url());
  await frame.evaluate(() => { ['dragenter', 'dragover', 'drop'].forEach((t) => document.addEventListener(t, (e) => console.log('IFRAME EVT', t, Array.from(e.dataTransfer.types).join('|')), true)); });
  const a = await p.locator('#product').boundingBox(); const b = await frame.locator('.video-wrap').boundingBox();
  console.log('boxes', JSON.stringify(a), JSON.stringify(b));
  await p.mouse.move(a.x + 60, a.y + 60); await p.mouse.down(); await p.mouse.move(a.x + 80, a.y + 80, { steps: 4 });
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 }); await p.mouse.up();
  await p.waitForTimeout(2000);
  console.log('toast:', await frame.evaluate(() => document.getElementById('toast').textContent), '| hidden:', await frame.evaluate(() => document.getElementById('toast').hidden));
  await c.close(); srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
});
