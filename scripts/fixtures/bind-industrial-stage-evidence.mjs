import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const matrixPath = path.join(root, "docs/specs/industrial-s1-s6-acceptance-matrix-2026-09-18.json");
const outputDir = path.resolve(process.argv[2] ?? "test-output/industrial-s1-s6-evidence-binding-20260919");

const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
const references = [...new Set(matrix.stages.flatMap((stage) => stage.evidence))].sort();
const bindings = [];
for (const relative of references) {
  if (!relative.startsWith("docs/") || relative.includes("..")) throw new Error(`invalid evidence path: ${relative}`);
  const absolute = path.resolve(root, relative);
  const bytes = await readFile(absolute);
  const info = await stat(absolute);
  bindings.push({ path: relative, bytes: info.size, sha256: createHash("sha256").update(bytes).digest("hex") });
}

const evidence = {
  schemaVersion: 1,
  generatedAt: "2026-09-19",
  authority: "docs/specs/industrial-3d-format-work-plan-2026-09-16.md",
  matrix: "docs/specs/industrial-s1-s6-acceptance-matrix-2026-09-18.json",
  stageCount: matrix.stages.length,
  referencedEvidenceCount: bindings.length,
  bindings,
  note: "This binds the current S1–S6 matrix references to exact in-tree report bytes; it does not upgrade any stage or profile quality.",
};
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ output: path.relative(root, path.join(outputDir, "evidence.json")), stageCount: evidence.stageCount, referencedEvidenceCount: evidence.referencedEvidenceCount }, null, 2));
