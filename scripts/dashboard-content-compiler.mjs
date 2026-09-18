import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { compileDashboardRasterContent } from "../apps/web/src/delivery/compileDashboardRasterContent.ts";
import { verifyDashboardButtonComposition } from "../apps/web/src/delivery/verifyDashboardButtonComposition.ts";
import { runtimeContentSha256, serializeDeepRuntimePackage } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { createDashboardRasterHost } from "./lib/dashboardRasterHost.mjs";
import { dashboardFrozenRasterInput } from "./lib/dashboardFrozenRasterInput.mjs";
import { dashboardCompiledWindowEvidence } from "./lib/dashboardCompiledWindowEvidence.mjs";
import { createDashboardChromiumLayoutHost } from "./lib/dashboardChromiumLayoutHost.mjs";
import { measureFrozenDashboardCharts } from "./lib/dashboardChartLayout.mjs";
import { measureDashboardFilterVariants } from "./lib/dashboardFilterLayout.mjs";
import { measureDashboardTableViews } from "./lib/dashboardTableLayout.mjs";
import { dataPresentation } from "../apps/web/src/delivery/dashboardDataPresentation.ts";
import { createDashboardTextRasterCache } from "./lib/dashboardTextRasterCache.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Build this module before deployment: its bundle hash identifies the actual lowering code. */
export async function createDashboardContentCompiler({ nativeExecutable, configuration }) {
  const frozenConfiguration = structuredClone({ ...configuration, textRasterScale: configuration.textRasterScale ?? 2 });
  const nativeSha256 = hash(await readFile(nativeExecutable));
  const textCache = createDashboardTextRasterCache(nativeSha256);
  const compilerSha256 = hash(await readFile(new URL(import.meta.url)));
  const layoutHost = frozenConfiguration.layoutCapture
    ? await createDashboardChromiumLayoutHost(frozenConfiguration.layoutCapture, new URL("./", import.meta.url)) : undefined;
  // C4/C5 对同一冻结输入各编译一次并要求逐字节一致;Chromium 表格测量存在会话级微差,
  // 因此测量结果按输入内容寻址缓存:同输入只测量一次,两次编译共享同一份测量产物。
  const measurementCache = new Map();
  return {
    compilerId: "dashboard-frozen-raster", compilerVersion: "1.0.0", compilerSha256,
    get configuration() { return structuredClone({ ...frozenConfiguration, nativeSha256, imageProducer: sharp.versions,
      ...(layoutHost ? { layoutProducer: layoutHost.identity } : {}) }); },
    async compile(source, signal) {
      const started = performance.now();
      const trace = phase => { if (process.env.DASHBOARD_COMPILER_TRACE === "1") console.info(`dashboard phase ${phase} ms=${(performance.now() - started).toFixed(1)}`); };
      signal?.throwIfAborted();
      const input = dashboardFrozenRasterInput(source, frozenConfiguration);
      const frozenSource = { freezeManifest: structuredClone(source.freezeManifest), document: input.document,
        resources: Object.fromEntries(Object.entries(input.assets).map(([id, asset]) => [id, asset.bytes])),
        data: Object.fromEntries(source.freezeManifest.data.map(binding => [binding.id, input.data[binding.nodeId]])) };
      const measureKey = runtimeContentSha256({ document: input.document, data: input.data,
        resources: Object.entries(input.assets).map(([id, asset]) => [id, hash(asset.bytes)]) });
      let measured = measurementCache.get(measureKey);
      if (measured) {
        input.tableViews = measured.tableViews;
        input.data = measured.data;
        input.filterData = measured.filterData;
      } else {
        const measure = async host => {
          await measureFrozenDashboardCharts(frozenSource, input, host, signal);
          trace("charts");
          await measureDashboardFilterVariants(frozenSource, input, host, signal);
          trace("filters");
          input.tableViews = await measureDashboardTableViews(frozenSource, input, host, signal);
          trace("tables");
        };
        if (layoutHost) await layoutHost.withCaptureSession(measure, signal);
        else await measure(undefined);
        measured = { tableViews: input.tableViews, data: input.data, filterData: input.filterData };
        measurementCache.set(measureKey, measured);
        if (measurementCache.size > 4) measurementCache.delete(measurementCache.keys().next().value);
      }
      if (process.env.DASHBOARD_COMPILER_TRACE === "1") for (const node of input.document.application.pages.flatMap(page => page.nodes)) {
        const data = input.data[node.id];
        if (node.kind === "data-widget" && node.widget.type === "table" && data?.layout) console.info("dashboard table roles:", JSON.stringify({
          measured: data.layout.textBoxes.map(box => box.role), expected: [...dataPresentation(node.widget, data, input.locale).values()].map(value => value.role) }));
      }
      if (hash(await readFile(nativeExecutable)) !== nativeSha256) throw new Error("Dashboard text producer changed after deployment");
      signal?.throwIfAborted();
      const result = await compileDashboardRasterContent(input, createDashboardRasterHost({ nativeExecutable, signal, textCache }));
      trace("raster");
      if (process.env.DASHBOARD_COMPILER_TRACE === "1") console.info("dashboard compiler objects:",
        JSON.stringify(result.capabilityReport.objects.map(({ nodeId, contentCompiled, reasons }) => ({ nodeId, contentCompiled, reasons }))));
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
