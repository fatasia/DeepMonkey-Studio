import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "../../test-output/studio-engine-lod-switch-20261007");
await mkdir(output, { recursive: true });
const bundle = path.join(output, "cluster-probe.mjs");
await build({ absWorkingDir: root, entryPoints: ["lab/packetClusterLodPbrProbe.ts"], bundle: true,
  format: "esm", target: "es2022", outfile: bundle, logLevel: "silent" });
const bundleSha256 = createHash("sha256").update(await readFile(bundle)).digest("hex");
const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/result") {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    result.provenance = { bundleSha256, validatedAt: new Date().toISOString() };
    await writeFile(path.join(output, "cluster-pbr-gpu-result.json"), JSON.stringify(result, null, 2));
    response.writeHead(200).end("saved"); console.log(JSON.stringify({ success: result.success, bundleSha256 })); return;
  }
  if (request.url === "/probe.mjs") { response.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(bundle)); return; }
  response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><title>Cluster PBR production probe</title><h1>Cluster PBR production probe</h1><button id="run">Run production validation</button><div id="canvases"></div><pre id="result">Ready</pre><script type="module" src="/probe.mjs"></script>');
});
server.listen(5198, "127.0.0.1", () => console.log("Cluster probe ready: http://127.0.0.1:5198"));
