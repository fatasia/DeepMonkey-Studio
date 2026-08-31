import { GitCompareArrows, LoaderCircle, Route, Save } from "lucide-react";
import { usePprPlanController } from "./pprPlanController";
import type { PprPlanReferenceContext } from "./pprPlanTemplate";

export function PprPlanDetails({
  projectId,
  references,
}: {
  projectId: string;
  references: PprPlanReferenceContext;
}) {
  const controller = usePprPlanController(projectId, references);
  return (
    <div className="ppr-plan-body">
      <p>默认模板已绑定当前可用的场景、对象、脚本和 Study ID；缺失项不会被虚构。</p>
      <div className="operations-inline-actions">
        <button className="primary" disabled={controller.busy} onClick={() => void controller.saveVersion()}>
          {controller.busy ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
          保存当前引用为新版本
        </button>
        <button
          disabled={controller.busy || controller.versions.length < 2}
          onClick={() => void controller.compareLatest()}
        >
          <GitCompareArrows size={14} />
          比较最近两版
        </button>
      </div>
      {controller.summary && (
        <p className="operations-sync-ok">
          <Route size={14} />
          {controller.summary}
        </p>
      )}
      {controller.error && <p className="operations-notice">{controller.error}</p>}
      {controller.versions.length > 0 && (
        <ol className="ppr-version-list">
          {controller.versions.slice(-4).reverse().map((version) => (
            <li key={version.id}>
              {version.version} · {version.operations.length} 工序 · {version.resources.length} 资源
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
