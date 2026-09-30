import type { RenderPacket } from "../src/renderPacketTypes.js";
import type { DeepRuntimePackageV1 } from "../src/runtimePackage/types.js";
import { materializeRuntimeRenderPacket } from "../src/runtimePackage/renderPacket.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { normalMatrixFromWorld } from "../src/scene/math.js";
import type { SceneMatrix4 } from "../src/scene/types.js";
import { lookAt, type Vec3 } from "../src/webgpu/cameraMath.js";
import { invertMat4, pixelRayProbe } from "../src/postprocess/temporalMotionReference.js";
import { buildRenderPacketRayScene } from "../src/rayTracing/renderPacketRayScene.js";
import { traceTlasClosest } from "../src/rayTracing/tlas.js";
import { planCascadedShadows } from "../src/shadows/cascadedShadowPlanner.js";

export interface J3NormalShadowManifest {
  readonly packageHash: string; readonly packetHash: string; readonly width: number; readonly height: number;
  readonly cameras: readonly {
    readonly id: string; readonly eye: Vec3; readonly target: Vec3; readonly up: Vec3;
    readonly verticalFovRadians: number; readonly near: number; readonly far: number;
    readonly expectedVP: readonly number[];
    readonly subsets: readonly { readonly instanceId: string; readonly materialId: string; readonly pixels: readonly number[] }[];
  }[];
}

export const J3_NORMAL_SHADOW_PROFILE = Object.freeze({
  surfaceToLight: Object.freeze([-.6, -.3, Math.sqrt(.55)]) as Vec3,
  shadowMapSize: 2048, maxShadowDistance: 40, splitLambda: .7, depthPadding: 10, blendRatio: 0,
  depthBias: .00075, rayOriginOffset: .001,
  normalAttachmentFormat: "rgba8unorm", normalComponentQuantizationBound: 1 / 255,
  normalQuantizationAngleBoundDegrees: Math.asin(Math.sqrt(3) / 255) * 180 / Math.PI,
});

