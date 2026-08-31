import { DoorOpen, Eye, EyeOff, LocateFixed, X } from "lucide-react";
import { numberFormat } from "../appDefaults";
import { spacePropertyEntries } from "../appPresentation";
import { translate as tr, type AppLocale } from "../i18n";
import type { BimSpaceRecord } from "../viewer/ViewerEngine";
import { StructuredProperties } from "./AppFormControls";

interface SceneSpaceInspectorProps {
  locale: AppLocale;
  space: BimSpaceRecord;
  visible: boolean;
  onClose: () => void;
  onFocus: () => void;
  onVisibilityChange: (visible: boolean) => void;
}

export function SceneSpaceInspector(props: SceneSpaceInspectorProps) {
  const { locale, space } = props;
  return (
    <div className="inspector-content space-inspector">
      <div className="space-inspector-title">
        <span>
          <DoorOpen size={16} />
        </span>
        <div>
          <strong>
            {space.number ? `${space.number} ${space.name}` : space.name}
          </strong>
          <small>
            {space.modelName} · {space.level}
          </small>
        </div>
        <button
          title={tr(locale, "关闭空间属性", "Close space properties")}
          onClick={props.onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className="space-summary-grid">
        <div>
          <span>{tr(locale, "面积", "Area")}</span>
          <strong>
            {space.areaSquareMetres === undefined
              ? "—"
              : `${numberFormat.format(space.areaSquareMetres)} m²`}
          </strong>
        </div>
        <div>
          <span>{tr(locale, "体积", "Volume")}</span>
          <strong>
            {space.volumeCubicMetres === undefined
              ? "—"
              : `${numberFormat.format(space.volumeCubicMetres)} m³`}
          </strong>
        </div>
        <div>
          <span>{tr(locale, "楼层", "Floor")}</span>
          <strong title={space.level}>{space.level}</strong>
        </div>
        <div>
          <span>{tr(locale, "类型", "Type")}</span>
          <strong>{space.kind}</strong>
        </div>
      </div>
      <div className="space-inspector-actions">
        <button onClick={props.onFocus}>
          <LocateFixed size={13} />
          {tr(locale, "定位", "Focus")}
        </button>
        <button
          className={props.visible ? "active" : ""}
          onClick={() => props.onVisibilityChange(!props.visible)}
        >
          {props.visible ? <EyeOff size={13} /> : <Eye size={13} />}
          {props.visible
            ? tr(locale, "隐藏空间体", "Hide space")
            : tr(locale, "显示空间体", "Show space")}
        </button>
      </div>
      <StructuredProperties
        locale={locale}
        entries={spacePropertyEntries(space, locale)}
        emptyText={tr(
          locale,
          "该空间没有更多 BIM 参数",
          "This space has no additional BIM parameters",
        )}
      />
    </div>
  );
}
