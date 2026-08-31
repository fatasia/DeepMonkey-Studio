import { describe, expect, it } from "vitest";
import dashboardFixture from "../../../test-fixtures/scene-v1-dashboard.json";
import interactionFixture from "../../../test-fixtures/scene-v1-interaction.json";
import pure3dFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { parseScene } from "./sceneFiles.js";

const fixtures = [pure3dFixture, dashboardFixture, interactionFixture];

describe("loose scene file compatibility", () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))
    ("imports v1 fixture %s without changing it", (_id, fixture) => {
      expect(parseScene(JSON.stringify(fixture))).toEqual(fixture);
    });

  it("rejects unsupported scene file versions", () => {
    expect(() => parseScene(JSON.stringify({ ...pure3dFixture, schemaVersion: 2 })))
      .toThrow("不支持的场景文件版本");
  });

  it("round-trips persisted fire settings in a loose scene", () => {
    const fire = { enabled: true, color: "#ff6a22", intensity: 3, height: 4.5, density: 1.4 };
    const scene = {
      ...pure3dFixture,
      primitives: [{
        modelId: "alarm-box", name: "报警点", kind: "box", color: "#ffffff", visible: true, opacity: 1,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        effects: { outline: false, glow: false, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: false, color: "#36a3ff", intensity: 1, fire },
      }],
    };

    expect(parseScene(JSON.stringify(scene)).primitives[0]?.effects?.fire).toEqual(fire);
  });

  it("round-trips independent material UV transforms in a loose scene", () => {
    const material = {
      baseColorMapUrl: "/textures/nameplate.png",
      textureRepeatX: 4,
      textureRepeatY: 1.5,
      textureOffsetX: 0.25,
      textureOffsetY: -0.1,
      textureRotation: Math.PI / 6,
    };
    const scene = {
      ...pure3dFixture,
      models: [{
        modelId: "nameplate-1",
        name: "设备铭牌",
        visible: true,
        opacity: 1,
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        material,
      }],
    };

    expect(parseScene(JSON.stringify(scene)).models[0]?.material).toEqual(material);
  });

  it("round-trips imported HDRI and PBR resource URLs", () => {
    const material = {
      baseColorMapUrl: "/assets/projects/default/assets/material/base-color.jpg",
      normalMapUrl: "/assets/projects/default/assets/material/normal.jpg",
      ambientOcclusionMapUrl: "/assets/projects/default/assets/material/ao.jpg",
      roughnessMapUrl: "/assets/projects/default/assets/material/roughness.jpg",
      metalnessMapUrl: "/assets/projects/default/assets/material/metalness.jpg",
      roughness: 1,
      metalness: 1,
    };
    const environment = {
      gridVisible: true,
      backgroundColor: "#101820",
      skybox: "studio" as const,
      environmentMapUrl: "/assets/projects/default/assets/environment/environment.hdr",
      environmentMapName: "车间晨光",
    };
    const scene = {
      ...pure3dFixture,
      environment,
      models: [{
        modelId: "machine-1", name: "设备", visible: true, opacity: 1,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        material,
      }],
    };

    const restored = parseScene(JSON.stringify(scene));
    expect(restored.environment).toEqual(environment);
    expect(restored.models[0]?.material).toEqual(material);
  });
});
