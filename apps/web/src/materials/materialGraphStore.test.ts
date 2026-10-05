import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SceneMaterialGraphDefinition, SceneSnapshot } from "@bim-studio/contracts";
import { createLayer, createMaterialGraph } from "./materialGraphModel";
import {
  deleteMaterialGraph,
  graphStorageKey,
  loadMaterialGraph,
  saveMaterialGraph,
  setMaterialGraphSceneBridge,
} from "./materialGraphStore";

/**
 * Tier-2 迁移测试:图定义权威存储 = SceneSnapshot.materialGraphs;
 * v1 localStorage(键 = sceneId:modelId)仅保留一次性迁移读取。
 * node 测试环境无 localStorage,注入内存桩;桥为确定性伪实现(镜像
 * scenePersistenceController 的注册语义:场景不匹配静默拒绝)。
 */

const memory = new Map<string, string>();
const localStorageStub: Storage = {
  get length() {
    return memory.size;
  },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => {
    memory.delete(key);
  },
  setItem: (key, value) => {
    memory.set(key, value);
  },
};

const globalScope = globalThis as { localStorage?: Storage | undefined };

function makeScene(id: string, materialGraphs?: SceneSnapshot["materialGraphs"]): SceneSnapshot {
  return {
    schemaVersion: 1,
    id,
    projectId: "p1",
    name: "测试场景",
    camera: {} as unknown as SceneSnapshot["camera"],
    models: [],
    primitives: [],
    measurements: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(materialGraphs ? { materialGraphs } : {}),
  };
}

/** 伪桥:与持久化控制器注册语义同构(写他场景静默拒绝;空映射摘除字段)。 */
function attachBridge(harness: { scene: SceneSnapshot | undefined }): void {
  setMaterialGraphSceneBridge({
    getScene: (sceneId) => (harness.scene && harness.scene.id === sceneId ? harness.scene : undefined),
    commitMaterialGraph: (sceneId, modelId, graph) => {
      const current = harness.scene;
      if (!current || current.id !== sceneId) return;
      const { [modelId]: _dropped, ...remaining } = current.materialGraphs ?? {};
      if (!graph) {
        if (Object.keys(remaining).length) {
          harness.scene = { ...current, materialGraphs: remaining };
        } else {
          const { materialGraphs: _omitted, ...withoutGraphs } = current;
          harness.scene = withoutGraphs;
        }
        return;
      }
      harness.scene = { ...current, materialGraphs: { ...remaining, [modelId]: graph } };
    },
  });
}

beforeEach(() => {
  memory.clear();
  globalScope.localStorage = localStorageStub;
});

afterEach(() => {
  setMaterialGraphSceneBridge(undefined);
  globalScope.localStorage = undefined;
});

/** 迁移组:v1 旧键 → 快照的一次性收编与顺位规则。 */
describe("materialGraphStore Tier-2 迁移", () => {
  it("快照缺失 + 旧键存在 → 迁入快照、清除旧键、返回定义;二次读走快照", () => {
    const harness = { scene: makeScene("s1") };
    attachBridge(harness);
    const legacy = createMaterialGraph("旧图");
    localStorage.setItem(graphStorageKey("s1", "m1"), JSON.stringify(legacy));

    const loaded = loadMaterialGraph("s1", "m1");
    expect(loaded?.id).toBe(legacy.id);
    expect(harness.scene?.materialGraphs?.m1?.id).toBe(legacy.id);
    expect(harness.scene?.materialGraphs?.m1?.name).toBe("旧图");
    expect(localStorage.getItem(graphStorageKey("s1", "m1"))).toBeNull();

    // 二次读取:旧键已清,从快照稳定恢复(迁移幂等)。
    const again = loadMaterialGraph("s1", "m1");
    expect(again?.id).toBe(legacy.id);
    expect(memory.size).toBe(0);
  });

  it("顺位:快照已有定义时以快照为权威,并顺手清理 v1 残键", () => {
    const snapGraph = createMaterialGraph("快照图");
    const harness = { scene: makeScene("s1", { m1: snapGraph }) };
    attachBridge(harness);
    localStorage.setItem(graphStorageKey("s1", "m1"), JSON.stringify(createMaterialGraph("旧图")));

    const loaded = loadMaterialGraph("s1", "m1");
    expect(loaded?.id).toBe(snapGraph.id);
    expect(loaded?.name).toBe("快照图");
    expect(localStorage.getItem(graphStorageKey("s1", "m1"))).toBeNull();
  });
});

