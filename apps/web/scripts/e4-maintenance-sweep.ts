/**
 * E4 维护净空扫掠 CLI:runMaintenanceClearanceSweep + formatMaintenanceClearanceReport
 * 的最小生产装配入口(输入=运动体+路径+障碍场景 → 输出=人读报告)。
 *
 * 形态沿 apps/web/scripts 既有脚本先例(benchmark-ordinary-picking.ts:
 * TS CLI + import ../src/viewer/* + 报告落盘),不进编辑器 UI(components/**
 * 与挂载面属并行线路在途文件,禁碰)。
 *
 * 用法(apps/web 目录):
 *   pnpm sweep:maintenance                     # 内置验收双场景(过道人形 + 拆卸件抽取)
 *   pnpm sweep:maintenance -- --scene s.json   # 自定义场景(见 SCENE_FORMAT)
 *   pnpm sweep:maintenance -- --scene s.json --out report.txt --json report.json
 *
 * 场景 JSON(SCENE_FORMAT):
 *   {
 *     "name": "过道检修",                          // 可选,展示名
 *     "sampleCount": 1600,                         // 必填,≥2
 *     "defaultRequiredClearanceMetres": 0.5,       // 可选,场景默认红线(米)
 *     "sweepOptions": { "touchEpsilon": 1e-9,      // 可选,透传扫掠选项
 *                       "refinementTimeToleranceSeconds": 1e-6,
 *                       "maxRefinementIterations": 40 },
 *     "path": { "waypoints": [                     // 必填,≥2 路标,时刻严格递增
 *       { "timeSeconds": 0, "position": [0,0,0], "headingRadians": 0 },
 *       { "timeSeconds": 8, "position": [10,0,0] } ] },
 *     "movers": [                                  // 必填,≥1
 *       { "bodyId": "human",
 *         "shape": { "kind": "humanProxyBox", "widthMetres": 0.6, "depthMetres": 0.8, "heightMetres": 1.75 },
 *         "requiredClearanceMetres": 0.5,          // 可选,覆盖场景默认红线
 *         "localOffset": { "translation": [0,0,0], "rotationQuaternion": [0,0,0,1] } } ],
 *     "obstacles": [                               // 必填,≥1
 *       { "bodyId": "pillar",
 *         "shape": { "kind": "box", "halfExtents": [0.2,0.2,1.5] },
 *         "translation": [4,-1.2,1.5],             // 可选,缺省原点
 *         "headingRadians": 0 } ] }                // 可选,绕 +Z 航向(弧度)
 *
 * shape kind:humanProxyBox / capsule / box / sphere / mesh
 *   mesh.vertices 为平面顶点数组(长度 3 的倍数),走 sceneMeshConvexShape
 *   生产通路(WeakMap 缓存;凸包 ⊇ 本体,净空只低估不高估)。
 *
 * 退出码:0 = 全部场景通过;1 = 存在场景未通过(碰撞或红线违规);2 = 工具/输入错误。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as THREE from "three";
import type { ConvexShape, RigidTransform } from "../src/viewer/convexDistance";
import {
  boxShapeFromHalfExtents,
  capsuleProxyShape,
  formatMaintenanceClearanceReport,
  humanProxyBoxShape,
  runMaintenanceClearanceSweep,
  sceneMeshConvexShape,
  type MaintenanceClearanceReport,
  type MaintenanceClearanceSpec,
  type MaintenanceObstacleSpec,
  type MaintenanceMoverSpec,
} from "../src/viewer/maintenanceSweep";
import type { SweepCollisionOptions } from "../src/viewer/robotSweepCollision";

// ─────────────────────────── JSON 结构解析(数值合法性委托域层断言) ───────────────────────────

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数值`);
  }
  return value;
}

function asNumberArray(value: unknown, label: string, length?: number): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  if (length !== undefined && value.length !== length) {
    throw new Error(`${label} 必须是长度 ${length} 的数组,得到 ${value.length}`);
  }
  return value.map((item, index) => asNumber(item, `${label}[${index}]`));
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : asNumber(value, label);
}

/** 绕 +Z 航向角 → (x,y,z,w) 四元数(与 maintenanceSweep 路径航向同轴同式)。 */
function yawQuaternionRadians(yaw: number): [number, number, number, number] {
  const half = yaw / 2;
  return [0, 0, Math.sin(half), Math.cos(half)];
}

type CliShape =
  | { kind: "humanProxyBox"; record: Record<string, unknown> }
  | { kind: "capsule"; record: Record<string, unknown> }
  | { kind: "box"; record: Record<string, unknown> }
  | { kind: "sphere"; record: Record<string, unknown> }
  | { kind: "mesh"; record: Record<string, unknown> };

