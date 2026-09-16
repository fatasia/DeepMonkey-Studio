import { createServer } from "node:http";
import { build } from "esbuild";

// Run: pnpm --filter @bim-studio/deep-engine exec node scripts/authorBloomGpuServer.mjs
// Open the printed localhost URL with the approved browser tool. The page prints adapter, tolerances and results.
// Standalone probe page; no product server, browser launch, installation or output bundle is required.
const result = await build({ entryPoints: [new URL("../lab/authorBloomGpuMain.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  bundle: true, format: "esm", platform: "browser", conditions: ["development"], write: false });
const script = result.outputFiles[0].contents;
const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Author Bloom GPU probe</title><script type="module" src="/bundle.js"></script>');
  } else if (request.url === "/bundle.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(script);
  } else { response.writeHead(404); response.end(); }
});
server.listen(0, "127.0.0.1", () => console.log(`Author Bloom GPU probe: http://127.0.0.1:${server.address().port}/`));
