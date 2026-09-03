import { BadgeCheck, BookOpenCheck, Download, Image, Printer, ShieldAlert } from "lucide-react";
import { useState } from "react";
import type { PprBopVersionDraft } from "@bim-studio/contracts";
import {
  buildPprWorkInstructionPreview,
  formatPprQualitySpecification,
  formatPprSamplingFrequency,
  type PprWorkInstructionOperationPreview,
} from "@bim-studio/ppr-lite-engine";
import { downloadTextFile, printHtmlDocument } from "../browserDownload";
import { pprWorkInstructionFileName, renderPprWorkInstructionHtml } from "./pprWorkInstructionHtml";
import "./PprWorkInstructions.css";

export function PprWorkInstructionPreview({
  draft,
  operationOrder,
  documentLabel,
}: {
  draft: PprBopVersionDraft;
  operationOrder: string[];
  documentLabel: string;
}) {
  const [deliveryError, setDeliveryError] = useState("");
  const preview = buildPprWorkInstructionPreview(draft, operationOrder);
  const hasInstructions = preview.operations.length > 0;

  function createDocument(): string {
    return renderPprWorkInstructionHtml(preview, {
      documentLabel,
      generatedAt: new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date()),
    });
  }

  function exportOfflineHtml() {
    setDeliveryError("");
    try {
      downloadTextFile(createDocument(), pprWorkInstructionFileName(preview.planName), "text/html;charset=utf-8");
    } catch (error) {
      setDeliveryError(messageOf(error));
    }
  }

  function printDocument() {
    setDeliveryError("");
    try {
      printHtmlDocument(createDocument(), `${preview.planName} · EWI`);
    } catch (error) {
      setDeliveryError(messageOf(error));
    }
  }

  return (
    <section className="ppr-ewi-preview" aria-labelledby="ppr-ewi-preview-title">
      <header>
        <span><BookOpenCheck size={14} /><span><strong id="ppr-ewi-preview-title">电子作业指导书</strong><small>{hasInstructions ? `${preview.operations.length} 道工序 · ${preview.totalStepCount} 个步骤` : "尚未编制"}</small></span></span>
        <div>
          <button type="button" disabled={!hasInstructions} title="打开系统打印对话框" onClick={printDocument}><Printer size={12} />打印</button>
          <button type="button" disabled={!hasInstructions} title="下载可离线打开和打印的 HTML" onClick={exportOfflineHtml}><Download size={12} />离线 HTML</button>
        </div>
      </header>
      {!hasInstructions && <p className="ppr-ewi-preview-empty">在工序卡片中按需编制 EWI；预览会依照有效工序顺序自动汇总。</p>}
      <div className="ppr-ewi-preview-list">
        {preview.operations.map((operation, index) => <OperationInstruction key={operation.operationId} operation={operation} initiallyOpen={index === 0} />)}
      </div>
      {deliveryError && <p className="ppr-ewi-delivery-error" role="alert">{deliveryError}</p>}
    </section>
  );
}

function OperationInstruction({ operation, initiallyOpen }: { operation: PprWorkInstructionOperationPreview; initiallyOpen: boolean }) {
  return (
    <details open={initiallyOpen} className="ppr-ewi-preview-operation">
      <summary><span>{operation.sequence}</span><strong>{operation.operationName || operation.operationId}</strong><small>{operation.steps.length} 步</small></summary>
      <div>
        {!!operation.visualReferences.length && (
          <p className="ppr-ewi-preview-context"><Image size={12} />{operation.visualReferences.map((reference) => <code key={`${reference.kind}:${reference.id}`}>{reference.kind === "scene" ? "场景" : "对象"} · {reference.id}</code>)}</p>
        )}
        <ol>{operation.steps.map((step) => <li key={step.id}>{step.instruction || <em>待补充操作说明</em>}</li>)}</ol>
        {!!operation.safetyNotes.length && <div className="ppr-ewi-preview-safety"><strong><ShieldAlert size={12} />安全注意</strong>{operation.safetyNotes.map((note) => <p key={note.id}>{note.note}</p>)}</div>}
        {!!operation.qualityChecks.length && <div className="ppr-ewi-preview-quality"><strong><BadgeCheck size={12} />质量控制点</strong>{operation.qualityChecks.map((check) => <article key={check.id}><span><b>{check.checkpoint}</b><small>{formatPprQualitySpecification(check)}</small></span><dl><div><dt>检测</dt><dd>{check.inspectionMethod || "待补"}</dd></div><div><dt>频率</dt><dd>{formatPprSamplingFrequency(check.samplingFrequency)}</dd></div><div><dt>失控反应</dt><dd>{check.outOfControlReaction || "待补"}</dd></div></dl>{check.acceptanceCriteria && <p>{check.acceptanceCriteria}</p>}</article>)}</div>}
      </div>
    </details>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "作业指导书输出失败";
}
