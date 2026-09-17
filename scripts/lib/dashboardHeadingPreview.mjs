import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

/** Local visual verification of the same bundled production capture page. */
export async function serveDashboardHeadingPreview(directory, request, port) {
  const script = await readFile(new URL("layout-capture.js", directory));
  const css = await readFile(new URL("layout-capture.css", directory));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/capture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(script); return; }
    if (url.pathname === "/capture.css") { res.setHeader("Content-Type", "text/css"); res.end(css); return; }
    if (url.pathname !== "/") { res.writeHead(404).end(); return; }
    const width = url.searchParams.get("width") === "320" ? 320 : 480;
    const theme = url.searchParams.get("theme") === "light" ? "light" : "dark";
    const payload = JSON.stringify({ ...request, width }).replaceAll("<", "\\u003c");
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html data-theme="${theme}"><title>Frozen chart heading</title>
      <link rel="stylesheet" href="/capture.css"><body><div id="root"></div><output id="capture-status">Measuring</output>
      <script>globalThis.__DASHBOARD_LAYOUT_REQUEST__=${payload};</script><script type="module" src="/capture.js"></script>
      <script>const timer=setInterval(()=>{if(!globalThis.captureDashboardHeading)return;try {
        const captured=globalThis.captureDashboardHeading();document.getElementById('capture-status').textContent=
        'Measured '+captured.layout.textBoxes.length+' frozen heading roles';clearInterval(timer);
      }catch(error){document.getElementById('capture-status').textContent=String(error);}},100);</script></body></html>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  console.log(`Heading visual preview: http://127.0.0.1:${server.address().port}`);
  return server;
}
