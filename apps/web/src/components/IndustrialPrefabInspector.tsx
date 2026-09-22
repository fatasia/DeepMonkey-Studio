import { Pause, Play, Plus, RotateCcw, Square, Trash2 } from "lucide-react";
import type {
  IndustrialPrefabDefinition,
  IndustrialPrefabInstanceState,
  IndustrialPrefabParameterDefinition,
  IndustrialPrefabRuntimeAction,
  SceneMotionRoutePoint,
  SceneLinearPrefabPathPoint,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { INDUSTRIAL_PREFAB_CATALOG, industrialPrefabDefinition } from "../prefabs/industrialPrefabCatalog";
import { createIndustrialPrefabInstance } from "../prefabs/industrialPrefabInstance";
import type { ViewerEngine } from "../viewer/ViewerEngine";

export function IndustrialPrefabInspector({
  locale,
  engine,
  modelId,
  disabled,
  onChange,
  onCommit,
}: {
  locale: AppLocale;
  engine: ViewerEngine;
  modelId: string;
  disabled: boolean;
  onChange: () => void;
  onCommit?: (label: string) => void;
}) {
  const state = engine.getIndustrialPrefabState(modelId);
  if (!state) return <AttachPrefab locale={locale} engine={engine} modelId={modelId} disabled={disabled} onChange={onChange} />;
  const definition = industrialPrefabDefinition(state.definitionId);
  const route = state.motionRoute;
  const placementPath = state.placementPath;

  function save(next: IndustrialPrefabInstanceState, label = "更新工业预制体") {
    engine.setIndustrialPrefabState(modelId, next);
    onChange();
    onCommit?.(label);
  }

  function run(action: IndustrialPrefabRuntimeAction) {
    engine.executeIndustrialPrefabAction(modelId, action);
    onChange();
  }

  return (
    <details className="industrial-prefab-inspector" open>
      <summary>
        <span>{tr(locale, "工业预制体", "Industrial prefab")}</span>
        <small>{definition ? tr(locale, definition.name, definition.englishName) : state.definitionId}</small>
        <i data-state={state.operatingState}>{operatingStateLabel(locale, state.operatingState)}</i>
      </summary>
      <div className="industrial-prefab-body">
        {definition && (
          <details>
            <summary>{tr(locale, "设备参数", "Device parameters")}</summary>
            <div className="industrial-prefab-fields">
              {definition.parameters.map((parameter) => (
                <ParameterField
                  key={parameter.key}
                  locale={locale}
                  definition={parameter}
                  value={state.parameters[parameter.key] ?? parameter.defaultValue}
                  disabled={disabled}
                  onChange={(value) => save({ ...state, parameters: { ...state.parameters, [parameter.key]: value } })}
                />
              ))}
            </div>
          </details>
        )}
        {route && (
          <section className="industrial-route-editor">
            <header>
              <div>
                <strong>{tr(locale, "运动路线", "Motion route")}</strong>
                <small>{tr(locale, "坐标为场景绝对坐标；到点事件可直接驱动脚本和联动", "Uses scene coordinates and emits route-point events")}</small>
              </div>
              <label>
                <input type="checkbox" disabled={disabled} checked={route.enabled} onChange={(event) => save({ ...state, motionRoute: { ...route, enabled: event.target.checked } })} />
                {tr(locale, "启用", "Enabled")}
              </label>
            </header>
            <div className="industrial-route-playback">
              <label>
                <input type="checkbox" disabled={disabled} checked={route.autoplay ?? false} onChange={(event) => save({ ...state, motionRoute: { ...route, autoplay: event.target.checked } })} />
                {tr(locale, "自动播放", "Autoplay")}
              </label>
              <label>
                <span>{tr(locale, "播放方式", "Playback")}</span>
                <select disabled={disabled} value={route.loopMode} onChange={(event) => save({ ...state, motionRoute: { ...route, loopMode: event.target.value as typeof route.loopMode } })}>
                  <option value="once">{tr(locale, "播放一次", "Once")}</option>
                  <option value="loop">{tr(locale, "循环播放", "Loop")}</option>
                  <option value="ping-pong">{tr(locale, "往返循环", "Ping-pong")}</option>
                </select>
              </label>
              <NumberField label={tr(locale, "速度", "Speed")} unit="m/s" value={route.speedMps} min={0.01} step={0.05} disabled={disabled} onChange={(value) => save({ ...state, motionRoute: { ...route, speedMps: value } })} />
              <NumberField label={tr(locale, "加速度", "Acceleration")} unit="m/s²" value={route.accelerationMps2} min={0.01} step={0.05} disabled={disabled} onChange={(value) => save({ ...state, motionRoute: { ...route, accelerationMps2: value } })} />
              <label>
                <input type="checkbox" disabled={disabled} checked={route.orientToPath} onChange={(event) => save({ ...state, motionRoute: { ...route, orientToPath: event.target.checked } })} />
                {tr(locale, "沿路线转向", "Orient to path")}
              </label>
            </div>
            <div className="industrial-route-points">
              {route.points.map((point, index) => (
                <RoutePointRow
                  key={point.id}
                  locale={locale}
                  point={point}
                  index={index}
                  disabled={disabled}
                  onChange={(next) => save({ ...state, motionRoute: { ...route, points: route.points.map((candidate) => (candidate.id === point.id ? next : candidate)) } })}
                  onDelete={() => save({ ...state, motionRoute: { ...route, points: route.points.filter((candidate) => candidate.id !== point.id) } })}
                />
              ))}
              <button disabled={disabled} onClick={() => save({ ...state, motionRoute: { ...route, points: [...route.points, nextRoutePoint(route.points)] } })}>
                <Plus size={12} /> {tr(locale, "添加路线点", "Add point")}
              </button>
            </div>
            <div className="industrial-route-controls">
              <button disabled={disabled || route.points.length < 2} onClick={() => run("dispatch")}><Play size={12} />{tr(locale, "派发", "Dispatch")}</button>
              <button disabled={disabled} onClick={() => run("pause")}><Pause size={12} />{tr(locale, "暂停", "Pause")}</button>
              <button disabled={disabled} onClick={() => run("resume")}><Play size={12} />{tr(locale, "继续", "Resume")}</button>
              <button disabled={disabled} onClick={() => run("stop")}><Square size={11} />{tr(locale, "停止", "Stop")}</button>
              <button disabled={disabled} onClick={() => run("replay")}><RotateCcw size={12} />{tr(locale, "重播", "Replay")}</button>
            </div>
          </section>
        )}
        {placementPath && (
          <section className="industrial-route-editor industrial-placement-path-editor">
            <header>
              <div>
                <strong>{tr(locale, "铺设路径", "Placement path")}</strong>
                <small>{tr(locale, "编辑围栏或道路端点；样条和贴地使用同一发布合同", "Edit fence or road points with the same spline and ground contract used for publishing")}</small>
              </div>
              <label>
                <input type="checkbox" disabled={disabled} checked={placementPath.snapToGround}
                  onChange={(event) => save({ ...state, placementPath: { ...placementPath, snapToGround: event.target.checked } }, "更新铺设贴地方式")} />
                {tr(locale, "贴地", "Snap to ground")}
              </label>
            </header>
            <div className="industrial-route-playback">
              <label><span>{tr(locale, "路径类型", "Path type")}</span>
                <select disabled={disabled} value={placementPath.interpolation}
                  onChange={(event) => save({ ...state, placementPath: { ...placementPath,
                    interpolation: event.target.value as typeof placementPath.interpolation } }, "更新铺设路径类型")}>
                  <option value="linear">{tr(locale, "直线折线", "Linear")}</option>
                  <option value="catmull-rom">{tr(locale, "平滑样条", "Smooth spline")}</option>
                </select>
              </label>
              <label><input type="checkbox" disabled={disabled} checked={placementPath.closed}
                onChange={(event) => save({ ...state, placementPath: { ...placementPath, closed: event.target.checked } }, "更新铺设闭环")} />
                {tr(locale, "闭合", "Closed")}
              </label>
              <NumberField label={tr(locale, "固定种子", "Fixed seed")} value={placementPath.seed} min={0}
                max={0xffff_ffff} step={1} disabled={disabled}
                onChange={(value) => save({ ...state, placementPath: { ...placementPath, seed: Math.trunc(value) } }, "更新铺设种子")} />
            </div>
            <div className="industrial-route-points">
              {placementPath.points.map((point, index) => <PathPointRow key={point.id} locale={locale}
                point={point} index={index} disabled={disabled} deleteDisabled={disabled || placementPath.points.length <= 2}
                onChange={(next) => save({ ...state, placementPath: { ...placementPath,
                  points: placementPath.points.map(candidate => candidate.id === point.id ? next : candidate) } }, "编辑铺设端点")}
                onDelete={() => placementPath.points.length > 2 && save({ ...state, placementPath: { ...placementPath,
                  points: placementPath.points.filter(candidate => candidate.id !== point.id) } }, "删除铺设端点")} />)}
              <button disabled={disabled || placementPath.points.length >= 512}
                onClick={() => save({ ...state, placementPath: { ...placementPath,
                  points: [...placementPath.points, nextPathPoint(placementPath.points)] } }, "添加铺设端点")}>
                <Plus size={12} /> {tr(locale, "添加端点", "Add point")}
              </button>
            </div>
          </section>
        )}
        <button className="industrial-prefab-remove" disabled={disabled} onClick={() => { engine.setIndustrialPrefabState(modelId, undefined); onChange(); }}>
          <Trash2 size={12} /> {tr(locale, "移除预制体配置", "Remove prefab configuration")}
        </button>
      </div>
    </details>
  );
}

function AttachPrefab({ locale, engine, modelId, disabled, onChange }: { locale: AppLocale; engine: ViewerEngine; modelId: string; disabled: boolean; onChange: () => void }) {
  function attach(definition: IndustrialPrefabDefinition) {
    const transform = engine.getModelTransform(modelId);
    const start = transform?.position ?? { x: 0, y: 0, z: 0 };
    engine.setIndustrialPrefabState(modelId, createIndustrialPrefabInstance(definition, start));
    onChange();
  }
  return (
    <details className="industrial-prefab-inspector">
      <summary><span>{tr(locale, "工业预制体", "Industrial prefab")}</span><small>{tr(locale, "为模型添加设备参数、动作与路线", "Add parameters, actions and routes")}</small></summary>
      <div className="industrial-prefab-attach-grid">
        {INDUSTRIAL_PREFAB_CATALOG.map((definition) => (
          <button key={definition.id} disabled={disabled} onClick={() => attach(definition)}>
            <strong>{tr(locale, definition.name, definition.englishName)}</strong>
            <small>{definition.routeCapable ? tr(locale, "可配置路线", "Route ready") : tr(locale, definition.description, definition.englishDescription)}</small>
          </button>
        ))}
      </div>
    </details>
  );
}

function ParameterField({ locale, definition, value, disabled, onChange }: { locale: AppLocale; definition: IndustrialPrefabParameterDefinition; value: string | number | boolean; disabled: boolean; onChange: (value: string | number | boolean) => void }) {
  const name = tr(locale, definition.name, definition.englishName);
  if (definition.kind === "boolean") return <label><input type="checkbox" disabled={disabled} checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /><span>{name}</span></label>;
  if (definition.kind === "select") return <label><span>{name}</span><select disabled={disabled} value={String(value)} onChange={(event) => onChange(event.target.value)}>{definition.options?.map((option) => <option key={option}>{option}</option>)}</select></label>;
  if (definition.kind === "text") return <label><span>{name}</span><input type="text" disabled={disabled} value={String(value)} onChange={(event) => onChange(event.target.value)} /></label>;
  return <NumberField label={name} {...(definition.unit ? { unit: definition.unit } : {})} value={typeof value === "number" ? value : 0} {...(definition.min === undefined ? {} : { min: definition.min })} {...(definition.max === undefined ? {} : { max: definition.max })} {...(definition.step === undefined ? {} : { step: definition.step })} disabled={disabled} onChange={onChange} />;
}

function NumberField({ label, unit, value, min, max, step, disabled, onChange }: { label: string; unit?: string; value: number; min?: number; max?: number; step?: number; disabled: boolean; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" disabled={disabled} value={value} {...(min === undefined ? {} : { min })} {...(max === undefined ? {} : { max })} step={step ?? 0.1} onChange={(event) => {
    const numeric = Number(event.target.value);
    if (!Number.isFinite(numeric)) return;
    onChange(Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, numeric)));
  }} />{unit && <i>{unit}</i>}</label>;
}

