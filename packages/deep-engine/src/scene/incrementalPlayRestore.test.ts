import { describe, expect, it } from "vitest";
import { deepEquals, planIncrementalPlayRestore,
  type PlayRestoreModelIdentity, type PlayRestorePrimitiveIdentity, type PlayRestoreSnapshotView } from "./incrementalPlayRestore.js";

function model(id: string, overrides: Partial<PlayRestoreModelIdentity> = {}): PlayRestoreModelIdentity {
  return { modelId: id, ...overrides };
}

function primitive(id: string, overrides: Partial<PlayRestorePrimitiveIdentity> = {}): PlayRestorePrimitiveIdentity {
  return { modelId: id, name: `图元 ${id}`, kind: "box", color: "#d9a441", ...overrides };
}

function snapshot(overrides: Partial<PlayRestoreSnapshotView> = {}): PlayRestoreSnapshotView {
  return {
    id: "scene-1",
    models: [model("a"), model("b", { assetModelId: "asset-b" }), model("c", { assetRevision: { packageId: "pkg", revision: 3, sourceHash: "h3" } })],
    primitives: [primitive("p1"), primitive("p2", { kind: "cylinder", color: "#2255aa" })],
    measurements: [{ id: "m1", start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } }],
    annotations: [{ id: "a1", name: "标签", position: { x: 1, y: 2, z: 3 } }],
    ...overrides,
  };
}

