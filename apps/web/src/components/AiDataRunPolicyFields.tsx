import { ChevronDown, Clock3, ShieldCheck } from "lucide-react";

export interface AiDataRunPolicyDraft {
  mode: "manual" | "interval";
  intervalSeconds: number;
  windowRows: number;
  minimumSamples: number;
  maxAgeSeconds: number;
  maximumMissingRate: number;
  entityField: string;
  timeField: string;
}

interface AiDataRunPolicyFieldsProps {
  value: AiDataRunPolicyDraft;
  fields: Array<{ key: string; label: string }>;
  onChange: (value: AiDataRunPolicyDraft) => void;
}

/** 高频选项直接展示，字段语义与质量门禁折叠，减少首次配置成本。 */
export function AiDataRunPolicyFields({ value, fields, onChange }: AiDataRunPolicyFieldsProps) {
  const patch = <K extends keyof AiDataRunPolicyDraft>(key: K, next: AiDataRunPolicyDraft[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <section className="ai-run-policy">
      <div className="ai-run-policy-primary">
        <label>
          <span>运行方式</span>
          <select value={value.mode} onChange={(event) => patch("mode", event.target.value as AiDataRunPolicyDraft["mode"])}>
            <option value="manual">按需运行</option>
            <option value="interval">自动周期运行</option>
          </select>
        </label>
        {value.mode === "interval" && (
          <label>
            <span>运行周期</span>
            <div className="ai-run-policy-number">
              <input type="number" min={1} value={value.intervalSeconds} onChange={(event) => patch("intervalSeconds", positive(event.target.value, 60))} />
              <em>秒</em>
            </div>
          </label>
        )}
      </div>
      <small className="ai-run-policy-hint">
        <Clock3 size={12} /> 数据集负责采集刷新，这里只控制模型何时读取最近窗口。
      </small>
      <details>
        <summary>
          <ChevronDown size={13} />
          高级策略
          <small>窗口、设备字段和质量门禁</small>
        </summary>
        <div className="ai-run-policy-grid">
          <label>
            <span>最近窗口</span>
            <div className="ai-run-policy-number">
              <input type="number" min={1} value={value.windowRows} onChange={(event) => patch("windowRows", positive(event.target.value, 60))} />
              <em>条</em>
            </div>
          </label>
          <label>
            <span>最少有效样本</span>
            <input type="number" min={1} value={value.minimumSamples} onChange={(event) => patch("minimumSamples", positive(event.target.value, 1))} />
          </label>
          <label>
            <span>设备标识字段</span>
            <select value={value.entityField} onChange={(event) => patch("entityField", event.target.value)}>
              <option value="">不按设备拆分</option>
              {fields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
            </select>
          </label>
          <label>
            <span>时间字段</span>
            <select value={value.timeField} onChange={(event) => patch("timeField", event.target.value)}>
              <option value="">使用读取时间</option>
              {fields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
            </select>
          </label>
          <label>
            <span>最大数据延迟</span>
            <div className="ai-run-policy-number">
              <input type="number" min={1} value={value.maxAgeSeconds} onChange={(event) => patch("maxAgeSeconds", positive(event.target.value, 300))} />
              <em>秒</em>
            </div>
          </label>
          <label>
            <span>允许缺失率</span>
            <div className="ai-run-policy-number">
              <input type="number" min={0} max={100} value={Math.round(value.maximumMissingRate * 100)} onChange={(event) => patch("maximumMissingRate", ratio(event.target.value))} />
              <em>%</em>
            </div>
          </label>
        </div>
        <p><ShieldCheck size={13} /> 超过缺失率或数据过期时暂停本次推理并记录原因，不生成伪结果。</p>
      </details>
    </section>
  );
}

function positive(value: string, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ratio(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed / 100)) : 0.2;
}