function parseShape(value: unknown, label: string): CliShape {
  const record = asRecord(value, label);
  const kind = record.kind;
  if (kind !== "humanProxyBox" && kind !== "capsule" && kind !== "box" && kind !== "sphere" && kind !== "mesh") {
    throw new Error(`${label}.kind 必须是 humanProxyBox/capsule/box/sphere/mesh,得到 ${String(kind)}`);
  }
  return { kind, record } as CliShape;
}

/** JSON 形状 → GJK ConvexShape(数值断言全部委托 maintenanceSweep 域层,CLI 层只做结构分发)。 */
function resolveShape(shape: CliShape, label: string): ConvexShape {
  switch (shape.kind) {
    case "humanProxyBox":
      return humanProxyBoxShape({
        widthMetres: asNumber(shape.record.widthMetres, `${label}.widthMetres`),
        depthMetres: asNumber(shape.record.depthMetres, `${label}.depthMetres`),
        heightMetres: asNumber(shape.record.heightMetres, `${label}.heightMetres`),
      });
    case "capsule": {
      const segments = optionalNumber(shape.record.segments, `${label}.segments`);
      return capsuleProxyShape({
        radiusMetres: asNumber(shape.record.radiusMetres, `${label}.radiusMetres`),
        heightMetres: asNumber(shape.record.heightMetres, `${label}.heightMetres`),
        ...(segments !== undefined ? { segments: Math.trunc(segments) } : {}),
      });
    }
    case "box": {
      const halfExtents = asNumberArray(shape.record.halfExtents, `${label}.halfExtents`, 3);
      return boxShapeFromHalfExtents(halfExtents[0]!, halfExtents[1]!, halfExtents[2]!);
    }
    case "sphere":
      return { kind: "sphere", radius: asNumber(shape.record.radius, `${label}.radius`) };
    case "mesh": {
      const vertices = asNumberArray(shape.record.vertices, `${label}.vertices`);
      if (vertices.length === 0 || vertices.length % 3 !== 0) {
        throw new Error(`${label}.vertices 长度必须是 3 的倍数(平面 [x,y,z,...] 顶点数组),得到 ${vertices.length}`);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
      const maxVertices = optionalNumber(shape.record.maxVertices, `${label}.maxVertices`);
      return sceneMeshConvexShape(geometry, maxVertices !== undefined ? { maxVertices: Math.trunc(maxVertices) } : {});
    }
  }
}

function parseWaypoints(value: unknown, label: string): MaintenanceClearanceSpec["path"]["waypoints"] {
  if (!Array.isArray(value) || value.length < 2) throw new Error(`${label} 至少需要 2 个路标`);
  return value.map((item, index) => {
    const record = asRecord(item, `${label}[${index}]`);
    const position = asNumberArray(record.position, `${label}[${index}].position`, 3);
    const heading = optionalNumber(record.headingRadians, `${label}[${index}].headingRadians`);
    return {
      timeSeconds: asNumber(record.timeSeconds, `${label}[${index}].timeSeconds`),
      position: [position[0]!, position[1]!, position[2]!] as [number, number, number],
      ...(heading !== undefined ? { headingRadians: heading } : {}),
    };
  });
}

function parseLocalOffset(value: unknown, label: string): RigidTransform {
  const record = asRecord(value, label);
  const translation = asNumberArray(record.translation, `${label}.translation`, 3);
  const rotation = asNumberArray(record.rotationQuaternion, `${label}.rotationQuaternion`, 4);
  return {
    translation: [translation[0]!, translation[1]!, translation[2]!],
    rotationQuaternion: [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!],
  };
}

/** 场景 JSON → MaintenanceClearanceSpec。 */
export function parseSceneDocument(document: unknown, sourceLabel: string): MaintenanceClearanceSpec & { name: string } {
  const root = asRecord(document, sourceLabel);
  const pathRecord = asRecord(root.path, `${sourceLabel}.path`);
  const moversValue = root.movers;
  const obstaclesValue = root.obstacles;
  if (!Array.isArray(moversValue) || moversValue.length === 0) throw new Error(`${sourceLabel}.movers 至少 1 个运动体`);
  if (!Array.isArray(obstaclesValue) || obstaclesValue.length === 0) throw new Error(`${sourceLabel}.obstacles 至少 1 个障碍`);
  const sampleCount = optionalNumber(root.sampleCount, `${sourceLabel}.sampleCount`);
  if (sampleCount === undefined) throw new Error(`${sourceLabel}.sampleCount 必填(≥2 整数)`);

  const movers: MaintenanceMoverSpec[] = moversValue.map((item, index) => {
    const record = asRecord(item, `${sourceLabel}.movers[${index}]`);
    const shape = resolveShape(parseShape(record.shape, `${sourceLabel}.movers[${index}].shape`), `${sourceLabel}.movers[${index}].shape`);
    const required = optionalNumber(record.requiredClearanceMetres, `${sourceLabel}.movers[${index}].requiredClearanceMetres`);
    return {
      bodyId: asString(record.bodyId, `${sourceLabel}.movers[${index}].bodyId`),
      shape,
      ...(required !== undefined ? { requiredClearanceMetres: required } : {}),
      ...(record.localOffset !== undefined
        ? { localOffset: parseLocalOffset(record.localOffset, `${sourceLabel}.movers[${index}].localOffset`) }
        : {}),
    };
  });

  const obstacles: MaintenanceObstacleSpec[] = obstaclesValue.map((item, index) => {
    const record = asRecord(item, `${sourceLabel}.obstacles[${index}]`);
    const shape = resolveShape(parseShape(record.shape, `${sourceLabel}.obstacles[${index}].shape`), `${sourceLabel}.obstacles[${index}].shape`);
    const translationValue = record.translation;
    const translation: [number, number, number] = translationValue === undefined
      ? [0, 0, 0]
      : (asNumberArray(translationValue, `${sourceLabel}.obstacles[${index}].translation`, 3) as [number, number, number]);
    const heading = optionalNumber(record.headingRadians, `${sourceLabel}.obstacles[${index}].headingRadians`);
    const transform: RigidTransform = {
      translation,
      rotationQuaternion: yawQuaternionRadians(heading ?? 0),
    };
    return { bodyId: asString(record.bodyId, `${sourceLabel}.obstacles[${index}].bodyId`), shape, transform };
  });

  const sweepOptionsValue = root.sweepOptions;
  let sweepOptions: SweepCollisionOptions | undefined;
  if (sweepOptionsValue !== undefined) {
    const record = asRecord(sweepOptionsValue, `${sourceLabel}.sweepOptions`);
    const touchEpsilon = optionalNumber(record.touchEpsilon, `${sourceLabel}.sweepOptions.touchEpsilon`);
    const refinement = optionalNumber(record.refinementTimeToleranceSeconds, `${sourceLabel}.sweepOptions.refinementTimeToleranceSeconds`);
    const maxIterations = optionalNumber(record.maxRefinementIterations, `${sourceLabel}.sweepOptions.maxRefinementIterations`);
    sweepOptions = {
      ...(touchEpsilon !== undefined ? { touchEpsilon } : {}),
      ...(refinement !== undefined ? { refinementTimeToleranceSeconds: refinement } : {}),
      ...(maxIterations !== undefined ? { maxRefinementIterations: Math.trunc(maxIterations) } : {}),
    };
  }

  const defaultRequired = optionalNumber(root.defaultRequiredClearanceMetres, `${sourceLabel}.defaultRequiredClearanceMetres`);
  return {
    name: typeof root.name === "string" && root.name.length > 0 ? root.name : sourceLabel,
    path: { waypoints: parseWaypoints(pathRecord.waypoints, `${sourceLabel}.path.waypoints`) },
    movers,
    obstacles,
    sampleCount: Math.trunc(sampleCount),
    ...(defaultRequired !== undefined ? { defaultRequiredClearanceMetres: defaultRequired } : {}),
    ...(sweepOptions !== undefined ? { sweepOptions } : {}),
  };
}

// ─────────────────────────── 内置验收场景(复刻 E4 验收几何,通路自证) ───────────────────────────

/** 内置双场景:人形代理过道(双柱+内伸机柜,碰撞检出)+ 拆卸件上架抽取(网格凸近似通路)。 */
export function builtinScenes(): Array<MaintenanceClearanceSpec & { name: string }> {
  const corridor: MaintenanceClearanceSpec = {
    path: {
      waypoints: [
        { timeSeconds: 0, position: [0, 0, 0] },
        { timeSeconds: 8, position: [10, 0, 0] },
      ],
    },
    movers: [
      { bodyId: "human-proxy", shape: humanProxyBoxShape({ widthMetres: 0.6, depthMetres: 0.8, heightMetres: 1.75 }) },
    ],
    obstacles: [
      { bodyId: "pillar-left", shape: boxShapeFromHalfExtents(0.2, 0.2, 1.5), transform: { translation: [4, -1.2, 1.5], rotationQuaternion: [0, 0, 0, 1] } },
      { bodyId: "pillar-right", shape: boxShapeFromHalfExtents(0.2, 0.2, 1.5), transform: { translation: [6, 1.2, 1.5], rotationQuaternion: [0, 0, 0, 1] } },
      { bodyId: "machine-intrusion", shape: boxShapeFromHalfExtents(0.5, 0.7, 0.6), transform: { translation: [5, 0.55, 0.6], rotationQuaternion: [0, 0, 0, 1] } },
    ],
    sampleCount: 1600,
    defaultRequiredClearanceMetres: 0.5,
  };
  // 拆卸件走生产网格通路:BufferGeometry → sceneMeshConvexShape(WeakMap 缓存)。
  const partGeometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
  const extraction: MaintenanceClearanceSpec = {
    path: {
      waypoints: [
        { timeSeconds: 0, position: [0, 0, 0.6] },
        { timeSeconds: 3, position: [0, 0, 2.6] },
      ],
    },
    movers: [{ bodyId: "disassembly-part", shape: sceneMeshConvexShape(partGeometry) }],
    obstacles: [
      { bodyId: "shelf", shape: boxShapeFromHalfExtents(0.1, 1.0, 0.2), transform: { translation: [0.5, 0, 1.4], rotationQuaternion: [0, 0, 0, 1] } },
    ],
    sampleCount: 900,
    defaultRequiredClearanceMetres: 0.2,
  };
  return [
    { name: "内置场景一 · 人形代理过道(双柱+内伸机柜)", ...corridor },
    { name: "内置场景二 · 拆卸件上架抽取(网格凸近似)", ...extraction },
  ];
}

// ─────────────────────────── CLI 主流程 ───────────────────────────

interface CliInvocation {
  scenesPath: string | null;
  outPath: string | null;
  jsonPath: string | null;
}

function parseInvocation(argv: readonly string[]): CliInvocation {
  const invocation: CliInvocation = { scenesPath: null, outPath: null, jsonPath: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const takeValue = (label: string): string => {
      const inline = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argv[++index];
      if (!inline) throw new Error(`${label} 需要一个值`);
      return inline;
    };
    if (argument === "--") continue; // pnpm/npm 透传的参数分隔符,按 CLI 惯例跳过
    if (argument === "--scene" || argument.startsWith("--scene=")) invocation.scenesPath = takeValue("--scene");
    else if (argument === "--out" || argument.startsWith("--out=")) invocation.outPath = takeValue("--out");
    else if (argument === "--json" || argument.startsWith("--json=")) invocation.jsonPath = takeValue("--json");
    else throw new Error(`未知参数 ${argument}(支持 --scene/--out/--json)`);
  }
  return invocation;
}

function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), content);
}

