import * as THREE from "three";
import type { RenderView, SpotLightIes } from "@bim-studio/deep-engine/webgpu";
import type { RuntimeLightProfile } from "@bim-studio/deep-engine/runtime-package";
import { DISPLAY_THREE_SHADOW_MAP_TYPE } from "./displayContractThree";
import { projectStudioDirectionalShadow } from "./studioDeepDirectionalShadow";

export interface StudioDeepEnvironmentIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

type Lights = NonNullable<RenderView["lights"]>;
type Vec3 = readonly [number, number, number];

/**
 * WebGL 作者路径的全局光照站位光（viewerEngineCore 的 globalIlluminationLight，
 * HemisphereLight 天/地双色）。产品 `globalIlluminationEnabled` 开关在 Deep 端的
 * 语义是探针 GI 体积（StudioDeepWebGpuBridge.probeClipmapEnabled 同一谓词）；
 * 站位光若同时进入 Deep 光照投影，会经 packDiffuseIrradiance → deepAuthoredDiffuse
 * 与探针 GI 双重计账——该站位填充无遮挡、门态无关，是封门哨兵 leakRatio 的载体
 * （F5-L5 实测：三区 gi-on−gi-off delta 全部蓝主异，量级与该灯合同值同阶）。
 * 因此默认 Deep 投影排除它：GI 关闭时该灯 visible=false 本就不进投影，此拦截只
 * 作用于 GI 开启态；作者自建的半球光（有独立 id）不受影响。明确无法捕获探针的
 * 变形作者包可显式复用该灯，避免同时失去作者填充光与探针辐射。
 */
export const GLOBAL_ILLUMINATION_STAND_IN_LIGHT_NAME = "scene-light:global-illumination";

/** Read the author's resolved gain once; weather and total intensity are already applied. */
export function readStudioDeepGlobalIlluminationIntensity(scene: THREE.Scene): number {
  const light = scene.getObjectByName(GLOBAL_ILLUMINATION_STAND_IN_LIGHT_NAME);
  if (!(light instanceof THREE.Light) || !light.visible) return 0;
  if (!Number.isFinite(light.intensity) || light.intensity < 0 || light.intensity > 16) {
    throw new RangeError("作者全局光照强度必须在 0 到 16 之间。");
  }
  return light.intensity;
}

/** E02：Three SpotLight 的 IES 载体（object.userData.ies）合同验证；非法即 issue。 */
function readSpotIes(object: THREE.Object3D, path: string,
  report: (code: string, message: string) => void): SpotLightIes | undefined {
  const carrier = (object as unknown as { userData?: { ies?: unknown } }).userData?.ies;
  if (carrier === undefined) return undefined;
  if (!carrier || typeof carrier !== "object" || Array.isArray(carrier)) {
    report("invalid-light-ies", "灯光 userData.ies 必须是对象。"); return undefined;
  }
  const value = carrier as Record<string, unknown>;
  const allowed = ["profileId", "rotationDeg", "scaleFactor"];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.profileId !== "string" || !value.profileId) {
    report("invalid-light-ies", "userData.ies 必须携带非空 profileId（仅支持 profileId/rotationDeg/scaleFactor）。"); return undefined;
  }
  const rotation = value.rotationDeg;
  if (rotation !== undefined && (typeof rotation !== "number" || !Number.isFinite(rotation) || rotation < 0 || rotation >= 360 || Math.abs(rotation * 2 - Math.round(rotation * 2)) > 1e-6)) {
    report("invalid-light-ies", "userData.ies.rotationDeg 必须位于 0.5° 网格且在 [0,360)。"); return undefined;
  }
  const scale = value.scaleFactor;
  if (scale !== undefined && (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0 || scale > 10)) {
    report("invalid-light-ies", "userData.ies.scaleFactor 必须在 [0,10]。"); return undefined;
  }
  return { profileId: value.profileId,
    ...(rotation === undefined ? {} : { rotationDeg: rotation }),
    ...(scale === undefined ? {} : { scaleFactor: scale }) };
}

