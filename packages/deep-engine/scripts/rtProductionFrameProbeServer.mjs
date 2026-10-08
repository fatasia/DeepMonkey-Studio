import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "../../test-output/rt-production-1080p-20261007");
await mkdir(output, { recursive: true });
const bundle = path.join(output, "probe.mjs");
await build({ absWorkingDir: root, entryPoints: ["lab/rtProductionFrameProbe.ts"], bundle: true,
  format: "esm", target: "es2022", outfile: bundle, logLevel: "silent" });
const identity = Object.fromEntries(await Promise.all([
  "lab/rtProductionFrameProbe.ts", "src/webgpu/pbrRtReflectionsFrame.ts",
  "src/webgpu/pbrRenderer.ts", "src/webgpu/pbrRendererFrames.ts", "src/webgpu/rtShadowFrame.ts",
  "src/rayTracing/shadowRayFramePass.ts",
  "src/rayTracing/rayTraceClosestFramePass.ts", "src/rayTracing/rayTraceClosestFrameKernel.ts",
  "src/rayTracing/rtSpecularFramePasses.ts", "src/rayTracing/rtSpecularIndirectionKernel.ts",
].map(async name => [name, createHash("sha256").update(await readFile(path.join(root, name))).digest("hex")])));
createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/result") {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const result = { ...JSON.parse(Buffer.concat(chunks).toString()), identity };
    await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    response.writeHead(200).end("saved"); console.log(JSON.stringify(result)); return;
  }
  if (request.url === "/probe.mjs") { response.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(bundle)); return; }
  response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><title>Production RT 1080p probe</title><button id="run">Run production RT validation</button><div id="canvases"></div><pre id="result">Ready</pre><script type="module" src="/probe.mjs"></script>');
}).listen(5197, "127.0.0.1", () => console.log("Production RT ready: http://127.0.0.1:5197"));
