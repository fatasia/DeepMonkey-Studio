import type { ProjectRecord } from "@bim-studio/contracts";
import { compileStudioWasmRuntimePackageInProcess } from "./studioWasmRuntimePackageCompiler";
import type { StudioWasmCompilationInput, StudioWasmCompilationOutput, StudioWasmCompilationProgress } from "./studioWasmCompilationClient";

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<StudioWasmCompilationInput>) => void) | null;
  postMessage(output: StudioWasmCompilationOutput, transfer?: Transferable[]): void;
};

type CanonicalHashModule = { compute_runtime_package_canonical_hash(bytes: Uint8Array): string };
let canonicalHashModule: CanonicalHashModule | undefined;

/**
 * Same wasm module as the consuming thread. The canonical re-hash runs here so
 * the author input thread verifies against an independent value instead of
 * re-walking the whole package tree a second time. Failure keeps compilation
 * usable: the bridge falls back to its own verification path.
 */
async function computeCanonicalHash(bytes: Uint8Array): Promise<string | undefined> {
  try {
    if (!canonicalHashModule) {
      const runtimeUrl = new URL(`${import.meta.env.BASE_URL}engine-wasm/deep_engine_wasm.js`, self.location.href).href;
      const module = await import(/* @vite-ignore */ runtimeUrl) as CanonicalHashModule & { default(): Promise<void> };
      await module.default();
      canonicalHashModule = module;
    }
    return canonicalHashModule.compute_runtime_package_canonical_hash(bytes);
  } catch {
    return undefined;
  }
}

worker.onmessage = async ({ data }) => {
  try {
    const bytes = await compileStudioWasmRuntimePackageInProcess(data.scene,
      { models: data.models as ProjectRecord["models"] }, new AbortController().signal, data.irradianceProbes,
      (progress: StudioWasmCompilationProgress) => worker.postMessage(progress));
    const canonicalHash = await computeCanonicalHash(bytes);
    worker.postMessage(canonicalHash ? { bytes, canonicalHash } : { bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    worker.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
