import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const defaultMatrix = path.join(root, "docs/specs/industrial-s1-s6-acceptance-matrix-2026-09-18.json");
const allowedStageStatus = new Set(["complete", "partial", "blocked", "project_post_acceptance"]);
const allowedQuality = new Set(["inspect", "preview", "visual-complete", "engineering-verified"]);

function fail(message) {
  throw new Error(`工业阶段矩阵无效：${message}`);
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} 必须为非空字符串`);
}

function assertEvidencePath(value, label, workspaceRoot) {
  assertString(value, label);
  const normalized = value.replaceAll("\\", "/");
  if (!normalized.startsWith("docs/") || normalized.includes("..")) fail(`${label} 必须引用仓内 docs 证据`);
  if (workspaceRoot && !path.extname(normalized)) fail(`${label} 必须指向报告文件`);
  // 机器矩阵可以在证据尚未随工作树恢复时校验结构；存在时额外检查路径。
}

function assertNoMisleadingParasolidCopy(value, label) {
  if (typeof value !== "string") return;
  // 只审查用户可见字段；历史 URL、机器 ID 和外部路径不在此规则内。
  if (/\bXT\b/i.test(value) && !value.includes("X_T")) fail(`${label} 使用了禁止的用户可见 XT 术语`);
}

export function validateStageMatrix(matrix, workspaceRoot = root) {
  if (!matrix || typeof matrix !== "object") fail("根对象缺失");
  if (matrix.schemaVersion !== 1) fail("schemaVersion 必须为 1");
  if (matrix.authority !== "docs/specs/industrial-3d-format-work-plan-2026-09-16.md") fail("authority 未指向唯一权威计划");
  if (matrix.terminology?.parasolidDisplayName !== "X_T") fail("Parasolid 用户可见名称必须是 X_T");
  if (matrix.terminology?.parasolidExtension !== ".x_t") fail("Parasolid 扩展名必须是 .x_t");
  if (matrix.terminology?.commercialFallback !== false) fail("不得启用商业回退");

  if (!Array.isArray(matrix.stages) || matrix.stages.length !== 6) fail("必须恰好包含 S1–S6 六个阶段");
  const stageIds = new Set();
  for (const stage of matrix.stages) {
    assertString(stage?.id, "阶段 id");
    if (!/^S[1-6]$/.test(stage.id) || stageIds.has(stage.id)) fail(`阶段 id 重复或越界：${stage.id}`);
    stageIds.add(stage.id);
    if (!allowedStageStatus.has(stage.status)) fail(`${stage.id} status 不受支持：${stage.status}`);
    assertString(stage.summary, `${stage.id}.summary`);
    if (!Array.isArray(stage.evidence) || stage.evidence.length === 0) fail(`${stage.id} 缺少 evidence`);
    stage.evidence.forEach((item, index) => assertEvidencePath(item, `${stage.id}.evidence[${index}]`, workspaceRoot));
    if (!Array.isArray(stage.openGates)) fail(`${stage.id}.openGates 必须为数组`);
    if ((stage.status === "partial" || stage.status === "blocked" || stage.status === "project_post_acceptance")
      && stage.openGates.length === 0) fail(`${stage.id} 的未完成状态必须列出 openGates`);
    if (stage.status === "complete" && stage.openGates.length > 0) fail(`${stage.id} 标记 complete 时不得保留 openGates`);
    stage.openGates.forEach((gate, index) => assertString(gate, `${stage.id}.openGates[${index}]`));
    for (const text of [stage.summary, ...stage.openGates]) assertNoMisleadingParasolidCopy(text, `${stage.id}.text`);
  }
  for (let index = 1; index <= 6; index += 1) if (!stageIds.has(`S${index}`)) fail(`缺少 S${index}`);

  if (!Array.isArray(matrix.profiles) || matrix.profiles.length !== 7) fail("必须包含七个格式 profile");
  const profileIds = new Set();
  for (const profile of matrix.profiles) {
    assertString(profile?.id, "profile id");
    if (profileIds.has(profile.id)) fail(`profile id 重复：${profile.id}`);
    profileIds.add(profile.id);
    assertString(profile.displayName, `${profile.id}.displayName`);
    assertNoMisleadingParasolidCopy(profile.displayName, `${profile.id}.displayName`);
    if (!allowedQuality.has(profile.quality)) fail(`${profile.id}.quality 不受支持：${profile.quality}`);
    if (profile.productionReady !== false) fail(`${profile.id} 当前不允许声明 productionReady`);
    assertString(profile.reason, `${profile.id}.reason`);
  }
  const xt = matrix.profiles.find(profile => profile.id === "bim.xt-builtin");
  if (!xt || xt.displayName !== "X_T" || xt.quality === "visual-complete" || xt.quality === "engineering-verified") {
    fail("X_T profile 必须保持 inspect/preview");
  }
  const e57 = matrix.profiles.find(profile => profile.id === "bim.pointcloud-builtin");
  if (!e57 || e57.quality !== "inspect") fail("E57/LAS/LAZ/COPC 在无渲染入口时必须保持 inspect");
  return matrix;
}

export async function readAndValidateMatrix(file = defaultMatrix, workspaceRoot = root) {
  const bytes = await readFile(file);
  const matrix = JSON.parse(bytes.toString("utf8"));
  validateStageMatrix(matrix, workspaceRoot);
  for (const stage of matrix.stages) {
    for (const evidence of stage.evidence) {
      try {
        await access(path.resolve(workspaceRoot, evidence));
      } catch {
        fail(`${stage.id}.evidence 缺少文件：${evidence}`);
      }
    }
  }
  return { matrix, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : defaultMatrix;
  const result = await readAndValidateMatrix(file);
  console.log(JSON.stringify({ file: path.relative(root, file), sha256: result.sha256, bytes: result.bytes,
    stages: result.matrix.stages.map(stage => ({ id: stage.id, status: stage.status })),
    profiles: result.matrix.profiles.map(profile => ({ id: profile.id, quality: profile.quality })) }, null, 2));
}
