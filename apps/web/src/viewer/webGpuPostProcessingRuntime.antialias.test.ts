import { describe, expect, it, vi } from "vitest";
import type * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import { WebGpuPostProcessingRuntime } from "./webGpuPostProcessingRuntime";

const graph = vi.hoisted(() => {
  type Value = { space: "linear" | "srgb"; transforms: number; effects: string[] };
  type Node = { evaluate: () => Value; dispose?: () => void };
  const wrap = (input: Node, kind: "smaa" | "fxaa" | "output"): Node => ({ evaluate() {
    const value = input.evaluate();
    if (kind === "output") {
      if (value.space !== "linear") throw new Error("Double output encoding");
      return { ...value, space: "srgb", transforms: value.transforms + 1 };
    }
    if (value.space !== (kind === "smaa" ? "linear" : "srgb")) throw new Error(`Wrong ${kind} color space`);
    return { ...value, effects: [...value.effects, kind] };
  } });
  return { wrap, rendered: undefined as Value | undefined, pipeline: undefined as unknown };
});
vi.mock("three/webgpu", () => ({ RenderPipeline: class {
  outputColorTransform = true; outputNode!: Parameters<typeof graph.wrap>[0]; needsUpdate = false;
  constructor() { graph.pipeline = this; }
  render() { graph.rendered = (this.outputColorTransform ? graph.wrap(this.outputNode, "output") : this.outputNode).evaluate(); }
  dispose() {}
} }));
vi.mock("three/tsl", () => ({
  pass: () => ({ getTextureNode: () => ({ evaluate: () => ({ space: "linear", transforms: 0, effects: [] }) }) }),
  renderOutput: (node: Parameters<typeof graph.wrap>[0]) => graph.wrap(node, "output"),
  hue: vi.fn(), mrt: vi.fn(), normalView: {}, output: {}, saturation: vi.fn(), uniform: vi.fn(), vec3: vi.fn(), vec4: vi.fn(),
}));
vi.mock("three/examples/jsm/tsl/display/SMAANode.js", () => ({ smaa: (node: Parameters<typeof graph.wrap>[0]) => graph.wrap(node, "smaa") }));
vi.mock("three/examples/jsm/tsl/display/FXAANode.js", () => ({ fxaa: (node: Parameters<typeof graph.wrap>[0]) => graph.wrap(node, "fxaa") }));
vi.mock("three/examples/jsm/tsl/display/AfterImageNode.js", () => ({ afterImage: vi.fn() }));
vi.mock("three/examples/jsm/tsl/display/BloomNode.js", () => ({ bloom: vi.fn() }));
vi.mock("three/examples/jsm/tsl/display/CRT.js", () => ({ vignette: vi.fn() }));
vi.mock("three/examples/jsm/tsl/display/DepthOfFieldNode.js", () => ({ dof: vi.fn() }));
vi.mock("three/examples/jsm/tsl/display/FilmNode.js", () => ({ film: vi.fn() }));
vi.mock("three/examples/jsm/tsl/display/GTAONode.js", () => ({ ao: vi.fn() }));
vi.mock("three/examples/jsm/tsl/display/OutlineNode.js", () => ({ outline: vi.fn() }));

describe("Three WebGPU author antialias color flow", () => {
  it("evaluates SMAA in linear and FXAA in sRGB through live switching, with one output transform", () => {
    const runtime = new WebGpuPostProcessingRuntime({} as WebGPURenderer, {} as THREE.Scene, {} as THREE.PerspectiveCamera);
    try {
      for (const [smaa, fxaa, enabled, effects] of [[true, false, true, ["smaa"]], [false, true, true, ["fxaa"]],
        [true, true, true, ["smaa"]], [false, false, true, []], [true, true, false, []]] as const) {
        runtime.apply({ ...DEFAULT_POST_PROCESSING, enabled, smaa, fxaa, gtao: false, ssao: false, bloom: false,
          vignette: false, colorGrading: false }, []);
        runtime.render(1 / 60);
        expect(graph.rendered).toEqual({ space: "srgb", transforms: 1, effects });
      }
    } finally { runtime.dispose(); }
  });
});
