import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SceneSnapshot, VisionEventRecord } from "@bim-studio/contracts";
import { VisionEventLocalizationBadge } from "./VisionEventLocalizationBadge";

const scene = {
  schemaVersion: 1,
  id: "scene-a",
  projectId: "project-a",
  name: "一号产线",
  camera: { position: { x: 0, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit", avatarVisible: false },
  models: [
    {
      modelId: "pump-01",
      name: "循环泵",
      visible: true,
      opacity: 1,
      transform: {
        position: { x: 1, y: 0, z: 2 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    },
  ],
  primitives: [],
  measurements: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
} satisfies SceneSnapshot;

const event = {
  id: "event-a",
  projectId: "project-a",
  taskId: "task-a",
  sourceType: "image",
  modelId: "model-a",
  result: "detected",
  detections: [{ label: "pump", classId: 0, confidence: 0.92, bbox: [0.1, 0.1, 0.5, 0.5] }],
  imageUrl: "/event.png",
  sceneId: "scene-a",
  objectIds: ["pump-01"],
  status: "pending",
  inferenceMs: 18,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
} satisfies VisionEventRecord;

describe("VisionEventLocalizationBadge", () => {
  it("shows a reviewable 3D anchor without claiming precise defect coordinates", () => {
    const html = renderToStaticMarkup(<VisionEventLocalizationBadge event={event} scenes={[scene]} locale="zh-CN" />);
    expect(html).toContain("一号产线 / 循环泵");
    expect(html).toContain("锚点待复核");
  });

  it("makes a missing scene link visible", () => {
    const html = renderToStaticMarkup(<VisionEventLocalizationBadge event={{ ...event, sceneId: "missing" }} scenes={[scene]} locale="zh-CN" />);
    expect(html).toContain("未关联三维场景");
  });
});
