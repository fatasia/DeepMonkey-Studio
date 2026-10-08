import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "../../test-output/scene-transmission-20261007");
await mkdir(output, { recursive: true });
const bundle = path.join(output, "probe.mjs");
await build({ absWorkingDir: root, entryPoints: ["lab/sceneTransmissionGpuProbe.ts"], bundle: true,
  format: "esm", target: "es2022", outfile: bundle, logLevel: "silent" });
const names = ["lab/sceneTransmissionGpuProbe.ts", "src/webgpu/pbrSceneTransmissionWgsl.ts",
  "src/shader/materialAdvancedWgsl.ts", "src/webgpu/pbrAdvancedMaterialShader.ts", "src/webgpu/pbrRendererFrames.ts",
  "src/webgpu/pbrMainBindings.ts", "src/webgpu/pipelines.ts", "src/webgpu/packetDraw.ts"];
const identity = Object.fromEntries(await Promise.all(names.map(async name => [name,
  createHash("sha256").update(await readFile(path.join(root, name))).digest("hex")])));
createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/result") {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const result = { ...JSON.parse(Buffer.concat(chunks).toString()), identity };
    await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    response.writeHead(200).end("saved"); console.log(JSON.stringify(result)); return;
  }
  if (request.url === "/probe.mjs") { response.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(bundle)); return; }
  response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><title>Production scene transmission</title><button id="run">Run scene transmission GPU validation</button><div id="canvases"></div><pre id="result">Ready</pre><script type="module" src="/probe.mjs"></script>');
}).listen(5198, "127.0.0.1", () => console.log("Scene transmission ready: http://127.0.0.1:5198"));
