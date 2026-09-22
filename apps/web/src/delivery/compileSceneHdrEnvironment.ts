import type { RuntimePrefilteredIbl, RuntimeSolidEnvironment } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneEnvironment } from "./compileSceneEnvironment.ts";

/** Author semantics only; frozen HDR bytes are verified separately by the publication boundary. */
export function compileSceneHdrDescriptor(value: unknown, lighting: unknown, weather?: unknown, origin?: {x:number;y:number;z:number}): RuntimeSolidEnvironment | undefined {
  if (!value || typeof value!=="object" || Array.isArray(value) || !lighting || typeof lighting!=="object" || Array.isArray(lighting)) return;
  const environment=value as Record<string,unknown>, light=lighting as Record<string,unknown>;
  if (typeof environment.environmentMapUrl!=="string" || !environment.environmentMapUrl.trim()
    || environment.environmentAsBackground===true || light.reflectionsEnabled!==true
    // F4 对拍缺口修复：v6 载荷不携带 environmentIntensity（RuntimePrefilteredIbl
    // 无强度字段），非默认值的作者环境强度会被静默丢弃——一律 fail-closed 拒绝
    // 编译，让 environment 留在 deferred 由发布门禁显式阻断，而不是发布后丢强度。
    || (environment.environmentIntensity !== undefined && environment.environmentIntensity !== 1)
    || (environment.environmentIntensity !== undefined && (typeof environment.environmentIntensity!=="number" || !Number.isFinite(environment.environmentIntensity)))) return;
  const plain=compileSceneEnvironment({...environment,environmentMapUrl:""},{...light,reflectionsEnabled:false},weather,origin);
  if (!plain?.lighting) return;
  // HDR 档（v6）本轮不接雾：雾随 v7 固体环境档交付，剥离后进 v6，避免混档。
  const withoutFog={...plain}; delete withoutFog.fog;
  return {...withoutFog,schemaVersion:6,kind:"solid-background-prefiltered-ibl",outputTransform:"native-aces-hdr-v6"};
}
export function compileSceneHdrEnvironment(value:unknown,lighting:unknown,ibl:RuntimePrefilteredIbl,weather?:unknown,origin?:{x:number;y:number;z:number}):RuntimeSolidEnvironment|undefined {
  const descriptor=compileSceneHdrDescriptor(value,lighting,weather,origin);
  return descriptor ? {...descriptor,ibl} : undefined;
}
