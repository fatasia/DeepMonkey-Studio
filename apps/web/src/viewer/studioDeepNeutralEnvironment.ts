import type { RadianceHdrImage } from "@bim-studio/deep-engine";
import type { PbrEnvironmentSource } from "@bim-studio/deep-engine/webgpu";

/**
 * Deep 的中性环境兜底。作者未配置环境时，黑 IBL 会把无贴图材质打回死黑、并让
 * DDGI 探针捕获零辐照（违反"禁止纯黑裸背景"红线），因此兜底必须是可照明的中性
 * 摄影棚环境：
 *
 * - 背景为纯色时返回引擎原生 `{ kind: "studio" }`：GPU 程序生成预滤波立方体
 *   （environmentShader.ts `studio()`），零 CPU 像素、含完整 mip 链与辐照/BRDF；
 * - 背景为纹理时引擎源不带 backgroundImage 字段，走 radiance-hdr 兜底：CPU 复刻
 *   同一份 `studio()` 辐照为确定性等距柱状图（同 shader 数学，冷灰基调 + 主光/
 *   轮廓光/补光 softbox，辐照非零），再叠加作者天空作为背景像素。
 */

const WIDTH = 64;
const HEIGHT = 32;

type Vec3 = readonly [number, number, number];

function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 与 environmentShader.ts `softbox()` 逐算子同源的 CPU 复刻。 */
function softbox(direction: Vec3, center: Vec3, width: number, height: number): number {
  const normal = normalize(center);
  const right = normalize(cross([0, 1, 0], normal));
  const up = cross(normal, right);
  const forward = dot(direction, normal);
  const scale = Math.max(forward, 0.001);
  const edgeX = Math.abs(dot(direction, right) / scale) / width;
  const edgeY = Math.abs(dot(direction, up) / scale) / height;
  return (1 - smoothstep(0.88, 1, Math.max(edgeX, edgeY))) * (forward < 0 ? 0 : 1);
}

/** 与 environmentShader.ts `studio()` 同源的中性摄影棚辐照（线性 sRGB）。 */
export function studioNeutralRadiance(direction: Vec3): Vec3 {
  const sky = mix([0.025, 0.03, 0.04], [0.2, 0.24, 0.3], smoothstep(-0.3, 0.9, direction[1]));
  const key = softbox(direction, [-1.0, 1.5, 1.0], 0.7, 0.35);
  const rim = softbox(direction, [1.0, 0.65, -1.0], 0.2, 0.8);
  const fill = softbox(direction, [0.3, 1.8, -0.5], 0.8, 0.3);
  return [
    sky[0] + 5.0 * key + 2.8 * rim + 1.3 * fill,
    sky[1] + 4.8 * key + 3.4 * rim + 1.5 * fill,
    sky[2] + 4.4 * key + 4.2 * rim + 1.8 * fill,
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

/**
 * 确定性中性等距柱状环境（线性 sRGB、top-left 行主序，与 RadianceHdrImage 合同
 * 及引擎 `equirectangular()` 采样方向一致：第 0 行 = 天顶）。
 * 64×32 足够：引擎侧会重新执行 GGX 预滤波并生成完整 mip 链。
 */
export function studioNeutralEnvironmentImage(): RadianceHdrImage {
  let image = neutralEnvironmentImage;
  if (!image) {
    const data = new Float32Array(WIDTH * HEIGHT * 3);
    for (let y = 0; y < HEIGHT; y++) {
      const polar = ((y + 0.5) / HEIGHT) * Math.PI;
      const sinPolar = Math.sin(polar), cosPolar = Math.cos(polar);
      for (let x = 0; x < WIDTH; x++) {
        const azimuth = ((x + 0.5) / WIDTH - 0.5) * 2 * Math.PI;
        const [r, g, b] = studioNeutralRadiance([sinPolar * Math.cos(azimuth), cosPolar, sinPolar * Math.sin(azimuth)]);
        const offset = (y * WIDTH + x) * 3;
        data[offset] = r; data[offset + 1] = g; data[offset + 2] = b;
      }
    }
    image = Object.freeze({ width: WIDTH, height: HEIGHT, data });
    neutralEnvironmentImage = image;
  }
  return image;
}

let neutralEnvironmentImage: RadianceHdrImage | undefined;

/** 作者环境的确定性中性兜底：无天空纹理走引擎原生 studio IBL，有天空则叠加为背景像素。 */
export function studioDeepNeutralEnvironment(backgroundImage?: RadianceHdrImage): PbrEnvironmentSource {
  return backgroundImage
    ? { kind: "radiance-hdr", image: studioNeutralEnvironmentImage(), backgroundImage }
    : { kind: "studio" };
}