/** 往返组:接桥后写读删全走快照,localStorage 不再是持久化层。 */
describe("materialGraphStore 快照往返", () => {
  it("save → 快照可见 → load 深等价;delete → 条目与字段摘除", () => {
    const harness = { scene: makeScene("s1") };
    attachBridge(harness);
    const graph = createMaterialGraph("往返图", { color: "#123456", metalness: 0.4, roughness: 0.6 });
    graph.layers = [createLayer("dust", "灰尘")];

    expect(saveMaterialGraph("s1", "m1", graph)).toBe(true);
    expect(harness.scene?.materialGraphs?.m1?.version).toBe(1);
    expect(harness.scene?.materialGraphs?.m1?.layers).toHaveLength(1);
    const loaded = loadMaterialGraph("s1", "m1");
    expect(loaded).toEqual(graph);
    // 写路径不落 localStorage(v1 键空间保持干净)。
    expect(memory.size).toBe(0);

    deleteMaterialGraph("s1", "m1");
    expect(harness.scene?.materialGraphs?.m1).toBeUndefined();
    expect(loadMaterialGraph("s1", "m1")).toBeUndefined();
  });

  it("跨场景保护:活动场景 id 不匹配时 save 拒绝、delete 不写他场景", () => {
    const harness = { scene: makeScene("s1") };
    attachBridge(harness);
    const graph = createMaterialGraph("他场景图");

    expect(saveMaterialGraph("s9", "m1", graph)).toBe(false);
    expect(harness.scene?.materialGraphs).toBeUndefined();
    expect(memory.size).toBe(0);

    deleteMaterialGraph("s9", "m1");
    expect(harness.scene && "materialGraphs" in harness.scene).toBe(false);
  });
});

/** 旧快照兼容组:无 materialGraphs 字段照常加载(Tier-2 可选字段向后兼容)。 */
describe("materialGraphStore 旧快照兼容", () => {
  it("无字段的旧快照:读取返回 undefined,写入创建字段", () => {
    const harness = { scene: makeScene("s1") };
    attachBridge(harness);
    expect(harness.scene && "materialGraphs" in harness.scene).toBe(false);

    expect(loadMaterialGraph("s1", "m1")).toBeUndefined();
    const graph = createMaterialGraph("新图");
    expect(saveMaterialGraph("s1", "m1", graph)).toBe(true);
    expect(harness.scene?.materialGraphs?.m1?.id).toBe(graph.id);
  });
});

/** 损坏拒收组:毒数据不外吐、不留存。 */
describe("materialGraphStore 损坏拒收", () => {
  it("快照内非对象条目:拒收并从快照摘除", () => {
    const harness = {
      scene: makeScene("s1", { m1: "垃圾" as unknown as SceneMaterialGraphDefinition }),
    };
    attachBridge(harness);

    expect(loadMaterialGraph("s1", "m1")).toBeUndefined();
    expect(harness.scene && "materialGraphs" in harness.scene).toBe(false);
  });

  it("快照内缺 layers 数组的伪定义:拒收并摘除", () => {
    const harness = {
      scene: makeScene("s1", {
        m2: { version: 1, id: "x", name: "x", base: { color: "#000000", metalness: 0, roughness: 0 }, updatedAt: "2026-01-01T00:00:00.000Z" } as unknown as SceneMaterialGraphDefinition,
      }),
    };
    attachBridge(harness);

    expect(loadMaterialGraph("s1", "m2")).toBeUndefined();
    expect(harness.scene && "materialGraphs" in harness.scene).toBe(false);
  });

  it("旧键损坏 JSON:清键不留毒数据", () => {
    const harness = { scene: makeScene("s1") };
    attachBridge(harness);
    localStorage.setItem(graphStorageKey("s1", "m3"), "{broken json");

    expect(loadMaterialGraph("s1", "m3")).toBeUndefined();
    expect(localStorage.getItem(graphStorageKey("s1", "m3"))).toBeNull();
  });
});

/** 未接桥回落组:组件单测/预览渲染环境保 v1 行为(回归防线)。 */
describe("materialGraphStore 未接桥回落", () => {
  it("无桥时 save/load/delete 走 localStorage,与 v1 语义一致", () => {
    const graph = createMaterialGraph("回落图");
    expect(saveMaterialGraph("s1", "m1", graph)).toBe(true);
    expect(localStorage.getItem(graphStorageKey("s1", "m1"))).not.toBeNull();
    expect(loadMaterialGraph("s1", "m1")?.id).toBe(graph.id);
    deleteMaterialGraph("s1", "m1");
    expect(localStorage.getItem(graphStorageKey("s1", "m1"))).toBeNull();
  });
});
