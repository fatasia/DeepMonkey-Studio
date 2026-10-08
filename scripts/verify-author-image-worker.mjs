import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const require = createRequire(process.cwd() + '/apps/api/package.json');
const sharp = require('sharp');
const width = 4096, height = 2048, rgba = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const offset = (y * width + x) * 4;
  rgba[offset] = (x * 7 + y * 13) & 255; rgba[offset + 1] = (x ^ y) & 255;
  rgba[offset + 2] = (x * 3 + y * 5) & 255; rgba[offset + 3] = (x + y) % 3 ? 255 : 127;
}
const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
const { default: playwright } = await import('../apps/cloud-render-worker/node_modules/playwright-core/index.js');
const browser = await playwright.chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--disable-gpu'] });
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async ({ png }) => {
    const worker = (await import('/src/delivery/browserImageDecoder.ts')).browserImageDecoder;
    const pure = (await import('/src/delivery/inProcessImageDecoder.ts')).inProcessImageDecoder;
    const { capImageDimension } = await import('/src/delivery/textureBudget.ts');
    const data = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const encoded = { id: 'rgba-test', imageIndex: 0, mimeType: 'image/png', data };
    const sha = async image => [...new Uint8Array(await crypto.subtle.digest('SHA-256', image.data))].map(x => x.toString(16).padStart(2, '0')).join('');
    const baseline = await pure.decode(encoded);
    const baselineCapped = await capImageDimension(pure, 1024).decode(encoded);
    const tasks = []; const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ type: 'longtask', buffered: false });
    await new Promise(done => setTimeout(done, 50)); tasks.length = 0;
    let beats = 0; const interval = setInterval(() => beats++, 10);
    const begin = performance.now();
    const decoded = await worker.decode(encoded);
    const capped = await capImageDimension(worker, 1024).decode(encoded);
    const elapsed = performance.now() - begin;
    await new Promise(done => setTimeout(done, 50)); clearInterval(interval); observer.disconnect();
    return { dimensions: [decoded.width, decoded.height], cappedDimensions: [capped.width, capped.height],
      mainSha: await sha(baseline), workerSha: await sha(decoded), mainCapSha: await sha(baselineCapped), workerCapSha: await sha(capped),
      sourceBytes: data.byteLength, beats, elapsed, longTasks: tasks };
  }, { png: png.toString('base64') });
  await writeFile('test-output/studio-author-image-worker-browser.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.mainSha, result.workerSha); assert.equal(result.mainCapSha, result.workerCapSha);
  assert.deepEqual(result.cappedDimensions, [1024, 512]); assert.ok(result.sourceBytes > 0); assert.ok(result.beats >= 5);
  assert.deepEqual(result.longTasks, []);
} finally { await browser.close(); }
