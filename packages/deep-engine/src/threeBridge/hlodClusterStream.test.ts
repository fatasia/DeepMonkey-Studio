import { describe, expect, it } from "vitest";
import type { EditorOverlaySnapshot, RenderView } from "../webgpu/pbrRendererTypes.js";
import { applyAffineDirection, applyAffinePoint, applyHlodPlanToInstances, collapseSuppressedByOverlay,
  HLOD_PROXY_MATERIAL_ID, hlodPlanSignature, HlodClusterDecisionEngine, shrinkTransform,
  type HlodClusterProxyDraw, type HlodClusterStreamBinding } from "./hlodClusterStream.js";
import { buildTestHlodPackage } from "./hlodClusterStream.testUtils.js";

const view: RenderView = { width: 100, height: 100, pixelRatio: 1, eye: [0, 0, 5], target: [0, 0, 0],
  extent: 2, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 0.5 };
const overlay: EditorOverlaySnapshot = { revision: 1, vertices: new Float32Array(24) };

/** 三实例一簇:根内节点 + 3 叶;模型放置 = 平移 [100,0,0](决策空间逆 = 平移 [-100,0,0])。 */
function threeInstanceBinding(): { binding: HlodClusterStreamBinding;
  proxyGeometryId: string; rootProxy: HlodClusterProxyDraw } {
  const pkg = buildTestHlodPackage([
    { id: "inst-0", position: [0, 0, 0], radius: 0.5 },
    { id: "inst-1", position: [2, 0, 0], radius: 0.5 },
    { id: "inst-2", position: [4, 0, 0], radius: 0.5 },
  ], { targetPixelError: 8, hysteresisRatio: 0.12 });
  const root = pkg.manifest.proxies[0]!;
  const rootProxy: HlodClusterProxyDraw = { instanceId: "px-root", geometryId: root.geometryId,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1] };
  const binding: HlodClusterStreamBinding = {
    manifest: pkg.manifest,
    // 真实管线:T26 树以 apiId 为叶成员;绑定键 = 叶成员(apiId),值 = 场景实例 id。
    instanceIdsByNode: new Map(pkg.manifest.nodes
      .filter(node => node.children.length === 0)
      .flatMap(node => node.instanceIds).map(apiId => [apiId, [`scene-${apiId}`]])),
    proxyDrawsByNode: new Map([[root.nodeId, [rootProxy]]]),
    decisionFromWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -100, 0, 0, 1],
  };
  return { binding, proxyGeometryId: root.geometryId, rootProxy };
}

describe("HLOD cluster decision engine", () => {
  it("collapses the root from far cameras and localizes proxy draws to the render frame", () => {
    const { binding, proxyGeometryId } = threeInstanceBinding();
    const engine = new HlodClusterDecisionEngine([binding]);
    // 渲染局部相机 [100,0,30000] → 世界 +origin → 决策空间 [0,0,30000]:screenError≈0.1px。
    const plan = engine.decide({ ...view, eye: [100, 0, 30000], target: [100, 0, 0] }, [0, 0, 0]);
    expect(plan.suppressed).toBe(false);
    expect(plan.collapsedNodeCount).toBe(1);
    expect([...plan.hiddenInstanceIds].sort()).toEqual(["scene-inst-0", "scene-inst-1", "scene-inst-2"]);
    const draw = plan.activeProxyDraws.get("px-root")!;
    expect(draw.geometryId).toBe(proxyGeometryId);
    expect(draw.transform[12]).toBe(100); // 平移 −origin(0)后保留世界 x。
  });

  it("keeps originals rendered from near cameras", () => {
    const { binding } = threeInstanceBinding();
    const engine = new HlodClusterDecisionEngine([binding]);
    const plan = engine.decide({ ...view, eye: [102, 0, 6], target: [102, 0, 0] }, [0, 0, 0]);
    expect(plan.collapsedNodeCount).toBe(0);
    expect(plan.hiddenInstanceIds.size).toBe(0);
    expect(plan.activeProxyDraws.size).toBe(0);
  });

  it("transforms the decision camera through the placement inverse (rotation + translation)", () => {
    const pkg = buildTestHlodPackage([
      { id: "solo", position: [0, 0, 0], radius: 1 },
    ], { targetPixelError: 8 });
    // 单实例树无内节点 → 决策恒空;此用例只验证相机换算经 90° Y 旋转 + 平移后
    // 深度公式仍然自洽(远距同样不折叠,近距也不折叠,无异常抛出)。
    const cos = 0, sin = 1; // cos90=0, sin90=1 → R⁻¹ = Rᵀ。
    const binding: HlodClusterStreamBinding = { manifest: pkg.manifest,
      instanceIdsByNode: new Map(), proxyDrawsByNode: new Map(),
      decisionFromWorld: [cos, 0, -sin, 0, 0, 1, 0, 0, sin, 0, cos, 0, -10, 0, -20, 1] };
    const engine = new HlodClusterDecisionEngine([binding]);
    const plan = engine.decide({ ...view, eye: [10, 0, 25], target: [10, 0, 24] }, [0, 0, 0]);
    expect(plan.collapsedNodeCount).toBe(0);
  });

  it("suppresses collapse from editor overlay vertices or the host callback and resets hysteresis", () => {
    const { binding } = threeInstanceBinding();
    let hostSuppressed = false;
    const engine = new HlodClusterDecisionEngine([binding], () => hostSuppressed);
    const far = { ...view, eye: [100, 0, 30000], target: [100, 0, 0] };
    expect(engine.decide(far, [0, 0, 0]).collapsedNodeCount).toBe(1);
    const overlayPlan = engine.decide({ ...far, editorOverlay: overlay }, [0, 0, 0]);
    expect(overlayPlan.suppressed).toBe(true);
    expect(overlayPlan.hiddenInstanceIds.size).toBe(0);
    expect(overlayPlan.activeProxyDraws.size).toBe(0);
    expect(engine.decide(far, [0, 0, 0]).collapsedNodeCount).toBe(1);
    hostSuppressed = true;
    expect(engine.decide(far, [0, 0, 0]).suppressed).toBe(true);
  });

  it("holds collapsed clusters inside the hysteresis band across frames", () => {
    const { binding } = threeInstanceBinding();
    const engine = new HlodClusterDecisionEngine([binding]);
    // root radius=2.5 → depth 36 投影 ≈8.4px ∈ (8, 8×1.12];已折叠时保持。
    const band = { ...view, eye: [100, 0, 36], target: [100, 0, 0] };
    expect(engine.decide(band, [0, 0, 0]).collapsedNodeCount).toBe(0); // 无历史:严格阈值,不折叠。
    engine.decide({ ...view, eye: [100, 0, 30000], target: [100, 0, 0] }, [0, 0, 0]);
    expect(engine.decide(band, [0, 0, 0]).collapsedNodeCount).toBe(1); // 迟滞保持。
  });

  it("validates binding contracts fail-closed", () => {
    const { binding } = threeInstanceBinding();
    expect(() => new HlodClusterDecisionEngine([{ ...binding, decisionFromWorld: [1, 0, 0] }]))
      .toThrow(/affine/);
    expect(() => new HlodClusterDecisionEngine([undefined as never])).toThrow();
    const broken: HlodClusterStreamBinding = { ...binding,
      instanceIdsByNode: new Map([...binding.instanceIdsByNode].map(([id]) => [id, []])) };
    const engine = new HlodClusterDecisionEngine([broken]);
    expect(() => engine.decide({ ...view, eye: [100, 0, 30000], target: [100, 0, 0] }, [0, 0, 0]))
      .toThrow(/no Web instance mapping/);
  });
});

