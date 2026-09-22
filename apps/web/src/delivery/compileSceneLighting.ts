import { validateLightIes, validateLightingIes, validateLightProfileShape,
  type RuntimeLightProfile, type RuntimeLocalLight, type RuntimeSolidEnvironment } from "@bim-studio/deep-engine/runtime-package";
type Vec3 = [number,number,number];

/** 复用原方向光/CSM和Web局部灯衰减；未支持的局部阴影继续阻断。 */
export function compileSceneLighting(value: unknown, weather?: unknown, coordinateOrigin: { readonly x: number; readonly y: number; readonly z: number } = { x:0,y:0,z:0 }, builtinIbl = false): RuntimeSolidEnvironment["lighting"] {
  const origin = [coordinateOrigin.x, coordinateOrigin.y, coordinateOrigin.z];
  if (!value || typeof value !== "object" || Array.isArray(value) || (weather !== undefined && weather !== "sunny")) return;
  const state = value as Record<string, unknown>;
  if (Object.keys(state).some(key => !["enabled", "intensity", "shadowsEnabled", "reflectionsEnabled", "globalIlluminationEnabled", "globalIlluminationIntensity", "lights", "lightProfiles"].includes(key))
    || typeof state.enabled !== "boolean" || !bounded(state.intensity, 16)
    || typeof state.shadowsEnabled !== "boolean"
    || (builtinIbl ? state.reflectionsEnabled !== true || state.globalIlluminationEnabled !== true : state.reflectionsEnabled !== false || state.globalIlluminationEnabled !== false)
    || (state.globalIlluminationIntensity !== undefined && !bounded(state.globalIlluminationIntensity, 16))
    || !Array.isArray(state.lights) || state.lights.length < 1 || state.lights.length > 17
    || origin.length !== 3 || !origin.every(Number.isFinite)) return;
  const profiles = compileProfiles(state.lightProfiles);
  if (state.lightProfiles !== undefined && !profiles) return;
  const seen = new Set<string>();
  const lights: Array<{ light: RuntimeLocalLight; castShadow: boolean }> = [];
  for (const item of state.lights) {
    const light = compileLight(item, state.enabled ? state.intensity : 0, origin);
    if (!light || seen.has(item.id)) return;
    seen.add(item.id); lights.push(light);
  }
  const primaryIndex = lights.findIndex(item => item.light.kind === "directional");
  const primary = primaryIndex >= 0 ? lights.splice(primaryIndex, 1)[0] : undefined;
  const casters = lights.filter(item => state.shadowsEnabled && item.castShadow);
  if (lights.length > 16 || casters.filter(({light})=>light.kind==="point").length > 1
    || casters.filter(({light})=>light.kind==="spot").length > 4
    || casters.some(({light}) => light.kind === "directional"
      || (light.kind === "spot" && (light.outerCos <= .001 || light.outerCos >= .999999))
      || (light.range !== 0 && light.range <= .0001))) return;
  const result = { direction: primary?.light.direction ?? [0,1,0], radiance: primary?.light.radiance ?? [0,0,0],
    exposure: state.enabled ? Math.min(1.55, Math.max(0.55, 0.72 + state.intensity * 0.33)) : 0.55,
    shadows: state.shadowsEnabled && (primary?.castShadow ?? false),
    ...(builtinIbl && state.globalIlluminationEnabled === true ? { globalIlluminationIntensity: state.globalIlluminationIntensity ?? 1 } : {}),
    ...(lights.length ? { localLights: lights.map(item => ({ ...item.light, ...(state.shadowsEnabled && item.castShadow ? { castShadow:true } : {}) })) } : {}),
    ...(profiles?.length ? { lightProfiles: profiles } : {}) };
  try { validateLightingIes(result as unknown as Record<string, unknown>, "$.lighting"); } catch { return; }
  return result;
}

