import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const script = new URL("./prepare-pages-scene-viewer.mjs", import.meta.url);
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "studio-pages-qa-"));
  const source = path.join(root, "stage"), output = path.join(root, "output");
  const bytes = Buffer.from("a frozen logo");
  await mkdir(path.join(source, "delivery/assets"), { recursive: true });
  await writeFile(path.join(source, "delivery/assets/logo.svg"), bytes);
  const manifest = { kind: "industrial-studio-scene-viewer", packageId: "fixture", sourcePublicationSha256: "original",
    publication: { snapshot: { models: [], primitives: [{ kind: "box" }] } }, project: { models: [] },
    branding: { logoUrl: "/delivery/assets/logo.svg" }, assets: [{ localUrl: "/delivery/assets/logo.svg", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }] };
  await writeFile(path.join(source, "index.html"), '<head><meta name="scene-viewer-delivery" content="/delivery/scene-viewer.json"><script src="/DeepMonkey-Studio/browse/assets/main.js"></script></head>');
  await writeFile(path.join(source, "delivery/scene-viewer.json"), JSON.stringify(manifest));
  try { await run({ source, output, manifest, execute: () => execFileSync(process.execPath, [fileURLToPath(script), source, output], { encoding: "utf8", stdio: "pipe" }) }); }
  finally { assert.ok(root.startsWith(path.join(tmpdir(), "studio-pages-qa-"))); await rm(root, { recursive: true, force: true }); }
}

test("packages a public primitive example under the project Pages base with frozen digests", () => fixture(async ({ output, execute }) => {
  execute();
  const manifest = JSON.parse(await readFile(path.join(output, "browse/delivery/scene-viewer.json"), "utf8"));
  assert.equal(manifest.branding.logoUrl, "/DeepMonkey-Studio/browse/delivery/assets/logo.svg");
  assert.equal(manifest.sourcePublicationSha256, "original");
  assert.equal(manifest.publication.name, "在线浏览样例");
  assert.equal(manifest.publication.snapshot.name, "在线浏览样例");
  assert.equal(manifest.project.name, "公开样例");
  assert.equal(manifest.projectSha256, createHash("sha256").update(JSON.stringify(manifest.project)).digest("hex").toUpperCase());
  const html = await readFile(path.join(output, "browse/index.html"), "utf8");
  assert.match(html, /scene-viewer-route" content="static"/);
  assert.match(html, /content="\.\/delivery\/scene-viewer\.json"/);
  assert.ok((await readFile(path.join(output, "deepmonkey-studio-browser.zip"))).length > 0);
}));

test("rejects customer model references in a public example", () => fixture(async ({ source, manifest, execute }) => {
  manifest.project.models.push({ sourceUrl: "/customer/model.glb" });
  await writeFile(path.join(source, "delivery/scene-viewer.json"), JSON.stringify(manifest));
  assert.throws(execute, /authored primitives only/);
}));

test("rejects changed frozen bytes", () => fixture(async ({ source, execute }) => {
  await writeFile(path.join(source, "delivery/assets/logo.svg"), "tampered");
  assert.throws(execute, /digest mismatch/);
}));

test("rejects root-based Vite output instead of publishing broken relative URLs", () => fixture(async ({ source, execute }) => {
  await writeFile(path.join(source, "index.html"), '<head><script src="/assets/main.js"></script></head>');
  assert.throws(execute, /Vite frontend was not built/);
}));
