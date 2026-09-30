/**
 * J3-E unknown-loss 自动化 runner 入口 —— 纯 CPU，不启动 GPU。
 *
 * - 默认：展开注入矩阵 + "空证据必须不完整"自检，写出 test-output/j3-e-unknown-loss/expansion.json；
 * - `--validate <receipts.json>`：对 GPU 实跑产出的 receipts 做纯 CPU 证据校验，
 *   写出 validation.json（matrixComplete=false 时退出码 1，不粉饰）。
 * - 矩阵/期望/负例语义见 scripts/lib/j3UnknownLossMatrix.mjs 与
 *   docs/specs/j3-e-gpu-runner-prep-20261001.md；GPU 实跑命令见该规格第 7 节。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expandUnknownLossMatrix, validateUnknownLossMatrixEvidence } from "./lib/j3UnknownLossMatrix.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outDir = path.join(root, "test-output/j3-e-unknown-loss");
const args = process.argv.slice(2);
const validateIndex = args.indexOf("--validate");
const validForm = args.length === 0 || (args.length === 2 && validateIndex === 0);
if (!validForm) {
  throw Error("Usage: node scripts/j3-unknown-loss-runner.mjs [--validate <receipts.json>]");
}

await mkdir(outDir, { recursive: true });
const expansion = expandUnknownLossMatrix();

if (validateIndex === -1) {
  const empty = await validateUnknownLossMatrixEvidence({ sourceHash: "cpu-skeleton-selfcheck" }, []);
  if (empty.matrixComplete || empty.rows.some(row => row.status === "measured"))
    throw Error("Empty evidence must never measure the unknown-loss matrix");
  const result = { currentRun: false, mode: "cpu-expansion", expansion, emptyGuard: {
    matrixComplete: empty.matrixComplete, rows: empty.rows.map(row => ({ rowId: row.rowId, host: row.host, status: row.status })) } };
  await writeFile(path.join(outDir, "expansion.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ mode: result.mode, cells: expansion.cells.length,
    rows: empty.rows.length, matrixComplete: empty.matrixComplete }, null, 2));
} else {
  const receiptsPath = path.resolve(root, args[validateIndex + 1]);
  if (!receiptsPath.startsWith(root)) throw Error("Receipts file must live inside the repository");
  const { createHash } = await import("node:crypto");
  // receipts 的源码身份由 GPU 线落盘在 receipts.json 的 identity.sourceHash（J5 源码快照 sha256）。
  const payload = JSON.parse(await readFile(receiptsPath, "utf8"));
  const identity = payload.identity ?? { sourceHash: createHash("sha256").update(JSON.stringify(payload.receipts ?? [])).digest("hex") };
  const validation = await validateUnknownLossMatrixEvidence(identity, payload.receipts ?? payload);
  const result = { currentRun: true, mode: "cpu-validation", identity, validation };
  await writeFile(path.join(outDir, "validation.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ matrixComplete: validation.matrixComplete,
    countedCells: validation.countedCells, declaredCells: validation.declaredCells,
    invalid: validation.rows.filter(row => row.status === "invalid")
      .map(row => `${row.rowId}/${row.host}: ${row.reasons.join("; ")}`) }, null, 2));
  if (!validation.matrixComplete) throw Error("Unknown-loss matrix incomplete; see test-output/j3-e-unknown-loss/validation.json");
}
