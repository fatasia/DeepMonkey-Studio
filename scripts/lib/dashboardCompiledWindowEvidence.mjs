import { createHash } from "node:crypto";
import { compiledBackgroundBindings } from "./dashboardBackgroundEvidence.mjs";

/** Bind producer receipts to the exact atlas bytes emitted by this compilation. */
export function dashboardCompiledWindowEvidence(result, input, verifyComposition) {
  const payloads = result.package.payloads;
  const dashboard = Object.values(payloads).find(value => value.schema === "deep-engine.dashboard-runtime");
  if (!dashboard) throw new Error("Compiled Dashboard payload is missing");
  const nodeBindings = [], fontBindings = [];
  for (const binding of result.nodeBindings) {
    const page = dashboard.pages.find(value => value.id === binding.runtimePageId);
    for (const runtimeNodeId of binding.runtimeNodeIds) {
      const runtime = page?.nodes.find(value => value.id === runtimeNodeId);
      if (!runtime) throw new Error("Compiled node binding is missing from the runtime package");
      nodeBindings.push({ nodeId: binding.nodeId, runtimeNodeId, pageId: binding.runtimePageId,
        staticResourceId: runtime.deep2d });
      const content = payloads[runtime.deep2d];
      for (const evidence of result.producerEvidence.filter(value => value.nodeId === binding.nodeId)) {
        const atlas = content?.atlases?.find(value => value.id === evidence.atlasId);
        if (!atlas) continue;
        const pixelSha256 = createHash("sha256").update(Buffer.from(atlas.dataBase64, "base64")).digest("hex");
        if (pixelSha256 !== evidence.pixelSha256) throw new Error("Producer evidence does not match compiled atlas bytes");
        if (evidence.composition) {
          if (typeof verifyComposition !== "function") throw new Error("Composed atlas requires trusted pixel replay");
          verifyComposition(evidence, input, atlas);
        }
        for (const face of evidence.usedFaces) {
          if (!evidence.producerEvidence || evidence.producerEvidence.pixelSha256 !== (evidence.composition?.sourcePixelSha256 ?? pixelSha256))
            throw new Error("Font atlas requires a trusted text producer receipt");
          const resources = (input.nodeAssets[binding.nodeId]?.fonts ?? []).filter(id =>
            input.assets[id].sha256 === face.sha256 && input.assets[id].faceIndex === face.faceIndex);
          if (!resources.length) throw new Error("Used font face is absent from the frozen node closure");
          for (const resourceId of resources) fontBindings.push({ resourceId, sha256: face.sha256,
            faceIndex: face.faceIndex, runtimeNodeId, atlasId: atlas.id });
        }
      }
    }
  }
  const backgroundBindings = compiledBackgroundBindings(result, input, dashboard);
  return { nodeBindings, fontBindings, ...(backgroundBindings.length ? { backgroundBindings } : {}) };
}
