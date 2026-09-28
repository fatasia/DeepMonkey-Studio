import { useEffect, useState } from "react";
import type { MtmCodeApplication, PprBopVersionDraft } from "@bim-studio/contracts";
import { applyMtmToOperations, resolveStandardTime } from "@bim-studio/ppr-lite-engine";

/** MTM data-card values are supplied by the user; only the derived time enters the BOP version. */
export function PprMtmTimeEditor({ draft, operationId, onChange }: {
  draft: PprBopVersionDraft;
  operationId: string;
  onChange: (draft: PprBopVersionDraft) => void;
}) {
  const operation = draft.operations.find((item) => item.id === operationId);
  const [code, setCode] = useState("");
  const [count, setCount] = useState("1");
  const [minutes, setMinutes] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { setCode(""); setCount("1"); setMinutes(""); setMessage(""); }, [operationId]);
  if (!operation) return null;
  const application: MtmCodeApplication = {
    operationId,
    codes: [{ code: code.trim(), count: Number(count), minutesPerApplication: Number(minutes) }],
  };
  function apply() {
    try {
      if (!minutes.trim()) throw new Error("请填写经授权数据卡核对的每次应用分钟数。");
      const resolved = resolveStandardTime(application, operation!.standardTimeMinutes);
      if (resolved.standardTimeMinutes <= 0) throw new Error("分解工时必须大于零，才能写入工艺版本。");
      onChange({ ...draft, operations: applyMtmToOperations(draft.operations, [application]) });
      setMessage(`已更新草稿工时为 ${resolved.standardTimeMinutes.toFixed(3)} 分钟；请保存新版本。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "工时分解无效，请检查输入。");
    }
  }
  return <details className="ppr-mtm-entry">
    <summary>MTM 工时分解 · 用户数据卡</summary>
    <p>仅对本工序输入一条代码应用；不提供或核验受版权保护的代码时间表。应用后只保存推导出的标准工时，不保存代码、次数或数据卡来源；重开仍能读出工时，但不能追溯原始 MTM 分解。正式使用前请在受控系统保存原始数据卡证据。</p>
    <div className="ppr-mtm-fields">
      <label>代码<input aria-label={`${operation.name} MTM 代码`} value={code} maxLength={80} onChange={(event) => setCode(event.target.value)} /></label>
      <label>次数<input aria-label={`${operation.name} MTM 次数`} type="number" min="1" step="1" value={count} onChange={(event) => setCount(event.target.value)} /></label>
      <label>每次分钟<input aria-label={`${operation.name} MTM 每次分钟`} type="number" min="0" step="any" value={minutes} onChange={(event) => setMinutes(event.target.value)} /></label>
    </div>
    <button type="button" onClick={apply}>应用到工序草稿</button>
    {message && <small role="status" aria-live="polite">{message}</small>}
  </details>;
}