function RoutePointRow({ locale, point, index, disabled, onChange, onDelete }: { locale: AppLocale; point: SceneMotionRoutePoint; index: number; disabled: boolean; onChange: (point: SceneMotionRoutePoint) => void; onDelete: () => void }) {
  return <div className="industrial-route-point"><strong>P{index + 1}</strong>{(["x", "y", "z"] as const).map((axis) => <label key={axis}><span>{axis.toUpperCase()}</span><input type="number" disabled={disabled} value={point.position[axis]} step="0.1" onChange={(event) => onChange({ ...point, position: { ...point.position, [axis]: Number(event.target.value) } })} /></label>)}<label><span>{tr(locale, "停留", "Wait")}</span><input type="number" disabled={disabled} min="0" step="0.1" value={point.waitSeconds ?? 0} onChange={(event) => onChange({ ...point, waitSeconds: Math.max(0, Number(event.target.value)) })} /></label><button disabled={disabled} title={tr(locale, "删除路线点", "Delete point")} onClick={onDelete}><Trash2 size={11} /></button></div>;
}

function PathPointRow({ locale, point, index, disabled, deleteDisabled, onChange, onDelete }: { locale: AppLocale; point: SceneLinearPrefabPathPoint; index: number; disabled: boolean; deleteDisabled: boolean; onChange: (point: SceneLinearPrefabPathPoint) => void; onDelete: () => void }) {
  return <div className="industrial-route-point"><strong>P{index + 1}</strong>{(["x", "y", "z"] as const).map(axis =>
    <label key={axis}><span>{axis.toUpperCase()}</span><input type="number" disabled={disabled}
      value={point.position[axis]} step="0.1" onChange={(event) => {
        const value = Number(event.target.value);
        if (Number.isFinite(value)) onChange({ ...point, position: { ...point.position, [axis]: value } });
      }} /></label>)}<button disabled={deleteDisabled} title={tr(locale, "删除铺设端点", "Delete placement point")} onClick={onDelete}><Trash2 size={11} /></button></div>;
}

function nextRoutePoint(points: SceneMotionRoutePoint[]): SceneMotionRoutePoint {
  const previous = points.at(-1)?.position ?? { x: 0, y: 0, z: 0 };
  return { id: crypto.randomUUID(), position: { ...previous, x: previous.x + 5 }, waitSeconds: 0 };
}

function nextPathPoint(points: SceneLinearPrefabPathPoint[]): SceneLinearPrefabPathPoint {
  const previous = points.at(-1)?.position ?? { x: 0, y: 0, z: 0 };
  return { id: crypto.randomUUID(), position: { ...previous, x: previous.x + 5 } };
}

function operatingStateLabel(locale: AppLocale, state: IndustrialPrefabInstanceState["operatingState"]): string {
  const labels = { idle: ["空闲", "Idle"], running: ["运行中", "Running"], paused: ["已暂停", "Paused"], fault: ["故障", "Fault"], maintenance: ["维护", "Maintenance"] } as const;
  const label = labels[state];
  return tr(locale, label[0], label[1]);
}
