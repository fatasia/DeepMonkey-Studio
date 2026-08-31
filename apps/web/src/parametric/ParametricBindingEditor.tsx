import type { ParametricCadDefinition } from "@bim-studio/contracts";
import { bindingTargetKey, type ParametricBindingSource } from "@bim-studio/parametric-modeling-plugin";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

interface ParametricBindingEditorProps {
  locale: AppLocale;
  definition: ParametricCadDefinition;
  sources: ParametricBindingSource[];
  onChange: (parameterId: string, sourceKey: string) => void;
}

/** 把几何参数绑定到项目数据目录；自由文本不作为可执行运行绑定。 */
export function ParametricBindingEditor({ locale, definition, sources, onChange }: ParametricBindingEditorProps) {
  const activeCount = definition.semanticBindings?.filter((binding) => binding.target).length ?? 0;
  return (
    <details>
      <summary>
        {tr(locale, "设备、数据与仿真绑定", "Device, data & simulation bindings")}
        <small>{activeCount} / {definition.parameters.length}</small>
      </summary>
      <p className="parametric-binding-help">
        {sources.length
          ? tr(locale, "绑定只引用项目数据目录；连接或字段失效时服务端会阻止保存。", "Bindings reference the project data catalog; stale fields are rejected on save.")
          : tr(locale, "项目中暂无可绑定的数据集字段。可先在数据中心建立设备、仿真或业务数据集。", "No bindable dataset fields yet. Create a device, simulation, or business dataset in Data Center first.")}
      </p>
      {definition.parameters.map((parameter) => {
        const binding = definition.semanticBindings?.find((item) => item.parameterId === parameter.id);
        return (
          <label className="parametric-binding-editor" key={parameter.id}>
            <span>
              <strong>{parameter.label}</strong>
              <small>{binding?.meaning ?? parameter.semantic ?? parameter.id}</small>
            </span>
            <select
              value={binding?.target ? bindingTargetKey(binding.target) : ""}
              onChange={(event) => onChange(parameter.id, event.target.value)}
            >
              <option value="">{tr(locale, "仅保留设计语义", "Design semantics only")}</option>
              {sources.map((source) => <option key={source.key} value={source.key}>{source.label}</option>)}
            </select>
            {binding?.target && <code>{binding.target.kind}</code>}
          </label>
        );
      })}
    </details>
  );
}
