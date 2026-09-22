import { createHash } from "node:crypto";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}

/** Resolve only the resource/data identities already selected by C3. */
export function dashboardFrozenRasterInput(source, configuration) {
  const textRasterScale = configuration.textRasterScale ?? 1;
  if (textRasterScale !== 1 && textRasterScale !== 2) throw new Error("Text raster scale must be 1 or 2");
  const input = structuredClone(source), manifest = input.freezeManifest;
  if (!manifest || manifest.schema !== "deep-engine.dashboard-publication-freeze" || manifest.schemaVersion !== 1)
    throw new Error("Dashboard compiler requires the C3 freeze manifest");
  const { manifestSha256, ...body } = manifest;
  if (hash(canonical(body)) !== manifestSha256 || hash(canonical(input.document)) !== manifest.documentSha256)
    throw new Error("Dashboard compiler freeze manifest/document mismatch");
  if (input.document.application.metadata.id !== manifest.authority.applicationId
    || input.document.application.metadata.projectId !== manifest.authority.projectId
    || input.document.application.metadata.revision !== manifest.authority.applicationRevision
    || input.document.entryPageId !== manifest.entryPageId) throw new Error("Dashboard compiler authority mismatch");
  if (typeof configuration.locale !== "string" || !configuration.locale.trim()
    || typeof configuration.packageVersion !== "string" || !configuration.packageVersion.trim())
    throw new Error("Dashboard compiler locale and package version are required");
  const nodeById = new Map(input.document.application.pages.flatMap(page => page.nodes.map(node => [node.id, node])));
  const nodes = new Set(nodeById.keys());
  const pages = new Map(input.document.application.pages.map(page => [page.id, page]));
  const pageAssets = Object.create(null);
  const assets = Object.create(null), nodeAssets = Object.create(null), data = Object.create(null);
  const resourceIds = new Set(), dataIds = new Set();
  for (const item of manifest.resources) {
    if (resourceIds.has(item.id)) throw new Error("Duplicate frozen resource identity");
    resourceIds.add(item.id);
    const bytes = input.resources[item.id];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== item.bytes || hash(bytes) !== item.sha256)
      throw new Error(`Frozen resource bytes mismatch: ${item.id}`);
    if (!["font", "image", "video"].includes(item.kind) || !item.mime
      || (item.kind === "font" && !item.mime.startsWith("font/"))
      || (item.kind === "image" && !item.mime.startsWith("image/"))
      || (item.kind === "video" && item.mime !== "video/mp4")
      || (item.kind === "font" && (!Number.isSafeInteger(item.faceIndex) || item.faceIndex < 0 || !item.licenseEvidence)))
      throw new Error(`Frozen resource metadata missing: ${item.id}`);
    assets[item.id] = { bytes, sha256: item.sha256, mime: item.mime,
      identity: { id: item.id, revision: item.revision }, ...(item.kind === "font" ? { faceIndex: item.faceIndex } : {}) };
    for (const pageId of item.pageIds ?? []) {
      const page = pages.get(pageId);
      if (item.kind !== "image" || !page || page.appearance?.backgroundImageUrl !== `/assets/${item.objectKey}`)
        throw new Error(`Frozen background does not belong to page: ${pageId}`);
      if (pageAssets[pageId]) throw new Error(`Multiple frozen images for page: ${pageId}`);
      pageAssets[pageId] = { image: item.id };
    }
    for (const nodeId of item.nodeIds) {
      if (!nodes.has(nodeId)) throw new Error(`Unknown resource node: ${nodeId}`);
      const binding = nodeAssets[nodeId] ??= {};
      if (item.kind === "font") (binding.fonts ??= []).push(item.id);
      else if (item.kind === "image") {
        if (nodeById.get(nodeId)?.kind !== "data-widget" || nodeById.get(nodeId)?.widget?.type !== "image")
          throw new Error(`Frozen image does not belong to image node: ${nodeId}`);
        if (binding.image) throw new Error(`Multiple frozen images for node: ${nodeId}`);
        binding.image = item.id;
      } else {
        if (nodeById.get(nodeId)?.kind !== "data-widget" || nodeById.get(nodeId)?.widget?.type !== "video")
          throw new Error(`Frozen video does not belong to video node: ${nodeId}`);
        if (binding.video) throw new Error(`Multiple frozen videos for node: ${nodeId}`);
        binding.video = item.id;
      }
    }
  }
  for (const [nodeId, binding] of Object.entries(nodeAssets)) {
    const declared = configuration.nodeAssets?.[nodeId];
    if (declared?.fonts) {
      if (new Set(declared.fonts).size !== declared.fonts.length || declared.fonts.length !== (binding.fonts?.length ?? 0)
        || declared.fonts.some(id => !binding.fonts.includes(id))) throw new Error(`Font order differs from frozen closure: ${nodeId}`);
      binding.fonts = [...declared.fonts];
    } else if (binding.fonts?.length > 1) throw new Error(`Explicit frozen font order required: ${nodeId}`);
    if (declared?.textStyle) binding.textStyle = structuredClone(declared.textStyle);
  }
  for (const item of manifest.data) {
    if (dataIds.has(item.id) || Object.hasOwn(data, item.nodeId) || !nodes.has(item.nodeId))
      throw new Error("Ambiguous frozen data node binding");
    dataIds.add(item.id);
    const value = input.data[item.id], bytes = canonical(value);
    if (bytes === undefined || Buffer.byteLength(bytes) !== item.bytes || hash(bytes) !== item.sha256)
      throw new Error(`Frozen data bytes mismatch: ${item.id}`);
    data[item.nodeId] = value;
    // Layout font references are node-local; a font belonging to another node is not a fallback.
    for (const box of value?.layout?.textBoxes ?? []) {
      if (!Array.isArray(box.fonts) || box.fonts.some(id => !nodeAssets[item.nodeId]?.fonts?.includes(id)))
        throw new Error(`Frozen data layout references an unbound font: ${item.nodeId}`);
    }
  }
  if (Object.keys(input.resources).some(id => !resourceIds.has(id)) || Object.keys(input.data).some(id => !dataIds.has(id)))
    throw new Error("Compiler received bytes outside the frozen closure");
  return { document: input.document, packageId: `dashboard.${manifest.manifestSha256}`,
    packageVersion: configuration.packageVersion, locale: configuration.locale, textRasterScale, assets, nodeAssets, data,
    ...(Object.keys(pageAssets).length ? { pageAssets } : {}) };
}
