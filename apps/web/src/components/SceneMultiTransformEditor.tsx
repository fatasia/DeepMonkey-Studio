import type { AppStudioController } from "../views/AppStudioShell";
import type { ModelTransform } from "@bim-studio/contracts";
import { dispatchEngineEditCommand } from "../commands/engineCommandApplier";
import { modelTransformCommand } from "../commands/engineEditCommand";
import { translate as tr } from "../i18n";
import { projectToWorld, worldToProject } from "../viewer/sceneCoordinates";
import { DeferredNumberInput } from "./AppFormControls";

type Props = Pick<AppStudioController, "engine" | "locale" | "sceneOrganizationSelection" | "sceneCoordinates" | "setRevision" | "bindings">;
const axes = ["x", "y", "z"] as const;
const groups = ["position", "rotation", "scale"] as const;

/** 多选按输入轴统一设值，其他轴保留；与已有主选相对变换区分。 */
export function SceneMultiTransformEditor(props: Props) {
  const { engine, locale, sceneOrganizationSelection, sceneCoordinates } = props;
  const items = [...sceneOrganizationSelection].flatMap(id => {
    const transform = engine?.getModelTransform(id);
    return transform ? [{ id, transform, locked: engine!.isModelLocked(id) }] : [];
  });
  const editable = items.filter(item => !item.locked);
  function displayed(transform: ModelTransform, group: keyof ModelTransform, axis: typeof axes[number]) {
    const value = group === "position" ? worldToProject(transform.position, sceneCoordinates)[axis] : transform[group][axis];
    return Number((group === "rotation" ? value * 180 / Math.PI : value).toFixed(3));
  }
  function commit(group: keyof ModelTransform, axis: typeof axes[number], value: number) {
    if (!engine || !Number.isFinite(value) || (group === "scale" && Math.abs(value) < 0.000001)) return;
    props.bindings.sceneHistory.flush();
    let changed = false;
    for (const id of sceneOrganizationSelection) {
      if (engine.isModelLocked(id)) continue;
      const current = engine.getModelTransform(id);
      if (!current || displayed(current, group, axis) === value) continue;
      const next = structuredClone(current);
      if (group === "position") next.position = projectToWorld({ ...worldToProject(current.position, sceneCoordinates), [axis]: value }, sceneCoordinates);
      else next[group][axis] = group === "rotation" ? value * Math.PI / 180 : value;
      // 批 1 接线:多选统一设值发 model 级命令 → 总线 → applier 经 graph 权威通道后
      // 原样调 setModelTransform,数值与直调逐位一致。
      dispatchEngineEditCommand(engine, modelTransformCommand(locale, id, next));
      changed = true;
    }
    if (changed) {
      props.bindings.sceneEditor.recordSceneEdit(tr(locale, "批量修改变换", "Edit selected transforms"));
      props.setRevision(revision => revision + 1);
      props.bindings.sceneHistory.flush(tr(locale, "批量修改变换", "Edit selected transforms"));
    }
  }
  return <section aria-label={tr(locale, "多选变换", "Selected transforms")}>
    <div className="section-label"><span>{tr(locale, "变换 · 统一设值", "Transform · set common value")}</span></div>
    {groups.map(group => {
      const title = group === "position" ? tr(locale, "位置", "Position") : group === "rotation" ? tr(locale, "旋转", "Rotation") : tr(locale, "缩放", "Scale");
      const unit = group === "position" ? sceneCoordinates.unit : group === "rotation" ? "°" : "";
      return <fieldset className="transform-fields" key={group}><legend>{title}</legend><div>{axes.map(axis => {
        const values = items.map(item => displayed(item.transform, group, axis));
        const value = values.length && values.every(item => item === values[0]) ? values[0] : undefined;
        return <label key={axis}><span>{axis.toUpperCase()}</span><DeferredNumberInput
          key={`${[...sceneOrganizationSelection].join("|")}:${group}:${axis}`}
          value={value} placeholder={tr(locale, "混合", "Mixed")} disabled={!editable.length}
          ariaLabel={`${title} ${axis.toUpperCase()}${unit ? ` (${unit})` : ""}`} step={0.1}
          onCommit={next => commit(group, axis, next)} />{unit && <i>{unit}</i>}</label>;
      })}</div></fieldset>;
    })}
    {items.some(item => item.locked) && <small>{tr(locale, "锁定对象保留原值", "Locked objects retain their values")}</small>}
  </section>;
}
