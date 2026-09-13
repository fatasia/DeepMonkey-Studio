import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.DEEP_ENGINE_LAB_PORT ?? 5291);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid lab port.");
const files = new Map([["/", ["index.html", "text/html"]], ["/switch", ["switch.html", "text/html"]],
  ["/benchmark", ["benchmark.html", "text/html"]], ["/lab.js", ["lab.js", "text/javascript"]],
  ["/switch.js", ["switch.js", "text/javascript"]], ["/benchmark.js", ["benchmark.js", "text/javascript"]],
  ["/lab.css", ["lab.css", "text/css"]], ["/switch.css", ["switch.css", "text/css"]],
  ["/benchmark.css", ["benchmark.css", "text/css"]], ["/tokens.css", ["tokens.css", "text/css"]],
  ["/manifest.json", ["manifest.json", "application/json"]]]);
for (const name of ["Box", "BoxInterleaved", "BoxTextured", "NormalTangentTest", "TextureEncodingTest", "AlphaBlendModeTest"]) {
  files.set(`/assets/${name}.glb`, [`assets/${name}.glb`, "model/gltf-binary"]);
  files.set(`/assets/${name}.LICENSE.md`, [`assets/${name}.LICENSE.md`, "text/plain"]);
}
files.set("/assets/sources.json", ["assets/sources.json", "application/json"]);
const origin = `http://127.0.0.1:${port}`;
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
    if (request.url === "/favicon.ico") { response.writeHead(204).end(); return; }
    const file = files.get(request.url);
    if (!file) { response.writeHead(404).end(); return; }
    const content = await readFile(path.join(root, "dist/lab", file[0]));
    response.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` }).end(content);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (!response.headersSent) response.writeHead(500).end("Lab request failed."); else response.end();
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Deep Engine lab: ${origin} (isolated static fixture; no product API)`));
