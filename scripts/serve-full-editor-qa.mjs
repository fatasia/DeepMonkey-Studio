import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, extname, join } from 'node:path';
const root = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 44101);
const metadata = JSON.parse(await readFile(join(root, 'editor-hosting.json'), 'utf8'));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith(metadata.base)) { response.writeHead(404).end(); return; }
    const path = resolve(root, decodeURIComponent(url.pathname.slice(metadata.base.length)) || 'index.html');
    if (relative(root, path).startsWith('..')) { response.writeHead(404).end(); return; }
    const body = await readFile(path).catch(async () => {
      if (!extname(path) && request.headers.accept?.includes('text/html')) return readFile(join(root, '404.html'));
      throw new Error('missing');
    });
    response.writeHead(200, { 'Content-Type': types[extname(path)] ?? (!extname(path) ? 'text/html; charset=utf-8' : 'application/octet-stream'), 'Cache-Control': 'no-store' }).end(body);
  } catch { response.writeHead(404).end(); }
}).listen(port, '127.0.0.1', () => console.log(`Full editor QA: http://localhost:${port}${metadata.base} → ${metadata.apiOrigin}`));
