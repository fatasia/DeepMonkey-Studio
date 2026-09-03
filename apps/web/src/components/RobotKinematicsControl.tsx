import type { SceneRigState, SceneRobotJointState } from "@bim-studio/contracts";
import { Bot, WandSparkles } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { createRobotKinematicsState, robotLoadCapabilityFromPrefab } from "../viewer/robotKinematics";
import { RobotLoadProfileControl } from "./RobotLoadProfileControl";

type BoneInfo = ReturnType<ViewerEngine["listModelBones"]>[number];

export function RobotKinematicsControl({
  locale,
  engine,
  modelId,
  bones,
  rig,
  disabled,
  onChange,
}: {
  locale: AppLocale;
  engine: ViewerEngine;
  modelId: string;
  bones: BoneInfo[];
  rig: SceneRigState;
  disabled: boolean;
  onChange: () => void;
}) {
  const robot = rig.robot;
  const prefabCapability = robotLoadCapabilityFromPrefab(engine.getIndustrialPrefabState(modelId));
  const objectOptions = engine.listModels().filter((item) => item.id !== modelId).map((item) => ({ id: item.id, name: item.name }));

  function save(nextRobot: SceneRigState["robot"]) {
    engine.setModelRigState(modelId, { ...rig, ...(nextRobot ? { robot: nextRobot } : {}) });
    onChange();
  }

  function enableRobot() {
    if (robot) {
      save({ ...robot, enabled: !robot.enabled });
      return;
    }
    save(createRobotKinematicsState(bones, prefabCapability));
  }

  function updateJoint(index: number, patch: Partial<SceneRobotJointState>) {
    if (!robot) return;
    save({ ...robot, joints: robot.joints.map((joint, current) => (current === index ? { ...joint, ...patch } : joint)) });
  }

  const maximumReach = robot?.joints.reduce((total, joint) => total + joint.length, 0) ?? 0;
  return (
    <section className={`robot-kinematics ${robot?.enabled ? "enabled" : ""}`}>
      <header>
        <div>
          <Bot size={12} />
          <span>{tr(locale, "轻量机器人验证", "Lightweight robot validation")}</span>
        </div>
        <label>
          <input disabled={disabled} type="checkbox" checked={robot?.enabled ?? false} onChange={enableRobot} />
          {tr(locale, "启用", "Enable")}
        </label>
      </header>
      {!robot?.enabled ? (
        <p>
          {tr(
            locale,
            "从骨骼自动生成品牌无关关节链，用于可达域、碰撞计划和粗略节拍；不会生成控制器程序。",
            "Generate an engine-neutral chain for reach, collision planning and rough cycle checks; no controller program is generated.",
          )}
        </p>
      ) : (
        <>
          <div className="robot-kinematics-summary">
            <WandSparkles size={11} />
            <span>
              {robot.joints.length} {tr(locale, "个关节", "joints")} · {tr(locale, "最大包络", "max envelope")} {maximumReach.toFixed(2)} m
            </span>
          </div>
          <div className="robot-kinematics-bones">
            <label>
              <span>{tr(locale, "基座骨骼", "Base bone")}</span>
              <select disabled={disabled} value={robot.baseBonePath} onChange={(event) => save({ ...robot, baseBonePath: event.target.value })}>
                {bones.map((bone) => (
                  <option key={bone.path} value={bone.path}>
                    {bone.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{tr(locale, "工具骨骼", "Tool bone")}</span>
              <select disabled={disabled} value={robot.toolBonePath ?? ""} onChange={(event) => save({ ...robot, toolBonePath: event.target.value })}>
                {bones.map((bone) => (
                  <option key={bone.path} value={bone.path}>
                    {bone.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="robot-joint-list">
            {robot.joints.map((joint, index) => (
              <article key={joint.bonePath}>
                <strong>
                  {index + 1}. {joint.name}
                </strong>
                <label>
                  <span>{tr(locale, "轴", "Axis")}</span>
                  <select disabled={disabled} value={joint.axis} onChange={(event) => updateJoint(index, { axis: event.target.value as SceneRobotJointState["axis"] })}>
                    <option>x</option>
                    <option>y</option>
                    <option>z</option>
                  </select>
                </label>
                <label>
                  <span>{tr(locale, "臂长 m", "Length m")}</span>
                  <input
                    disabled={disabled}
                    type="number"
                    min="0.001"
                    step="0.01"
                    value={joint.length}
                    onChange={(event) => updateJoint(index, { length: Number(event.target.value) })}
                  />
                </label>
                <label>
                  <span>{tr(locale, "最小°", "Min °")}</span>
                  <input
                    disabled={disabled}
                    type="number"
                    min="-360"
                    max="360"
                    value={joint.minAngleDeg}
                    onChange={(event) => updateJoint(index, { minAngleDeg: Number(event.target.value) })}
                  />
                </label>
                <label>
                  <span>{tr(locale, "最大°", "Max °")}</span>
                  <input
                    disabled={disabled}
                    type="number"
                    min="-360"
                    max="360"
                    value={joint.maxAngleDeg}
                    onChange={(event) => updateJoint(index, { maxAngleDeg: Number(event.target.value) })}
                  />
                </label>
              </article>
            ))}
          </div>
          <RobotLoadProfileControl
            locale={locale}
            robot={robot}
            {...(prefabCapability ? { prefabCapability } : {})}
            objectOptions={objectOptions}
            disabled={disabled}
            onChange={save}
          />
        </>
      )}
    </section>
  );
}
