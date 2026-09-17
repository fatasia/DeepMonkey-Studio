import { runtimeContentSha256, type Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { assetIdentity, base64, rasterExtent, verifyRaster, RASTER_BYTES_LIMIT } from "./dashboardRasterValidation";
import type { DashboardRasterCompileInput, DashboardRasterHost, DashboardPageImageRasterRequest } from "./dashboardRasterTypes";

/** Page images are system content, never author-node or font evidence. */
export async function compileDashboardPageImage(
  page: DashboardRasterCompileInput["document"]["application"]["pages"][number],
  content: Deep2dRuntimePackage, input: DashboardRasterCompileInput, host: DashboardRasterHost, usedBytes: number,
) {
  const appearance = page.appearance, binding = input.pageAssets?.[page.id];
  if (!appearance?.backgroundImageUrl || !binding || !host.decodePageBackground) return null;
  const asset = input.assets[binding.image];
  if (!asset || !asset.mime.startsWith("image/")) throw new Error("Frozen page image is missing");
  const width = Math.ceil(page.width), height = Math.ceil(page.height);
  rasterExtent(width, height);
  const bytes = width * height * 4;
  if (usedBytes + bytes > RASTER_BYTES_LIMIT) throw new Error("Dashboard atlas byte budget exceeded");
  const background: DashboardPageImageRasterRequest["background"] = {
    fit: appearance.backgroundImageFit ?? "cover", position: appearance.backgroundImagePosition ?? "center",
    repeat: appearance.backgroundImageRepeat ?? false,
  };
  if (!["cover", "contain", "stretch", "original"].includes(background.fit)
    || !["center", "top", "bottom", "left", "right"].includes(background.position) || typeof background.repeat !== "boolean")
    throw new Error("Invalid frozen page background layout");
  const requestHash = runtimeContentSha256({ width, height, background, asset: assetIdentity(asset) });
  const result = verifyRaster(await host.decodePageBackground({ width, height, background, fit: "fill", asset, requestHash }),
    requestHash, width, height);
  const atlasId = `${content.id}.image`;
  return { bytes, content: { ...content,
    atlases: [{ id: atlasId, revision: content.revision, kind: "image" as const, format: "rgba8unorm-srgb" as const,
      width, height, sampling: "linear" as const, dataBase64: base64(result.rgba) }],
    quads: [{ id: `${atlasId}.quad`, zOrder: 1, transform: [1, 0, 0, 1, 0, 0] as const, atlasId,
      source: [0, 0, width, height] as const, destination: [0, 0, page.width, page.height] as const, color: [1, 1, 1, 1] as const }],
  }, evidence: { pageId: page.id, atlasId, resourceId: binding.image, requestHash,
    pixelSha256: result.sha256, sourceSha256: result.sourceSha256, producer: result.producer } };
}
