import type { SceneMaterialState } from "@bim-studio/contracts";
import type { AppStudioController } from "../views/AppStudioShell";
import { translate as tr } from "../i18n";
import { DeferredNumberInput } from "./AppFormControls";

type Props = Pick<AppStudioController, "engine" | "locale" | "sceneOrganizationSelection" | "bindings" | "setRevision">;
const numericFields = [
  ["roughness", "粗糙度", "Roughness", 0, 1],
  ["metalness", "金属度", "Metalness", 0, 1],
  ["emissiveIntensity", "自发光强度", "Emissive intensity", 0, 10],
  ["normalScale", "法线强度", "Normal strength", 0, 4],
  ["ior", "折射率", "Index of refraction", 1, 3.4028234663852886e38],
] as const;
const booleanFields = [["doubleSided", "双面", "Double-sided"], ["wireframe", "线框", "Wireframe"]] as const;
type Field = typeof numericFields[number][0] | typeof booleanFields[number][0];

export function SceneMultiMaterialEditor(props: Props) {
  const { engine, locale, sceneOrganizationSelection } = props;
  const allStates = [...sceneOrganizationSelection].flatMap(id => engine?.getModelMaterialStates(id) ?? []);
  const editableStates = [...sceneOrganizationSelection].flatMap(id => engine && !engine.isModelLocked(id) ? engine.getModelMaterialStates(id) : []);
  function common(field: Field) {
    const first = allStates[0]?.[field];
    return allStates.length && allStates.every(state => state[field] === first) ? first : undefined;
  }
  function supported(field: Field) {
    return editableStates.length > 0 && editableStates.every(state => state[field] !== undefined);
  }
  function apply(field: Field, value: number | boolean) {
    if (!engine || (typeof value === "number" && !Number.isFinite(value))) return;
    const patches: Array<{ id: string; patch: SceneMaterialState }> = [];
    for (const id of sceneOrganizationSelection) {
      if (engine.isModelLocked(id)) continue;
      const states = engine.getModelMaterialStates(id);
      if (!states.length || states.some(state => state[field] === undefined) || states.every(state => state[field] === value)) continue;
      const patch: SceneMaterialState = { [field]: value };
      const slots = engine.getModelMaterialOverride(id)?.slotOverrides;
      // 批量设值覆盖所有槽的同一参数，保留各槽其他作者差异。
      if (slots) patch.slotOverrides = Object.fromEntries(Object.entries(slots).map(([key, state]) => [key, { ...state, [field]: value }]));
      patches.push({ id, patch });
    }
    if (!patches.length) return;
    props.bindings.sceneHistory.flush();
    for (const { id, patch } of patches) engine.setModelMaterial(id, patch);
    const label = tr(locale, "批量修改材质", "Edit selected materials");
    props.bindings.sceneEditor.recordSceneEdit(label);
    props.setRevision(revision => revision + 1);
    props.bindings.sceneHistory.flush(label);
  }
  if (!allStates.length) return null;
  return <section aria-label={tr(locale, "多选材质", "Selected materials")}>
    <div className="section-label"><span>{tr(locale, "材质 · 全部材质槽", "Material · all slots")}</span></div>
    <div className="two-column">
      {numericFields.map(([field, zh, en, min, max]) => {
        const value = common(field);
        return <label className="field" key={field}><span>{tr(locale, zh, en)}</span><DeferredNumberInput
          key={`${[...sceneOrganizationSelection].join("|")}:${field}`} ariaLabel={tr(locale, zh, en)}
          value={typeof value === "number" ? value : undefined} placeholder={tr(locale, "混合", "Mixed")}
          min={min} max={max} step={0.01} disabled={!supported(field)} onCommit={next => apply(field, next)} /></label>;
      })}
      {booleanFields.map(([field, zh, en]) => {
        const value = common(field);
        return <label className="field" key={field}><span>{tr(locale, zh, en)}</span><select
          aria-label={tr(locale, zh, en)} disabled={!supported(field)} value={value === undefined ? "mixed" : String(value)}
          onChange={event => { if (event.target.value !== "mixed") apply(field, event.target.value === "true"); }}>
          <option value="mixed" disabled>{tr(locale, "混合", "Mixed")}</option>
          <option value="true">{tr(locale, "开启", "On")}</option><option value="false">{tr(locale, "关闭", "Off")}</option>
        </select></label>;
      })}
    </div>
  </section>;
}
