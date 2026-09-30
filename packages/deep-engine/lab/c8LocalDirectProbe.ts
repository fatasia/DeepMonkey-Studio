/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { sceneShader } from "../src/webgpu/pbrShader.js";
import { FORWARD_PLUS_PBR_WGSL, forwardPlusPbrLibrary } from "../src/lighting/clusterLightingPbrWgsl.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { createLocalDirectFixture, type LocalDirectCase } from "./c8LocalDirectFixture.js";
import { runSharedSceneProbe } from "./c8SharedSceneProbe.js";
import { resolvePbrSceneLighting } from "../src/lighting/pbrSceneLighting.js";

export type LocalDirectProfile = "formal" | "single-scatter-ablation";
export function localDirectModule(profile: LocalDirectProfile) {
  if (profile !== "formal" && profile !== "single-scatter-ablation") throw Error("Unknown local shader profile");
  const formal = forwardPlusPbrLibrary("direct-multiscattering");
  if (!sceneShader.startsWith(`${formal}\n`)) throw Error("Formal production cluster library drifted");
  const code = profile === "formal" ? sceneShader : `${FORWARD_PLUS_PBR_WGSL}${sceneShader.slice(formal.length)}`;
  return { code, originalHash: sha256Utf8(sceneShader), actualHash: sha256Utf8(code) };
}

/** Uses the actual production device/module; ablation changes only the cluster library. */
export async function runLocalDirect(kind: LocalDirectCase, profile: LocalDirectProfile) {
  const candidate = localDirectModule(profile), restores: (() => void)[] = [], threeHashes: string[] = [];
  let moduleCount = 0;
  const gpu = new Proxy(navigator.gpu, { get(target, key) {
    if (key === "requestAdapter") return async (options?: GPURequestAdapterOptions) => {
      const adapter = await target.requestAdapter(options);
      return adapter && new Proxy(adapter, { get(source, property) {
        if (property === "requestDevice") return async (descriptor?: GPUDeviceDescriptor) => {
          const device = await source.requestDevice(descriptor), old = Object.getOwnPropertyDescriptor(device, "createShaderModule"), original = device.createShaderModule.bind(device);
          try { Object.defineProperty(device, "createShaderModule", { configurable: true, value(spec: GPUShaderModuleDescriptor) {
            if (spec.label !== "Deep PBR") return original(spec);
            if (sha256Utf8(spec.code) !== candidate.originalHash) throw Error("Actual production module identity drifted");
            const module = original({ ...spec, code: candidate.code }); moduleCount++; return module;
          } }); } catch (error) { device.destroy(); throw error; }
          restores.push(() => { if (old) Object.defineProperty(device, "createShaderModule", old); else Reflect.deleteProperty(device, "createShaderModule"); });
          return device;
        };
        const value = Reflect.get(source, property, source); return typeof value === "function" ? value.bind(source) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    let lighting: ReturnType<typeof resolvePbrSceneLighting> | undefined;
    const run = await runSharedSceneProbe({ exposures: [.5], directProfile: "three-r185", hdrAttachmentProfile: "shared-rgba16f",
      gpu, fixtureFactory: () => {
        const fixture = createLocalDirectFixture(kind), view = fixture.view;
        return { ...fixture, view(camera: number, exposure: number) { const result = view(camera, exposure);
          lighting = resolvePbrSceneLighting(result.lights); return result; } };
      }, observeThreePrograms(renderer: THREE.WebGLRenderer) {
        const gl = renderer.getContext();
        for (const program of renderer.info.programs ?? []) {
          const code = gl.getShaderSource(program.fragmentShader);
          if (!code || !code.includes("void RE_Direct_Physical(")) throw Error("Actual Three physical material program missing");
          threeHashes.push(sha256Utf8(code));
        }
      } });
    if (moduleCount !== 1 || !threeHashes.length) throw Error("Empty or repeated production compile receipt");
    return { kind, profile, run, lighting, receipt: { originalHash: candidate.originalHash, actualHash: candidate.actualHash, moduleCount,
      threeCompiledHashes: [...new Set(threeHashes)], threeObservations: threeHashes.length } };
  } finally { for (const restore of restores.reverse()) restore(); }
}
