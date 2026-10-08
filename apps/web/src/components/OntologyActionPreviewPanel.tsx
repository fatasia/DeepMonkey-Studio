import { useState } from "react";
import type { OntologyActionType, OntologyPackage, OntologyActionPlanInput, OntologyActionPreview } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { buildOntologyActionPreviewInput, ontologyActionTargetIds, ontologyActionDefaultArguments, OntologyActionInputError } from "./ontologyActionPreviewInput";

/** H-C4-P3 行动预览面板：调 /ai/ontology-actions/preview，4xx 理由码 fail-closed 直呈，不猜测不放行。 */
export default function ActionPreviewPanel({ pkg, action, locale, previewAction }: {
  pkg: OntologyPackage;
  action: OntologyActionType;
  locale: AppLocale;
  previewAction: (input: OntologyActionPlanInput) => Promise<OntologyActionPreview>;
}) {
  const [preview, setPreview] = useState<OntologyActionPreview | undefined>(undefined);
  const [error, setError] = useState<{ message: string; reasonCodes?: string[] } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const objectKey = action.boundObject || "";
  const targets = ontologyActionTargetIds(pkg, action);
  const [identity, setIdentity] = useState(targets[0] ?? "");
  const [parameters, setParameters] = useState(() => ontologyActionDefaultArguments(action));
  const published = pkg.status === "published" && action.status === "published";
  const changed = () => { setPreview(undefined); setError(undefined); };
  const run = async () => {
    setBusy(true); setError(undefined); setPreview(undefined);
    try {
      setPreview(await previewAction(buildOntologyActionPreviewInput(pkg, action, identity, parameters)));
    } catch (cause) {
      const body = cause as { message?: string; reasonCodes?: string[] };
      const inputMessages = {
        "identity-invalid": tr(locale, "请选择或填写有效的对象身份", "Select or enter a valid object identity"),
        "identity-unregistered": tr(locale, "对象身份未登记，请选择列表中的对象", "Choose a registered object identity"),
        "object-unbound": tr(locale, "行动未绑定有效对象", "Action has no valid bound object"),
        "json-invalid": tr(locale, "参数格式有误，请检查 JSON", "Check the parameters JSON syntax"),
        "parameters-not-object": tr(locale, "参数必须是 JSON 对象", "Parameters must be a JSON object"),
      };
      setError({ message: cause instanceof OntologyActionInputError ? inputMessages[cause.code] : body.message || tr(locale, "预览请求失败", "Preview request failed"), ...(body.reasonCodes ? { reasonCodes: body.reasonCodes } : {}) });
    } finally { setBusy(false); }
  };
  return (
    <div className="ontology-graph-action-preview">
      <label>{tr(locale, "对象身份", "Object identity")}
        {targets.length ? <select aria-label={tr(locale, "对象身份", "Object identity")} value={identity} disabled={busy} onChange={event => { setIdentity(event.target.value); changed(); }}>
          {targets.map(id => <option key={id} value={id}>{id}</option>)}
        </select> : <input aria-label={tr(locale, "对象身份", "Object identity")} value={identity} disabled={busy} onChange={event => { setIdentity(event.target.value); changed(); }} />}
      </label>
      <label>{tr(locale, "行动参数", "Action parameters")}
        <textarea aria-label={tr(locale, "行动参数", "Action parameters")} value={parameters} disabled={busy} rows={6} spellCheck={false} onChange={event => { setParameters(event.target.value); changed(); }} />
      </label>
      <details><summary>{tr(locale, "参数格式", "Parameter format")}</summary><pre>{JSON.stringify(action.inputSchema, null, 2)}</pre></details>
      {!published && <small>{tr(locale, "发布本体和行动后可生成预览", "Publish the ontology and action to preview")}</small>}
      <button type="button" disabled={busy || !objectKey || !identity.trim() || !published} onClick={run}>
        {busy ? tr(locale, "预览生成中…", "Previewing…") : tr(locale, "预览行动", "Preview action")}
      </button>
      {!objectKey && <small>{tr(locale, "行动未绑定对象，无法预览", "Action has no bound object; preview unavailable")}</small>}
      {error && (
        <p role="alert" className="ontology-graph-action-preview-error">
          {error.message}
          {error.reasonCodes?.length ? <code> [{error.reasonCodes.join(", ")}]</code> : null}
        </p>
      )}
      {preview && (
        <dl>
          <dt>{tr(locale, "包/版本", "Package/version")}</dt><dd>{preview.packageId} v{preview.packageVersion}</dd>
          <dt>{tr(locale, "目标对象", "Target")}</dt><dd><code>{preview.target.canonicalId}</code></dd>
          <dt>{tr(locale, "风险", "Risk")}</dt><dd>{preview.risk}</dd>
          <dt>{tr(locale, "需要审批", "Approval")}</dt><dd>{preview.approvalRequired ? tr(locale, "是", "Yes") : tr(locale, "否", "No")}</dd>
          <dt>{tr(locale, "幂等键", "Idempotency")}</dt><dd><code>{preview.idempotencyKey}</code></dd>
          <dt>{tr(locale, "前置条件", "Preconditions")}</dt>
          <dd>{preview.preconditions.length ? preview.preconditions.map((item, index) => (
            <span key={index}>{item.label}: {item.status}</span>
          )) : tr(locale, "无", "None")}</dd>
          <dt>{tr(locale, "影响范围", "Impact")}</dt>
          <dd>{preview.impact.length ? preview.impact.map((item, index) => (
            <span key={index}>{item.objectKey} ← {item.relationKey} ({item.hops} 跳)</span>
          )) : tr(locale, "无邻域影响", "No neighborhood impact")}</dd>
          <dt>{tr(locale, "可执行", "Executable")}</dt>
          <dd>{preview.executable ? tr(locale, "是", "Yes") : tr(locale, "否（存在阻断）", "No (blocked)")}</dd>
          <dt>{tr(locale, "回滚", "Rollback")}</dt><dd>{preview.rollback || tr(locale, "无", "None")}</dd>
          {preview.blockingReasons.length ? <dt>{tr(locale, "阻断理由", "Blocking reasons")}</dt> : null}
          {preview.blockingReasons.length ? (
            <dd>{preview.blockingReasons.map((item, index) => (
              <span key={index}><code>{item.code}</code> {item.message}</span>
            ))}</dd>
          ) : null}
        </dl>
      )}
    </div>
  );
}
