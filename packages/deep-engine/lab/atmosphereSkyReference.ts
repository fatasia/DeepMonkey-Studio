/**
 * I-C6 白球期望辐亮度参考(逐像素 CPU):E(n)/π,E(n) = ∫L(ω)max(0,n·ω)dΩ,
 * 与 GPU 环境同一图像数据源(atmosphereSkyEnvironmentImage)。
 */
import { atmosphereSkyEnvironmentImage, type AtmosphereSkyParameters } from "../src/environment/atmosphereSky.js";
import { furnaceSphereSegmentation } from "../src/webgpu/whiteFurnace.js";

/** 探针画布与相机常量(白球几何/期望积分共用单源)。 */
export const WIDTH = 192, HEIGHT = 192, VERTICAL_FOV = Math.PI / 4;

/** 白球期望辐亮度(逐像素):E(n)/π,E(n) = ∫L(ω)max(0,n·ω)dΩ,与 GPU 同一图像数据源。 */
export function expectedSphereRadiance(parameters: AtmosphereSkyParameters): Float32Array {
  const image = atmosphereSkyEnvironmentImage(parameters, 256, 128);
  const segmentation = furnaceSphereSegmentation(WIDTH, HEIGHT, 5, 1.7, VERTICAL_FOV);
  const expected = new Float32Array(WIDTH * HEIGHT * 3);
  // 与 atmosphereSkyEnvironmentImage 的方位约定互逆:azimuth = ((col+0.5)/w - 0.5)·2π。
  const texel = (mu: number, phi: number, channel: number): number => {
    const row = Math.min(Math.max(Math.round((1 - mu) / 2 * image.height - 0.5), 0), image.height - 1);
    const column = Math.min(Math.max(Math.round((phi / (2 * Math.PI) + 0.5) * image.width - 0.5), 0), image.width - 1);
    return image.data[(row * image.width + column) * 3 + channel]!;
  };
  const rows = 24, columns = 48;
  const deltaOmega = (1 / rows) * (2 * Math.PI / columns); // μ 均匀网格:dΩ = dμ·dφ
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const worldX = ((x + 0.5) / WIDTH * 2 - 1) * 5 * Math.tan(VERTICAL_FOV / 2);
      const worldY = (1 - (y + 0.5) / HEIGHT * 2) * 5 * Math.tan(VERTICAL_FOV / 2);
      const index = y * WIDTH + x;
      if (segmentation[index] !== 0 || (worldX / 1.7) ** 2 + (worldY / 1.7) ** 2 > 1) continue;
      const nx = worldX / 1.7, ny = worldY / 1.7;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      let eR = 0, eG = 0, eB = 0;
      for (let row = 0; row < rows; row += 1) {
        const mu = (row + 0.5) / rows, sinMu = Math.sqrt(Math.max(0, 1 - mu * mu));
        for (let column = 0; column < columns; column += 1) {
          const phi = 2 * Math.PI * (column + 0.5) / columns;
          const cosine = mu * nz + sinMu * (Math.cos(phi) * nx + Math.sin(phi) * ny);
          if (cosine <= 0) continue;
          eR += texel(mu, phi, 0) * cosine; eG += texel(mu, phi, 1) * cosine; eB += texel(mu, phi, 2) * cosine;
        }
      }
      expected[index * 3] = eR * deltaOmega / Math.PI;
      expected[index * 3 + 1] = eG * deltaOmega / Math.PI;
      expected[index * 3 + 2] = eB * deltaOmega / Math.PI;
    }
  }
  return expected;
}

