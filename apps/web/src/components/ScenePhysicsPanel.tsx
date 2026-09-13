import { X } from "lucide-react";
import type {
  ScenePhysicsBodyState,
  ScenePhysicsState,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { DeferredNumberInput } from "./AppFormControls";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";

interface ScenePhysicsPanelProps {
  locale: AppLocale;
  value: ScenePhysicsState;
  selectedName?: string | undefined;
  selectedBody?: ScenePhysicsBodyState | undefined;
  onChange: (next: ScenePhysicsState) => void;
  onSelectedBodyChange: (patch: Partial<ScenePhysicsBodyState>) => void;
  onReset: () => void;
  onClose: () => void;
}

export function ScenePhysicsPanel(props: ScenePhysicsPanelProps) {
  const { locale, value, selectedBody } = props;
  const drag = useFloatingPanelDrag<HTMLDivElement>();

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
    </div>
  );
}
