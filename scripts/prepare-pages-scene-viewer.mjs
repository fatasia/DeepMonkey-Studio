import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
const JSZip = createRequire(new URL("../apps/web/package.json", import.meta.url))("jszip");

// Reuse a verified scene-viewer stage. Vite must build for this same Pages base.
const [stageArg, outputArg, base = "/DeepMonkey-Studio/browse/"] = process.argv.slice(2);
if (!stageArg || !outputArg || !/^\/[A-Za-z0-9_/-]+\/$/.test(base)) {
  throw Error("Usage: node scripts/prepare-pages-scene-viewer.mjs <stage frontend> <new output> [Pages base]");
}
const source = path.resolve(stageArg), output = path.resolve(outputArg);
if (output === source || output.startsWith(`${source}${path.sep}`)) throw Error("Output must be outside the stage");
await mkdir(output, { recursive: true });
const viewer = path.join(output, "browse");
await cp(source, viewer, { recursive: true, errorOnExist: true, force: false });
const manifestPath = path.join(viewer, "delivery/scene-viewer.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.kind !== "industrial-studio-scene-viewer") throw Error("Not a scene-viewer stage");
// Public examples are authored basic geometry; customer models must not enter Pages.
if (manifest.publication.snapshot.models.length || manifest.project.models.length) {
  throw Error("Pages example must contain authored primitives only");
}
const rebase = value => {
  if (typeof value === "string") return /^\/(?:delivery|brand)\//.test(value) ? `${base}${value.slice(1)}` : value;
  if (Array.isArray(value)) return value.map(rebase);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item)]));
  return value;
};
const rebased = rebase(manifest);
rebased.publication.name = "在线浏览样例";
rebased.publication.snapshot.name = "在线浏览样例";
rebased.project.name = "公开样例";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
rebased.publicationSha256 = hash(JSON.stringify(rebased.publication)).toUpperCase();
rebased.projectSha256 = hash(JSON.stringify(rebased.project)).toUpperCase();
for (const asset of rebased.assets) {
  if (!asset.localUrl.startsWith(base)) throw Error(`Asset outside static base: ${asset.localUrl}`);
  const bytes = await readFile(path.join(viewer, asset.localUrl.slice(base.length)));
  if (bytes.length !== asset.bytes || hash(bytes).toLowerCase() !== asset.sha256.toLowerCase()) throw Error("Frozen asset digest mismatch");
}
await writeFile(manifestPath, `${JSON.stringify(rebased, null, 2)}\n`);
let html = await readFile(path.join(viewer, "index.html"), "utf8");
if (!html.includes(`${base}assets/`)) throw Error(`Vite frontend was not built with --base=${base}`);
html = html.replace('content="/delivery/scene-viewer.json"', 'content="./delivery/scene-viewer.json"')
  .replace("</head>", '<meta name="scene-viewer-route" content="static"></head>');
await writeFile(path.join(viewer, "index.html"), html);
const zip = new JSZip(), files = [];
async function collect(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`, location = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(location, `${relative}/`);
    else if (entry.isFile()) { const bytes = await readFile(location); zip.file(relative, bytes); files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) }); }
    else throw Error("Static viewer contains a symlink or unsupported file");
  }
}
await collect(viewer);
const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
await writeFile(path.join(output, "deepmonkey-studio-browser.zip"), bytes);
await writeFile(path.join(output, "pages-viewer-evidence.json"), JSON.stringify({ base, source, packageId: manifest.packageId,
  sourcePublicationSha256: manifest.sourcePublicationSha256, zipBytes: bytes.length, zipSha256: hash(bytes), files }, null, 2));
console.log(JSON.stringify({ output, zipBytes: bytes.length, files: files.length, zipSha256: hash(bytes) }));
