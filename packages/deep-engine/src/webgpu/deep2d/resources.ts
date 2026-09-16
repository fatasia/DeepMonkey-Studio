import { validateRuntimeDeep2d } from "../../runtimePackage/deep2d.js";
import type { DashboardResourceLoader } from "../../runtimePackage/dashboardCandidateTypes.js";
import type { Deep2dRuntimePackage, RuntimeJson } from "../../runtimePackage/types.js";
export interface DashboardGpuResource { readonly id: string; readonly kind: string; readonly payload: RuntimeJson;
  readonly atlases?: ReadonlyMap<string, Uint8Array<ArrayBuffer>> }
export function decodeDeep2dAtlases(content: Deep2dRuntimePackage): ReadonlyMap<string, Uint8Array<ArrayBuffer>> {
  validateRuntimeDeep2d(content, content.id, content.revision, "$frame");
  return new Map(content.atlases.map(atlas => [atlas.id, base64(atlas.dataBase64)]));
}
export function dashboardGpuResourceLoader(): DashboardResourceLoader<DashboardGpuResource, DashboardGpuResource> {
  return {
    async load(item, value, signal) {
      if (signal.aborted) throw new Error("Dashboard resource load aborted.");
      if (item.type !== "resource") throw new Error("Dashboard v5 does not accept shader resources.");
      const payload = value.payloads[item.resourceId]; if (!payload) throw new Error("Missing dashboard resource.");
      return { id: item.resourceId, kind: item.resourceKind, payload };
    },
    async prepare(_item, loaded, signal) {
      if (signal.aborted) throw new Error("Dashboard resource preparation aborted.");
      return loaded.kind === "deep2d-runtime" ? { ...loaded,
        atlases: decodeDeep2dAtlases(loaded.payload as unknown as Deep2dRuntimePackage) } : loaded;
    },
    release() { /* CPU snapshots own no external handles; candidate GPU leases retire separately. */ },
  };
}
const BASE64 = new Uint8Array(128);
for (const [index, char] of Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/" ).entries()) BASE64[char.charCodeAt(0)] = index;
function base64(value: string): Uint8Array<ArrayBuffer> {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(value.length / 4 * 3 - padding); let cursor = 0;
  for (let i = 0; i < value.length; i += 4) {
    const bits = BASE64[value.charCodeAt(i)]! << 18 | BASE64[value.charCodeAt(i + 1)]! << 12
      | BASE64[value.charCodeAt(i + 2)]! << 6 | BASE64[value.charCodeAt(i + 3)]!;
    for (const shift of [16, 8, 0]) if (cursor < bytes.length) bytes[cursor++] = bits >>> shift & 255;
  }
  return bytes;
}
