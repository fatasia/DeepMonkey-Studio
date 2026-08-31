import { Ruler, ScanLine, X } from "lucide-react";
import type { MeasurementState } from "@bim-studio/contracts";
import { formatMeasurementValue, measureModeName } from "../appPresentation";
import { translate as tr, type AppLocale } from "../i18n";
import type { CollisionRecord } from "../viewer/ViewerEngine";

interface SceneResultListsProps {
  locale: AppLocale;
  measurements: MeasurementState[];
  collisions: CollisionRecord[];
  onMeasurementFocus: (measurement: MeasurementState) => void;
  onMeasurementRemove: (id: string) => void;
  onMeasurementsClear: () => void;
  onCollisionFocus: (collision: CollisionRecord) => void;
}

export function SceneResultLists(props: SceneResultListsProps) {
  return (
    <>
      {props.measurements.length > 0 && (
        <div className="measurement-list">
          <div className="section-label">
            <span>{tr(props.locale, "测量结果", "Measurements")}</span>
            <button onClick={props.onMeasurementsClear}>
              {tr(props.locale, "清空", "Clear")}
            </button>
          </div>
          {props.measurements.map((item, index) => (
            <div className="measurement-row" key={item.id}>
              <Ruler size={14} />
              <button onClick={() => props.onMeasurementFocus(item)}>
                <span>
                  {measureModeName(item.kind ?? "distance", props.locale)}{" "}
                  {index + 1}
                </span>
                <strong>{formatMeasurementValue(item)}</strong>
              </button>
              <button
                className="measurement-delete"
                title={tr(props.locale, "删除该测量", "Delete measurement")}
                onClick={() => props.onMeasurementRemove(item.id)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {props.collisions.length > 0 && (
        <div className="collision-list">
          <div className="section-label">
            <span>{tr(props.locale, "碰撞结果", "Collisions")}</span>
            <small>{props.collisions.length}</small>
          </div>
          {props.collisions.map((item) => (
            <button key={item.id} onClick={() => props.onCollisionFocus(item)}>
              <ScanLine size={14} />
              <span>
                <strong>{item.sourceName}</strong>
                <small>
                  {tr(
                    props.locale,
                    `与 ${item.targetName} 相交`,
                    `Intersects ${item.targetName}`,
                  )}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
