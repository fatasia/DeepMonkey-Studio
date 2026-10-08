import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { SceneIrradianceProbeBake } from "../delivery/compileSceneRuntimePackage";
import type { CompileSceneRenderOptions } from "../delivery/compileSceneRenderPacket";

export type StudioDecodedAsset = readonly [string, ReturnType<NonNullable<CompileSceneRenderOptions["decodedAssetCache"]>["get"]> & {}];

type Model = ProjectRecord["models"][number];
export interface StudioWasmCompilationInput {
  readonly decodedAssets?: readonly StudioDecodedAsset[];
  readonly scene: SceneSnapshot;
  readonly models: readonly Pick<Model, "id" | "name" | "status" | "manifest">[];
  readonly irradianceProbes: SceneIrradianceProbeBake | null;
}
export const STUDIO_WASM_COMPILATION_STAGES = ["starting", "assets", "geometry", "textures", "package", "complete"] as const;
export interface StudioWasmCompilationProgress {
  readonly kind: "progress"; readonly stage: typeof STUDIO_WASM_COMPILATION_STAGES[number];
}
export const STUDIO_WASM_COMPILATION_LABELS: Readonly<Record<StudioWasmCompilationProgress["stage"], string>> = {
  starting: "准备 WASM 场景", assets: "读取场景资源", geometry: "解析场景模型", textures: "解码材质贴图",
  package: "生成场景运行包", complete: "场景资源已就绪",
};
export type StudioWasmCompilationOutput =
  | { readonly bytes: Uint8Array; readonly canonicalHash?: string }
  | { readonly error: string }
  | StudioWasmCompilationProgress;
/** Compiled package bytes plus the worker-side canonical hash when available. */
export interface StudioWasmCompiledPackage {
  readonly bytes: Uint8Array;
  readonly canonicalHash?: string;
}

const CANONICAL_HASH_PATTERN = /^[0-9a-f]{64}$/;
export interface StudioWasmCompilationWorker {
  onmessage: ((event: MessageEvent<StudioWasmCompilationOutput>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
  postMessage(input: StudioWasmCompilationInput): void;
  terminate(): void;
}

/** Each candidate owns its compiler: stale synchronous work is cancelled by terminating it. */
export function runStudioWasmCompilation(input: StudioWasmCompilationInput, signal: AbortSignal,
  createWorker: () => StudioWasmCompilationWorker,
  options: { readonly timeoutMs?: number; readonly onProgress?: (progress: StudioWasmCompilationProgress) => void } = {}): Promise<StudioWasmCompiledPackage> {
  signal.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error("Invalid WASM compilation deadline.");
  const worker = createWorker();
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: StudioWasmCompiledPackage, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (value) resolve(value); else reject(error);
    };
    const abort = () => finish(undefined, signal.reason ?? new DOMException("Compilation cancelled.", "AbortError"));
    worker.onmessage = ({ data }) => {
      if (signal.aborted) { abort(); return; }
      if (settled) return;
      try {
        if (!data || typeof data !== "object") throw new Error("Invalid WASM compilation response.");
        if ("kind" in data && data.kind === "progress") {
          if (Object.keys(data).length !== 2 || !STUDIO_WASM_COMPILATION_STAGES.includes(data.stage)) throw new Error("Invalid WASM compilation stage.");
          options.onProgress?.(data); return;
        }
        if ("error" in data && typeof data.error === "string" && Object.keys(data).length === 1) finish(undefined, new Error(data.error));
        else if (!("bytes" in data) || !(data.bytes instanceof Uint8Array) || !(data.bytes.buffer instanceof ArrayBuffer)
          || !data.bytes.byteLength || data.bytes.byteLength > 256 * 1024 * 1024) throw new Error("Invalid WASM compilation response.");
        else if ("canonicalHash" in data && (Object.keys(data).length !== 2 || typeof data.canonicalHash !== "string" || !CANONICAL_HASH_PATTERN.test(data.canonicalHash))) throw new Error("Invalid WASM compilation response.");
        else if (Object.keys(data).length > 2) throw new Error("Invalid WASM compilation response.");
        else finish("canonicalHash" in data ? { bytes: data.bytes, canonicalHash: data.canonicalHash } : { bytes: data.bytes });
      } catch (error) { finish(undefined, error); }
    };
    worker.onerror = event => { event.preventDefault?.(); finish(undefined, new Error(event.message || "WASM compilation worker failed.")); };
    worker.onmessageerror = () => finish(undefined, new Error("WASM 后台编译数据传输失败，请重试。"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    deadline = setTimeout(() => finish(undefined, new Error("WASM 场景编译超时，请重试或减少当前场景资源。")), timeoutMs);
    try {
      options.onProgress?.({ kind: "progress", stage: "starting" });
      if (signal.aborted || settled) { abort(); return; }
      worker.postMessage(input);
    }
    catch (error) { finish(undefined, error); }
  });
}
