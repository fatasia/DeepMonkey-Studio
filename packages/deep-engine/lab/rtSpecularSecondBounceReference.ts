import { buildTlas, traceTlasClosest } from "../src/rayTracing/tlas.js";
import { invertColumnMajor4x4 } from "../src/webgpu/rtShadowFrame.js";
import { lookAt, multiply, perspective } from "../src/webgpu/cameraMath.js";
import { buildSpecularGiScene, RT_SPECULAR_PROBE_INSTANCE_ALBEDOS, RT_SPECULAR_PROBE_LIGHT } from "./rtSpecularGiGpuProbe.js";
import { referenceReflectionRecords, REFLECTION_BIAS, REFLECTION_EYE, REFLECTION_RESOLUTION,
  REFLECTION_TARGET, REFLECTION_T_MAX } from "./reflectionRayGpuCases.js";

/** Independent geometry traversal and material/visibility reference; does not consume GPU hit records. */
export function referenceSecondBounce(depth: Float32Array) {
  const scene = buildSpecularGiScene();
  const tlas = buildTlas(scene.instances);
  const resolution = REFLECTION_RESOLUTION;
  const inverse = invertColumnMajor4x4(multiply(perspective(50 * Math.PI / 180, 1, 0.1, 200),
    lookAt(REFLECTION_EYE, REFLECTION_TARGET, [0, 1, 0])));
  const shading = new Float32Array(resolution * resolution * 4);
  const records = referenceReflectionRecords(scene, depth, resolution, resolution, Array.from(inverse), REFLECTION_EYE,
    REFLECTION_T_MAX, REFLECTION_BIAS, 2, (pixel, hit, position) => {
      const instance = scene.instances.findIndex(item => item.id === hit.instanceId);
      const light = RT_SPECULAR_PROBE_LIGHT.surfaceToLightWorld;
      const shadowOrigin = position.map((axis, i) => axis + light[i]! * REFLECTION_BIAS);
      const occluded = traceTlasClosest(tlas, { ox: shadowOrigin[0]!, oy: shadowOrigin[1]!, oz: shadowOrigin[2]!,
        dx: light[0], dy: light[1], dz: light[2], tMax: REFLECTION_T_MAX }, 0xff);
      shading.set(RT_SPECULAR_PROBE_INSTANCE_ALBEDOS.subarray(instance * 4, instance * 4 + 3), pixel * 4);
      shading[pixel * 4 + 3] = occluded ? 0 : 1;
    }, true);
  return { ...records, shading };
}
