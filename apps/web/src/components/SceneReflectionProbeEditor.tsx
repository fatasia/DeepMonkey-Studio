import type { ProjectAssetRecord, SceneEnvironmentState, SceneReflectionProbeState, Vector3Value } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

interface Props { locale: AppLocale; value: SceneEnvironmentState; assets: ProjectAssetRecord[]; onChange(value: SceneEnvironmentState): void }
export function SceneReflectionProbeEditor({ locale, value, assets, onChange }: Props) {
  const probes = value.reflectionProbes ?? [];
  const replace = (index: number, patch: Partial<SceneReflectionProbeState>) => onChange({ ...value,
    reflectionProbes: probes.map((probe, slot) => slot === index ? { ...probe, ...patch } : probe) });
  const environments = assets.filter(asset => asset.maps?.some(map => map.kind === "environment"));
  const vector = (probe: SceneReflectionProbeState, index: number, key: "center" | "halfExtents", title: string) => (
    <div className="light-vector"><span>{title} (m)</span>
      {(["x", "y", "z"] as const).map(axis => <label key={axis}><i>{axis.toUpperCase()}</i><input type="number" step="0.1"
        aria-label={`${probe.name} ${title} ${axis.toUpperCase()} (m)`} min={key === "halfExtents" ? 0.000001 : -1e9} max={1e9}
        value={probe[key][axis]} onChange={event => {
          const number = event.target.valueAsNumber;
          if (Number.isFinite(number) && number >= (key === "halfExtents" ? 1e-6 : -1e9) && number <= 1e9) replace(index, { [key]: { ...probe[key], [axis]: number } as Vector3Value });
        }} /></label>)}
    </div>
  );
  return <details className="post-processing-control reflection-probe-editor">
    <summary>{tr(locale, "局部反射探针", "Local reflection probes")} · {probes.length}/2</summary>
    <p className="panel-note">{tr(locale, "Deep WebGPU 使用房间盒校正反射。影响范围外保留全局环境；混合距离控制相邻探针过渡。", "Deep WebGPU corrects reflections within a room box. Global IBL remains outside coverage; blend distance controls adjacent probes.")}</p>
    {probes.map((probe, index) => <div className="light-editor" key={probe.id}>
      <div className="light-system-head"><label><input type="checkbox" checked={probe.enabled}
        onChange={event => replace(index, { enabled: event.target.checked })} />{probe.name}</label>
        <button type="button" aria-label={`${tr(locale, "移除", "Remove")} ${probe.name}`} onClick={() => onChange({ ...value,
          reflectionProbes: probes.filter((_, slot) => slot !== index) })}>{tr(locale, "移除", "Remove")}</button></div>
      {vector(probe, index, "center", tr(locale, "中心", "Center"))}
      {vector(probe, index, "halfExtents", tr(locale, "半尺寸", "Half extents"))}
      {(["blendDistance", "influenceRadius"] as const).map(key => <label className="post-quality-select" key={key}>
        <span>{key === "blendDistance" ? tr(locale, "混合距离", "Blend distance") : tr(locale, "影响外扩", "Influence radius")} (m)</span>
        <input type="number" min={0} max={1e9} step="0.1" value={probe[key]}
          aria-label={`${probe.name} ${key === "blendDistance" ? tr(locale, "混合距离", "Blend distance") : tr(locale, "影响外扩", "Influence radius")} (m)`}
          onChange={event => { const number = event.target.valueAsNumber; if (Number.isFinite(number) && number >= 0 && number <= 1e9) replace(index, { [key]: number }); }} />
      </label>)}
      <label className="post-quality-select"><span>{tr(locale, "反射环境", "Reflection source")}</span>
        <select aria-label={`${probe.name} ${tr(locale, "反射环境", "Reflection source")}`} value={probe.environmentMapUrl ?? ""} onChange={event => {
          const url = event.target.value, asset = environments.find(item => item.maps?.some(map => map.kind === "environment" && map.url === url));
          if (!url) { const next = { ...probe }; delete next.environmentMapUrl; delete next.environmentMapName;
            onChange({ ...value, reflectionProbes: probes.map((item, slot) => slot === index ? next : item) }); }
          else replace(index, { environmentMapUrl: url, environmentMapName: asset?.name ?? probe.environmentMapName ?? url });
        }}><option value="">{tr(locale, "继承当前环境", "Inherit current environment")}</option>
          {environments.map(asset => <option key={asset.id} value={asset.maps!.find(map => map.kind === "environment")!.url}>{asset.name}</option>)}
          {probe.environmentMapUrl && !environments.some(asset => asset.maps?.some(map => map.url === probe.environmentMapUrl))
            && <option value={probe.environmentMapUrl}>{probe.environmentMapName ?? probe.environmentMapUrl}</option>}
        </select></label>
    </div>)}
    <button type="button" disabled={probes.length >= 2} title={probes.length >= 2 ? tr(locale, "当前预算最多两个探针", "Current budget supports two probes") : undefined}
      onClick={() => onChange({ ...value, reflectionProbes: [...probes, { id: crypto.randomUUID(),
        name: tr(locale, `探针 ${probes.length + 1}`, `Probe ${probes.length + 1}`), enabled: true,
        center: { x: 0, y: 2, z: 0 }, halfExtents: { x: 5, y: 2, z: 5 }, blendDistance: 1, influenceRadius: 2 }] })}>
      {tr(locale, "添加反射探针", "Add reflection probe")}</button>
  </details>;
}
