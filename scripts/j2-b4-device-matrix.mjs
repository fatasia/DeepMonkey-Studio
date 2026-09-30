/**
 * J2-B4 多物理设备矩阵 runner 骨架 —— 纯 CPU 入口，不启动 GPU。
 *
 * - 默认 `--expand`：读取矩阵 fixture + CSM timing/parity fixture，计算身份哈希，
 *   展开矩阵并做"空证据必须不完整"自检，写出 expansion.json；
 * - `--validate <receipts.json>`：对主线程 GPU 实跑产出的 receipts 做纯 CPU 证据校验，
 *   写出 validation.json（matrixComplete=false 时退出码 1，不粉饰）。
 * - GPU 实跑命令（Chrome/`cargo test --ignored`）见 docs/specs/j2-b4-matrix-cpu-20261001.md，
 *   由主线程串行执行后把每宿主 receipt 落成 JSON，再交本入口校验。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expandDeviceMatrix, parseDeviceMatrix, validateDeviceMatrixEvidence } from "./lib/j2DeviceMatrix.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outDir = path.join(root, "test-output/j2-b4-matrix");
const args = process.argv.slice(2);
const validateIndex = args.indexOf("--validate");
const validForm = args.length === 0 || (args.length === 2 && validateIndex === 0);
if (!validForm) {
  throw Error("Usage: node scripts/j2-b4-device-matrix.mjs [--validate <receipts.json>]");
}

const hash = value => createHash("sha256").update(value).digest("hex");
const read = name => readFile(path.join(root, name), "utf8");
const matrixText = await read("packages/deep-engine/fixtures/j2-b4-device-matrix-v1.json");
const planText = await read("packages/deep-engine/fixtures/j2-csm-timing-v1.json");
const fixtureText = await read("packages/deep-engine/fixtures/j2-csm-parity-v1.json");
const matrix = parseDeviceMatrix(JSON.parse(matrixText));
const plan = JSON.parse(planText);
const identity = { fixtureHash: hash(fixtureText), planHash: hash(planText), matrixHash: hash(matrixText) };
await mkdir(outDir, { recursive: true });

const expansion = expandDeviceMatrix(matrix, plan);
if (validateIndex === -1) {
  const empty = validateDeviceMatrixEvidence(matrix, plan, identity, []);
  if (empty.matrixComplete || empty.rows.some(row => row.status === "measured"))
    throw Error("Empty evidence must never measure the matrix");
  const result = { currentRun: false, mode: "cpu-expansion", identity, expansion, emptyGuard: empty };
  await writeFile(path.join(outDir, "expansion.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ mode: result.mode, cells: expansion.cells.length, rows: empty.rows,
    identity }, null, 2));
} else {
  const receiptsPath = path.resolve(root, args[validateIndex + 1]);
  if (!receiptsPath.startsWith(root)) throw Error("Receipts file must live inside the repository");
  const receipts = JSON.parse(await readFile(receiptsPath, "utf8"));
  const result = { currentRun: true, mode: "cpu-validation", identity,
    validation: validateDeviceMatrixEvidence(matrix, plan, identity, receipts) };
  await writeFile(path.join(outDir, "validation.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result.validation, null, 2));
  if (!result.validation.matrixComplete) {
    throw Error("Device matrix incomplete; see test-output/j2-b4-matrix/validation.json");
  }
}
