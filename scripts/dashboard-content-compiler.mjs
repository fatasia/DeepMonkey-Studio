import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { compileDashboardRasterContent } from "../apps/web/src/delivery/compileDashboardRasterContent.ts";
import { verifyDashboardButtonComposition } from "../apps/web/src/delivery/verifyDashboardButtonComposition.ts";
import { serializeDeepRuntimePackage } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { createDashboardRasterHost } from "./lib/dashboardRasterHost.mjs";
import { dashboardFrozenRasterInput } from "./lib/dashboardFrozenRasterInput.mjs";
import { dashboardCompiledWindowEvidence } from "./lib/dashboardCompiledWindowEvidence.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Build this module before deployment: its bundle hash identifies the actual lowering code. */
export async function createDashboardContentCompiler({ nativeExecutable, configuration }) {
  const frozenConfiguration = structuredClone(configuration);
  const nativeSha256 = hash(await readFile(nativeExecutable));
  const compilerSha256 = hash(await readFile(new URL(import.meta.url)));
  return {
    compilerId: "dashboard-frozen-raster", compilerVersion: "1.0.0", compilerSha256,
    get configuration() { return structuredClone({ ...frozenConfiguration, nativeSha256, imageProducer: sharp.versions }); },
    async compile(source, signal) {
      signal?.throwIfAborted();
      const input = dashboardFrozenRasterInput(source, frozenConfiguration);
      if (hash(await readFile(nativeExecutable)) !== nativeSha256) throw new Error("Dashboard text producer changed after deployment");
      signal?.throwIfAborted();
      const result = await compileDashboardRasterContent(input, createDashboardRasterHost({ nativeExecutable, signal }));
      signal?.throwIfAborted();
      if (result.producerEvidence.some(item => item.producerEvidence && item.producerEvidence.executableSha256 !== nativeSha256))
        throw new Error("Rasterized text used a different deployed producer");
      // 页面背景色已编译，其余外观与交互仍按实际缺口报告。
      const pageDeferred = result.deferredPageFields.flatMap(page => page.fields.map(field => `page.${field}`));
      return { artifact: new TextEncoder().encode(serializeDeepRuntimePackage(result.package)),
        windowEvidence: dashboardCompiledWindowEvidence(result, input, verifyDashboardButtonComposition),
        objects: result.capabilityReport.objects.map(object => ({ nodeId: object.nodeId,
          contentCompiled: object.contentCompiled, deferredFields: [...new Set([...object.deferredFields,
            ...pageDeferred, "runtime.interactions", "appearance.crossHost"])] })) };
    },
  };
}
