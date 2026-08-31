import { MapPin, Unlink } from "lucide-react";
import type { SceneSnapshot, VisionEventRecord } from "@bim-studio/contracts";
import { localizeVisionEvent, type VisionSceneAnchor } from "@bim-studio/studio-core";
import { translate as tr, type AppLocale } from "../i18n";

export function VisionEventLocalizationBadge({
  event,
  scenes,
  locale,
}: {
  event: VisionEventRecord;
  scenes: readonly SceneSnapshot[];
  locale: AppLocale;
}) {
  const scene = scenes.find((item) => item.id === event.sceneId);
  if (!scene) {
    return (
      <small className="vision-event-localization missing">
        <Unlink size={11} />
        {tr(locale, "未关联三维场景", "No linked 3D scene")}
      </small>
    );
  }
  const detection = [...event.detections].sort((left, right) => right.confidence - left.confidence)[0];
  if (!detection) return null;
  const result = localizeVisionEvent({
    sceneId: scene.id,
    detection: { label: detection.label, confidence: detection.confidence, ...(detection.bbox ? { bbox: detection.bbox } : {}) },
    image: { width: 1, height: 1 },
    bboxCoordinates: "normalized",
    boundObjectIds: event.objectIds,
    anchors: sceneAnchors(scene),
  });
  const candidate = result.objectCandidates[0];
  if (!candidate) {
    return (
      <small className="vision-event-localization missing">
        <Unlink size={11} />
        {tr(locale, `${scene.name} · 待绑定对象`, `${scene.name} · Object binding required`)}
      </small>
    );
  }
  const targetName = anchorName(scene, candidate.objectId) ?? candidate.objectId;
  return (
    <small className="vision-event-localization" title={result.issues.join("；")}>
      <MapPin size={11} />
      {tr(locale, `${scene.name} / ${targetName} · 锚点待复核`, `${scene.name} / ${targetName} · Anchor review required`)}
    </small>
  );
}

/** 将可持久化模型/图层变换转成锚点；没有相机标定时只表达对象归属，不冒充表面精确位置。 */
function sceneAnchors(scene: SceneSnapshot): VisionSceneAnchor[] {
  return scene.models.flatMap((model) => [
    { objectId: model.modelId, name: model.name, position: model.transform.position },
    ...(model.layers ?? []).filter((layer) => !layer.deleted).map((layer) => ({
      objectId: layer.nodeId,
      name: layer.name ?? layer.nodeId,
      position: layer.transform?.position ?? model.transform.position,
    })),
  ]);
}

function anchorName(scene: SceneSnapshot, objectId: string): string | undefined {
  for (const model of scene.models) {
    if (model.modelId === objectId) return model.name;
    const layer = model.layers?.find((item) => item.nodeId === objectId);
    if (layer) return layer.name ?? layer.nodeId;
  }
  return undefined;
}
