import { X } from "lucide-react";
import * as THREE from "three";
import type {
  ScenePhysicsBodyState,
  ScenePhysicsJointState,
  ScenePhysicsState,
  Vector3Value,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { DeferredNumberInput } from "./AppFormControls";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";

interface ScenePhysicsPanelProps {
  locale: AppLocale;
  value: ScenePhysicsState;
  selectedName?: string | undefined;
  selectedId?: string | undefined;
  selectedPosition?: Vector3Value | undefined;
  selectedBody?: ScenePhysicsBodyState | undefined;
  bodyOptions?: readonly { id: string; name: string; type: ScenePhysicsBodyState["type"] }[];
  onChange: (next: ScenePhysicsState) => void;
  onSelectedBodyChange: (patch: Partial<ScenePhysicsBodyState>) => void;
  onReset: () => void;
  onClose: () => void;
}

export function ScenePhysicsPanel(props: ScenePhysicsPanelProps) {
  const { locale, value, selectedBody } = props;
  const drag = useFloatingPanelDrag<HTMLDivElement>();
  const selectedJoint = value.joints?.find((joint) => joint.bodyId === props.selectedId);
  const replaceJoint = (next?: ScenePhysicsJointState) => props.onChange({
    ...value,
    joints: [
      ...(value.joints ?? []).filter((joint) => joint.bodyId !== props.selectedId),
      ...(next ? [next] : []),
    ],
  });
  const updateJoint = (patch: Partial<ScenePhysicsJointState>) => {
    if (selectedJoint) replaceJoint({ ...selectedJoint, ...patch });
  };

  return (
    <div
      ref={drag.panelRef}
      style={drag.style}
      className="physics-panel"
      aria-label={tr(locale, "物理系统", "Physics system")}
    >
      <header
        data-drag-handle="true"
        title={tr(locale, "拖动标题栏移动物理面板", "Drag the title bar to move the physics panel")}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
      >
        <div>
          <strong>{tr(locale, "物理系统", "Physics")}</strong>
          <small>Rapier · WebAssembly</small>
        </div>
        <button
          onClick={props.onClose}
          aria-label={tr(locale, "关闭物理面板", "Close physics panel")}
        >
          <X size={14} />
        </button>
      </header>
      <div className="physics-global">
        <button
          className={value.enabled ? "active" : ""}
          onClick={() =>
            props.onChange({
              ...value,
              enabled: !value.enabled,
              playing: !value.enabled ? value.playing : false,
            })
          }
        >
          {value.enabled
            ? tr(locale, "已启用", "Enabled")
            : tr(locale, "已关闭", "Disabled")}
        </button>
        <button
          disabled={!value.enabled}
          className={value.playing ? "active" : ""}
          onClick={() => props.onChange({ ...value, playing: !value.playing })}
        >
          {value.playing
            ? tr(locale, "暂停", "Pause")
            : tr(locale, "播放", "Play")}
        </button>
        <button disabled={!value.enabled} onClick={props.onReset}>
          {tr(locale, "重置", "Reset")}
        </button>
      </div>
      <label className="physics-gravity">
        <span>{tr(locale, "重力 Y", "Gravity Y")}</span>
        <input
          type="range"
          min="-30"
          max="10"
          step="0.1"
          value={value.gravity.y}
          onChange={(event) =>
            props.onChange({
              ...value,
              gravity: { ...value.gravity, y: Number(event.target.value) },
            })
          }
        />
        <output>{value.gravity.y.toFixed(1)}</output>
      </label>
      <section className="physics-object">
        <div>
          <strong>
            {props.selectedName ??
              tr(locale, "未选择对象", "No object selected")}
          </strong>
          <small>
            {tr(
              locale,
              "使用包围盒碰撞体，BIM 默认关闭",
              "Bounding-box collider; BIM is off by default",
            )}
          </small>
        </div>
        {selectedBody && (
          <>
            <label>
              <span>{tr(locale, "刚体类型", "Body type")}</span>
              <select
                value={selectedBody.type}
                onChange={(event) =>
                  props.onSelectedBodyChange({
                    type: event.target.value as ScenePhysicsBodyState["type"],
                  })
                }
              >
                <option value="none">{tr(locale, "关闭", "Off")}</option>
                <option value="fixed">{tr(locale, "静态", "Fixed")}</option>
                <option value="dynamic">{tr(locale, "动态", "Dynamic")}</option>
              </select>
            </label>
            <label>
              <span>{tr(locale, "质量", "Mass")}</span>
              <DeferredNumberInput
                disabled={selectedBody.type !== "dynamic"}
                min={0.01}
                step={0.5}
                value={selectedBody.mass}
                onCommit={(mass) => props.onSelectedBodyChange({ mass })}
              />
            </label>
            <label>
              <span>{tr(locale, "摩擦", "Friction")}</span>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={selectedBody.friction}
                onChange={(event) =>
                  props.onSelectedBodyChange({
                    friction: Number(event.target.value),
                  })
                }
              />
              <output>{selectedBody.friction.toFixed(2)}</output>
            </label>
            <label>
              <span>{tr(locale, "弹性", "Bounce")}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={selectedBody.restitution}
                onChange={(event) =>
                  props.onSelectedBodyChange({
                    restitution: Number(event.target.value),
                  })
                }
              />
              <output>{selectedBody.restitution.toFixed(2)}</output>
            </label>
          </>
        )}
      </section>
      {selectedBody?.type === "dynamic" && props.selectedId && (
        <section className="physics-object">
          <div>
            <strong>{tr(locale, "旋转关节", "Revolute joint")}</strong>
            <small>{tr(locale, "连接世界或另一刚体；角度单位为度", "Connect to the world or another rigid body; angles are degrees")}</small>
          </div>
          {!selectedJoint ? (
            <button onClick={() => replaceJoint({
              id: `revolute-${props.selectedId}`,
              kind: "revolute",
              bodyId: props.selectedId!,
              worldAnchor: { ...(props.selectedPosition ?? { x: 0, y: 0, z: 0 }) },
              localAnchor: { x: 0, y: 0, z: 0 },
              axis: { x: 0, y: 1, z: 0 },
              limits: { enabled: true, min: -Math.PI, max: Math.PI },
              motor: { enabled: false, targetVelocity: 0, strength: 1 },
            })}>
              {tr(locale, "挂载旋转关节", "Mount revolute joint")}
            </button>
          ) : (
            <>
              <label>
                <span>{tr(locale, "求解器", "Solver")}</span>
                <select value={selectedJoint.solver ?? "impulse"} onChange={(event) => {
                  const solver = event.target.value as "impulse" | "multibody";
                  updateJoint({ solver, ...(solver === "multibody" ? {
                    limits: { ...selectedJoint.limits, enabled: false },
                    motor: { ...selectedJoint.motor, enabled: false },
                  } : {}) });
                }}>
                  <option value="impulse">ImpulseJoint</option>
                  <option value="multibody">MultibodyJoint</option>
                </select>
              </label>
              <label>
                <span>{tr(locale, "连接目标", "Connected body")}</span>
                <select value={selectedJoint.connectedBodyId ?? ""} onChange={(event) => {
                  const connectedBodyId = event.target.value;
                  if (connectedBodyId) updateJoint({ connectedBodyId });
                  else {
                    const { connectedBodyId: _discarded, ...worldJoint } = selectedJoint;
                    replaceJoint(worldJoint);
                  }
                }}>
                  <option value="">{tr(locale, "固定世界", "Fixed world")}</option>
                  {(props.bodyOptions ?? []).filter(option => option.id !== props.selectedId && option.type !== "none").map(option => (
                    <option key={option.id} value={option.id}>{option.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{tr(locale, "旋转轴", "Axis")}</span>
                <select value={selectedJoint.axis.x ? "x" : selectedJoint.axis.z ? "z" : "y"} onChange={(event) => {
                  const axis = event.target.value;
                  updateJoint({ axis: { x: axis === "x" ? 1 : 0, y: axis === "y" ? 1 : 0, z: axis === "z" ? 1 : 0 } });
                }}>
                  <option value="x">X</option><option value="y">Y</option><option value="z">Z</option>
                </select>
              </label>
              <label>
                <span>{tr(locale, "启用限位", "Enable limits")}</span>
                <input type="checkbox" disabled={selectedJoint.solver === "multibody"} checked={selectedJoint.limits.enabled} onChange={(event) => updateJoint({ limits: { ...selectedJoint.limits, enabled: event.target.checked } })} />
              </label>
              <label>
                <span>{tr(locale, "最小角", "Minimum angle")}</span>
                <DeferredNumberInput disabled={selectedJoint.solver === "multibody" || !selectedJoint.limits.enabled} min={-360} max={360} step={5} value={THREE.MathUtils.radToDeg(selectedJoint.limits.min)} onCommit={(degrees) => updateJoint({ limits: { ...selectedJoint.limits, min: THREE.MathUtils.degToRad(degrees) } })} />
              </label>
              <label>
                <span>{tr(locale, "最大角", "Maximum angle")}</span>
                <DeferredNumberInput disabled={selectedJoint.solver === "multibody" || !selectedJoint.limits.enabled} min={-360} max={360} step={5} value={THREE.MathUtils.radToDeg(selectedJoint.limits.max)} onCommit={(degrees) => updateJoint({ limits: { ...selectedJoint.limits, max: THREE.MathUtils.degToRad(degrees) } })} />
              </label>
              <label>
                <span>{tr(locale, "速度马达", "Velocity motor")}</span>
                <input type="checkbox" disabled={selectedJoint.solver === "multibody"} checked={selectedJoint.motor.enabled} onChange={(event) => updateJoint({ motor: { ...selectedJoint.motor, enabled: event.target.checked } })} />
              </label>
              <label>
                <span>{tr(locale, "目标速度 rad/s", "Target speed rad/s")}</span>
                <DeferredNumberInput disabled={selectedJoint.solver === "multibody" || !selectedJoint.motor.enabled} min={-100} max={100} step={0.1} value={selectedJoint.motor.targetVelocity} onCommit={(targetVelocity) => updateJoint({ motor: { ...selectedJoint.motor, targetVelocity } })} />
              </label>
              <label title={tr(locale, "Rapier 速度约束求解强度，不代表额定扭矩", "Rapier velocity-constraint strength; not a rated torque") }>
                <span>{tr(locale, "马达强度", "Motor strength")}</span>
                <DeferredNumberInput disabled={selectedJoint.solver === "multibody" || !selectedJoint.motor.enabled} min={0} max={1000000} step={0.1} value={selectedJoint.motor.strength} onCommit={(strength) => updateJoint({ motor: { ...selectedJoint.motor, strength } })} />
              </label>
              <button onClick={() => replaceJoint()}>{tr(locale, "移除关节", "Remove joint")}</button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
