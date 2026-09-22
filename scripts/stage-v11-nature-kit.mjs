import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { inspectGlbFile } from "./lib/glbAudit.mjs";

const root = path.resolve(import.meta.dirname, "..");
const extracted = path.join(root, "test-output/de26-v11-nature-review-20260918/extracted");
const auditPath = path.join(root, "test-output/de26-v11-nature-review-20260918/evidence.json");
const derivedPath = path.join(root, "test-output/de26-v11-nature-review-20260918/derived/fence_gate-grounded.glb");
const output = path.join(root, "apps/web/public/assets/nature-kit");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const audit = JSON.parse(await readFile(auditPath, "utf8"));
await mkdir(path.join(output, "models"), { recursive: true });
await mkdir(path.join(output, "thumbnails"), { recursive: true });
const entries = [];
for (const selected of audit.selected) {
  const source = path.join(extracted, selected.path);
  const modelName = path.basename(selected.path);
  const modelSource = modelName === "fence_gate.glb" ? derivedPath : source;
  const modelBytes = await readFile(modelSource);
  if (modelName !== "fence_gate.glb" && sha256(modelBytes) !== selected.sha256) throw new Error(`source hash mismatch: ${selected.path}`);
  const id = `kenney.nature-kit.${path.basename(modelName, ".glb")}`;
  await copyFile(modelSource, path.join(output, "models", `${id}.glb`));
  const thumbnails = [];
  for (const direction of ["NE", "NW", "SE", "SW"]) {
    const thumbnailSource = path.join(extracted, "Isometric", `${path.basename(modelName, ".glb")}_${direction}.png`);
    const thumbnailTarget = path.join(output, "thumbnails", `${id}_${direction}.png`);
    await copyFile(thumbnailSource, thumbnailTarget);
    thumbnails.push(`/assets/nature-kit/thumbnails/${id}_${direction}.png`);
  }
  const metrics = await inspectGlbFile(modelSource, modelBytes.length);
  entries.push({ id, category: selected.category, sourcePath: selected.path, sourceSha256: selected.sha256,
    contentHash: sha256(modelBytes), bytes: modelBytes.length, metrics,
    modelUrl: `/assets/nature-kit/models/${id}.glb`, thumbnails, groundedDerived: modelName === "fence_gate.glb" });
}
await copyFile(path.join(extracted, "License.txt"), path.join(output, "License.txt"));
const index = { schema: "deep-engine.v11-nature-kit-catalog", schemaVersion: 1, source: audit.source,
  archiveSha256: audit.archiveSha256, license: "CC0", selectedCount: entries.length, entries,
  admission: { geometry: "audited", units: "meters", groundedDerivedFenceGate: true, productDragDrop: "pending", saveRefreshReopen: "pending" } };
await writeFile(path.join(output, "catalog.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify({ output, selectedCount: entries.length, modelCount: entries.length, thumbnailCount: entries.length * 4 }));
