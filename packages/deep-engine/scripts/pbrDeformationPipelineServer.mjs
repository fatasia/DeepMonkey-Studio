import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Run from packages/deep-engine: node scripts/pbrDeformationPipelineServer.mjs
// Open the printed URL with the approved browser tool; the visible page contains all evidence.
const result = await build({ entryPoints: [fileURLToPath(new URL("../lab/pbrDeformationPipelineProbe.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "browser", conditions: ["development"], write: false });
const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Deformation pipeline GPU probe</title><pre id="result">Running…</pre>
      <script type="module">
      import { runPbrDeformationPipelineProbe } from '/bundle.js';
      const output = document.getElementById('result');
      runPbrDeformationPipelineProbe().then(result => {
        output.textContent = JSON.stringify(result, null, 2);
        document.title = result.success ? 'Deformation GPU PASS' : 'Deformation GPU FAIL';
      }).catch(error => { output.textContent = String(error.stack || error); document.title = 'Deformation GPU ERROR'; });
      </script>`);
  } else if (request.url === "/bundle.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(result.outputFiles[0].contents);
  } else { response.writeHead(404); response.end(); }
});
server.listen(0, "127.0.0.1", () => console.log(`Deformation GPU probe: http://127.0.0.1:${server.address().port}/`));