interface SceneRunOutcome {
  name: string;
  pass: boolean;
  elapsedMs: number;
  report: MaintenanceClearanceReport;
}

function runScene(scene: MaintenanceClearanceSpec, name: string): SceneRunOutcome {
  const { report, elapsedMs } = runMaintenanceClearanceSweep(scene);
  return { name, pass: report.summary.pass, elapsedMs, report };
}

async function main(): Promise<number> {
  const invocation = parseInvocation(process.argv.slice(2));

  const scenes = invocation.scenesPath
    ? [parseSceneDocument(JSON.parse(readFileSync(resolve(invocation.scenesPath), "utf-8")), invocation.scenesPath)]
    : builtinScenes();

  const outcomes: SceneRunOutcome[] = [];
  const textBlocks: string[] = [];
  for (const scene of scenes) {
    const outcome = runScene(scene, scene.name);
    outcomes.push(outcome);
    textBlocks.push(`【${outcome.name}】\n${formatMaintenanceClearanceReport(outcome.report)}\n(耗时 ${outcome.elapsedMs.toFixed(1)} ms)`);
  }
  const text = textBlocks.join("\n\n");
  console.log(text);

  if (invocation.outPath) writeTextFile(invocation.outPath, `${text}\n`);
  if (invocation.jsonPath) {
    writeTextFile(invocation.jsonPath, JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        tool: "e4-maintenance-sweep",
        scenes: outcomes.map(outcome => ({
          name: outcome.name,
          pass: outcome.pass,
          elapsedMs: outcome.elapsedMs,
          report: outcome.report,
        })),
        allPass: outcomes.every(outcome => outcome.pass),
      },
      null,
      2,
    ));
  }

  const allPass = outcomes.every(outcome => outcome.pass);
  console.log(`\n总评:${allPass ? "全部场景通过" : "存在未通过场景"}(场景 ${outcomes.length} 个,未通过 ${outcomes.filter(outcome => !outcome.pass).length} 个)`);
  return allPass ? 0 : 1;
}

main().then(
  code => { process.exitCode = code; },
  error => {
    console.error(`[e4-maintenance-sweep] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
