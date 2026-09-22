import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { INDUSTRIAL_PREFAB_CATALOG, industrialPrefabDefinition } from "../industrialPrefabCatalog";
import { prefabThumbnailVariant } from "./prefabThumbnailKit";
import { buildIndustrialPrefabThumbnailModel, INDUSTRIAL_PREFAB_THUMBNAIL_KINDS, disposeThumbnailModel } from "./prefabThumbnailModels";

function buildOrThrow(id: string): { definition: IndustrialPrefabDefinition; model: THREE.Group } {
  const definition = industrialPrefabDefinition(id);
  expect(definition, `目录中应存在 ${id}`).toBeDefined();
  const model = buildIndustrialPrefabThumbnailModel(definition!);
  expect(model, `${id} 应产出非空模型`).toBeDefined();
  return { definition: definition!, model: model! };
}

function withParameterOverride(base: IndustrialPrefabDefinition, key: string, value: number): IndustrialPrefabDefinition {
  return {
    ...base,
    parameters: base.parameters.map((parameter) => (parameter.key === key ? { ...parameter, defaultValue: value } : parameter)),
  };
}

describe("industrial prefab thumbnail models", () => {
  it("全量目录(121 个预制体)都能产出几何有效的小样", () => {
    expect(INDUSTRIAL_PREFAB_CATALOG.length).toBe(121);
    const kinds = new Set<string>();
    for (const definition of INDUSTRIAL_PREFAB_CATALOG) {
      kinds.add(definition.kind);
      const model = buildIndustrialPrefabThumbnailModel(definition);
      expect(model, `${definition.id} 应产出模型`).toBeDefined();
      const box = new THREE.Box3().setFromObject(model!);
      expect(box.isEmpty(), `${definition.id} 包围盒不应为空`).toBe(false);
      const size = box.getSize(new THREE.Vector3());
      for (const value of [size.x, size.y, size.z]) {
        expect(Number.isFinite(value), `${definition.id} 包围盒应有限`).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
      let meshes = 0;
      model!.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) meshes += 1;
      });
      expect(meshes, `${definition.id} 应包含网格`).toBeGreaterThan(0);
      expect(() => disposeThumbnailModel(model!)).not.toThrow();
    }
    expect([...kinds].sort()).toEqual([...INDUSTRIAL_PREFAB_THUMBNAIL_KINDS].sort()); // kind 全覆盖,与构建器表对账
  });

  it("family 分型会改变轮廓(机器人族、输送布局、公用工程族)", () => {
    const fingerprint = (id: string) => {
      const { model } = buildOrThrow(id);
      let meshes = 0;
      model.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) meshes += 1;
      });
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      disposeThumbnailModel(model);
      return `${meshes}|${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}`;
    };
    expect(fingerprint("robot.delta-3")).not.toBe(fingerprint("robot.articulated-6"));
    expect(fingerprint("conveyor.straight")).not.toBe(fingerprint("conveyor.spiral"));
    expect(fingerprint("utility.pump.centrifugal")).not.toBe(fingerprint("utility.compressor.air"));
    expect(fingerprint("utility.cabinet.mcc")).not.toBe(fingerprint("utility.meter.power"));
  });

  it("扩量新增变体与同 kind 既有变体轮廓可区分(分型指纹差异)", () => {
    const fingerprint = (id: string) => {
      const { model } = buildOrThrow(id);
      let meshes = 0;
      model.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) meshes += 1;
      });
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      disposeThumbnailModel(model);
      return `${meshes}|${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}`;
    };
    expect(fingerprint("machine.gantry-mill")).not.toBe(fingerprint("machine.cnc-mill"));
    expect(fingerprint("machine.surface-grinder")).not.toBe(fingerprint("machine.cnc-mill"));
    expect(fingerprint("machine.press")).not.toBe(fingerprint("machine.press-brake"));
    expect(fingerprint("machine.heat-treat-furnace")).not.toBe(fingerprint("machine.cnc-mill"));
    expect(fingerprint("robot.gantry-3")).not.toBe(fingerprint("robot.articulated-6"));
    expect(fingerprint("robot.dual-arm-14")).not.toBe(fingerprint("robot.cobot-6"));
    expect(fingerprint("conveyor.screw")).not.toBe(fingerprint("conveyor.straight"));
    expect(fingerprint("conveyor.bucket-elevator")).not.toBe(fingerprint("conveyor.vertical-lift"));
    expect(fingerprint("utility.heat-exchanger.shell")).not.toBe(fingerprint("utility.pump.centrifugal"));
    expect(fingerprint("utility.tank.vertical")).not.toBe(fingerprint("utility.compressor.air"));
    expect(fingerprint("utility.softener.duplex")).not.toBe(fingerprint("utility.pump.dosing"));
    expect(fingerprint("utility.dosing-station.skid")).not.toBe(fingerprint("utility.pump.dosing"));
    expect(fingerprint("sensor.level")).not.toBe(fingerprint("sensor.photoelectric"));
    expect(fingerprint("sensor.flow")).not.toBe(fingerprint("sensor.pressure-transmitter"));
    expect(fingerprint("sensor.temperature-transmitter")).not.toBe(fingerprint("sensor.temperature"));
    expect(fingerprint("storage.silo")).not.toBe(fingerprint("storage.pallet-rack"));
    expect(fingerprint("storage.asrs-rack")).not.toBe(fingerprint("storage.asrs-shuttle"));
    expect(fingerprint("agv.uav")).not.toBe(fingerprint("agv.carrier"));
    // 2026-09-12 数量波次 C:新变体与同族既有变体、以及族内两两之间轮廓可区分
    expect(fingerprint("sensor.smoke-detector")).not.toBe(fingerprint("sensor.heat-detector"));
    expect(fingerprint("sensor.sounder-strobe")).not.toBe(fingerprint("sensor.smoke-detector"));
    expect(fingerprint("sensor.vibration")).not.toBe(fingerprint("sensor.photoelectric"));
    expect(fingerprint("sensor.rtu")).not.toBe(fingerprint("sensor.edge-gateway"));
    expect(fingerprint("sensor.rtu")).not.toBe(fingerprint("utility.cabinet.mcc"));
    expect(fingerprint("camera.bullet")).not.toBe(fingerprint("camera.fixed"));
    expect(fingerprint("camera.dome")).not.toBe(fingerprint("camera.ptz"));
    expect(fingerprint("camera.thermal")).not.toBe(fingerprint("camera.bullet"));
    expect(fingerprint("camera.ai-box")).not.toBe(fingerprint("sensor.edge-gateway"));
    expect(fingerprint("vehicle.tractor-unit")).not.toBe(fingerprint("vehicle.truck"));
    expect(fingerprint("vehicle.dump-truck")).not.toBe(fingerprint("vehicle.water-truck"));
    expect(fingerprint("vehicle.boom-lift")).not.toBe(fingerprint("vehicle.truck"));
    expect(fingerprint("vehicle.patrol-pickup")).not.toBe(fingerprint("vehicle.car"));
    expect(fingerprint("agv.stacker")).not.toBe(fingerprint("agv.forklift"));
    expect(fingerprint("agv.latent-jack")).not.toBe(fingerprint("agv.amr-shelf"));
    expect(fingerprint("agv.tote-robot")).not.toBe(fingerprint("agv.amr"));
    expect(fingerprint("storage.drive-in-rack")).not.toBe(fingerprint("storage.pallet-rack"));
    expect(fingerprint("storage.mobile-shelving")).not.toBe(fingerprint("storage.carton-flow"));
    expect(fingerprint("storage.cold-room")).not.toBe(fingerprint("storage.vertical-lift-module"));
    expect(fingerprint("storage.roll-cage")).not.toBe(fingerprint("storage.pallet-rack"));
  });

  it("C6 display 行列联动:rows/columns 驱动单元阵列规模,画幅比驱动总高", () => {
    const base = industrialPrefabDefinition("display.wall")!;
    const measure = (definition: IndustrialPrefabDefinition) => {
      const model = buildIndustrialPrefabThumbnailModel(definition)!;
      let meshes = 0;
      model.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) meshes += 1;
      });
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      disposeThumbnailModel(model);
      return { meshes, width: size.x, height: size.y };
    };
    const single = measure(withParameterOverride(base, "columns", 1));
    const triple = measure(withParameterOverride(base, "columns", 3));
    expect(triple.meshes).toBeGreaterThan(single.meshes + 2); // 单元数随列数增长
    expect(triple.width).toBeCloseTo(single.width, 1); // 阵列总宽归一,拼缝数量变化
    const wide = measure(withParameterOverride(withParameterOverride(base, "widthM", 6), "heightM", 1));
    expect(wide.height).toBeLessThan(single.height * 0.6); // 画幅比参与构图
  });

  it("C1 人员分色:靴子橡胶色与安全黄材质同场,构成三段配色", () => {
    const { model } = buildOrThrow("person.worker");
    const colors = new Set<number>();
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      colors.add(material.color.getHex());
    });
    expect(colors.has(0x161d21)).toBe(true); // 橡胶靴
    expect(colors.has(0xe0a63c)).toBe(true); // 安全黄帽/背心
    disposeThumbnailModel(model);
  });

  it("未知 kind 构建失败时回落 undefined 且不抛出", () => {
    const fake = { id: "unknown.x", kind: "no-such-kind", parameters: [] } as unknown as IndustrialPrefabDefinition;
    expect(buildIndustrialPrefabThumbnailModel(fake)).toBeUndefined();
  });

  it("变体抽取覆盖 family/subtype/process/layout 分型键", () => {
    const agv = industrialPrefabDefinition("agv.amr-shelf")!;
    const variant = prefabThumbnailVariant(agv);
    expect(variant).toMatchObject({ id: "agv.amr-shelf", tail: "amr-shelf", subtype: "shelf-amr" });
    const machine = industrialPrefabDefinition("machine.cnc-lathe")!;
    expect(prefabThumbnailVariant(machine)).toMatchObject({ process: "turning" });
    const conveyor = industrialPrefabDefinition("conveyor.roller")!;
    expect(prefabThumbnailVariant(conveyor)).toMatchObject({ layout: "straight", surface: "roller" });
    const display = industrialPrefabDefinition("display.wall")!;
    expect(prefabThumbnailVariant(display)).toMatchObject({ columns: 2, rows: 2, width: 3.2, height: 1.8 });
  });
});
