import { Link2, Trash2 } from "lucide-react";
import type { VirtualDebugSignalBinding } from "@bim-studio/contracts";
import type { VirtualDebugObjectOption } from "./virtualCommissioningModel";
import { VIRTUAL_DEBUG_SIGNALS } from "./virtualCommissioningDraft";

export function BindingRow({
  binding,
  objects,
  onChange,
  onRemove,
}: {
  binding: VirtualDebugSignalBinding;
  objects: VirtualDebugObjectOption[];
  onChange: (patch: Partial<VirtualDebugSignalBinding>) => void;
  onRemove: () => void;
}) {
  return (
    <article>
      <Link2 size={14} />
      <select
        aria-label="控制信号"
        value={binding.signal}
        onChange={(event) => onChange({ signal: event.target.value, label: event.target.value })}
      >
        {VIRTUAL_DEBUG_SIGNALS.map((signal) => (
          <option key={signal}>{signal}</option>
        ))}
      </select>
      <span>→</span>
      <select
        aria-label="场景设备"
        value={binding.target.objectId}
        onChange={(event) => {
          const target = objects.find((item) => item.id === event.target.value);
          if (!target) return;
          onChange({
            target: { ...binding.target, objectId: target.id, objectKind: target.kind },
          });
        }}
      >
        {objects.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <select
        aria-label="呈现方式"
        value={binding.presentation}
        onChange={(event) =>
          onChange({ presentation: event.target.value as VirtualDebugSignalBinding["presentation"] })
        }
      >
        <option value="running">运行状态</option>
        <option value="alarm">告警状态</option>
        <option value="value">数值</option>
      </select>
      <button type="button" aria-label="删除信号映射" onClick={onRemove}>
        <Trash2 size={13} />
      </button>
    </article>
  );
}

export function NumberField({
  label,
  value,
  min,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
