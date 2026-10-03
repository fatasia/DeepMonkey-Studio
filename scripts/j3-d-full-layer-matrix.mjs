// J3-D-full 逐层双端对拍 CPU 骨架 runner(本刀不执行任何 GPU/Cargo)。
// 模式: 默认=打印层×双端×场景格计划与主线程 GPU 命令清单(不执行);
//       --prepare=逐层核验既有 evidence 新鲜度,过期/不可读/身份不符即失效删除(对齐 j3-texture 模式);
//       --compare=仅聚合历史 receipt,currentRun=false,绝不宣称 fresh。
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { hash, aggregateLayerMatrix } from "./lib/j3DFullLayerMatrix.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const flags = new Set(process.argv.slice(2));
if (flags.size > 1 || [...flags].some(flag => !["--prepare", "--compare", "--verify-fresh"].includes(flag)))
  throw Error("Choose default (plan), --prepare, --compare or --verify-fresh; GPU execution belongs to the main thread runners");
const out = path.join(root, "test-output/interrupted-0930/j3-d-full-layer-matrix");
await mkdir(out, { recursive: true });
const { build } = require("../packages/deep-engine/node_modules/esbuild");
const bundle = path.join(out, "catalog.mjs");
await build({ absWorkingDir: root, entryPoints: ["packages/deep-engine/lab/j3DFullLayerMatrix.ts"],
  outfile: bundle, bundle: true, format: "esm", platform: "node", metafile: true,
  conditions: ["development"], logLevel: "silent" });
const catalog = await import(pathToFileURL(bundle));
const layers = catalog.J3_D_FULL_LAYERS;
const fixtureText = new Map(await Promise.all(layers.filter(layer => layer.fixtureFile).map(async layer =>
  [layer.id, await readFile(path.join(root, layer.fixtureFile), "utf8")])));
const fixtureData = new Map([...fixtureText].map(([id, text]) => [id, JSON.parse(text)]));
fixtureData.set("texture-coverage", { ...fixtureData.get("texture-coverage"), cameras: fixtureData.get("normal").cameras });
const identityOf = layer => {
  if (!layer.fixtureFile) return undefined;
  const text = fixtureText.get(layer.id);
  // geometry/hdr manifest 以其声明的 packageHash 为源身份;bloom/fog 以 fixture 文件字节哈希为准。
  return layer.freshnessKey === "packageHash" ? JSON.parse(text).packageHash : hash(text);
};
const cellsOf = layer => catalog.expandSceneCells(layer, fixtureData.get(layer.id)
  ?? { cameras: [], cases: [], profiles: [], nativeOnly: [], colors: [] });
const evidencePath = layer => path.join(root, layer.evidenceDir, "evidence.json");
const loadEvidence = async layer => JSON.parse(await readFile(evidencePath(layer), "utf8"));
const sourceHashes = new Map();
const sourcesOf = async (_layer, evidence) => {
  const sources = evidence.sourceIdentity?.sources ?? evidence.sourceIdentity;
  if (!sources) return undefined;
  return Object.fromEntries(await Promise.all(Object.keys(sources).map(async file => {
    const target = path.resolve(root, file);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw Error(`Source outside repository: ${file}`);
    if (!sourceHashes.has(file)) sourceHashes.set(file, readFile(target).then(hash, () => null));
    return [file, await sourceHashes.get(file)];
  })));
};
const { validateLayerEvidence } = await import("./lib/j3DFullLayerMatrix.mjs");

/** 主线程 GPU 命令清单(顺序即建议执行序;全部命令已验收、root 串行、禁止 --compare/--web-only 替代 strict)。 */
const GPU_COMMANDS = [
  { layers: ["texture-coverage"], command: "node scripts/j3-texture-coverage-parity.mjs" },
  { layers: ["geometry-coverage", "main-depth"], command: "node scripts/j3-geometry-depth-parity.mjs" },
  { layers: ["hdr-color"], command: "node scripts/j3-geometry-depth-parity.mjs --hdr" },
  { layers: ["normal", "shadow-visibility"], command: "node scripts/j3-shadow-visibility-parity.mjs" },
  { layers: ["post-bloom"], command: "node scripts/j3-bloom-texture-parity.mjs" },
  { layers: ["post-fog"], command: "node scripts/j3-fog-profile-parity.mjs" },
  { layers: ["post-fog"], command: "node scripts/j3-web-author-fog-modes.mjs (Web-only 作者 linear/volume 补充)" },
  { layers: ["display"], command: "node scripts/j3-display-parity.mjs" },
  { layers: ["all"], command: "node scripts/j3-d-full-layer-matrix.mjs --compare (聚合,非 GPU)" },
];

if (flags.has("--prepare")) {
  const report = [];
  for (const layer of layers) {
    const file = evidencePath(layer);
    let status = "missing", detail = "no evidence.json yet; GPU runner will create it";
    if (existsSync(file)) {
      try {
        const evidence = JSON.parse(await readFile(file, "utf8"));
        try {
          const expectedSources = await sourcesOf(layer, evidence);
          validateLayerEvidence(layer, evidence, { expectedIdentity: identityOf(layer), expectedSources, freshRequired: false });
          status = evidence.currentRun === true && expectedSources ? "fresh-source-verified" : "historical-retained";
          detail = `scope ok, currentRun=${evidence.currentRun}`;
        } catch (error) {
          status = String(error.message).startsWith("stale ") || String(error.message).includes("wrong-layer")
            || String(error.message).includes("identity") ? "invalidated-stale-input" : "invalidated-unreadable";
          detail = String(error.message);
          await rm(file, { force: true });
        }
      } catch (error) {
        status = "invalidated-unreadable"; detail = String(error.message); await rm(file, { force: true });
      }
    }
    report.push({ layerId: layer.id, status, detail });
  }
  const payload = { schema: catalog.J3_D_FULL_SCHEMA, preparedAt: new Date().toISOString(), report };
  await writeFile(path.join(out, "prepare-report.json"), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} else if (flags.has("--compare") || flags.has("--verify-fresh")) {
  // A failed audit must not leave the preceding successful aggregate visible.
  await rm(path.join(out, "evidence.json"), { force: true });
  const fresh = flags.has("--verify-fresh");
  const joined = await aggregateLayerMatrix({ layers, loadEvidence, identityOf, sourcesOf, cellsOf, compare: !fresh });
  const evidence = { ...joined, currentRun: false, freshnessVerified: fresh,
    execution: fresh ? "current production source verified against fresh producer receipts; aggregation executes no host" : joined.execution };
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed: evidence.passed, currentRun: evidence.currentRun,
    freshnessVerified: evidence.freshnessVerified, gridRows: evidence.grid.length, freshnessNotes: evidence.freshnessNotes }, null, 2));
} else {
  const plan = { schema: catalog.J3_D_FULL_SCHEMA, mode: "cpu-plan-only; GPU deferred to main thread",
    gates: catalog.J3_D_FULL_GATES,
    grid: layers.flatMap(layer => cellsOf(layer).map(cell => ({ layerId: layer.id, cellId: cell.cellId,
      hostScope: cell.hostScope, gateId: layer.gateId, status: layer.status }))),
    gpuCommands: GPU_COMMANDS };
  await writeFile(path.join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`J3-D-full CPU plan: ${plan.grid.length} grid rows across ${layers.length} layers; ` +
    `GPU execution deferred. Main-thread commands:\n${GPU_COMMANDS.map(entry => `  ${entry.command}  # ${entry.layers.join(",")}`).join("\n")}`);
}
