/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { prepareFragmentObservation } from "./c8FragmentObservablesProbe.js";
import { observeDeepFragment, type FragmentObservable } from "./c8FragmentObservablesShader.js";
import { observeDeepExplicitDerivative } from "./c8ExplicitDerivativeShader.js";
import { runSharedSceneProbe } from "./c8SharedSceneProbe.js";

type Chunks = Parameters<typeof prepareFragmentObservation>[2];
/** Wraps the existing default observer; Three source and receipt checks remain unchanged. */
export function prepareExplicitDerivativeObservation(mode: FragmentObservable, gpu: GPU, chunks: Chunks) {
  const baseline = observeDeepFragment(mode), candidate = observeDeepExplicitDerivative(mode);
  const restores: (() => void)[] = [];
  let replaced = 0, disposed = false;
  const innerGpu = new Proxy(gpu, { get(target, key) {
    if (key === "requestAdapter") return async (options?: GPURequestAdapterOptions) => {
      const adapter = await target.requestAdapter(options);
      return adapter && new Proxy(adapter, { get(adapterTarget, property) {
        if (property === "requestDevice") return async (descriptor?: GPUDeviceDescriptor) => {
          const device = await adapterTarget.requestDevice(descriptor);
          if (disposed) { device.destroy(); throw Error("Explicit derivative observation disposed"); }
          const original = device.createShaderModule.bind(device), own = Object.getOwnPropertyDescriptor(device, "createShaderModule");
          Object.defineProperty(device, "createShaderModule", { configurable: true, value(input: GPUShaderModuleDescriptor) {
            if (input.label !== "Deep PBR") return original(input);
            if (disposed || sha256Utf8(input.code) !== baseline.instrumentedHash) throw Error("Explicit candidate default observation source drifted");
            replaced++;
            return original({ ...input, code: candidate.code });
          } });
          restores.push(() => { if (own) Object.defineProperty(device, "createShaderModule", own); else Reflect.deleteProperty(device, "createShaderModule"); });
          return device;
        };
        const value = Reflect.get(adapterTarget, property, adapterTarget);
        return typeof value === "function" ? value.bind(adapterTarget) : value;
      } });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const observer = prepareFragmentObservation(mode, innerGpu, chunks);
  return { ...observer,
    receipt() {
      const receipt = observer.receipt();
      if (replaced < 1 || replaced !== receipt.deep.moduleCount) throw Error("Empty or incomplete actual explicit candidate receipt");
      return { ...receipt, derivative: candidate.candidate, threeDerivative: "default", qualityCertified: false,
        deep: { ...receipt.deep, instrumentedHash: candidate.instrumentedHash, replacedModules: replaced } };
    },
    dispose() {
      if (disposed) return;
      observer.dispose();
      disposed = true;
      for (const restore of restores.reverse()) restore();
    },
  };
}

export async function runExplicitDerivativeObservation(mode: FragmentObservable, cameraScale: .6 | 1) {
  const observer = prepareExplicitDerivativeObservation(mode, navigator.gpu, THREE.ShaderChunk);
  try {
    const run = await runSharedSceneProbe({ exposures: [.5], directProfile: "three-r185", cameraScale,
      hdrAttachmentProfile: "shared-rgba16f", gpu: observer.gpu,
      observeThreePrograms(renderer: THREE.WebGLRenderer) {
        const gl = renderer.getContext(), sources = (renderer.info.programs ?? []).map(program => gl.getShaderSource(program.fragmentShader));
        if (sources.some(source => source === null)) throw Error("Actual Three fragment source unavailable");
        observer.recordThreeFragments(sources as string[]);
      } });
    return { run, receipt: observer.receipt() };
  } finally { observer.dispose(); }
}
