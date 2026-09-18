import * as THREE from "three";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import { projectStudioDirectionalShadow } from "./studioDeepDirectionalShadow";

export interface StudioDeepEnvironmentIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

type Lights = NonNullable<RenderView["lights"]>;
type Vec3 = readonly [number, number, number];

/** Reads resolved world matrices; the author frame must update matrices before calling. */
export function projectStudioDeepLights(scene: THREE.Scene, cameraLayerMask = 0xffffffff, shadowsEnabled = true,
  shadowType: THREE.ShadowMapType = THREE.PCFShadowMap): {
  lights: Lights; issues: StudioDeepEnvironmentIssue[];
} {
  const directional: NonNullable<Lights["directional"]>[number][] = [];
  const points: NonNullable<Lights["points"]>[number][] = [];
  const spots: NonNullable<Lights["spots"]>[number][] = [];
  const ambient: { color: Vec3; intensity: number }[] = [];
  const hemisphere: { directionWorld: Vec3; skyColor: Vec3; groundColor: Vec3; intensity: number }[] = [];
  const issues: StudioDeepEnvironmentIssue[] = [];
  scene.traverseVisible(object => {
    if (!(object instanceof THREE.Light) || object.intensity === 0) return;
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
    if (object.decay !== 2 || !Number.isFinite(object.distance) || object.distance <= 0) {
      report("unsupported-light-attenuation", "Deep 局部光要求有限正距离和平方反比衰减，无法等价表示无限距离或其他衰减。");
      return;
    }
    if (![position.x, position.y, position.z].every(Number.isFinite)) {
      report("invalid-light-position", "灯光世界坐标必须为有限数。"); return;
    }
    const local = { ...common, positionWorld: position.toArray() as unknown as Vec3, range: object.distance };
    if (shadowsEnabled && object.castShadow) report("local-shadow-policy", "局部阴影尚未映射作者偏移、分辨率和投影相机参数。");
    if (object instanceof THREE.SpotLight) {
      if (!Number.isFinite(object.angle) || object.angle <= 0 || object.angle >= Math.PI / 2
        || !Number.isFinite(object.penumbra) || object.penumbra < 0 || object.penumbra > 1) {
        report("invalid-spot-cone", "聚光角度或半影超出 Deep 支持范围。"); return;
      }
      const directionWorld = direction(object.target);
      if (directionWorld) spots.push({ ...local, directionWorld,
        innerConeCos: Math.cos(object.angle * (1 - object.penumbra)), outerConeCos: Math.cos(object.angle) });
      if (object.map) report("spot-texture", "Deep 尚未接入聚光灯投影贴图。");
    } else points.push(local);
  });
  const casters = directional.filter(light => light.castShadow);
  if (casters.length > 1) issues.push({ code: "directional-shadow-count", path: "lights.directional",
    message: "Deep 当前只支持一盏作者方向光投影。" });
  if (casters.length === 1) {
    const index = directional.indexOf(casters[0]!);
    directional.unshift(...directional.splice(index, 1));
  }
  return { lights: { directional, points, spots,
    ...(ambient.length ? { ambient } : {}), ...(hemisphere.length ? { hemisphere } : {}) }, issues };
}
