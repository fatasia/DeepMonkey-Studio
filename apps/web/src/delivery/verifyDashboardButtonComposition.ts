import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { compositeDashboardButtonGroup } from "./dashboardButtonGroup";
import { dashboardTextRasterScale, scaleRasterRect, scaleRasterButtonGroup } from "./dashboardRasterDensity";
import type { DashboardRasterCompileInput, DashboardRasterEvidence } from "./dashboardRasterTypes";

/** Replay the trusted compiler transformation against the frozen capture and producer pixels. */
export function verifyDashboardButtonComposition(evidence: DashboardRasterEvidence, input: DashboardRasterCompileInput,
  atlas: { width: number; height: number; dataBase64: string }): void {
  const value = evidence.composition, data = input.data?.[evidence.nodeId];
  const scale = dashboardTextRasterScale(input.textRasterScale);
  if (dashboardTextRasterScale(evidence.textRasterScale) !== scale) throw new Error("Button raster density differs from frozen compiler input");
  if (!value || value.id !== "dashboard-button-group-v1" || !data || !("layout" in data)
    || value.sourceRgbaBase64.length > 6 * 1024 * 1024) throw new Error("Invalid button composition evidence");
  const box = data.layout.textBoxes.find(box => runtimeContentSha256(box.role) === runtimeContentSha256(value.recipe.role));
  if (!box?.buttonGroup || runtimeContentSha256({ group: box.buttonGroup, textRect: box.rect, role: box.role }) !== value.recipeSha256
    || runtimeContentSha256(value.recipe) !== value.recipeSha256) throw new Error("Button recipe differs from frozen measured layout");
  if (value.sourceWidth !== Math.ceil(box.rect[2]) * scale || value.sourceHeight !== Math.ceil(box.rect[3]) * scale)
    throw new Error("Button composition source dimensions differ from frozen text layout");
  const bytes = Uint8Array.from(atob(value.sourceRgbaBase64), char => char.charCodeAt(0));
  if (sha256Bytes(bytes) !== value.sourcePixelSha256 || value.sourcePixelSha256 !== evidence.producerEvidence?.pixelSha256)
    throw new Error("Button composition source differs from native producer pixels");
  const output = compositeDashboardButtonGroup(scaleRasterButtonGroup(value.recipe.group, scale), { rect: scaleRasterRect(value.recipe.textRect, scale),
    width: value.sourceWidth, height: value.sourceHeight, rgba: bytes },
    { width: Math.ceil(value.recipe.group.rect[2]) * scale, height: Math.ceil(value.recipe.group.rect[3]) * scale });
  const atlasBytes = Uint8Array.from(atob(atlas.dataBase64), char => char.charCodeAt(0));
  if (output.width !== atlas.width || output.height !== atlas.height || sha256Bytes(output.rgba) !== value.outputPixelSha256
    || value.outputPixelSha256 !== evidence.pixelSha256 || sha256Bytes(atlasBytes) !== value.outputPixelSha256)
    throw new Error("Button composition output differs from replayed atlas pixels");
}
