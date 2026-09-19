import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const pairedPath = path.join(root, "docs/specs/de26-a04-a08-paired-runtime-2026-09-18.md");
const closurePath = path.join(root, "docs/specs/deep-engine-mainline-closure-recheck-2026-09-18.md");
const outDir = path.join(root, "test-output/d24-d28-post-acceptance-20260919");

const paired = await fs.readFile(pairedPath, "utf8");
const closure = await fs.readFile(closurePath, "utf8");
const referenced = [...paired.matchAll(/`(test-output\/[^`]+\.json)`/g)].map((m) => m[1]);
const files = referenced.map((relative) => ({ relative, exists: true }));
for (const file of files) {
  try { await fs.access(path.join(root, file.relative)); } catch { file.exists = false; }
}
const rows = [...paired.matchAll(/^\| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
  .filter((m) => !m[1].includes("资产") && !m[1].includes("---"))
  .map((m) => ({ asset: m[1].trim(), cpu: m[2].trim(), gpu: m[3].trim(), similarity: m[4].trim(), gate: m[5].trim() }));
const report = {
  schema: "deep-engine.d24-d28-post-acceptance-evidence.v1",
  generatedAt: new Date().toISOString(),
  scope: "D24-D28 project post-acceptance",
  sourceDocuments: ["docs/specs/de26-a04-a08-paired-runtime-2026-09-18.md", "docs/specs/deep-engine-mainline-closure-recheck-2026-09-18.md"],
  referencedEvidence: files,
  pairedAssetRows: rows,
  checks: {
    pairedEvidenceReferencesPresent: files.length > 0 && files.every((file) => file.exists),
    hasIndependentNativeOpponentEvidence: /independent.*Native|Native.*逐对手/i.test(closure),
    hasLongStabilityEvidence: files.some(({ relative }) => /soak|stability|long-run|fault/i.test(relative)),
    hasFullChannelEvidence: files.some(({ relative }) => /full-channel|input-latency|present|rss/i.test(relative)),
  },
  verdict: "partial",
  explicitGap: "A04/A08 references are present and reproducible, but D24-D28 still lack independent multi-asset, Native opponent, long-stability/fault, and full-channel evidence.",
};
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`);
const boundRelative = path.join(root, "test-output/d24-d28-evidence-20260919/evidence.json");
let bound = null;
try {
  bound = JSON.parse(await fs.readFile(boundRelative, "utf8"));
} catch {
  bound = null;
}
console.log(JSON.stringify({
  verdict: report.verdict,
  referenced: files.length,
  rows: rows.length,
  checks: report.checks,
  boundEvidence: bound?.schema === "deep-engine.d24-d28-project-post-acceptance.v2"
    ? { verdict: bound.verdict, checks: bound.checks, cards: bound.postAcceptanceCards.map((card) => ({ id: card.id, status: card.status })) }
    : "run scripts/fixtures/run-d24-d28-evidence.mjs to bind runtime evidence",
}, null, 2));