/** E02：场景级 lightProfiles 载荷（scene.userData.lightProfiles）原样透传；
 * 引用闭合与量化网格由引擎打包层（packIesShading）强制。 */
function readSceneLightProfiles(scene: THREE.Scene, report: (code: string, message: string) => void): RuntimeLightProfile[] | undefined {
  const carrier = (scene as unknown as { userData?: { lightProfiles?: unknown } }).userData?.lightProfiles;
  if (carrier === undefined) return undefined;
  if (!Array.isArray(carrier) || carrier.some(profile => !profile || typeof profile !== "object" || typeof (profile as RuntimeLightProfile).profileId !== "string")) {
    report("invalid-light-profiles", "scene.userData.lightProfiles 必须是 lightProfile 对象数组。"); return undefined;
  }
  return carrier as RuntimeLightProfile[];
}

/** Reads resolved world matrices; the author frame must update matrices before calling. */
export function projectStudioDeepLights(scene: THREE.Scene, cameraLayerMask = 0xffffffff, shadowsEnabled = true,
  shadowType: THREE.ShadowMapType = DISPLAY_THREE_SHADOW_MAP_TYPE,
  includeGlobalIlluminationStandIn = false): {
  lights: Lights; issues: StudioDeepEnvironmentIssue[];
} {
  const directional: NonNullable<Lights["directional"]>[number][] = [];
  const points: NonNullable<Lights["points"]>[number][] = [];
  const spots: NonNullable<Lights["spots"]>[number][] = [];
  const ambient: { color: Vec3; intensity: number }[] = [];
  const hemisphere: { directionWorld: Vec3; skyColor: Vec3; groundColor: Vec3; intensity: number }[] = [];
  const issues: StudioDeepEnvironmentIssue[] = [];
  const reportScene = (code: string, message: string) => issues.push({ code, path: "scene.userData", message });
  const lightProfiles = readSceneLightProfiles(scene, reportScene);
  scene.traverseVisible(object => {
    if (!(object instanceof THREE.Light) || object.intensity === 0) return;
    // Deep GI 权威 = 探针体积;WebGL GI 站位光不进入 Deep 光照投影(防双重计账,见常量注释)。
    if (!includeGlobalIlluminationStandIn && object.name === GLOBAL_ILLUMINATION_STAND_IN_LIGHT_NAME) return;
    if ((object.layers.mask & cameraLayerMask) === 0) return;
    const path = `lights.${object.uuid}`;
    const report = (code: string, message: string) => issues.push({ code, path, message });
    const color = [object.color.r, object.color.g, object.color.b] as Vec3;
    if (![object.intensity, ...color].every(value => Number.isFinite(value) && value >= 0)) {
      report("invalid-light", "灯光颜色和强度必须为有限非负数。"); return;
    }
    const position = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
    const direction = (target: THREE.Object3D): Vec3 | undefined => {
      const ray = new THREE.Vector3().setFromMatrixPosition(target.matrixWorld).sub(position);
      if (![ray.x, ray.y, ray.z].every(Number.isFinite) || ray.lengthSq() < 1e-16) {
        report("invalid-light-direction", "灯光位置和目标必须不同且有限。"); return;
      }
      return ray.normalize().toArray() as unknown as Vec3;
    };
    const common = { color, intensity: object.intensity };
    if (object instanceof THREE.AmbientLight) {
      ambient.push(common); return;
    }
    if (object instanceof THREE.HemisphereLight) {
      const groundColor = object.groundColor.toArray() as unknown as Vec3;
      if (!groundColor.every(value => Number.isFinite(value) && value >= 0)) {
        report("invalid-light", "半球光地面颜色必须为有限非负数。"); return;
      }
      // Three uses normalized world position, not the light's rotation or a target.
      if (![position.x, position.y, position.z].every(Number.isFinite) || position.lengthSq() < 1e-16) {
        report("invalid-light-direction", "半球光世界位置必须有限且不在原点。"); return;
      }
      hemisphere.push({ directionWorld: position.normalize().toArray() as unknown as Vec3,
        skyColor: color, groundColor, intensity: object.intensity });
      return;
    }
    if (object instanceof THREE.DirectionalLight) {
      const directionWorld = direction(object.target);
      const castShadow = shadowsEnabled && object.castShadow;
      try {
        const shadow = castShadow ? projectStudioDirectionalShadow(object, shadowType) : undefined;
        if (directionWorld) directional.push({ ...common, directionWorld, castShadow, ...(shadow ? { shadow } : {}) });
      } catch (error) {
        report("directional-shadow-policy", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (!(object instanceof THREE.PointLight) && !(object instanceof THREE.SpotLight)) {
      report("unsupported-light-type", `Deep 尚未接入 ${object.type}。`); return;
    }
    if (!Number.isFinite(object.decay) || object.decay < 0 || object.decay > 4 || !Number.isFinite(object.distance) || object.distance < 0) {
      report("unsupported-light-attenuation", "灯光距离必须非负，衰减指数必须在 0–4 之间。");
      return;
    }
    if (![position.x, position.y, position.z].every(Number.isFinite)) {
      report("invalid-light-position", "灯光世界坐标必须为有限数。"); return;
    }
    const local = { ...common, positionWorld: position.toArray() as unknown as Vec3, range: object.distance, decay: object.decay };
    if (object instanceof THREE.SpotLight) {
      if (!Number.isFinite(object.angle) || object.angle <= 0 || object.angle > Math.PI / 2
        || !Number.isFinite(object.penumbra) || object.penumbra < 0 || object.penumbra > 1) {
        report("invalid-spot-cone", "聚光角度或半影超出 Deep 支持范围。"); return;
      }
      const directionWorld = direction(object.target);
      // E02：userData.ies 载体（无 userData → undefined，路径不变）。
      const ies = readSpotIes(object, path, report);
      const shadow = readSpotShadow(object, shadowsEnabled, path, report);
      if (directionWorld) spots.push({ ...local, directionWorld,
        innerConeCos: Math.cos(object.angle * (1 - object.penumbra)), outerConeCos: Math.cos(object.angle),
        ...(ies ? { ies } : {}), ...(shadow ? { shadow } : {}) });
      if (object.map) report("spot-texture", "Deep 尚未接入聚光灯投影贴图。");
    } else {
      if (shadowsEnabled && object.castShadow) report("point-shadow-policy", "Deep WebGPU 当前只支持聚光灯局部阴影；点光六面阴影未接入。");
      points.push(local);
    }
  });
  const casters = directional.filter(light => light.castShadow);
  if (casters.length > 1) issues.push({ code: "directional-shadow-count", path: "lights.directional",
    message: "Deep 当前只支持一盏作者方向光投影。" });
  if (casters.length === 1) {
    const index = directional.indexOf(casters[0]!);
    directional.unshift(...directional.splice(index, 1));
  }
  return { lights: { directional, points, spots,
    ...(ambient.length ? { ambient } : {}), ...(hemisphere.length ? { hemisphere } : {}),
    ...(lightProfiles?.length ? { lightProfiles } : {}) }, issues };
}

function readSpotShadow(light: THREE.SpotLight, shadowsEnabled: boolean, path: string,
  report: (code: string, message: string) => void) {
  if (!shadowsEnabled || !light.castShadow) return undefined;
  const authorId = light.userData.authorLightId, softness = light.userData.shadowSoftness ?? 0;
  if (typeof authorId !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._:-]{0,121}$/.test(authorId)) {
    report("invalid-local-shadow-id", `${path} 缺少有界稳定的作者灯光 ID。`); return undefined;
  }
  if (typeof softness !== "number" || !Number.isFinite(softness) || softness < 0 || softness > 1) {
    report("invalid-local-shadow-softness", `${path}.shadowSoftness 必须在 [0,1] 内。`); return undefined;
  }
  return { key: `author:${authorId}`, softness };
}
