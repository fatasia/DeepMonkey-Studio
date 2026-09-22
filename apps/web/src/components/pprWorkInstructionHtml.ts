import type {
  PprWorkInstructionOperationPreview,
  PprWorkInstructionPreview,
} from "@bim-studio/ppr-lite-engine";
import { formatPprQualitySpecification, formatPprSamplingFrequency } from "@bim-studio/ppr-lite-engine";

export interface PprWorkInstructionDocumentOptions {
  documentLabel: string;
  generatedAt: string;
}

/** A dependency-free, self-contained document that stays readable offline and on paper. */
export function renderPprWorkInstructionHtml(
  preview: PprWorkInstructionPreview,
  options: PprWorkInstructionDocumentOptions,
): string {
  const operations = preview.operations.map(renderOperation).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(preview.planName)} · 电子作业指导书</title>
<style>
:root{color-scheme:light;font-family:"Microsoft YaHei","Noto Sans SC",Arial,sans-serif;color:#17211f;background:#edf1ef}*{box-sizing:border-box}body{margin:0;padding:32px;background:#edf1ef;line-height:1.55}main{max-width:920px;margin:auto;padding:34px;background:#fff;box-shadow:0 10px 36px #1d30291a}.document-header{display:grid;gap:14px;padding-bottom:22px;border-bottom:2px solid #1e7b6d}.eyebrow{margin:0;color:#1e7b6d;font-size:12px;font-weight:700;letter-spacing:.12em}.document-header h1{margin:0;font-size:26px;line-height:1.25}.meta{display:flex;flex-wrap:wrap;gap:8px 20px;color:#5b6864;font-size:12px}.summary{display:flex;gap:18px;margin:20px 0;padding:12px 14px;border:1px solid #dce4e1;background:#f6f9f8}.summary strong{display:block;font-size:18px}.summary span{color:#66736f;font-size:11px}.operation{margin-top:20px;border:1px solid #dce4e1;break-inside:avoid}.operation-header{display:grid;align-items:center;gap:12px;padding:13px 16px;grid-template-columns:40px minmax(0,1fr) auto;background:#edf7f4}.sequence{display:grid;width:32px;height:32px;place-items:center;color:#fff;border-radius:50%;background:#1e7b6d;font-weight:800}.operation h2{margin:0;font-size:17px}.operation-header small{color:#63716d}.operation-body{display:grid;gap:18px;padding:16px}.context{display:flex;flex-wrap:wrap;gap:6px}.context span{padding:3px 8px;color:#315a52;border-radius:99px;background:#eaf3f0;font:11px Consolas,monospace}.block h3{margin:0 0 8px;color:#44514d;font-size:12px;letter-spacing:.05em}.steps{display:grid;gap:8px;margin:0;padding:0;list-style:none;counter-reset:steps}.steps li{display:grid;gap:9px;grid-template-columns:25px minmax(0,1fr);counter-increment:steps}.steps li:before{display:grid;width:22px;height:22px;place-items:center;color:#1e7b6d;border:1px solid #92bcb3;border-radius:50%;content:counter(steps);font-size:11px;font-weight:700}.safety{padding:12px 14px;border-left:4px solid #b86b18;background:#fff7ec}.safety ul{margin:0;padding-left:19px}.quality{width:100%;border-collapse:collapse;table-layout:fixed}.quality th,.quality td{padding:7px 8px;border:1px solid #dce4e1;text-align:left;vertical-align:top;overflow-wrap:anywhere}.quality th{color:#52615d;background:#f4f7f6;font-size:10px}.quality td{font-size:10px}.quality td:first-child{font-weight:700}.quality small{display:block;margin-top:3px;color:#66736f}.quality-scope{margin:7px 0 0;color:#77827f;font-size:9px}.empty{color:#7a8582;font-style:italic}.document-footer{margin-top:28px;padding-top:12px;color:#77827f;border-top:1px solid #dce4e1;font-size:10px}@page{size:A4;margin:14mm}@media print{body{padding:0;background:#fff}main{max-width:none;padding:0;box-shadow:none}.operation{break-inside:avoid}.document-footer{position:running(footer)}}
</style>
</head>
<body><main>
<header class="document-header"><p class="eyebrow">ELECTRONIC WORK INSTRUCTION · EWI</p><h1>${escapeHtml(preview.planName)}</h1><div class="meta"><span>版本/状态：${escapeHtml(options.documentLabel)}</span><span>导出时间：${escapeHtml(options.generatedAt)}</span></div></header>
<section class="summary"><div><strong>${preview.operations.length}</strong><span>已编制作业工序</span></div><div><strong>${preview.totalStepCount}</strong><span>操作步骤</span></div><div><strong>${preview.totalQualityControlCount}</strong><span>质量控制点</span></div></section>
${operations || '<p class="empty">当前计划尚未编制电子作业指导书。</p>'}
<footer class="document-footer">DeepMonkey Studio 工艺规划离线副本 · 内容来自当前工艺计划快照；场景/对象仅保留可追溯 ID。</footer>
</main></body></html>`;
}

export function pprWorkInstructionFileName(planName: string): string {
  const stem = planName.replace(/[\\/:*?"<>|]/g, "_").trim().replace(/[. ]+$/, "") || "work-instructions";
  return `${stem}-EWI.html`;
}

function renderOperation(operation: PprWorkInstructionOperationPreview): string {
  const context = operation.visualReferences.map((reference) =>
    `<span>${reference.kind === "scene" ? "场景" : "对象"} · ${escapeHtml(reference.id)}</span>`).join("");
  const steps = operation.steps.map((step) => `<li>${escapeHtml(step.instruction) || '<span class="empty">待补充操作说明</span>'}</li>`).join("");
  const safety = operation.safetyNotes.map((note) => `<li>${escapeHtml(note.note)}</li>`).join("");
  const quality = operation.qualityChecks.map((check) => {
    const supplemental = check.acceptanceCriteria?.trim() ? `<small>${escapeHtml(check.acceptanceCriteria)}</small>` : "";
    return `<tr><td>${escapeHtml(check.checkpoint)}</td><td>${escapeHtml(formatPprQualitySpecification(check))}${supplemental}</td><td>${escapeHtml(check.inspectionMethod || "待补")}</td><td>${escapeHtml(formatPprSamplingFrequency(check.samplingFrequency))}</td><td>${escapeHtml(check.outOfControlReaction || "待补")}</td></tr>`;
  }).join("");
  return `<article class="operation">
<header class="operation-header"><span class="sequence">${operation.sequence}</span><h2>${escapeHtml(operation.operationName)}</h2><small>标准工时 ${formatMinutes(operation.standardTimeMinutes)} 分钟</small></header>
<div class="operation-body">
${context ? `<div class="context">${context}</div>` : ""}
<section class="block"><h3>操作步骤</h3><ol class="steps">${steps}</ol></section>
${safety ? `<section class="block safety"><h3>安全注意</h3><ul>${safety}</ul></section>` : ""}
${quality ? `<section class="block"><h3>质量控制点</h3><table class="quality"><thead><tr><th>特性</th><th>规格</th><th>检测方法</th><th>抽检频率</th><th>失控反应</th></tr></thead><tbody>${quality}</tbody></table><p class="quality-scope">本页为控制计划定义，不代表量测采集、SPC 或失控处置已经执行。</p></section>` : ""}
</div></article>`;
}

function formatMinutes(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "—";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}
