import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "../../test-output/specular-material-20261007");
await mkdir(output, { recursive: true });
const bundle = path.join(output, "probe.mjs");
await build({ absWorkingDir: root, entryPoints: ["lab/specularMaterialGpuProbe.ts"], bundle: true,
  format: "esm", target: "es2022", outfile: bundle, logLevel: "silent" });
const names = ["lab/specularMaterialGpuProbe.ts", "src/shader/materialSpecularWgsl.ts", "src/shader/materialAdvancedWgsl.ts",
  "src/webgpu/materialBindings.ts", "src/webgpu/pbrAdvancedMaterialShader.ts", "src/webgpu/pipelines.ts", "src/webgpu/deviceSession.ts",
  "src/webgpu/pbrReflectionArray.ts", "src/webgpu/pbrMainBindings.ts", "src/webgpu/studioEnvironment.ts",
  "src/webgpu/hdrEnvironment.ts", "src/webgpu/prefilteredEnvironment.ts", "src/webgpu/reflectionProbeSpecularEnvironment.ts",
  "src/webgpu/deformationDrawBindings.ts", "src/renderPacket.ts"];
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
  response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><title>Production specular material</title><button id="run">Run specular material GPU validation</button><div id="canvases"></div><pre id="result">Ready</pre><script type="module" src="/probe.mjs"></script>');
}).listen(5199, "127.0.0.1", () => console.log("Specular material ready: http://127.0.0.1:5199"));
