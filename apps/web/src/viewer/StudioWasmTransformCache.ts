import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { RUNTIME_BINARY_MAGIC, runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { sceneTransformIndependentKey as key, transformSceneInstances } from "./sceneInstanceTransforms";
import type { StudioWasmCompiledPackage } from "./studioWasmCompilationClient";

type Models = ProjectRecord["models"];
interface Header {
  schema: string; version: number; sections: unknown[];
  envelope: {
    entrypoints: { renderPacket: string; camera?: string; environment?: string };
    payloads: Record<string, Record<string, unknown>>;
    resources: { id: string; kind: string; revision: number; contentHash: { algorithm: string; value: string } }[];
    objectBindings: { nodeId: string; instanceIds: string[] }[];
    packageHash: { algorithm: string; value: string };
  };
}

/** One owned compressed baseline, never a second decoded texture cache. */
export class StudioWasmTransformCache {
  private baseline: { scene: SceneSnapshot; key: string; bytes: Uint8Array<ArrayBuffer>; header: Header; offset: number } | undefined;
  clear(): void { this.baseline = undefined; }

  remember(scene: SceneSnapshot, models: Models, compiled: StudioWasmCompiledPackage): void {
    this.clear();
    const bytes = compiled.bytes;
    if (bytes.length < 12 || bytes.length > 32 * 1024 * 1024 || new TextDecoder().decode(bytes.subarray(0, 8)) !== RUNTIME_BINARY_MAGIC) return;
    try {
      const offset = 12 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
      if (offset > bytes.length || offset > 4 * 1024 * 1024 + 12) return;
      const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, offset))) as Header;
      const envelope = header.envelope;
      if (header.schema !== "deep-engine.runtime-transfer" || header.version !== 1
        || !envelope.resources.every(resource => ["render-packet", "scene-camera", "ibl-environment"].includes(resource.kind))) return;
      const environment = envelope.payloads[envelope.entrypoints.environment ?? ""];
      if (environment && Object.keys(environment).some(field => !["schema", "schemaVersion", "id", "revision", "kind",
        "backgroundSrgb", "displayProfile", "fog", "lighting", "outputTransform"].includes(field))) return;
      if (!Array.isArray(envelope.objectBindings)) return;
      this.baseline = { scene: structuredClone(scene), key: key(scene, models), bytes: bytes.slice(), header, offset };
    } catch { /* A full compilation remains available for other transport profiles. */ }
  }

  async compile(scene: SceneSnapshot, models: Models, signal: AbortSignal): Promise<StudioWasmCompiledPackage | undefined> {
    signal.throwIfAborted();
    const base = this.baseline;
    if (!base || base.key !== key(scene, models)) return undefined;
    try {
      const header = structuredClone(base.header), envelope = header.envelope;
      const camera = envelope.payloads[envelope.entrypoints.camera ?? ""];
      const origin = (camera?.coordinateFrame as { origin?: { x: number; y: number; z: number } } | undefined)?.origin;
      if (!origin) return undefined;
      const render = envelope.payloads[envelope.entrypoints.renderPacket]!;
      const instances = render.instances as { id: string; transform: number[] }[];
      const transformed = transformSceneInstances(base.scene, scene, envelope.objectBindings, instances, origin);
      if (!transformed) return undefined;
      render.instances = transformed;
      const resource = envelope.resources.find(resource => resource.id === envelope.entrypoints.renderPacket)!;
      resource.revision++;
      resource.contentHash.value = runtimeContentSha256({ metadata: render, sections: header.sections });
      const { packageHash: _hash, ...core } = envelope;
      envelope.packageHash.value = runtimeContentSha256(core);
      const encoded = new TextEncoder().encode(JSON.stringify(header));
      if (encoded.length > 4 * 1024 * 1024) return undefined;
      const bytes = new Uint8Array(12 + encoded.length + base.bytes.length - base.offset);
      bytes.set(base.bytes.subarray(0, 8)); new DataView(bytes.buffer).setUint32(8, encoded.length, true);
      bytes.set(encoded, 12); bytes.set(base.bytes.subarray(base.offset), 12 + encoded.length);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.subarray(0, 12 + encoded.length)));
      signal.throwIfAborted();
      return { bytes, canonicalHash: Array.from(digest, value => value.toString(16).padStart(2, "0")).join("") };
    } catch (error) {
      signal.throwIfAborted(); return undefined;
    }
  }
}
