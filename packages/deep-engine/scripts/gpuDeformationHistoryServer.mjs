import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Run: pnpm --filter @bim-studio/deep-engine exec node scripts/gpuDeformationHistoryServer.mjs
// Open the printed localhost URL with the approved browser tool; no product server or browser launch.
const result = await build({ entryPoints: [fileURLToPath(new URL("../lab/gpuDeformationHistoryMain.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "browser", conditions: ["development"], write: false });
const script = result.outputFiles[0].contents;
const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>GPU History probe</title><script type="module" src="/bundle.js"></script>');
  } else if (request.url === "/bundle.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(script);
  } else { response.writeHead(404); response.end(); }
});
server.listen(0, "127.0.0.1", () => console.log(`GPU deformation history probe: http://127.0.0.1:${server.address().port}/`));
