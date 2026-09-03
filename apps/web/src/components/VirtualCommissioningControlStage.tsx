import type { SceneSnapshot, VirtualDebugSignalBinding } from "@bim-studio/contracts";
import { LoaderCircle, Play, Plus, SlidersHorizontal } from "lucide-react";
import type { VirtualDebugObjectOption } from "./virtualCommissioningModel";
import { VIRTUAL_DEBUG_SIGNALS } from "./virtualCommissioningDraft";
import { BindingRow, NumberField } from "./VirtualCommissioningControls";
import { VirtualCommissioningTestDesignPanel } from "./VirtualCommissioningTestDesignPanel";

interface Props {
  scene: SceneSnapshot;
  objects: VirtualDebugObjectOption[];
  bindings: VirtualDebugSignalBinding[];
  durationMs: number;
  tickMs: number;
  speedSetpoint: number;
  faultEnabled: boolean;
  faultAtMs: number;
  resetEnabled: boolean;
  resetAtMs: number;
  acceptanceAtMs: number;
  acceptanceSignal: string;
  acceptanceText: string;
  busy: boolean;
  onRunScenario: () => void;
  onRunSuite: () => void;
  onDurationChange: (value: number) => void;
  onTickChange: (value: number) => void;
  onSpeedChange: (value: number) => void;
  onFaultEnabledChange: (value: boolean) => void;
  onFaultAtChange: (value: number) => void;
  onResetEnabledChange: (value: boolean) => void;
  onResetAtChange: (value: number) => void;
  onAcceptanceAtChange: (value: number) => void;
  onAcceptanceSignalChange: (value: string) => void;
  onAcceptanceTextChange: (value: string) => void;
  onAddBinding: () => void;
  onBindingChange: (id: string, patch: Partial<VirtualDebugSignalBinding>) => void;
  onBindingRemove: (id: string) => void;
}

/** 普通用户直接运行预设；只有自定义用例才展开信号、时间和断言。 */
export function VirtualCommissioningControlStage(props: Props) {
  const runnable = props.objects.length > 0 && props.bindings.length > 0;
  return <section id="commissioning-control-validation" className="commissioning-control-stage" tabIndex={-1} aria-labelledby="commissioning-control-title">
    <header className="commissioning-control-stage-header">
      <div>
        <span>当前任务</span>
        <h3 id="commissioning-control-title">验证控制逻辑</h3>
        <p>直接运行预设，检查启动、故障联锁、复位和告警结果。</p>
      </div>
      <div className="commissioning-title-actions">
        <button type="button" className="commissioning-run" disabled={props.busy || !runnable} onClick={props.onRunSuite}>
          {props.busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{props.busy ? "正在验证" : "验证控制逻辑"}
        </button>
      </div>
    </header>
    <div className="commissioning-preset-summary" aria-label="当前验证预设">
      <strong>{props.scene.name}</strong>
      <span>启动</span><span>故障联锁</span><span>人工复位</span><span>结果留证</span>
    </div>
    {!props.objects.length && <p className="commissioning-inline-empty">当前工位没有可映射设备。请返回“检查任务”补充场景对象。</p>}
    {props.objects.length > 0 && !props.bindings.length && <p className="commissioning-inline-empty">当前没有控制信号映射。展开“自定义用例”添加信号后再运行。</p>}
    <details className="commissioning-custom-case">
      <summary><span><SlidersHorizontal size={14} />自定义用例</span><small>信号映射、时间和断言</small></summary>
      <div className="commissioning-custom-case-body">
        <p className="commissioning-control-scope">本阶段只验证控制逻辑，不替代机器人精确运动、碰撞或真实控制器校核。</p>
        <section className="commissioning-config">
          <fieldset>
            <legend>运行参数</legend>
            <div className="commissioning-field-grid">
              <NumberField label="运行时长 ms" value={props.durationMs} min={100} step={50} onChange={props.onDurationChange} />
              <NumberField label="采样周期 ms" value={props.tickMs} min={10} step={10} onChange={props.onTickChange} />
              <NumberField label="速度设定" value={props.speedSetpoint} min={0} step={100} onChange={props.onSpeedChange} />
            </div>
          </fieldset>
          <fieldset>
            <legend>故障与复位</legend>
            <ToggleTime label="注入设备联锁故障" enabled={props.faultEnabled} atMs={props.faultAtMs} tickMs={props.tickMs} timeLabel="故障时间 ms" onEnabled={props.onFaultEnabledChange} onTime={props.onFaultAtChange} />
            <ToggleTime label="执行人工复位" enabled={props.resetEnabled} atMs={props.resetAtMs} tickMs={props.tickMs} timeLabel="复位时间 ms" onEnabled={props.onResetEnabledChange} onTime={props.onResetAtChange} />
          </fieldset>
          <fieldset>
            <legend className="commissioning-legend-row"><span>控制信号映射</span><button type="button" onClick={props.onAddBinding}><Plus size={13} />添加信号</button></legend>
            <div className="commissioning-bindings">{props.bindings.map((binding) => <BindingRow
              key={binding.id} binding={binding} objects={props.objects}
              onChange={(patch) => props.onBindingChange(binding.id, patch)} onRemove={() => props.onBindingRemove(binding.id)}
            />)}</div>
          </fieldset>
          <fieldset>
            <legend>结果断言</legend>
            <div className="commissioning-assertion">
              <span>在</span><input type="number" min="0" step={props.tickMs} value={props.acceptanceAtMs} onChange={(event) => props.onAcceptanceAtChange(Number(event.target.value))} />
              <span>ms，信号</span><select value={props.acceptanceSignal} onChange={(event) => props.onAcceptanceSignalChange(event.target.value)}>{VIRTUAL_DEBUG_SIGNALS.map((item) => <option key={item}>{item}</option>)}</select>
              <span>应等于</span><input value={props.acceptanceText} onChange={(event) => props.onAcceptanceTextChange(event.target.value)} />
            </div>
          </fieldset>
        </section>
        <VirtualCommissioningTestDesignPanel sceneId={props.scene.id} bindings={props.bindings} durationMs={props.durationMs} tickMs={props.tickMs} speedSetpoint={props.speedSetpoint} />
        <footer className="commissioning-custom-case-actions">
          <span>只运行上方当前用例，不执行完整预设。</span>
          <button type="button" className="commissioning-suite-run" disabled={props.busy || !runnable} onClick={props.onRunScenario}>
            <Play size={14} />运行当前用例
          </button>
        </footer>
      </div>
    </details>
  </section>;
}

function ToggleTime({ label, enabled, atMs, tickMs, timeLabel, onEnabled, onTime }: {
  label: string; enabled: boolean; atMs: number; tickMs: number; timeLabel: string;
  onEnabled: (value: boolean) => void; onTime: (value: number) => void;
}) {
  return <div className="commissioning-switch-row">
    <label><input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} />{label}</label>
    {enabled && <NumberField label={timeLabel} value={atMs} min={0} step={tickMs} onChange={onTime} />}
  </div>;
}
