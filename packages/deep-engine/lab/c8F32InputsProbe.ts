import * as THREE from "three";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { prepareF32MrtObservation, decodeF32Witness } from "./c8F32MrtDevice.js";
import { runSharedSceneProbe } from "./c8SharedSceneProbe.js";
import { observeThreeFragment } from "./c8FragmentObservablesShader.js";
import { observeDeepF32Inputs, type F32InputMode } from "./c8F32InputsShader.js";

/** Reuses the passed MRT device wrapper; only its guarded full-module source is replaced. */
export function prepareF32InputObservation(mode: F32InputMode, gpu: GPU) {
  const input = observeDeepF32Inputs(mode), restores: (() => void)[] = [];
  let replacedModules = 0, disposed = false;
  const innerGpu = new Proxy(gpu, { get(target, property) {
    if (property === "requestAdapter") return async (options?: GPURequestAdapterOptions) => {
      const adapter = await target.requestAdapter(options);
      return adapter && new Proxy(adapter, { get(adapterTarget, key) {
        if (key === "requestDevice") return async (descriptor?: GPUDeviceDescriptor) => {
          const device = await adapterTarget.requestDevice(descriptor);
          if (disposed) { device.destroy(); throw Error("Exact F32 input observer disposed before device delivery"); }
          const original = device.createShaderModule.bind(device), own = Object.getOwnPropertyDescriptor(device, "createShaderModule");
          Object.defineProperty(device, "createShaderModule", { configurable: true, value(descriptor: GPUShaderModuleDescriptor) {
            if (descriptor.label !== "Deep PBR") return original(descriptor);
            if (disposed || sha256Utf8(descriptor.code) !== input.baselineInstrumentedHash) throw Error("Exact F32 input baseline observation module drifted");
            replacedModules++; return original({ ...descriptor, code: input.code });
          } });
          restores.push(() => { if (own) Object.defineProperty(device, "createShaderModule", own); else Reflect.deleteProperty(device, "createShaderModule"); });
          return device;
        };
        const value = Reflect.get(adapterTarget, key, adapterTarget); return typeof value === "function" ? value.bind(adapterTarget) : value;
      } });
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const observer = prepareF32MrtObservation("full", innerGpu);
  return { ...observer,
    receipt() {
      const receipt = observer.receipt();
      if (replacedModules < 1 || replacedModules !== receipt.moduleCount) throw Error("Exact F32 input replacement receipt incomplete");
      return { ...receipt, mode, instrumentedHash: input.instrumentedHash, baselineInstrumentedHash: input.baselineInstrumentedHash, replacedModules,
        lanes: input.lanes, basis: input.basis, derivative: input.derivative, coverage: input.coverage, qualityCertified: false };
    },
    dispose() { if (disposed) return; observer.dispose(); disposed = true; for (const restore of restores.reverse()) restore(); },
  };
}

export async function runF32Inputs(mode: F32InputMode) {
  const observer = prepareF32InputObservation(mode, navigator.gpu), actualThreeHashes: string[] = [];
  const frameNames = ["strict-emissive/front/exposure-0.5", "strict-emissive/oblique/exposure-0.5", "direct-diagnostic/front/exposure-0.5", "direct-diagnostic/oblique/exposure-0.5"];
  let hookCount = 0;
  try {
    const run = await runSharedSceneProbe({ cameraScale: .6, exposures: [.5], directProfile: "three-r185", gpu: observer.gpu,
      observeThreePrograms(renderer: THREE.WebGLRenderer) {
        const name = frameNames[hookCount++]; if (!name) throw Error(`Exact F32 inputs unexpected hook ${hookCount}`);
        observeThreeFragment("single", THREE.ShaderChunk);
        const re = THREE.ShaderChunk.lights_physical_pars_fragment.match(/^void RE_Direct_Physical\([^]*?^\}/m)?.[0], gl = renderer.getContext();
        for (const program of renderer.info.programs ?? []) {
          const source = gl.getShaderSource(program.fragmentShader);
          if (!source || !re || !source.includes(re) || source.includes("deepObservedFragment") || source.includes("C8 isolated")) throw Error("Exact F32 inputs require unchanged original Three full source");
          actualThreeHashes.push(sha256Utf8(source));
        }
        observer.armFrame(name);
      } });
    const snapshots = await observer.snapshots(), receipt = observer.receipt();
    const observed = receipt.passes.filter(pass => pass.phase === "observed"), validation = receipt.passes.filter(pass => pass.phase === "validation");
    if (hookCount !== 4 || observed.length !== 4 || actualThreeHashes.length < 1 || observed.some((pass, i) => pass.name !== run.frames[i]?.name)) throw Error(`Exact F32 inputs named receipt mismatch: ${JSON.stringify({ receipt, hookCount, compileHashes: actualThreeHashes.length, frames: run.frames.map(f => f.name) })}`);
    function capture(pass: typeof receipt.passes[number]) {
      const found = snapshots.filter(snapshot => snapshot.frameId === pass.frameId); if (found.length !== 1) throw Error(`Exact F32 inputs ${pass.frameId} snapshot count ${found.length}`);
      const snapshot = found[0]!;
      return { name: pass.name, phase: pass.phase, frameId: snapshot.frameId, format: snapshot.format, width: snapshot.width, height: snapshot.height, bytesPerRow: snapshot.bytesPerRow, rgba: decodeF32Witness(snapshot) };
    }
    return { run, witness: observed.map(capture), validationWitness: validation.map(capture), receipt: { ...receipt, hookCount,
      three: { format: "rgba32float", observable: "unchanged-original-full", actualCompiledFragmentHashes: [...new Set(actualThreeHashes)], compileObservations: actualThreeHashes.length } } };
  } finally { observer.dispose(); }
}
