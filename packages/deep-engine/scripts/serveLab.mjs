import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.DEEP_ENGINE_LAB_PORT ?? 5291);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid lab port.");
const files = new Map([["/", ["index.html", "text/html"]], ["/switch", ["switch.html", "text/html"]],
  ["/benchmark", ["benchmark.html", "text/html"]], ["/lab.js", ["lab.js", "text/javascript"]],
  ["/switch.js", ["switch.js", "text/javascript"]], ["/benchmark.js", ["benchmark.js", "text/javascript"]],
  ["/babylon-pairing", ["babylonPairing.html", "text/html"]],
  ["/babylonPairing.js", ["babylonPairing.js", "text/javascript"]],
  ["/lab.css", ["lab.css", "text/css"]], ["/switch.css", ["switch.css", "text/css"]],
  ["/benchmark.css", ["benchmark.css", "text/css"]], ["/tokens.css", ["tokens.css", "text/css"]],
  ["/manifest.json", ["manifest.json", "application/json"]]]);
for (const name of ["Box", "BoxInterleaved", "BoxTextured", "NormalTangentTest", "TextureEncodingTest", "TextureTransformMultiTest", "AlphaBlendModeTest"]) {
  files.set(`/assets/${name}.glb`, [`assets/${name}.glb`, "model/gltf-binary"]);
  files.set(`/assets/${name}.LICENSE.md`, [`assets/${name}.LICENSE.md`, "text/plain"]);
}
files.set("/assets/sources.json", ["assets/sources.json", "application/json"]);
const origin = `http://127.0.0.1:${port}`;
const localAssetDirectory = process.env.DEEP_ENGINE_BENCHMARK_ASSET_DIR;
const localAssets = new Map();
if (localAssetDirectory) {
  const catalog = JSON.parse(await readFile(path.join(localAssetDirectory, "sources.json"), "utf8"));
  for (const asset of catalog.assets) {
    if (!["LocalBim", "LocalPreheater"].includes(asset.name)) throw new Error("Unknown local benchmark asset.");
    const bytes = await readFile(path.join(localAssetDirectory, `${asset.name}.glb`));
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Local benchmark asset identity mismatch.");
    localAssets.set(`/assets/${asset.name}.glb`, { bytes, sourceSha256: asset.sourceSha256, sha256: asset.sha256, cameraFrame: asset.cameraFrame });
  }
}
const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(403).end(); return; }
    if (request.method === "POST" && request.url === "/report") {
      if (request.headers.origin !== origin) { response.writeHead(403).end(); return; }
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 512_000) { response.writeHead(413).end(); request.destroy(); return; }
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (data?.schema !== 1 || !Array.isArray(data.records) || !Array.isArray(data.errors)) { response.writeHead(400).end(); return; }
      const directory = path.resolve(root, "../../test-output/deep-engine");
      await mkdir(directory, { recursive: true });
      const file = `webgpu-${Date.now()}.json`;
      const manifest = JSON.parse(await readFile(path.join(root, "dist/lab/manifest.json"), "utf8"));
      if (data.buildSha256 !== manifest.sha256) { response.writeHead(409).end("Build changed; reload before verification."); return; }
      await writeFile(path.join(directory, file), JSON.stringify({ ...data, build: manifest }, null, 2), { flag: "wx" });
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ file })); return;
    }
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    const pathname = new URL(request.url ?? "/", origin).pathname;
    if (localAssets.has(pathname)) {
      // Same-origin Lab requests only; local private models are never added to a distributable build.
      if (request.headers["sec-fetch-site"] !== "same-origin") { response.writeHead(403).end(); return; }
      const asset = localAssets.get(pathname);
      response.writeHead(200, { "Content-Type": "model/gltf-binary", "X-Deep-Source-Sha256": asset.sourceSha256,
        "X-Deep-Asset-Sha256": asset.sha256, "X-Deep-Camera-Frame": JSON.stringify(asset.cameraFrame) }).end(asset.bytes); return;
    }
    if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    const file = files.get(pathname);
    if (!file) { response.writeHead(404).end(); return; }
    const content = await readFile(path.join(root, "dist/lab", file[0]));
    response.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` }).end(content);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (!response.headersSent) response.writeHead(500).end("Lab request failed."); else response.end();
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Deep Engine lab: ${origin} (isolated static fixture; no product API)`));
