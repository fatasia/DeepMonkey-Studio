import { createHash } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const check = (value, reason) => { if (!value) throw new Error(`Dashboard window evidence: ${reason}`); };

/** Binds trusted compiler provenance to draw commands from an exact, successfully presented package. */
export function bindDashboardWindowEvidence(input, runtime, receipt, runtimeContentSha256) {
  const { candidate, windowEvidence } = input;
  check(runtime.schemaVersion === 5, "requires Dashboard v5");
  check(windowEvidence && Array.isArray(windowEvidence.nodeBindings) && Array.isArray(windowEvidence.fontBindings), "missing compiler provenance");
  const report = receipt.report;
  check(receipt.sourceSha256 === sha(input.artifact) && receipt.sourceSha256 === input.targetArtifactHash, "artifact bytes mismatch");
  check(report?.packageHash === runtime.packageHash.value && report.scope === "native-window"
    && report.gpuErrorsClean === true && report.presentedFrames >= receipt.requestedFrames
    && receipt.requestedFrames >= 1 && report.nonce === receipt.nonce, "unverified native present");
  check(report.device && typeof report.device.name === "string" && report.device.name.length > 0
    && typeof report.device.backend === "string" && report.device.backend === report.backend
    && report.deviceFingerprintSha256 === runtimeContentSha256(report.device), "missing or mismatched device identity");
  check(Array.isArray(report.layers), "missing actual draw evidence");
  const dashboard = runtime.payloads[runtime.entrypoints.dashboard];
  const entry = dashboard.pages.find(page => page.id === dashboard.entryPageId);
  const authors = new Set(candidate.document.application.pages.flatMap(page => page.nodes.map(node => node.id)));
  const bindings = new Map();
  for (const binding of windowEvidence.nodeBindings) {
    check(authors.has(binding.nodeId) && !bindings.has(binding.runtimeNodeId), "invalid node binding");
    const page = dashboard.pages.find(page => page.id === binding.pageId);
    const node = page?.nodes.find(node => node.id === binding.runtimeNodeId);
    check(node && (binding.staticResourceId ?? null) === node.deep2d, "node resource binding mismatch");
    bindings.set(binding.runtimeNodeId, binding);
  }
  const drawn = new Map(), rendered = new Set();
  const backgroundId = `node.${runtimeContentSha256([entry.id, "background"])}`;
  for (const layer of report.layers) {
    check(typeof layer.id === "string" && !drawn.has(layer.id) && Number.isSafeInteger(layer.drawCalls)
      && layer.drawCalls > 0 && Number.isSafeInteger(layer.vertices) && layer.vertices > 0
      && Array.isArray(layer.atlasIds) && new Set(layer.atlasIds).size === layer.atlasIds.length, "invalid draw layer");
    const suffix = layer.id.endsWith(":static") ? ":static" : layer.id.endsWith(":chart") ? ":chart" : undefined;
    check(suffix, "unknown draw layer kind");
    const id = layer.id.slice(0, -suffix.length), binding = bindings.get(id);
    const node = entry.nodes.find(node => node.id === id);
    // 系统背景没有作者节点，不应计入作者内容的呈现证据。
    if (!binding && id === backgroundId) {
      check(suffix === ":static" && node?.visible && node.zOrder === 0 && node.clip === null
        && node.chart === null && node.chartSim === null && node.hitId === null
        && JSON.stringify(node.frame) === JSON.stringify([0, 0, entry.width, entry.height])
        && node.deep2d === `${entry.id}.background`
        && runtime.payloads[node.deep2d]?.schema === "deep-engine.deep2d-runtime"
        && layer.atlasIds.length === 0, "invalid system background layer");
      drawn.set(layer.id, layer);
      continue;
    }
    check(binding && binding.pageId === entry.id && node?.visible
      && (suffix === ":static" ? node.deep2d : node.chart), "draw layer is not on the verified entry page");
    drawn.set(layer.id, layer);
    rendered.add(binding.nodeId);
  }
  const fonts = new Map();
  for (const font of windowEvidence.fontBindings) {
    const binding = bindings.get(font.runtimeNodeId);
    const frozen = candidate.manifest.resources.find(resource => resource.id === font.resourceId && resource.kind === "font");
    check(binding && frozen && frozen.sha256 === font.sha256 && frozen.faceIndex === font.faceIndex
      && frozen.nodeIds.includes(binding.nodeId), "font binding is outside the frozen closure");
    const resource = runtime.payloads[binding.staticResourceId];
    // Frozen text is currently rasterized to RGBA image atlases; producer provenance identifies font use.
    check(resource?.atlases?.some(atlas => atlas.id === font.atlasId), "font atlas absent from artifact");
    const layerId = `${font.runtimeNodeId}:static`;
    const namespaced = `dashboard.${runtimeContentSha256([layerId, font.atlasId])}`;
    if (drawn.get(layerId)?.atlasIds.includes(namespaced)) {
      fonts.set(font.resourceId, { resourceId: font.resourceId, sha256: font.sha256, faceIndex: font.faceIndex });
    }
  }
  return { verifier: "native-dashboard-window-v1", authority: structuredClone(candidate.authority),
    freezeManifestSha256: candidate.manifest.manifestSha256, sourceSemanticHash: input.sourceSemanticHash,
    compileGraphHash: input.compileGraphHash, targetArtifactHash: input.targetArtifactHash,
    fixtureSha256: receipt.sourceSha256, deviceFingerprintSha256: report.deviceFingerprintSha256,
    fontSha256: [...fonts.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    renderedNodeIds: [...rendered].sort() };
}
