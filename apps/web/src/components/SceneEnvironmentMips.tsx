import type { SceneEnvironmentState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export function SceneEnvironmentMips({ locale, environment, active, onChange }: {
  locale: AppLocale; environment: SceneEnvironmentState; active: boolean;
  onChange: (value: SceneEnvironmentState) => void;
}) {
  return <div className="environment-row environment-compact-row">
    {/* 标签点击聚焦下方下拉;28px 最小点击目标由 .environment-field-label 统一保证(UI 红线)。 */}
    <label htmlFor="environment-specular-mips" className="environment-field-label">{tr(locale, "反射细节", "Reflection detail")}</label>
    <select id="environment-specular-mips" value={environment.environmentSpecularMips ?? "full"}
      disabled={!active} className="environment-field-select"
      title={tr(locale, active ? "降低细节可减少环境反射显存，保留粗糙表面的照明。" : "切换到 Deep WebGPU 后可调整反射细节。",
        active ? "Lower detail reduces reflection memory while preserving rough-surface lighting." : "Switch to Deep WebGPU to adjust reflection detail.")}
      onChange={event => {
        const next = { ...environment };
        if (event.target.value === "full") delete next.environmentSpecularMips;
        else {
          const value = Number(event.target.value);
          if (!Number.isInteger(value) || value < 1 || value > 8) return;
          next.environmentSpecularMips = value;
        }
        onChange(next);
      }}>
      <option value="full">{tr(locale, "完整", "Full")}</option>
      <option value="6">{tr(locale, "均衡 · 6 层", "Balanced · 6 levels")}</option>
      <option value="4">{tr(locale, "轻量 · 4 层", "Light · 4 levels")}</option>
      <option value="1">{tr(locale, "最低 · 1 层", "Minimum · 1 level")}</option>
      {[2, 3, 5, 7, 8].includes(environment.environmentSpecularMips ?? 0)
        && <option value={environment.environmentSpecularMips}>{tr(locale, `${environment.environmentSpecularMips} 层`, `${environment.environmentSpecularMips} levels`)}</option>}
    </select>
  </div>;
}
