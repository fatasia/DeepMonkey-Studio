import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import type { BakeLightState } from "./modelOptimizer";

export interface BounceSurface { diffuse: THREE.Vector3; emission: THREE.Vector3; doubleSided: boolean;
  sample?: (point: THREE.Vector3, diffuse: THREE.Vector3, emission: THREE.Vector3) => number; }
export interface BounceScene { bvh?: MeshBVH; epsilon: number; surfaces?: BounceSurface[]; }
export function createBounceScratch() {
  return { origin: new THREE.Vector3(), direction: new THREE.Vector3(), tangent: new THREE.Vector3(), bitangent: new THREE.Vector3(),
    normal: new THREE.Vector3(), lightDirection: new THREE.Vector3(), shadowOrigin: new THREE.Vector3(), incoming: new THREE.Vector3(),
    shadowDiffuse: new THREE.Vector3(), shadowEmission: new THREE.Vector3(),
    diffuse: new THREE.Vector3(), emission: new THREE.Vector3(), ray: new THREE.Ray(), shadowRay: new THREE.Ray(), color: new THREE.Color() };
}

function sampleHit(scene: BounceScene, hit: THREE.Intersection, diffuse: THREE.Vector3, emission: THREE.Vector3) {
  const surface = hit.face && scene.surfaces?.[Math.floor(hit.face.a / 3)];
  if (!surface) return undefined;
  diffuse.copy(surface.diffuse);emission.copy(surface.emission);
  return { surface, alpha: THREE.MathUtils.clamp(surface.sample?.(hit.point, diffuse, emission) ?? 1, 0, 1) };
}

function bounceHit(scene: BounceScene, ray: THREE.Ray, diffuse: THREE.Vector3, emission: THREE.Vector3) {
  const first = scene.bvh!.raycastFirst(ray, THREE.DoubleSide, scene.epsilon, Infinity);
  if (!first) return undefined;
  const sampled = sampleHit(scene, first, diffuse, emission);
  if (sampled && sampled.alpha > 0) return { hit: first, ...sampled };
  for (const hit of scene.bvh!.raycast(ray, THREE.DoubleSide, scene.epsilon, Infinity).sort((a, b) => a.distance - b.distance)) {
    const value = sampleHit(scene, hit, diffuse, emission);
    if (value && value.alpha > 0) return { hit, ...value };
  }
  return undefined;
}

function lightVisibility(scene: BounceScene, ray: THREE.Ray, far: number, diffuse: THREE.Vector3, emission: THREE.Vector3): number {
  const first = scene.bvh!.raycastFirst(ray, THREE.DoubleSide, scene.epsilon, far);
  if (!first) return 1;
  const sampled = sampleHit(scene, first, diffuse, emission);
  if (!sampled || sampled.alpha >= 1) return 0;
  let visibility = 1;
  for (const hit of scene.bvh!.raycast(ray, THREE.DoubleSide, scene.epsilon, far)) {
    const value = sampleHit(scene, hit, diffuse, emission);
    if (!value) return 0;
    visibility *= 1 - value.alpha;
    if (visibility <= 1e-6) return 0;
  }
  return visibility;
}

/** 余弦加权半球采样的一跳 Lambert 反弹；材质、可见性和采样概率使用同一积分约定。 */
export function diffuseBounce(position: THREE.Vector3, normal: THREE.Vector3, samples: number, scene: BounceScene,
  lights: readonly BakeLightState[], output: THREE.Vector3, scratch: ReturnType<typeof createBounceScratch>): void {
  output.set(0, 0, 0);
  if (!scene.bvh || samples <= 0) return;
  const { tangent, bitangent, direction, origin, ray, lightDirection, shadowOrigin, shadowRay, incoming, color } = scratch;
  if (Math.abs(normal.z) < 0.999) tangent.set(0, 0, 1).cross(normal).normalize();
  else tangent.set(1, 0, 0);
  bitangent.copy(normal).cross(tangent);
  // 各 texel 共用固定方位会把遮挡边界复制成大块条带；确定性旋转打散方向相关性，仍保持余弦采样概率。
  const phaseHash = Math.sin(position.x * 12.9898 + position.y * 78.233 + position.z * 37.719) * 43758.5453;
  const phase = (phaseHash - Math.floor(phaseHash)) * Math.PI * 2;
  for (let index = 0; index < samples; index++) {
    const u = (index + 0.5) / samples, phi = index * 2.399963229728653 + phase;
    direction.copy(tangent).multiplyScalar(Math.sqrt(u) * Math.cos(phi))
      .addScaledVector(bitangent, Math.sqrt(u) * Math.sin(phi)).addScaledVector(normal, Math.sqrt(1 - u)).normalize();
    origin.copy(position).addScaledVector(normal, scene.epsilon);
    ray.set(origin, direction);
    const bounced = bounceHit(scene, ray, scratch.diffuse, scratch.emission);
    if (!bounced?.hit.face) continue;
    const { hit, surface, alpha } = bounced;
    if (!hit.face) continue;
    scratch.normal.copy(hit.face.normal).normalize();
    if (scratch.normal.dot(direction) > 0) {
      if (!surface.doubleSided) continue;
      scratch.normal.negate();
    }
    incoming.copy(scratch.emission);
    for (const light of lights) {
      if (!light.enabled || light.intensity <= 0) continue;
      lightDirection.fromArray(light.type === "point" ? light.position : light.direction);
      if (light.type === "point") lightDirection.sub(hit.point);
      const distance = lightDirection.length();
      if (distance <= scene.epsilon) continue;
      lightDirection.divideScalar(distance);
      const cosine = Math.max(0, scratch.normal.dot(lightDirection));
      const attenuation = light.type === "point" ? Math.pow(Math.max(0, 1 - distance / Math.max(light.range, 0.001)), 2) : 1;
      if (cosine === 0 || attenuation === 0) continue;
      shadowOrigin.copy(hit.point).addScaledVector(scratch.normal, scene.epsilon);
      shadowRay.set(shadowOrigin, lightDirection);
      const far = light.type === "point" ? Math.max(scene.epsilon, distance - scene.epsilon) : Infinity;
      const visibility = lightVisibility(scene, shadowRay, far, scratch.shadowDiffuse, scratch.shadowEmission);
      if (visibility === 0) continue;
      color.set(light.color);
      const energy = cosine * attenuation * light.intensity * visibility;
      incoming.x += color.r * energy * scratch.diffuse.x;
      incoming.y += color.g * energy * scratch.diffuse.y;
      incoming.z += color.b * energy * scratch.diffuse.z;
    }
    output.addScaledVector(incoming, alpha / samples);
  }
}
