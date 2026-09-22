import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import playwright from '../apps/cloud-render-worker/node_modules/playwright-core/index.js';

const frontend = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const useSourceStyle = process.argv.includes('--source-style');
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(frontend, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(frontend + path.sep)) throw new Error('Invalid path');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' })[path.extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await playwright.chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const cases = [];
try {
  for (const round of [1, 2]) for (const dpr of [1, 1.25, 2]) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 900 }, deviceScaleFactor: dpr });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText(/场景已就绪/).waitFor();
    if (useSourceStyle) await page.addStyleTag({ content: await readFile('apps/web/src/delivery/scene-viewer-delivery.css', 'utf8') });
    for (const width of [1920, 980, 480, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      const dimensions = await page.locator('.scene-viewer-viewport').evaluate(element => {
        const canvas = element.querySelector('canvas');
        const viewport = element.getBoundingClientRect(), bounds = canvas.getBoundingClientRect();
        return { viewport: [viewport.width, viewport.height], canvas: [bounds.width, bounds.height],
          buffer: [canvas.width, canvas.height] };
      });
      cases.push({ round, dpr, width, ...dimensions });
      await page.screenshot({ path: path.join(output, `r${round}-dpr${dpr}-${width}.png`) });
      assert.deepEqual(dimensions.canvas, dimensions.viewport, `Canvas exceeds viewport at DPR ${dpr}, width ${width}`);
      assert.deepEqual(errors, []);
    }
    await page.close();
  }
  console.log(JSON.stringify({ passed: cases.length, output, useSourceStyle }));
} finally {
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ useSourceStyle, cases }, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