/** Pre-GPU oracle using existing packet, fixed masks, camera math and RayBackend. */
export function buildJ3NormalShadowMatrix(source: DeepRuntimePackageV1, manifest: J3NormalShadowManifest) {
  const payload = source.payloads[source.entrypoints.renderPacket];
  if (source.packageHash.value !== manifest.packageHash || sha256Utf8(JSON.stringify(payload)) !== manifest.packetHash) {
    throw Error("Normal/shadow source manifest mismatch.");
  }
  if (![manifest.width, manifest.height].every(value => Number.isInteger(value) && value > 0)) throw Error("Invalid matrix extent.");
  const packet = materializeRuntimeRenderPacket(payload, "$.normalShadowPacket");
  const visibleScene = buildRenderPacketRayScene(packet), profile = J3_NORMAL_SHADOW_PROFILE;
  if (visibleScene.excludedTransparentInstances || visibleScene.conservativeAlphaMaskInstances) {
    throw Error("Normal/shadow first cut requires opaque geometry.");
  }
  const casterPacket: RenderPacket = { ...packet, instances: packet.instances.filter(instance => instance.castShadow !== false) };
  const casterScene = buildRenderPacketRayScene(casterPacket);
  const disabledCasterScene = buildRenderPacketRayScene({ ...casterPacket,
    instances: casterPacket.instances.filter(instance => !instance.id.startsWith("golden-instance")) });
  const rayDirection = profile.surfaceToLight.map(value => -value) as unknown as Vec3;
  const cases = manifest.cameras.flatMap(camera => {
    const inverseVP = invertMat4(camera.expectedVP);
    const view = lookAt(camera.eye, camera.target, camera.up);
    return camera.subsets.flatMap(subset => {
      const instance = packet.instances.find(value => value.id === subset.instanceId);
      const geometry = packet.geometries.find(value => value.id === instance?.geometry);
      const material = packet.materials.find(value => value.id === subset.materialId);
      if (!instance || !geometry || !material || instance.material !== material.id || !subset.pixels.length) {
        throw Error("Normal/shadow subset references missing packet content.");
      }
      if (material.normalTexture || material.doubleSided || geometry.vertices.length % 6 !== 0) {
        throw Error("Normal first cut requires flat opaque single-sided geometry without a normal map.");
      }
      const localNormal = Array.from(geometry.vertices.slice(3, 6));
      for (let index = 3; index < geometry.vertices.length; index += 6) {
        if (localNormal.some((value, lane) => value !== geometry.vertices[index + lane])) {
          throw Error("Normal first cut requires constant vertex normals.");
        }
      }
      const normalMatrix = normalMatrixFromWorld(Array.from(instance.transform) as unknown as SceneMatrix4);
      if (!normalMatrix) throw Error("Normal/shadow instance has a singular transform.");
      const worldNormal = unit(transform3(normalMatrix, localNormal, 3));
      const viewNormal = unit(transform3(view, worldNormal, 4));
      const seen = new Set<number>();
      const points = subset.pixels.map(pixel => {
        if (!Number.isInteger(pixel) || pixel < 0 || pixel >= manifest.width * manifest.height || seen.has(pixel)) {
          throw Error("Normal/shadow mask contains an invalid or duplicate pixel.");
        }
        seen.add(pixel);
        const probe = pixelRayProbe(inverseVP, camera.eye, pixel % manifest.width + .5,
          Math.floor(pixel / manifest.width) + .5, manifest.width, manifest.height, 1);
        const direction = unit(probe.map((value, lane) => value - camera.eye[lane]!));
        const hit = traceTlasClosest(visibleScene.tlas, query(camera.eye, direction, camera.far));
        if (hit?.instanceId !== instance.id) throw Error(`Normal/shadow mask ${camera.id}/${pixel} is not on ${instance.id}.`);
        const worldPoint = camera.eye.map((value, lane) => value + direction[lane]! * hit.t) as unknown as Vec3;
        const origin = worldPoint.map((value, lane) => value + worldNormal[lane]! * profile.rayOriginOffset) as unknown as Vec3;
        const blocker = traceTlasClosest(casterScene.tlas, query(origin, profile.surfaceToLight, profile.maxShadowDistance));
        const withoutCube = traceTlasClosest(disabledCasterScene.tlas, query(origin, profile.surfaceToLight, profile.maxShadowDistance));
        return { pixel, worldPoint, expectedWorldNormal: worldNormal, expectedViewNormal: viewNormal,
          blockerInstance: blocker?.instanceId ?? null, blockerDistance: blocker?.t ?? null,
          baselineOccluded: instance.receiveShadow !== false && blocker !== undefined,
          casterDisabledOccluded: instance.receiveShadow !== false && withoutCube !== undefined,
          receiverDisabledOccluded: false };
      });
      return [1, 4].map(cascadeCount => {
        const plan = planCascadedShadows({ ...camera, aspect: manifest.width / manifest.height }, rayDirection,
          { ...profile, cascadeCount });
        return { id: `${camera.id}/${instance.id}/csm-${cascadeCount}`, cameraId: camera.id, instanceId: instance.id,
          cascadeCount, splitDepths: Array.from(plan.splitDepths), points,
          scenarios: ["baseline", "cube-caster-disabled", "triangle-receiver-disabled"] as const };
      });
    });
  });
  return { schema: "j3-normal-shadow-cpu-plan-v1", evidenceKind: "cpu-contract-plan", currentRun: false,
    actualNormalAttachments: false, actualShadowAttachments: false,
    packageHash: manifest.packageHash, packetHash: manifest.packetHash, width: manifest.width, height: manifest.height,
    profile, productionAdmission: "pending-normal-attachment-and-shadow-uniform-alignment", cases } as const;
}

function unit(vector: readonly number[]): Vec3 {
  const length = Math.hypot(...vector);
  if (!(length > 0) || !Number.isFinite(length)) throw Error("Normal/shadow vector is degenerate.");
  return vector.map(value => value / length) as unknown as Vec3;
}
function transform3(matrix: ArrayLike<number>, vector: readonly number[], stride: number): Vec3 {
  return [0, 1, 2].map(row => [0, 1, 2].reduce((sum, column) => sum + matrix[column * stride + row]! * vector[column]!, 0)) as unknown as Vec3;
}
function query(origin: Vec3, direction: Vec3, tMax: number) {
  return { ox: origin[0], oy: origin[1], oz: origin[2], dx: direction[0], dy: direction[1], dz: direction[2], tMax };
}
