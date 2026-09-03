import { BadgeCheck, Copy, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  PprElectronicWorkInstruction,
  PprQualitySamplingMode,
  PprQualitySpecificationKind,
  PprWorkInstructionQualityCheck,
} from "@bim-studio/contracts";
import {
  formatPprQualitySpecification,
  formatPprSamplingFrequency,
  pprQualityControlGaps,
} from "@bim-studio/ppr-lite-engine";
import { addPprQualityControl, duplicatePprQualityControl } from "./pprWorkInstructionDraft";

const SAMPLING_OPTIONS: Array<{ value: PprQualitySamplingMode; label: string }> = [
  { value: "every-item", label: "每件（全检）" },
  { value: "first-off", label: "每批首件" },
  { value: "every-n-items", label: "每 N 件" },
  { value: "per-batch", label: "每批 1 件" },
  { value: "once-per-shift", label: "每班 1 次" },
];

export function PprQualityControlEditor({
  instruction,
  onChange,
}: {
  instruction: PprElectronicWorkInstruction;
  onChange: (instruction: PprElectronicWorkInstruction) => void;
}) {
  return (
    <div className="ppr-ewi-group ppr-quality-group">
      <header>
        <span><BadgeCheck size={13} /><strong>质量控制点</strong><small>定义规格、检测与失控反应</small></span>
        <button type="button" onClick={() => onChange(addPprQualityControl(instruction))}><Plus size={12} />添加</button>
      </header>
      <div className="ppr-quality-list">
        {instruction.qualityChecks.map((check, index) => (
          <QualityControlCard
            key={check.id}
            check={check}
            index={index}
            onChange={(next) => onChange(replaceQualityControl(instruction, check.id, next))}
            onCopy={() => onChange(duplicatePprQualityControl(instruction, check.id))}
            onDelete={() => onChange({ ...instruction, qualityChecks: instruction.qualityChecks.filter((item) => item.id !== check.id) })}
          />
        ))}
      </div>
      {!instruction.qualityChecks.length && <p className="ppr-quality-empty">缺少质量定义；添加后才会进入计划就绪检查和 EWI 输出。</p>}
      <p className="ppr-quality-scope">控制计划仅保存定义级证据，不代表已经采集量测、执行 SPC 或完成处置闭环。</p>
    </div>
  );
}

