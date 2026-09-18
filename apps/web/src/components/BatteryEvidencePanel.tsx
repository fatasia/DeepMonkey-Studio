import { BatteryMedium, ChevronDown } from "lucide-react";
import type { BatteryModelCatalogEntry } from "@bim-studio/contracts";
import type { BatteryReleaseGateSnapshot } from "../api";
import { AiDataRunHistory } from "./AiDataRunHistory";

export function BatteryEvidencePanel({ catalog, release, selectedModel, projectId, bindingId }: {
  catalog: BatteryModelCatalogEntry[];
  release: BatteryReleaseGateSnapshot | undefined;
  selectedModel: BatteryModelCatalogEntry | undefined;
  projectId: string;
  bindingId: string | undefined;
}) {
  const routedExperts = catalog.filter((item) =>
    item.runtime === "onnx" && ["routed-expert", "production-router"].includes(item.role)
  );
  return (
    <aside className="operations-panel battery-evidence-panel">
      <header><div><strong>本次运行证据</strong><small>模型、版本与回退路径</small></div></header>
      {selectedModel ? (
        <div className="battery-primary-model">
          <span>{release?.deployment.mode === "local-validation" ? "项目内置模型" : "当前模型"}</span>
          <strong>{selectedModel.label}</strong>
          <p title={selectedModel.evidence.summary}>{selectedModel.evidence.summary}</p>
          <div><span>{selectedModel.modelVersion}</span><b>{release?.deployment.mode === "local-validation" ? "验证用" : selectedModel.evidence.gate.toUpperCase()}</b></div>
        </div>
      ) : <div className="operations-empty">正在读取模型目录…</div>}
      <details className="battery-details">
        <summary><span>运行时与发布门禁</span><ChevronDown size={14} /></summary>
        <div>
          <p>主模型：{release?.primaryModels.length ?? 0} 个 · 正式路由：{release?.routedModels.length ?? 0} 个 · 安全回退：{release?.fallbackModels.length ?? 0} 个</p>
          <p>ONNX：{release?.deployment.activeModels.length ? `${release.deployment.activeModels.length} 个${release.deployment.mode === "local-validation" ? "本地验证模型" : "正式模型"}` : "未启用"}</p>
          {release?.blockers.map((blocker) => <small key={blocker}>{blocker}</small>)}
        </div>
      </details>
      {routedExperts.length > 0 && <details className="battery-details">
        <summary><span>正式物理与路由专家</span><ChevronDown size={14} /></summary>
        <div className="battery-shadow-list">
          {routedExperts.map((model) => (
            <article key={model.id}><strong>{model.label}</strong><small>{model.evidence.summary}</small></article>
          ))}
          <p>SPM-PINO 与 TwinMoE 按动态风险、域判断和 SPM 回退运行；单个专家不能绕过路由直接覆盖结果。</p>
        </div>
      </details>}
      {bindingId && <AiDataRunHistory projectId={projectId} bindingId={bindingId} />}
      {catalog.some(item => item.family === "spm-conservation" && item.runtimeEnabled) && (
        <div className="battery-evidence-foot"><BatteryMedium size={15} /><span>域外或极高风险时，由确定性 SPM 守恒求解接管。</span></div>
      )}
    </aside>
  );
}
