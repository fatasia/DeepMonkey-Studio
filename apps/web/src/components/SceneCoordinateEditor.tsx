import type { SceneCoordinateSystemState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { normalizeSceneCoordinates } from "../viewer/sceneCoordinates";
import { DeferredNumberInput } from "./AppFormControls";

interface SceneCoordinateEditorProps {
  locale: AppLocale;
  value: SceneCoordinateSystemState;
  onChange: (next: SceneCoordinateSystemState) => void;
}

const AXES = ["x", "y", "z"] as const;

export function SceneCoordinateEditor({
  locale,
  value,
  onChange,
}: SceneCoordinateEditorProps) {
  const update = (patch: Partial<SceneCoordinateSystemState>) => {
    onChange(normalizeSceneCoordinates({ ...value, ...patch }));
  };

  return (
    <details className="scene-coordinate-settings">
      <summary>
        {tr(locale, "坐标与单位", "Coordinates & units")}
        <small>
          {value.handedness === "right" ? "RH" : "LH"} ·{" "}
          {value.upAxis.toUpperCase()}↑ · {value.unit}
        </small>
      </summary>
      <div className="scene-coordinate-grid">
        <label>
          <span>{tr(locale, "显示单位", "Display unit")}</span>
          <select
            value={value.unit}
            onChange={(event) =>
              update({
                unit: event.target.value as SceneCoordinateSystemState["unit"],
              })
            }
          >
            <option value="m">m</option>
            <option value="cm">cm</option>
            <option value="mm">mm</option>
            <option value="ft">ft</option>
          </select>
        </label>
        <label>
          <span>{tr(locale, "上轴", "Up axis")}</span>
          <select
            value={value.upAxis}
            onChange={(event) =>
              update({
                upAxis: event.target
                  .value as SceneCoordinateSystemState["upAxis"],
              })
            }
          >
            <option value="y">Y-up</option>
            <option value="z">Z-up</option>
          </select>
        </label>
        <label>
          <span>{tr(locale, "手性", "Handedness")}</span>
          <select
            value={value.handedness}
            onChange={(event) =>
              update({
                handedness: event.target
                  .value as SceneCoordinateSystemState["handedness"],
              })
            }
          >
            <option value="right">
              {tr(locale, "右手系", "Right-handed")}
            </option>
            <option value="left">{tr(locale, "左手系", "Left-handed")}</option>
          </select>
        </label>
        <label>
          <span>EPSG</span>
          <input
            value={value.epsg ?? ""}
            placeholder="EPSG:4547"
            onChange={(event) => update({ epsg: event.target.value })}
          />
        </label>
      </div>
      <div className="light-vector">
        <span>
          {tr(locale, "项目原点（内部米）", "Project origin (metres)")}
        </span>
        {AXES.map((axis) => (
          <label key={axis}>
            <i>{axis.toUpperCase()}</i>
            <DeferredNumberInput
              step={1}
              value={value.origin[axis]}
              onCommit={(nextValue) =>
                update({ origin: { ...value.origin, [axis]: nextValue } })
              }
            />
          </label>
        ))}
      </div>
      {/* 场景内部坐标始终保持统一，避免切换展示单位时重写几何数据。 */}
      <small>
        {tr(
          locale,
          "内部统一保存为右手 Y-up 米制；这里负责导入坐标、属性面板和外部系统坐标的无损换算。",
          "Storage stays canonical right-handed Y-up metres; this setting converts imported, inspector and external-system coordinates without rewriting geometry.",
        )}
      </small>
    </details>
  );
}
