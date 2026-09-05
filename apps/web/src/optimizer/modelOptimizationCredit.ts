import type { Document } from "@gltf-transform/core";
import type { ModelRecord } from "@bim-studio/contracts";

export function modelOptimizationCredit(model: ModelRecord | undefined): string | undefined {
  const origin = model?.libraryOrigin ?? model?.optimization?.libraryOrigin;
  if (!origin?.attribution) return undefined;
  const { author, text, sourceUrl, licenseUrl } = origin.attribution;
  return `${text}\nAuthor: ${author}\nSource: ${sourceUrl}\nLicense: ${origin.license ?? "See license URL"} (${licenseUrl})\nModified with BIM Studio model optimization.`;
}

export function preserveOptimizationCredit(document: Document, credit?: string): void {
  const asset = document.getRoot().getAsset();
  if (!credit || asset.copyright?.includes(credit)) return;
  asset.copyright = [asset.copyright, credit].filter(Boolean).join("\n\n");
}