describe("HLOD cluster plan helpers", () => {
  it("shrinks transforms to a legal affine that is visually absent", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
    const shrunk = shrinkTransform(identity, 1e-6, "test");
    expect(shrunk.slice(0, 11)).toEqual(identity.slice(0, 11).map(value => value * 1e-6));
    expect(shrunk.slice(12)).toEqual([5, 6, 7, 1]);
    expect(() => shrinkTransform([1, 0, 0], 1e-6, "bad")).toThrow(/affine/);
  });

  it("maps hidden originals and proxy draws onto a constant instance list", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const instances = [
      { id: "a", geometry: "mesh", material: "mat", transform: identity },
      { id: "b", geometry: "mesh", material: "mat", transform: identity },
    ];
    const draws = new Map<string, HlodClusterProxyDraw>([
      ["px-on", { instanceId: "px-on", geometryId: "hlod-proxy-1", transform: identity }],
      ["px-off", { instanceId: "px-off", geometryId: "hlod-proxy-2", transform: identity }],
    ]);
    const plan = { origin: [0, 0, 0] as const, hiddenInstanceIds: new Set(["a"]),
      activeProxyDraws: new Map<string, HlodClusterProxyDraw>([["px-on", draws.get("px-on")!]]),
      collapsedNodeCount: 1, suppressed: false };
    const applied = applyHlodPlanToInstances(instances, plan, draws);
    expect(applied).toHaveLength(4);
    expect(applied[0]!.id).toBe("a");
    expect(applied[0]!.transform[0]).toBeCloseTo(1e-6);
    expect(applied[1]!.transform[0]).toBe(1);
    const pxOn = applied.find(instance => instance.id === "px-on")!;
    expect(pxOn.material).toBe(HLOD_PROXY_MATERIAL_ID);
    expect(pxOn.transform[0]).toBe(1);
    const pxOff = applied.find(instance => instance.id === "px-off")!;
    expect(pxOff.transform[0]).toBeCloseTo(1e-6);
  });

  it("detects editor overlay suppression and fingerprints plan changes", () => {
    expect(collapseSuppressedByOverlay(view)).toBe(false);
    expect(collapseSuppressedByOverlay({ ...view, editorOverlay: overlay })).toBe(true);
    expect(collapseSuppressedByOverlay({ ...view,
      editorOverlay: { revision: 1, vertices: new Float32Array(0) } })).toBe(false);
    const plan = { origin: [0, 0, 0] as const, hiddenInstanceIds: new Set(["a"]),
      activeProxyDraws: new Map<string, HlodClusterProxyDraw>(), collapsedNodeCount: 1, suppressed: false };
    expect(hlodPlanSignature(plan)).toBe("o:1:");
    expect(hlodPlanSignature({ ...plan, suppressed: true, hiddenInstanceIds: new Set() })).toBe("s:0:");
  });

  it("converts points and directions through the affine inverse", () => {
    const inverse = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -100, 0, 0, 1];
    expect(applyAffinePoint(inverse, [105, 2, 3])).toEqual([5, 2, 3]);
    expect(applyAffineDirection(inverse, [1, 0, 0])).toEqual([1, 0, 0]);
  });
});
