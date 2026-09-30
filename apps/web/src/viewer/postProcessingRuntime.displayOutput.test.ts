import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import { PostProcessingRuntime } from "./postProcessingRuntime";

const fixture = vi.hoisted(() => ({ passes: [] as Array<{ enabled: boolean; dispose(): void }> }));
vi.mock("three/examples/jsm/postprocessing/EffectComposer.js", () => ({ EffectComposer: class {
  renderTarget1 = {}; renderTarget2 = {};
  constructor() { fixture.passes = []; }
  addPass(pass: typeof fixture.passes[number]) { fixture.passes.push(pass); }
  dispose() { fixture.passes.forEach(pass => pass.dispose()); }
} }));
vi.mock("./postProcessingAntialias", () => ({ configurePostProcessingAntialias: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe("production Three output source", () => {
  it("uses paired ACES on the real OutputPass and keeps authored grading", () => {
    vi.stubGlobal("window", { innerWidth: 64, innerHeight: 64 });
    vi.stubGlobal("Image", class { src = ""; });
    const runtime = new PostProcessingRuntime({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera());
    try {
      runtime.apply({ ...DEFAULT_POST_PROCESSING, colorGrading: true, hue: 30, saturation: 0.2,
        brightness: 0.1, contrast: -0.3, temperature: 0.4, tint: -0.5 }, []);
      const output = fixture.passes.filter(pass => pass instanceof OutputPass) as OutputPass[];
      expect(output).toHaveLength(1);
      expect(output[0]!.material.fragmentShader).toContain("deepThreeAcesFit( gl_FragColor.rgb, toneMappingExposure )");
      expect(output[0]!.material.fragmentShader).toContain("sRGBTransferOETF( gl_FragColor )");
      expect(output[0]!.material.glslVersion).toBeNull();
      const grading = fixture.passes.filter(pass => pass instanceof ShaderPass) as ShaderPass[];
      const hue = grading.find(pass => "hue" in pass.uniforms)!;
      const color = grading.find(pass => "temperature" in pass.uniforms)!;
      expect(hue.uniforms.hue!.value).toBe(30 / 180);
      expect(hue.uniforms.saturation!.value).toBe(0.2);
      for (const [key, value] of Object.entries({ brightness: 0.1, contrast: -0.3, temperature: 0.4, tint: -0.5 })) {
        expect(color.uniforms[key]!.value).toBe(value);
      }
      expect(fixture.passes.indexOf(color)).toBeLessThan(fixture.passes.indexOf(output[0]!));
    } finally { runtime.dispose(); }
  });
});
