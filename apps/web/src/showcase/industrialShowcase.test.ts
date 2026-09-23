import { assertApplicationDocument } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { createIndustrialShowcaseBundle } from "./industrialShowcase.js";

describe("industrial showcase bundle", () => {
  it("ships a valid editable 4K application with four connected 2D/3D levels", () => {
    const bundle = createIndustrialShowcaseBundle({
      projectId: "default",
      showcaseId: "industrial-test",
      createdAt: "2026-08-26T03:30:00.000Z"
    });

    expect(() => assertApplicationDocument(bundle.application)).not.toThrow();
    expect(bundle.application.pages).toHaveLength(4);
    expect(bundle.application.scenes).toHaveLength(4);
    expect(bundle.scenes).toHaveLength(4);
    expect(bundle.application.pages.every((page) => page.width === 3_840 && page.height === 2_160)).toBe(true);
    expect(bundle.application.spatialNavigation?.nodes.map((node) => node.kind)).toEqual([
      "campus", "workshop", "production-line", "equipment"
    ]);

    const pageSceneIds = bundle.application.pages.flatMap((page) => page.nodes.flatMap((node) => node.kind === "scene-viewport" ? [node.sceneId] : []));
    expect(new Set(pageSceneIds)).toEqual(new Set(bundle.scenes.map((scene) => scene.id)));
  });

  it("contains executable floor/component decomposition, media, AGV and both direct transports", () => {
    const { application, scenes } = createIndustrialShowcaseBundle({
      projectId: "default",
      showcaseId: "industrial-evidence",
      createdAt: "2026-08-26T03:30:00.000Z"
    });
    const widgetConfigs = application.pages.flatMap((page) => page.nodes.flatMap((node) => node.kind === "data-widget" ? [node.widget] : []));
    const bindings = [
      ...widgetConfigs.flatMap((widget) => widget.directBinding ? [widget.directBinding] : []),
      ...scenes.flatMap((scene) => (scene.dataBindings ?? []).flatMap((binding) => binding.directBinding ? [binding.directBinding] : []))
    ];

    expect(new Set(bindings.map((binding) => binding.transport))).toEqual(new Set(["http", "websocket"]));
    expect(bindings.every((binding) => binding.endpoint.startsWith("/api/public/demo/industrial"))).toBe(true);
    expect(widgetConfigs.map((widget) => widget.type)).toEqual(expect.arrayContaining(["image", "video", "monitor"]));
    expect(widgetConfigs.some((widget) => widget.type === "image" && widget.imageUrl?.startsWith("/showcase/"))).toBe(true);
    expect(widgetConfigs.some((widget) => widget.type === "video" && widget.videoUrl?.endsWith(".mp4"))).toBe(true);
    expect(widgetConfigs.some((widget) => widget.type === "monitor" && widget.videoUrl?.includes("live-monitor"))).toBe(true);

    const animatedScenes = scenes.filter((scene) => (scene.animation?.models.length ?? 0) > 0);
    expect(animatedScenes).toHaveLength(2);
    expect(animatedScenes.every((scene) => scene.animation?.loop && scene.animation.pingPong)).toBe(true);
    expect(scenes.some((scene) => scene.primitives.some((primitive) => primitive.name.includes("AGV-01")))).toBe(true);
    const prefabIds = scenes.flatMap((scene) => scene.primitives.flatMap((primitive) => primitive.prefab?.definitionId ? [primitive.prefab.definitionId] : []));
    expect(prefabIds).toEqual(expect.arrayContaining(["robot.articulated-6", "agv.carrier", "agv.amr", "conveyor.straight"]));
    expect(scenes.flatMap((scene) => scene.primitives).filter((primitive) => primitive.prefab).every((primitive) => primitive.prefab?.parameters)).toBe(true);
    expect(application.topologies[0]?.nodes.map((node) => node.kind)).toEqual(["source", "process", "buffer", "sink", "agv"]);
    expect(application.scripts[0]).toMatchObject({ runtime: "worker-sandbox", enabled: true });
  });
});
