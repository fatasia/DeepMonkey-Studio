/// <reference types="@webgpu/types" />
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { observeDeepFragment, observeThreeFragment, type FragmentObservable } from "./c8FragmentObservablesShader.js";
import * as THREE from "three";
import { runSharedSceneProbe } from "./c8SharedSceneProbe.js";

type Chunks = { lights_physical_pars_fragment: string; opaque_fragment: string };

/** Test leaf: production GPUDevice identity stays intact for native canvas configuration. */
export function prepareFragmentObservation(mode: FragmentObservable, gpu: GPU, chunks: Chunks) {
  const deep = observeDeepFragment(mode);
  const restores: (() => void)[] = [], compiledThreeHashes: string[] = [];
  let disposed = false, deepModuleCount = 0, threeInstallCount = 0;
  let three: ReturnType<typeof observeThreeFragment> | undefined;
  function ensureLive() { if (disposed) throw Error("Fragment observation was disposed"); }
  function installThree() {
    ensureLive();
    if (threeInstallCount) return;
    // Called by requestAdapter, after the existing probe's production math installers.
    const original = { ...chunks };
    three = observeThreeFragment(mode, original);
    chunks.lights_physical_pars_fragment = three.lights_physical_pars_fragment;
    chunks.opaque_fragment = three.opaque_fragment; threeInstallCount++;
    restores.push(() => { chunks.lights_physical_pars_fragment = original.lights_physical_pars_fragment; chunks.opaque_fragment = original.opaque_fragment; });
  }
  function instrumentDevice(device: GPUDevice) {
    if (disposed) { device.destroy(); throw Error("Fragment observation was disposed before device delivery"); }
    const original = device.createShaderModule.bind(device), property = Object.getOwnPropertyDescriptor(device, "createShaderModule");
    try {
      Object.defineProperty(device, "createShaderModule", { configurable: true, value(descriptor: GPUShaderModuleDescriptor) {
        ensureLive();
        if (descriptor.label !== "Deep PBR") return original(descriptor);
        if (sha256Utf8(descriptor.code) !== deep.originalHash) throw Error("Actual production module differs from the registered observation input");
        const module = original({ ...descriptor, code: deep.code }); deepModuleCount++; return module;
      } });
    } catch (error) { device.destroy(); throw error; }
    restores.push(() => { if (property) Object.defineProperty(device, "createShaderModule", property); else Reflect.deleteProperty(device, "createShaderModule"); });
    return device;
  }
  const isolatedGpu = new Proxy(gpu, { get(target, property) {
    if (property === "requestAdapter") return async (options?: GPURequestAdapterOptions) => {
      installThree();
      const adapter = await target.requestAdapter(options); ensureLive();
      return adapter && new Proxy(adapter, { get(adapterTarget, key) {
        if (key === "requestDevice") return async (descriptor?: GPUDeviceDescriptor) => instrumentDevice(await adapterTarget.requestDevice(descriptor));
        const value = Reflect.get(adapterTarget, key, adapterTarget); return typeof value === "function" ? value.bind(adapterTarget) : value;
      } });
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return {
    gpu: isolatedGpu,
    /** Called with actual attached GL fragment sources after the production draw. */
    recordThreeFragments(sources: readonly string[]) {
      ensureLive();
      const actualRe = three?.lights_physical_pars_fragment.match(/^void RE_Direct_Physical\([^]*?^\}/m)?.[0];
      if (!actualRe || !sources.length || sources.some(source => !source.includes(actualRe) || !source.includes("gl_FragColor = vec4( deepObservedFragment, diffuseColor.a )"))) throw Error("Actual Three fragment observation was not compiled");
      for (const source of sources) compiledThreeHashes.push(sha256Utf8(source));
    },
    receipt() {
      if (deepModuleCount < 1 || threeInstallCount !== 1 || !three || compiledThreeHashes.length < 1) throw Error("Empty actual fragment observation receipt");
      return { mode, deep: { originalHash: deep.originalHash, instrumentedHash: deep.instrumentedHash, moduleCount: deepModuleCount },
        three: { originalChunkHash: three.originalHash, instrumentedChunkHash: three.instrumentedHash, installCount: threeInstallCount,
          actualCompiledFragmentHashes: [...new Set(compiledThreeHashes)], compileObservations: compiledThreeHashes.length } };
    },
    dispose() { if (disposed) return; disposed = true; for (const restore of restores.reverse()) restore(); },
  };
}

/** Existing lab injection/compiled-program callback must be wired before GPU use; otherwise receipt fails. */
export async function runFragmentObservable(mode: FragmentObservable, cameraScale: .6 | 1) {
  const observer = prepareFragmentObservation(mode, navigator.gpu, THREE.ShaderChunk);
  try {
    const options = { exposures: [.5], directProfile: "three-r185" as const, cameraScale,
      hdrAttachmentProfile: "shared-rgba16f" as const, gpu: observer.gpu,
      observeThreePrograms(renderer: THREE.WebGLRenderer) {
        const gl = renderer.getContext(), sources = (renderer.info.programs ?? []).map(program => gl.getShaderSource(program.fragmentShader));
        if (sources.some(source => source === null)) throw Error("Actual compiled Three fragment source unavailable");
        observer.recordThreeFragments(sources as string[]);
      } };
    const run = await runSharedSceneProbe(options);
    return { run, receipt: observer.receipt() };
  } finally { observer.dispose(); }
}
