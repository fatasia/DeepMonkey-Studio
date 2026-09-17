import { createHash } from "node:crypto";
const sha = value => createHash("sha256").update(value).digest("hex");
const check = value => { if (!value) throw new Error("Dashboard background evidence mismatch"); };

export function compiledBackgroundBindings(result, input, dashboard) {
  const bindings = [], seen = new Set();
  for (const evidence of result.pageImageEvidence ?? []) {
    const index = input.document.application.pages.findIndex(page => page.id === evidence.pageId);
    const page = dashboard.pages[index], asset = input.assets[evidence.resourceId];
    check(index >= 0 && page && asset && input.pageAssets?.[evidence.pageId]?.image === evidence.resourceId && !seen.has(page.id));
    const content = result.package.payloads[`${page.id}.background`];
    const atlas = content?.atlases?.find(item => item.id === evidence.atlasId);
    check(atlas && atlas.id === `${content.id}.image` && content.atlases.length === 1
      && sha(Buffer.from(atlas.dataBase64, "base64")) === evidence.pixelSha256);
    seen.add(page.id);
    bindings.push({ authorPageId: evidence.pageId, pageId: page.id, resourceId: evidence.resourceId,
      sourceSha256: asset.sha256, atlasId: atlas.id, pixelSha256: evidence.pixelSha256 });
  }
  return bindings;
}

export function verifyBackgroundAtlases(candidate, evidence, entry, content, layer, hash) {
  const atlases = content.atlases ?? [];
  const bindings = (evidence.backgroundBindings ?? []).filter(item => item.pageId === entry.id);
  if (!atlases.length) return layer.atlasIds.length === 0 && bindings.length === 0;
  if (atlases.length !== 1 || bindings.length !== 1) return false;
  const binding = bindings[0], atlas = atlases[0];
  const page = candidate.document.application.pages.find(item => item.id === binding.authorPageId);
  const resource = candidate.manifest.resources.find(item => item.id === binding.resourceId && item.kind === "image");
  return Boolean(page && resource && resource.pageIds?.includes(page.id) && resource.sha256 === binding.sourceSha256
    && page.appearance?.backgroundImageUrl === `/assets/${resource.objectKey}`
    && entry.id === `page.${hash(JSON.stringify([candidate.document.application.metadata.id, page.id, page.id]))}`
    && atlas.id === `${content.id}.image` && atlas.id === binding.atlasId
    && sha(Buffer.from(atlas.dataBase64, "base64")) === binding.pixelSha256
    && layer.atlasIds.length === 1 && layer.atlasIds[0] === `dashboard.${hash([layer.id, atlas.id])}`);
}
