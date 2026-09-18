import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import { PostProcessingRuntime } from "./postProcessingRuntime";

const fixture = vi.hoisted(() => ({ passes: [] as Array<{ enabled: boolean; render: () => void; dispose: () => void }> }));
vi.mock("three/examples/jsm/postprocessing/EffectComposer.js", () => ({ EffectComposer: class {
  renderTarget1 = {}; renderTarget2 = {};
  constructor() { fixture.passes = []; }
  addPass(pass: typeof fixture.passes[number]) { fixture.passes.push(pass); }
  render() { fixture.passes.filter(pass => pass.enabled).forEach(pass => pass.render()); }
  dispose() { fixture.passes.forEach(pass => pass.dispose()); }
} }));
vi.mock("./postProcessingAntialias", () => ({ configurePostProcessingAntialias: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());
describe("WebGL author antialias execution order", () => {
  it.each([[true, false], [false, true], [true, true], [false, false]])("SMAA=%s FXAA=%s transforms output once", (smaa, fxaa) => {
    vi.stubGlobal("window", { innerWidth: 64, innerHeight: 64 });
    vi.stubGlobal("Image", class { src = ""; });
    const runtime = new PostProcessingRuntime({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera());
    try {
      runtime.apply({ ...DEFAULT_POST_PROCESSING, smaa, fxaa, gtao: false, ssao: false, bloom: false,
        vignette: false, colorGrading: false }, []);
      const calls: object[] = [];
      fixture.passes.forEach(pass => { pass.render = () => { calls.push(pass); }; });
      runtime.render(1 / 60);
      const actual = calls.filter(pass => pass instanceof SMAAPass || pass instanceof FXAAPass || pass instanceof OutputPass);
      const output = fixture.passes.find(pass => pass instanceof OutputPass)!;
      expect(actual).toEqual([
        ...(smaa ? [fixture.passes.find(pass => pass instanceof SMAAPass)] : []), output,
        ...(fxaa ? [fixture.passes.find(pass => pass instanceof FXAAPass)] : []),
      ]);
      expect(actual.filter(pass => pass instanceof OutputPass)).toHaveLength(1);
      runtime.apply({ ...DEFAULT_POST_PROCESSING, enabled: false }, []);
      calls.length = 0; runtime.render(1 / 60);
      expect(calls.filter(pass => pass instanceof SMAAPass || pass instanceof FXAAPass)).toHaveLength(0);
      expect(calls.filter(pass => pass instanceof OutputPass)).toHaveLength(1);
    } finally { runtime.dispose(); }
  });
});
