import { createServer } from "node:http";
import { build } from "esbuild";

// Run: node scripts/instanceOutlineProbeServer.mjs  (prints the localhost URL; ?mode=deep|three&outline=0|1&strength=2.5)
// Standalone probe page bundling lab/instanceOutlineProbe.ts against the in-repo sources.
const entry = new URL("../lab/instanceOutlineProbe.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const result = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "browser", conditions: ["development"], write: false });
const script = result.outputFiles[0].contents;
const server = createServer((request, response) => {
  if (request.url?.startsWith("/bundle.js")) { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(script); }
  else if (request.url === "/" || request.url?.startsWith("/?")) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Instance outline probe</title><script type="module" src="/bundle.js"></script>');
  } else { response.writeHead(404); response.end(); }
});
server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log(`Instance outline probe: http://127.0.0.1:${server.address().port}/`));