describe("C25 增量域重载计划（planIncrementalPlayRestore）", () => {
  it("纯驱动场景（只有位姿/播放头变化，不在视图内）→ fast，逐实例计数与缓存直通域齐全", () => {
    const enter = snapshot();
    const live = snapshot({ measurements: [{ id: "m1", start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } }] });
    const plan = planIncrementalPlayRestore(enter, live);
    expect(plan).toEqual({
      mode: "fast",
      stateRestoredModels: 3,
      stateRestoredPrimitives: 2,
      cacheHitDomains: ["models", "primitives", "measurements", "annotations"],
    });
  });

  it("播放中增删模型（数量不等）→ full，阻断域 models", () => {
    const live = snapshot({ models: [model("a"), model("b", { assetModelId: "asset-b" })] });
    expect(planIncrementalPlayRestore(snapshot(), live)).toEqual({ mode: "full", blockedBy: ["models"] });
  });

  it("播放中替换素材（assetModelId 变化）→ full；缺省身份按 modelId 口径对齐", () => {
    const live = snapshot({ models: [model("a", { assetModelId: "asset-swapped" }), model("b", { assetModelId: "asset-b" }),
      model("c", { assetRevision: { packageId: "pkg", revision: 3, sourceHash: "h3" } })] });
    expect(planIncrementalPlayRestore(snapshot(), live)).toEqual({ mode: "full", blockedBy: ["models"] });
    // 回退口径一致（a 无 assetModelId ↔ live 显式 assetModelId==="a"）视为同一身份 → fast。
    const fallbackAligned = snapshot({ models: [model("a", { assetModelId: "a" }), model("b", { assetModelId: "asset-b" }),
      model("c", { assetRevision: { packageId: "pkg", revision: 3, sourceHash: "h3" } })] });
    expect(planIncrementalPlayRestore(snapshot(), fallbackAligned).mode).toBe("fast");
    // 回退口径不一致（b 在 live 侧省略 assetModelId，按 modelId 口径失配）→ full。
    const fallbackDrifted = snapshot({ models: [model("a"), model("b"),
      model("c", { assetRevision: { packageId: "pkg", revision: 3, sourceHash: "h3" } })] });
    expect(planIncrementalPlayRestore(snapshot(), fallbackDrifted)).toEqual({ mode: "full", blockedBy: ["models"] });
  });

  it("素材修订快照变化（packageId/revision/sourceHash 任一）→ full", () => {
    const revised = snapshot({ models: [model("a"), model("b", { assetModelId: "asset-b" }),
      model("c", { assetRevision: { packageId: "pkg", revision: 4, sourceHash: "h3" } })] });
    expect(planIncrementalPlayRestore(snapshot(), revised)).toEqual({ mode: "full", blockedBy: ["models"] });
  });

  it("图元 kind 或 color 变化（GPU 几何/共享材质身份）→ full，阻断域 primitives；仅名称变化仍 fast", () => {
    const kindChanged = snapshot({ primitives: [primitive("p1", { kind: "sphere" }), primitive("p2", { kind: "cylinder", color: "#2255aa" })] });
    expect(planIncrementalPlayRestore(snapshot(), kindChanged)).toEqual({ mode: "full", blockedBy: ["primitives"] });
    const colorChanged = snapshot({ primitives: [primitive("p1", { color: "#ffffff" }), primitive("p2", { kind: "cylinder", color: "#2255aa" })] });
    expect(planIncrementalPlayRestore(snapshot(), colorChanged).blockedBy).toEqual(["primitives"]);
    const renamed = snapshot({ primitives: [primitive("p1", { name: "改名" }), primitive("p2", { kind: "cylinder", color: "#2255aa" })] });
    expect(planIncrementalPlayRestore(snapshot(), renamed).mode).toBe("fast");
  });

  it("测量/标注集合任一变化 → full 且阻断域逐一指明；多域同时阻断全部列出", () => {
    const measurementMoved = snapshot({ measurements: [{ id: "m1", start: { x: 5, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } }] });
    expect(planIncrementalPlayRestore(snapshot(), measurementMoved)).toEqual({ mode: "full", blockedBy: ["measurements"] });
    const annotationAdded = snapshot({ annotations: [{ id: "a1", name: "标签", position: { x: 1, y: 2, z: 3 } }, { id: "a2", name: "新标签", position: { x: 0, y: 0, z: 0 } }] });
    expect(planIncrementalPlayRestore(snapshot(), annotationAdded)).toEqual({ mode: "full", blockedBy: ["annotations"] });
    const both = planIncrementalPlayRestore(snapshot(), snapshot({
      models: [], primitives: [], measurements: [], annotations: [{ id: "x" }],
    }));
    expect(both).toEqual({ mode: "full", blockedBy: ["models", "primitives", "measurements", "annotations"] });
  });

  it("进入/退出之间场景被替换（id 不一致）→ full，阻断域 scene-identity", () => {
    expect(planIncrementalPlayRestore(snapshot(), snapshot({ id: "scene-2" }))).toEqual({ mode: "full", blockedBy: ["scene-identity"] });
  });

  it("缺省 kind 按 box 口径对齐（与 createPrimitive 语义一致），缺省测量/标注视为空集", () => {
    const enter = snapshot({ primitives: [primitive("p1", { kind: undefined })], measurements: undefined, annotations: undefined });
    const live = snapshot({ primitives: [primitive("p1")], measurements: [], annotations: [] });
    expect(planIncrementalPlayRestore(enter, live).mode).toBe("fast");
  });

  it("deepEquals：嵌套结构/数组顺序/NaN/undefined 字段省略语义", () => {
    expect(deepEquals({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(deepEquals([1, 2, 3], [1, 3, 2])).toBe(false);
    expect(deepEquals({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEquals(NaN, NaN)).toBe(true);
    expect(deepEquals({ a: NaN }, { a: 0 })).toBe(false);
    expect(deepEquals(null, undefined)).toBe(false);
    expect(deepEquals([1, 2], 2)).toBe(false);
  });
});

describe("C25 分段账本（模拟口径：真实 V8 耗时 + 引擎调用段计数）", () => {
  /**
   * 规模取自工业样场景量级：40 模型实例 / 120 图元 / 30 测量 / 20 标注。
   * 计时段为纯 CPU（Node 与浏览器同为 V8，量级可参照）；引擎侧段（loadModel/
   * clearSceneModels/createPrimitive）在 Node 无法测得真实 GPU 成本，按调用段计数 +
   * T11 文档参考值折算，真机数值未测（如实标注）。
   */
  const N_MODELS = 40, N_PRIMITIVES = 120, N_MEASUREMENTS = 30, N_ANNOTATIONS = 20;

  function scaledSnapshot(sceneId: string) {
    const models = Array.from({ length: N_MODELS }, (_, i) =>
      model(`inst-${i}`, { assetModelId: `asset-${i % 7}`, assetRevision: { packageId: "pkg", revision: 1, sourceHash: `h${i % 7}` } }));
    const primitives = Array.from({ length: N_PRIMITIVES }, (_, i) => primitive(`prim-${i}`, { kind: i % 3 === 0 ? "cylinder" : "box" }));
    const measurements = Array.from({ length: N_MEASUREMENTS }, (_, i) => ({
      id: `m-${i}`, start: { x: i, y: 0.5, z: 1.5 }, end: { x: i + 1, y: 2.5, z: 3.5 }, value: `${i}.00 m`,
    }));
    const annotations = Array.from({ length: N_ANNOTATIONS }, (_, i) => ({
      id: `ann-${i}`, name: `标签 ${i}`, description: "设备 · 工位", position: { x: i, y: 2, z: 0 }, color: "#d9a441", visible: true, locked: false, size: 0.85,
    }));
    return { id: sceneId, models, primitives, measurements, annotations };
  }

  function medianOf(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  function measure(label: string, samples: number[]): number {
    const median = medianOf(samples);
    console.info(`[C25 分段账本] ${label}: 中位 ${median.toFixed(3)} ms（${samples.length} 轮）`);
    return median;
  }

  it("同规模快照的差分计划耗时与引擎调用段计数（快 vs 全量）", () => {
    const enter = scaledSnapshot("bench-scene");
    const livePlayed = structuredClone(enter);
    // 播放驱动只改写位姿/播放头：视图不含这些字段，fast 计划成立。
    const planFast = planIncrementalPlayRestore(enter, livePlayed);
    expect(planFast).toEqual({
      mode: "fast",
      stateRestoredModels: N_MODELS,
      stateRestoredPrimitives: N_PRIMITIVES,
      cacheHitDomains: ["models", "primitives", "measurements", "annotations"],
    });
    // live 侧集合变化（播放中删了一台设备）→ full，且差分仍然便宜。
    const liveEdited = structuredClone(enter);
    (liveEdited.models as PlayRestoreModelIdentity[]).pop();
    expect(planIncrementalPlayRestore(enter, liveEdited)).toEqual({ mode: "full", blockedBy: ["models"] });

    const planFastSamples: number[] = [];
    const planEditedSamples: number[] = [];
    const cloneSamples: number[] = [];
    for (let round = 0; round < 25; round += 1) {
      const cloneStart = performance.now();
      structuredClone(enter);
      cloneSamples.push(performance.now() - cloneStart);
      const fastStart = performance.now();
      planIncrementalPlayRestore(enter, livePlayed);
      planFastSamples.push(performance.now() - fastStart);
      const editedStart = performance.now();
      planIncrementalPlayRestore(enter, liveEdited);
      planEditedSamples.push(performance.now() - editedStart);
    }
    const cloneMs = measure("enter 快照 structuredClone（进入 Play 固有成本）", cloneSamples);
    const planFastMs = measure("退出差分 planIncrementalPlayRestore（fast 判定）", planFastSamples);
    const planEditedMs = measure("退出差分 planIncrementalPlayRestore（full 判定）", planEditedSamples);

    // 引擎调用段计数（来自 applyScene 两条路径的代码事实，供折算与真机对账）：
    const segments = {
      full: {
        clearSceneModels: 1, modelLoadFetchParseUpload: N_MODELS, modelApplyModelState: N_MODELS,
        primitiveRemove: N_PRIMITIVES, primitiveCreateAndSelect: N_PRIMITIVES, primitiveApplyModelState: N_PRIMITIVES,
        measurementsRebuild: N_MEASUREMENTS + 1, annotationsRebuild: N_ANNOTATIONS,
        cheapStateSetters: 30, controlAnimationSeek: 0,
      },
      fast: {
        clearSceneModels: 0, modelLoadFetchParseUpload: 0, modelApplyModelState: N_MODELS,
        primitiveRemove: 0, primitiveCreateAndSelect: 0, primitiveApplyModelState: N_PRIMITIVES,
        measurementsRebuild: 0, annotationsRebuild: 0,
        cheapStateSetters: 30, controlAnimationSeek: N_MODELS,
      },
    };
    console.info("[C25 分段账本] 引擎调用段计数（全量 → 快速）：");
    console.info(`  clearSceneModels ${segments.full.clearSceneModels} → ${segments.fast.clearSceneModels}`);
    console.info(`  模型 fetch+parse+upload ${segments.full.modelLoadFetchParseUpload} → ${segments.fast.modelLoadFetchParseUpload}`);
    console.info(`  图元 remove+create+select ${segments.full.primitiveRemove} + ${segments.full.primitiveCreateAndSelect} → 0`);
    console.info(`  测量/标注重建 ${segments.full.measurementsRebuild}/${segments.full.annotationsRebuild} → 0/0`);
    console.info(`  逐实例 applyModelState ${segments.full.modelApplyModelState + segments.full.primitiveApplyModelState} → ${segments.fast.modelApplyModelState + segments.fast.primitiveApplyModelState}`);
    console.info(`  附加 controlAnimation(seek 0) ${segments.full.controlAnimationSeek} → ${segments.fast.controlAnimationSeek}`);

    // 结构性护栏（非计时断言，防 flaky）：差分必须远便宜于快照克隆本身。
    expect(planFastMs).toBeLessThan(Math.max(cloneMs, 1));
    expect(planFast.stateRestoredModels).toBe(N_MODELS);
  });
});