function compileLight(value: unknown, globalIntensity: number, origin: readonly number[]): { light: RuntimeLocalLight; castShadow: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  const allowed = ["id","name","type","enabled","color","intensity","position","castShadow"];
  if (source.type === "directional") allowed.push("target");
  else if (source.type === "point") allowed.push("distance","decay","target");
  else if (source.type === "spot") allowed.push("target","distance","decay","angle","penumbra","ies","shadowSoftness");
  else if (source.type === "hemisphere") allowed.push("groundColor","target");
  else return;
  if (Object.keys(source).some(key => !allowed.includes(key)) || typeof source.id !== "string" || !source.id.trim()
    || typeof source.name !== "string" || typeof source.enabled !== "boolean" || !bounded(source.intensity,16)
    || (source.type === "hemisphere" ? source.castShadow !== undefined && source.castShadow !== false : typeof source.castShadow !== "boolean")
    || typeof source.color !== "string" || !/^#[0-9a-f]{6}$/i.test(source.color)) return;
  const position=vector(source.position,[0,6,0]), target=vector(source.target,[0,0,0]);
  if (!position || !target) return;
  const delta=source.type === "point" ? [0,1,0] : source.type === "hemisphere" ? position : position.map((v,i) => (v-target[i]!) * (source.type === "spot" ? -1 : 1));
  const length=Math.hypot(...delta); if (!Number.isFinite(length) || length<1e-8) return;
  const range=source.distance ?? 0, decay=source.decay ?? 2, angle=source.angle ?? Math.PI/6, penumbra=source.penumbra ?? .25;
  if (!bounded(range,1e6) || !bounded(decay,4) || !bounded(angle,Math.PI/2) || angle === 0 || !bounded(penumbra,1)) return;
  if (source.shadowSoftness !== undefined && !bounded(source.shadowSoftness,1)) return;
  const localized = source.type === "directional" || source.type === "hemisphere" ? [0,0,0] : position.map((v,i)=>v-origin[i]!);
  if (!localized.every(v=>Number.isFinite(v) && Math.abs(v)<=1e6)) return;
  const intensity=source.enabled ? globalIntensity*source.intensity : 0;
  const color=source.color;
  const radiance=[1,3,5].map(offset=>{ const v=parseInt(color.slice(offset,offset+2),16)/255;
    return (v<=.04045 ? v/12.92 : ((v+.055)/1.055)**2.4)*intensity; });
  let groundRadiance: Vec3 | undefined;
  if (source.type === "hemisphere") {
    const ground = source.groundColor ?? "#3b4249";
    if (typeof ground !== "string" || !/^#[0-9a-f]{6}$/i.test(ground)) return;
    groundRadiance = [1,3,5].map(offset => { const v = parseInt(ground.slice(offset,offset+2),16)/255;
      return (v<=.04045 ? v/12.92 : ((v+.055)/1.055)**2.4)*intensity; }) as Vec3;
  }
  let ies: RuntimeLocalLight["ies"];
  if (source.ies !== undefined) { try { ies = validateLightIes(source.ies, "$.light.ies"); } catch { return; } }
  return { castShadow: source.castShadow === true, light: { kind: source.type, position: localized as Vec3,
    ...(groundRadiance ? { groundRadiance } : {}),
    ...(source.shadowSoftness !== undefined ? { shadowSoftness: source.shadowSoftness as number } : {}),
    direction: delta.map(v=>v/length) as Vec3, radiance: radiance as Vec3, range, decay,
    innerCos: Math.cos(angle*(1-penumbra)), outerCos: Math.cos(angle), ...(ies ? { ies } : {}) } };
}
function compileProfiles(value: unknown): RuntimeLightProfile[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) return;
  let cells = 0;
  const profiles: RuntimeLightProfile[] = [];
  try {
    for (const [index, candidate] of value.entries()) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
      validateLightProfileShape(candidate as Record<string, unknown>, `$.lighting.lightProfiles[${index}]`);
      const profile = structuredClone(candidate) as RuntimeLightProfile;
      cells += profile.candela.length * profile.verticalAngles.length;
      if (cells > 1_048_576) return;
      profiles.push(profile);
    }
  } catch { return; }
  return profiles;
}
function bounded(value: unknown, max: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max; }
function vector(value: unknown, fallback: Vec3): Vec3 | undefined {
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item=value as Record<string,unknown>;
  if (Object.keys(item).length!==3 || ![item.x,item.y,item.z].every(v=>typeof v === "number" && Number.isFinite(v))) return;
  return [item.x,item.y,item.z] as Vec3;
}
