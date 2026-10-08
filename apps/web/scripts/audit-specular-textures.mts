import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { parseGlb } from "@bim-studio/deep-engine/gltf";

const [modelPath, reportPath] = process.argv.slice(2);
if (!modelPath || !reportPath) throw new Error("usage: tsx audit-specular-textures.mts MODEL.glb REPORT.json");
const bytes = new Uint8Array(await readFile(modelPath)), glb = parseGlb(bytes);
const document = glb.json as any, reports = [];
await mkdir(dirname(reportPath), { recursive: true });
const decode = async (textureIndex: number) => {
  const imageIndex = document.textures[textureIndex].source, image = document.images[imageIndex];
  if (image.bufferView === undefined) throw new Error(`Image ${imageIndex} is external.`);
  const view = document.bufferViews[image.bufferView], offset = view.byteOffset ?? 0;
  const encoded = glb.buffers[view.buffer].subarray(offset, offset + view.byteLength);
  const decoded = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { imageIndex, image, encoded, ...decoded };
};
const linear = (channel: number) => {
  const srgb = channel / 255;
  return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
};
for (const [materialIndex, material] of document.materials.entries()) {
  const extension = material.extensions?.KHR_materials_specular;
  if (!extension?.specularColorTexture) continue;
  const specular = await decode(extension.specularColorTexture.index);
  const mrIndex = material.pbrMetallicRoughness?.metallicRoughnessTexture?.index;
  const mr = mrIndex === undefined ? undefined : await decode(mrIndex);
  const sameUv = (extension.specularColorTexture.texCoord ?? 0)
    === (material.pbrMetallicRoughness?.metallicRoughnessTexture?.texCoord ?? 0)
    && !extension.specularColorTexture.extensions && !material.pbrMetallicRoughness?.metallicRoughnessTexture?.extensions;
  if (mr && (mr.info.width !== specular.info.width || mr.info.height !== specular.info.height || !sameUv)) {
    throw new Error("Per-pixel association requires equal image dimensions and UV transforms.");
  }
  const count = specular.info.width * specular.info.height, min = [255, 255, 255, 255], max = [0, 0, 0, 0], sum = [0, 0, 0, 0];
  let white = 0, black = 0, colored = 0, dielectricWeight = 0, weightedF0Difference = 0;
  const ior = material.extensions?.KHR_materials_ior?.ior ?? 1.5, f0 = ((ior - 1) / (ior + 1)) ** 2;
  for (let pixel = 0; pixel < count; pixel++) {
    const offset = pixel * 4, rgb = [specular.data[offset], specular.data[offset + 1], specular.data[offset + 2]];
    for (let channel = 0; channel < 4; channel++) {
      const value = specular.data[offset + channel];
      min[channel] = Math.min(min[channel], value); max[channel] = Math.max(max[channel], value); sum[channel] += value;
    }
    white += rgb.every(value => value === 255) ? 1 : 0;
    black += rgb.every(value => value === 0) ? 1 : 0;
    colored += Math.max(...rgb) - Math.min(...rgb) > 1 ? 1 : 0;
    const metallic = (material.pbrMetallicRoughness?.metallicFactor ?? 1) * (mr ? mr.data[offset + 2] / 255 : 1);
    const dielectric = 1 - metallic;
    dielectricWeight += dielectric;
    const colorFactor = extension.specularColorFactor ?? [1, 1, 1];
    const difference = rgb.reduce((acc, value, channel) => acc + Math.abs(f0 - Math.min(1, f0 * linear(value) * colorFactor[channel])), 0) / 3;
    weightedF0Difference += dielectric * difference;
  }
  const imagePath = join(dirname(reportPath), `smt-specular-material-${materialIndex}.${specular.image.mimeType === "image/jpeg" ? "jpg" : "png"}`);
  await writeFile(imagePath, specular.encoded);
  reports.push({ materialIndex, name: material.name, textureIndex: extension.specularColorTexture.index,
    imageIndex: specular.imageIndex, imagePath, width: specular.info.width, height: specular.info.height,
    encodedSha256: createHash("sha256").update(specular.encoded).digest("hex"),
    rgbaMin: min, rgbaMax: max, rgbaMean: sum.map(value => value / count),
    whiteFraction: white / count, blackFraction: black / count, coloredFraction: colored / count,
    dielectricWeightMean: dielectricWeight / count, iorF0: f0,
    dielectricWeightedF0DifferenceMean: weightedF0Difference / count,
    scope: "Whole UV atlas pixels; not screen-space coverage or proof of screenshot causation." });
}
await writeFile(reportPath, JSON.stringify({ modelSha256: createHash("sha256").update(bytes).digest("hex"), reports }, null, 2) + "\n");
console.log(JSON.stringify(reports, null, 2));
