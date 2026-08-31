import { Camera, MousePointer2 } from "lucide-react";
import type { CameraState } from "@bim-studio/contracts";
import { numberFormat } from "../appDefaults";
import { formatVector } from "../appPresentation";
import { translate as tr, type AppLocale } from "../i18n";
import type { PointerInfo } from "../viewer/ViewerEngine";
import type { SceneStatisticsSummary } from "./SceneViewportStatus";

interface SceneInspectorInfoProps {
  locale: AppLocale;
  statistics: SceneStatisticsSummary & { primitiveCount: number };
  frameRate: number;
  camera?: CameraState | undefined;
  pointer?: PointerInfo | undefined;
}

export function SceneInspectorInfo(props: SceneInspectorInfoProps) {
  return (
    <>
      <section
        className="scene-info-panel"
        aria-label={tr(props.locale, "场景信息", "Scene information")}
      >
        <div className="section-label">
          <span>{tr(props.locale, "场景信息", "Scene information")}</span>
          <small>
            {props.statistics.modelCount + props.statistics.primitiveCount}{" "}
            {tr(props.locale, "对象", "objects")}
          </small>
        </div>
        <div className="scene-info-grid">
          <Metric
            value={props.statistics.modelCount}
            label={tr(props.locale, "模型", "Models")}
          />
          <Metric
            value={props.statistics.componentCount}
            label={tr(props.locale, "构件", "Components")}
          />
          <Metric
            value={props.statistics.triangleCount}
            label={tr(props.locale, "三角面", "Triangles")}
          />
          <Metric
            value={props.statistics.vertexCount}
            label={tr(props.locale, "顶点", "Vertices")}
          />
          <div>
            <strong>{props.frameRate || "—"}</strong>
            <span>FPS</span>
          </div>
        </div>
      </section>
      <section
        className="runtime-info-panel"
        aria-label={tr(
          props.locale,
          "相机和鼠标信息",
          "Camera and pointer information",
        )}
      >
        <div className="runtime-info-row">
          <Camera size={13} />
          <span>{tr(props.locale, "相机", "Camera")}</span>
          <code>
            {props.camera ? formatVector(props.camera.position) : "—"}
          </code>
        </div>
        <div className="runtime-info-row runtime-target">
          <span>◎</span>
          <span>{tr(props.locale, "目标", "Target")}</span>
          <code>{props.camera ? formatVector(props.camera.target) : "—"}</code>
        </div>
        <div className="runtime-info-row">
          <MousePointer2 size={13} />
          <span>{tr(props.locale, "鼠标", "Pointer")}</span>
          <code>
            {props.pointer?.world
              ? formatVector(props.pointer.world)
              : props.pointer
                ? `${props.pointer.screenX}, ${props.pointer.screenY}`
                : "—"}
          </code>
        </div>
        {props.pointer?.objectName && (
          <div className="runtime-object-name" title={props.pointer.objectName}>
            {props.pointer.objectName}
          </div>
        )}
      </section>
    </>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <strong>{numberFormat.format(value)}</strong>
      <span>{label}</span>
    </div>
  );
}
