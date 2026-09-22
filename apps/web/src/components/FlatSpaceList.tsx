import { DoorOpen, Eye, EyeOff, LocateFixed } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { BimSpaceRecord } from "../viewer/ViewerEngine";

interface FlatSpaceListProps {
  locale: AppLocale;
  spaces: BimSpaceRecord[];
  isVisible: (space: BimSpaceRecord) => boolean;
  onFocus: (space: BimSpaceRecord) => void;
  onVisibilityChange: (space: BimSpaceRecord, visible: boolean) => void;
}

/**
 * 空间属于场景对象，不再强制套入“模型 / 楼层 / 房间”的三级目录。
 * 楼层和模型名称保留为辅助信息，兼顾易用性与 BIM 语义检索。
 */
export function FlatSpaceList(props: FlatSpaceListProps) {
  return (
    <>
      {props.spaces.map((space) => {
        const visible = props.isVisible(space);
        const name = space.number
          ? `${space.number} ${space.name}`
          : space.name;
        const context = [
          space.level,
          space.modelName,
          space.areaSquareMetres === undefined
            ? space.kind
            : `${space.areaSquareMetres.toFixed(2)} m²`,
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <div
            className={`asset-row scene-object-row ${visible ? "" : "muted"}`}
            key={space.id}
          >
            <button className="asset-main" onClick={() => props.onFocus(space)}>
              <span className="scene-object-badge">
                <DoorOpen size={15} />
              </span>
              <span className="asset-copy">
                <strong title={name}>{name}</strong>
                <small>{context}</small>
              </span>
              <LocateFixed size={12} />
            </button>
            <button
              className="mini-button"
              title={
                visible
                  ? tr(props.locale, "隐藏空间体", "Hide space volume")
                  : tr(props.locale, "显示空间体", "Show space volume")
              }
              onClick={() => props.onVisibilityChange(space, !visible)}
            >
              {visible ? <Eye size={15} /> : <EyeOff size={15} />}
            </button>
          </div>
        );
      })}
    </>
  );
}
