import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { industrialPrefabDefinition } from "../industrialPrefabCatalog";
import { clearThumbnailCaches, inspectThumbnailCaches } from "../../settings/thumbnailCache";
import {
  __setPrefabThumbnailGlbLoaderForTests,
  __setPrefabThumbnailPainterForTests,
  getPrefabThumbnail,
} from "./prefabThumbnailRenderer";

const agv = industrialPrefabDefinition("agv.carrier")!;
const pump = industrialPrefabDefinition("utility.pump.centrifugal")!;

afterEach(() => {
  __setPrefabThumbnailPainterForTests(null); // 还原真实画笔并清空队列/缓存
  __setPrefabThumbnailGlbLoaderForTests(null); // 还原 GLB 加载器
});

describe("prefab thumbnail renderer queue/cache/fallback", () => {
  it("清理期间的排队缩略图仍交付调用方，但不会重新填回缓存", async () => {
    const painter = vi.fn(() => "data:image/webp;cache-test");
    __setPrefabThumbnailPainterForTests(painter);
    const pending = getPrefabThumbnail(agv);
    clearThumbnailCaches();
    await expect(pending).resolves.toBe("data:image/webp;cache-test");
    expect(inspectThumbnailCaches().entries).toBe(0);
    await getPrefabThumbnail(agv);
    expect(painter).toHaveBeenCalledTimes(2);
    expect(inspectThumbnailCaches().entries).toBe(1);
    clearThumbnailCaches();
    await getPrefabThumbnail(agv);
    expect(painter).toHaveBeenCalledTimes(3);
  });
  it("同一 definitionId 只渲染一次,缓存命中返回同一 dataURL", async () => {
    let calls = 0;
    __setPrefabThumbnailPainterForTests((model) => {
      calls += 1;
      expect(model.children.length).toBeGreaterThan(0);

      return "data:image/webp;mock";
    });
    const [first, second] = await Promise.all([getPrefabThumbnail(agv), getPrefabThumbnail(agv)]);
    expect(first).toBe("data:image/webp;mock");
    expect(second).toBe(first);
    expect(calls).toBe(1);
    // 缓存命中:不再进入队列
    await expect(getPrefabThumbnail(agv)).resolves.toBe(first);
    expect(calls).toBe(1);
  });

  it("不同预制体各自渲染,模型被构建器真实产出", async () => {
    const seen = new Set<string>();
    __setPrefabThumbnailPainterForTests((model) => {
      seen.add(model.uuid);

      return "data:image/webp;ok";
    });
    const [a, b] = await Promise.all([getPrefabThumbnail(agv), getPrefabThumbnail(pump)]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(seen.size).toBe(2);
  });

  it("画笔返回 undefined 时降级 resolve undefined", async () => {
    __setPrefabThumbnailPainterForTests(() => undefined);
    await expect(getPrefabThumbnail(agv)).resolves.toBeUndefined();
  });

  it("画笔抛异常时吞掉错误并降级 undefined", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __setPrefabThumbnailPainterForTests(() => {
      throw new Error("webgl boom");
    });
    await expect(getPrefabThumbnail(agv)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("同一 tick 入队的多个请求逐个出队,结果各自结算", async () => {
    const calls: string[] = [];
    __setPrefabThumbnailPainterForTests((model) => {
      calls.push(model.uuid);

      return `data:image/webp;${calls.length}`;
    });
    const fence = industrialPrefabDefinition("fence.modular")!;
    const [a, b, c] = await Promise.all([getPrefabThumbnail(agv), getPrefabThumbnail(pump), getPrefabThumbnail(fence)]);
    expect(calls.length).toBe(3); // 逐个渲染,无一遗漏
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("prefab thumbnail renderer real-model (GLB) path", () => {
  const glbDefinition = industrialPrefabDefinition("robot.articulated-6")!; // 匹配表内:industrial-576

  function fakeGlbSource(): THREE.Group {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(40, 20, 10), new THREE.MeshStandardMaterial());
    group.add(mesh);
    return group;
  }

  it("命中匹配表的预制体走 GLB 源渲染,模型被归一化并挂上风格种子", async () => {
    const painted: THREE.Group[] = [];
    __setPrefabThumbnailGlbLoaderForTests(async () => fakeGlbSource());
    __setPrefabThumbnailPainterForTests((model) => {
      painted.push(model);
      return "data:image/webp;glb";
    });
    await expect(getPrefabThumbnail(glbDefinition)).resolves.toBe("data:image/webp;glb");
    expect(painted).toHaveLength(1);
    const root = painted[0]!;
    // 归一化:最长边缩放到 3(本例最大维 40 → scale 0.075),底面落地
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(3, 5);
    expect(box.min.y).toBeGreaterThanOrEqual(-1e-6);
    expect(root.userData.prefabStyle).toMatchObject({ rimTint: expect.any(Number) });
  });

  it("GLB 源在同一资产内复用:两个预制体共享同一源,克隆各自渲染", async () => {
    let loads = 0;
    __setPrefabThumbnailGlbLoaderForTests(async () => {
      loads += 1;
      return fakeGlbSource();
    });
    const painted: string[] = [];
    __setPrefabThumbnailPainterForTests((model) => {
      painted.push(model.uuid);
      return `data:image/webp;${painted.length}`;
    });
    // 潜伏顶升 AGV 与 AMR 在匹配表里各用各的资产;这里连查两个不同资产 + 同资产缓存
    const first = await getPrefabThumbnail(glbDefinition);
    const again = await getPrefabThumbnail(glbDefinition);
    expect(first).toBe(again); // definitionId 级缓存仍然生效
    expect(loads).toBe(1);
    expect(painted).toHaveLength(1);
  });

  it("GLB 加载失败自动回退程序化渲染,永不白块", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __setPrefabThumbnailGlbLoaderForTests(async () => {
      throw new Error("network down");
    });
    const painted: THREE.Group[] = [];
    __setPrefabThumbnailPainterForTests((model) => {
      painted.push(model);
      return "data:image/webp;primitive";
    });
    await expect(getPrefabThumbnail(glbDefinition)).resolves.toBe("data:image/webp;primitive");
    expect(painted).toHaveLength(1); // 程序化模型顶上
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("失败的资产会话内不再重试 GLB,直接程序化", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    __setPrefabThumbnailGlbLoaderForTests(async () => {
      attempts += 1;
      throw new Error("still down");
    });
    __setPrefabThumbnailPainterForTests(() => "data:image/webp;primitive");
    await getPrefabThumbnail(glbDefinition);
    await getPrefabThumbnail(glbDefinition).then((url) => expect(url).toBe("data:image/webp;primitive"));
    expect(attempts).toBe(1); // 失败被记住,不再打第二遍
    warn.mockRestore();
  });

  it("未命中匹配表的预制体(如 SCARA 机器人)直接程序化,不触碰 GLB 加载", async () => {
    const loader = vi.fn(async () => fakeGlbSource());
    __setPrefabThumbnailGlbLoaderForTests(loader);
    __setPrefabThumbnailPainterForTests(() => "data:image/webp;primitive");
    const scara = industrialPrefabDefinition("robot.scara-4")!;
    await expect(getPrefabThumbnail(scara)).resolves.toBe("data:image/webp;primitive");
    expect(loader).not.toHaveBeenCalled();
  });
});
