import type { SceneIKConstraintState, Vector3Value } from "@bim-studio/contracts";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { RobotKinematicsControl } from "./RobotKinematicsControl";

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

export function ModelRigControl({
  locale,
  engine,
  modelId,
  disabled = false,
  onChange,
}: {
  locale: AppLocale;
  engine: ViewerEngine;
  modelId: string;
  disabled?: boolean;
  onChange: () => void;
}) {
  const bones = useMemo(() => engine.listModelBones(modelId), [engine, modelId]);
  const [bonePath, setBonePath] = useState(() => bones[0]?.path ?? "");
  const [, setRevision] = useState(0);
  const selectedBone = bones.find((bone) => bone.path === bonePath) ?? bones[0];
  const rotation = selectedBone ? engine.getBoneRotation(modelId, selectedBone.path) : undefined;
  const rig = engine.getModelRigState(modelId) ?? { bones: [], ik: [] };
  const constraints = selectedBone ? rig.ik.filter((item) => item.effectorBonePath === selectedBone.path) : [];

  function changed() {
    setRevision((value) => value + 1);
    onChange();
  }

  function updateRotation(axis: keyof Vector3Value, degrees: number) {
    if (!selectedBone || !rotation || !Number.isFinite(degrees)) return;
    engine.setBoneRotation(modelId, selectedBone.path, { ...rotation, [axis]: degrees * DEG_TO_RAD });
    changed();
  }

  function updateConstraint(constraint: SceneIKConstraintState, patch: Partial<Omit<SceneIKConstraintState, "id">>) {
    engine.updateIKConstraint(modelId, constraint.id, patch);
    changed();
  }

  if (!selectedBone || !rotation) return null;
  return (
    <details className="model-rig-control">
      <summary>
        <span>{tr(locale, "骨骼与 IK", "Skeleton & IK")}</span>
        <small>
          {bones.length} {tr(locale, "根骨骼", "bones")} · {rig.ik.length} IK
        </small>
      </summary>
      <div className="model-rig-body">
        <label className="model-rig-bone">
          <span>{tr(locale, "骨骼", "Bone")}</span>
          <select disabled={disabled} value={selectedBone.path} onChange={(event) => setBonePath(event.target.value)}>
            {bones.map((bone) => (
              <option key={bone.path} value={bone.path}>{`${"　".repeat(Math.min(bone.depth, 5))}${bone.name}`}</option>
            ))}
          </select>
        </label>
        <div className="model-rig-rotation">
          {(["x", "y", "z"] as const).map((axis) => (
            <label key={axis}>
              <span>{axis.toUpperCase()}</span>
              <input
                disabled={disabled}
                type="number"
                step="1"
                value={(rotation[axis] * RAD_TO_DEG).toFixed(1)}
                onChange={(event) => updateRotation(axis, Number(event.target.value))}
              />
              <i>°</i>
            </label>
          ))}
        </div>
        <div className="model-rig-actions">
          <button
            disabled={disabled}
            onClick={() => {
              engine.resetBonePose(modelId, selectedBone.path);
              changed();
            }}
          >
            <RotateCcw size={11} />
            {tr(locale, "复位骨骼", "Reset bone")}
          </button>
          <button
            disabled={disabled}
            onClick={() => {
              engine.createIKConstraint(modelId, selectedBone.path);
              changed();
            }}
          >
            <Plus size={11} />
            {tr(locale, "添加 IK", "Add IK")}
          </button>
        </div>
        {constraints.map((constraint, index) => (
          <div className="model-ik-card" key={constraint.id}>
            <header>
              <label>
                <input disabled={disabled} type="checkbox" checked={constraint.enabled} onChange={(event) => updateConstraint(constraint, { enabled: event.target.checked })} />
                <span>IK {index + 1}</span>
              </label>
              <button
                disabled={disabled}
                title={tr(locale, "删除 IK", "Delete IK")}
                onClick={() => {
                  engine.removeIKConstraint(modelId, constraint.id);
                  changed();
                }}
              >
                <Trash2 size={11} />
              </button>
            </header>
            <div className="model-ik-target">
              <span>{tr(locale, "目标（模型坐标）", "Target (model local)")}</span>
              {(["x", "y", "z"] as const).map((axis) => (
                <label key={axis}>
                  <i>{axis.toUpperCase()}</i>
                  <input
                    disabled={disabled || !constraint.enabled}
                    type="number"
                    step="0.1"
                    value={constraint.target[axis]}
                    onChange={(event) => updateConstraint(constraint, { target: { ...constraint.target, [axis]: Number(event.target.value) } })}
                  />
                </label>
              ))}
            </div>
            <div className="model-ik-settings">
              <label>
                <span>{tr(locale, "链长", "Chain")}</span>
                <input
                  disabled={disabled || !constraint.enabled}
                  type="number"
                  min="1"
                  max="16"
                  value={constraint.chainLength}
                  onChange={(event) => updateConstraint(constraint, { chainLength: Number(event.target.value) })}
                />
              </label>
              <label>
                <span>{tr(locale, "迭代", "Iterations")}</span>
                <input
                  disabled={disabled || !constraint.enabled}
                  type="number"
                  min="1"
                  max="64"
                  value={constraint.iterations}
                  onChange={(event) => updateConstraint(constraint, { iterations: Number(event.target.value) })}
                />
              </label>
            </div>
          </div>
        ))}
        <RobotKinematicsControl locale={locale} engine={engine} modelId={modelId} bones={bones} rig={rig} disabled={disabled} onChange={changed} />
      </div>
    </details>
  );
}