function QualityControlCard({
  check,
  index,
  onChange,
  onCopy,
  onDelete,
}: {
  check: PprWorkInstructionQualityCheck;
  index: number;
  onChange: (check: PprWorkInstructionQualityCheck) => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const gaps = pprQualityControlGaps(check);
  const field = `质量控制点 ${index + 1}`;
  return (
    <article className={`ppr-quality-card${gaps.length ? " incomplete" : " complete"}`}>
      <header>
        <span><b>Q{index + 1}</b><span><strong>{check.checkpoint.trim() || "未命名特性"}</strong><small>{formatPprQualitySpecification(check)} · {formatPprSamplingFrequency(check.samplingFrequency)}</small></span></span>
        <em>{gaps.length ? `缺 ${gaps.length} 项` : "定义完整"}</em>
        <button className="icon" type="button" aria-label={`复制${field}`} title="复制控制点" onClick={onCopy}><Copy size={12} /></button>
        <button className="icon danger" type="button" aria-label={`删除${field}`} title="删除控制点" onClick={onDelete}><Trash2 size={12} /></button>
      </header>
      <div className="ppr-quality-fields">
        <label><span>特性名称</span><input aria-label={`${field} 特性名称`} value={check.checkpoint} placeholder="如装配间隙、紧固扭矩" onChange={(event) => onChange({ ...check, checkpoint: event.target.value })} /></label>
        <SpecificationQuickInput field={field} check={check} onChange={onChange} />
        <label><span>规格表达</span><select aria-label={`${field} 规格表达`} value={check.specificationKind ?? ""} onChange={(event) => onChange(withSpecificationKind(check, event.target.value as PprQualitySpecificationKind | ""))}><option value="">选择规格</option><option value="limits">上下限</option><option value="tolerance">目标 ± 公差</option></select></label>
        <label><span>单位</span><input aria-label={`${field} 单位`} value={check.unit ?? ""} placeholder="mm / N·m" onChange={(event) => onChange(withOptionalValue(check, "unit", optionalText(event.target.value)))} /></label>
        {check.specificationKind === "limits" && <>
          <NumberField label="目标值（可选）" ariaLabel={`${field} 目标值`} value={check.targetValue} onChange={(value) => onChange(withOptionalValue(check, "targetValue", value))} />
          <NumberField label="下限" ariaLabel={`${field} 下限`} value={check.lowerLimit} onChange={(value) => onChange(withOptionalValue(check, "lowerLimit", value))} />
          <NumberField label="上限" ariaLabel={`${field} 上限`} value={check.upperLimit} onChange={(value) => onChange(withOptionalValue(check, "upperLimit", value))} />
        </>}
        {check.specificationKind === "tolerance" && <>
          <NumberField label="目标值" ariaLabel={`${field} 目标值`} value={check.targetValue} onChange={(value) => onChange(withOptionalValue(check, "targetValue", value))} />
          <NumberField label="± 公差" ariaLabel={`${field} 公差`} value={check.tolerance} min={0} onChange={(value) => onChange(withOptionalValue(check, "tolerance", value))} />
        </>}
        <label><span>检测方法</span><input aria-label={`${field} 检测方法`} value={check.inspectionMethod ?? ""} placeholder="如游标卡尺、扭矩枪" onChange={(event) => onChange(withOptionalValue(check, "inspectionMethod", optionalText(event.target.value)))} /></label>
        <label><span>抽检频率</span><select aria-label={`${field} 抽检频率`} value={check.samplingFrequency?.mode ?? ""} onChange={(event) => onChange(withSamplingMode(check, event.target.value as PprQualitySamplingMode | ""))}><option value="">选择频率</option>{SAMPLING_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
        {check.samplingFrequency?.mode === "every-n-items" && <NumberField label="间隔件数 N" ariaLabel={`${field} 抽检间隔件数`} value={check.samplingFrequency.interval} min={1} step={1} onChange={(interval) => onChange(withSamplingInterval(check, interval))} />}
        <label className="wide"><span>失控反应</span><textarea rows={2} aria-label={`${field} 失控反应`} value={check.outOfControlReaction ?? ""} placeholder="如停止工序、隔离本批并通知质量人员" onChange={(event) => onChange(withOptionalValue(check, "outOfControlReaction", optionalText(event.target.value)))} /></label>
        <label className="wide"><span>补充判定（可选）</span><input aria-label={`${field} 补充判定`} value={check.acceptanceCriteria ?? ""} placeholder="定性外观要求或图纸条款" onChange={(event) => onChange(withOptionalValue(check, "acceptanceCriteria", optionalText(event.target.value)))} /></label>
      </div>
    </article>
  );
}

function SpecificationQuickInput({
  field,
  check,
  onChange,
}: {
  field: string;
  check: PprWorkInstructionQualityCheck;
  onChange: (check: PprWorkInstructionQualityCheck) => void;
}) {
  const formatted = quickSpecificationValue(check);
  const [draft, setDraft] = useState(formatted);
  const valid = !draft.trim() || Boolean(parsePprQualitySpecification(check, draft));
  useEffect(() => setDraft(formatted), [check.id, formatted]);
  return <label className="wide ppr-quality-quick-spec">
    <span>规格快捷输入</span>
    <input
      aria-label={`${field} 快捷规格`}
      aria-invalid={!valid}
      value={draft}
      placeholder="0.5–0.8 mm 或 10 ± 0.2 N·m"
      onChange={(event) => {
        const value = event.target.value;
        setDraft(value);
        if (!value.trim()) onChange(clearSpecification(check));
        else {
          const parsed = parsePprQualitySpecification(check, value);
          if (parsed) onChange(parsed);
        }
      }}
    />
    {!valid && <small role="status">未识别，请使用“下限–上限 单位”或“目标 ± 公差 单位”。</small>}
  </label>;
}

function NumberField({ label, ariaLabel, value, min, step = "any", onChange }: { label: string; ariaLabel: string; value: number | undefined; min?: number; step?: number | "any"; onChange: (value: number | undefined) => void }) {
  return <label><span>{label}</span><input type="number" aria-label={ariaLabel} value={value ?? ""} min={min} step={step} onChange={(event) => onChange(optionalNumber(event.target.value))} /></label>;
}

function withSpecificationKind(check: PprWorkInstructionQualityCheck, kind: PprQualitySpecificationKind | ""): PprWorkInstructionQualityCheck {
  const next = { ...check };
  if (kind) next.specificationKind = kind;
  else delete next.specificationKind;
  if (kind === "limits") delete next.tolerance;
  if (kind === "tolerance") {
    delete next.lowerLimit;
    delete next.upperLimit;
  }
  return next;
}

export function parsePprQualitySpecification(
  check: PprWorkInstructionQualityCheck,
  expression: string,
): PprWorkInstructionQualityCheck | undefined {
  const source = expression.trim();
  const tolerance = source.match(/^([+-]?\d+(?:\.\d+)?)\s*(?:±|\+\s*\/\s*-)\s*(\d+(?:\.\d+)?)\s*(.*)$/u);
  if (tolerance) {
    const targetValue = Number(tolerance[1]);
    const toleranceValue = Number(tolerance[2]);
    if (!Number.isFinite(targetValue) || !Number.isFinite(toleranceValue)) return undefined;
    const next = withSpecificationKind(check, "tolerance");
    return withParsedUnit({ ...next, targetValue, tolerance: toleranceValue }, tolerance[3]);
  }
  const limits = source.match(/^([+-]?\d+(?:\.\d+)?)\s*[-–—~至]\s*([+-]?\d+(?:\.\d+)?)\s*(.*)$/u);
  if (!limits) return undefined;
  const lowerLimit = Number(limits[1]);
  const upperLimit = Number(limits[2]);
  if (!Number.isFinite(lowerLimit) || !Number.isFinite(upperLimit) || lowerLimit > upperLimit) return undefined;
  const next = withSpecificationKind(check, "limits");
  return withParsedUnit({ ...next, lowerLimit, upperLimit }, limits[3]);
}

function withParsedUnit(check: PprWorkInstructionQualityCheck, rawUnit: string | undefined): PprWorkInstructionQualityCheck {
  const unit = optionalText(rawUnit?.trim() ?? "");
  return withOptionalValue(check, "unit", unit);
}

function clearSpecification(check: PprWorkInstructionQualityCheck): PprWorkInstructionQualityCheck {
  const next = { ...check };
  delete next.specificationKind;
  delete next.targetValue;
  delete next.lowerLimit;
  delete next.upperLimit;
  delete next.tolerance;
  return next;
}

function quickSpecificationValue(check: PprWorkInstructionQualityCheck): string {
  const unit = check.unit ? ` ${check.unit}` : "";
  if (check.specificationKind === "limits" && check.lowerLimit !== undefined && check.upperLimit !== undefined) {
    return `${check.lowerLimit}–${check.upperLimit}${unit}`;
  }
  if (check.specificationKind === "tolerance" && check.targetValue !== undefined && check.tolerance !== undefined) {
    return `${check.targetValue} ± ${check.tolerance}${unit}`;
  }
  return "";
}

function withSamplingMode(check: PprWorkInstructionQualityCheck, mode: PprQualitySamplingMode | ""): PprWorkInstructionQualityCheck {
  const next = { ...check };
  if (!mode) delete next.samplingFrequency;
  else next.samplingFrequency = { mode, ...(mode === "every-n-items" && check.samplingFrequency?.mode === mode ? { interval: check.samplingFrequency.interval } : {}) };
  return next;
}

function withSamplingInterval(check: PprWorkInstructionQualityCheck, interval: number | undefined): PprWorkInstructionQualityCheck {
  const samplingFrequency = { mode: "every-n-items" as const };
  if (interval !== undefined) Object.assign(samplingFrequency, { interval });
  return { ...check, samplingFrequency };
}

function withOptionalValue<K extends keyof PprWorkInstructionQualityCheck>(
  check: PprWorkInstructionQualityCheck,
  key: K,
  value: PprWorkInstructionQualityCheck[K] | undefined,
): PprWorkInstructionQualityCheck {
  const next = { ...check };
  if (value === undefined) delete next[key];
  else Object.assign(next, { [key]: value });
  return next;
}

function replaceQualityControl(instruction: PprElectronicWorkInstruction, id: string, check: PprWorkInstructionQualityCheck): PprElectronicWorkInstruction {
  return { ...instruction, qualityChecks: instruction.qualityChecks.map((item) => item.id === id ? check : item) };
}

function optionalText(value: string): string | undefined {
  return value.length ? value : undefined;
}

function optionalNumber(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined;
}
