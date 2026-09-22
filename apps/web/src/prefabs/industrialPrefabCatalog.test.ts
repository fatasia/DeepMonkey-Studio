import { describe, expect, it } from "vitest";
import type { IndustrialPrefabParameterDefinition } from "@bim-studio/contracts";
import { INDUSTRIAL_PREFAB_CATALOG, industrialPrefabDefinition } from "./industrialPrefabCatalog";

describe("industrial prefab catalog", () => {
  it("contains one hundred twenty-one distinct configurable industrial prefabs", () => {
    const ids = INDUSTRIAL_PREFAB_CATALOG.map((item) => item.id);

    expect(INDUSTRIAL_PREFAB_CATALOG.length).toBe(121);
    expect(new Set(ids).size).toBe(ids.length);
    expect(INDUSTRIAL_PREFAB_CATALOG.every((item) => item.parameters.length > 0 && item.actions.length > 0 && item.dataPorts.length > 0)).toBe(true);
  });

  it("keeps every parameter key and default value valid", () => {
    for (const prefab of INDUSTRIAL_PREFAB_CATALOG) {
      const keys = prefab.parameters.map((parameter) => parameter.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(prefab.parameters.every(validParameter)).toBe(true);
    }
  });

  it("covers high-value manufacturing capability families", () => {
    const ids = new Set(INDUSTRIAL_PREFAB_CATALOG.map((item) => item.id));
    const expected = [
      "robot.welding-6",
      "robot.palletizer-4-heavy",
      "conveyor.roller-accumulation",
      "conveyor.sorter",
      "conveyor.vertical-lift",
      "agv.tugger",
      "agv.amr-shelf",
      "vehicle.forklift",
      "access.interlock-door",
      "machine.cnc-mill",
      "utility.pump.centrifugal",
      "utility.cabinet.mcc",
      "sensor.safety-lidar",
      "camera.vision",
      "display.wall",
      "storage.asrs-shuttle",
      "road.straight",
      // 2026-09-12 扩量新增:机床四工艺、机器人三族、公用工程四族、过程仪表四族、仓储/输送/无人机
      "machine.gantry-mill",
      "machine.surface-grinder",
      "machine.press",
      "machine.heat-treat-furnace",
      "robot.gantry-3",
      "robot.dual-arm-14",
      "robot.palletizer-6",
      "utility.heat-exchanger.shell",
      "utility.tank.vertical",
      "utility.softener.duplex",
      "utility.dosing-station.skid",
      "sensor.level",
      "sensor.flow",
      "sensor.pressure-transmitter",
      "sensor.temperature-transmitter",
      "storage.silo",
      "storage.asrs-rack",
      "conveyor.screw",
      "conveyor.bucket-elevator",
      "agv.uav",
      // 2026-09-12 数量波次 C:感知 +6、视觉 +4、车辆 +5、仓储 +4、移动 +3
      "sensor.smoke-detector",
      "sensor.heat-detector",
      "sensor.sounder-strobe",
      "sensor.rtu",
      "sensor.edge-gateway",
      "sensor.vibration",
      "camera.bullet",
      "camera.dome",
      "camera.thermal",
      "camera.ai-box",
      "vehicle.tractor-unit",
      "vehicle.dump-truck",
      "vehicle.water-truck",
      "vehicle.boom-lift",
      "vehicle.patrol-pickup",
      "storage.drive-in-rack",
      "storage.mobile-shelving",
      "storage.cold-room",
      "storage.roll-cage",
      "agv.stacker",
      "agv.latent-jack",
      "agv.tote-robot",
    ];

    expect([...ids]).toEqual(expect.arrayContaining(expected));
  });

  it("exposes a bounded editable straight-road contract", () => {
    const road = industrialPrefabDefinition("road.straight");
    expect(road).toMatchObject({ kind: "road", routeCapable: false, pathCapable: true, rigCapable: false });
    expect(industrialPrefabDefinition("fence.modular")).toMatchObject({ pathCapable: true });
    expect(road?.parameters.map((parameter) => parameter.key)).toEqual([
      "lengthM", "carriagewayWidthM", "laneCount", "shoulderWidthM", "surface", "marking",
    ]);
    expect(road?.parameters.find((parameter) => parameter.key === "lengthM")).toMatchObject({ min: 2, max: 500, unit: "m" });
    expect(road?.parameters.find((parameter) => parameter.key === "surface")?.options).toEqual(["asphalt", "concrete"]);
  });

  it("gives route-capable assets and robots operational controls", () => {
    const routeAssets = INDUSTRIAL_PREFAB_CATALOG.filter((item) => item.routeCapable);
    const robots = INDUSTRIAL_PREFAB_CATALOG.filter((item) => item.kind === "robot-arm");

    expect(routeAssets).toHaveLength(25); // 17 既有 + 波次 C 新增 8 个可路线移动设备
    expect(routeAssets.every((item) => item.actions.some((action) => action.id === "dispatch") && item.dataPorts.includes("routeProgress"))).toBe(true);
    expect(robots.every((item) => item.rigCapable && item.actions.some((action) => action.id === "move-tool") && item.dataPorts.includes("jointAngles"))).toBe(true);
  });

  it("keeps wave-C fire/gateway sensors and cameras on industry-real ports", () => {
    const ports = (id: string) => industrialPrefabDefinition(id)?.dataPorts ?? [];
    // 火灾探测按 GB 4715/4716 口径暴露遮光率、定温差温与声压数据口
    expect(ports("sensor.smoke-detector")).toContain("smokeDensity");
    expect(ports("sensor.heat-detector")).toEqual(expect.arrayContaining(["temperatureC", "rateOfRiseCpm"]));
    expect(ports("sensor.sounder-strobe")).toEqual(expect.arrayContaining(["soundLevelDb", "active"]));
    expect(ports("sensor.vibration")).toEqual(expect.arrayContaining(["velocityMms", "accelerationG"]));
    // RTU/网关按采集与网联口径暴露通道态、扫描与南北向速率
    expect(ports("sensor.rtu")).toEqual(expect.arrayContaining(["diStates", "doStates", "aiValues"]));
    expect(ports("sensor.edge-gateway")).toEqual(expect.arrayContaining(["ingressRate", "egressRate", "edgeTasksActive"]));
    // 热成像/AI 盒子按视频监控口径暴露测温与算力负载
    expect(ports("camera.thermal")).toEqual(expect.arrayContaining(["temperatureMaxC", "temperatureMinC"]));
    expect(ports("camera.ai-box")).toEqual(expect.arrayContaining(["channelsOnline", "eventRate", "npuLoad"]));
    const sounder = industrialPrefabDefinition("sensor.sounder-strobe");
    expect(sounder?.actions.map((action) => action.id)).toEqual(expect.arrayContaining(["mute", "self-test"]));
  });
});

function validParameter(parameter: IndustrialPrefabParameterDefinition): boolean {
  if (parameter.kind === "number") {
    return typeof parameter.defaultValue === "number"
      && (parameter.min === undefined || parameter.defaultValue >= parameter.min)
      && (parameter.max === undefined || parameter.defaultValue <= parameter.max)
      && (parameter.step === undefined || parameter.step > 0);
  }
  if (parameter.kind === "select") return typeof parameter.defaultValue === "string" && parameter.options?.includes(parameter.defaultValue) === true;
  return parameter.kind === "boolean" ? typeof parameter.defaultValue === "boolean" : typeof parameter.defaultValue === "string";
}
