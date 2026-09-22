import { expect, it } from "vitest";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
import { fixture } from "./dashboardDataRaster.testUtils";
import { runtimeContentSha256, validateDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";

it.each([true, false])("compiles bounded atomic KPI variants; baseline reuse=%s", async baselineMatches => {
  const { input, host, data, rasterizeText } = fixture();
  input.document.application.pages[0]!.nodes.push({ id: "filter", kind: "data-widget", zIndex: 1,
    frame: { x: 200, y: 30, width: 160, height: 100 },
    widget: { type: "filter", key: "region", title: "区域", unit: "", options: ["全部", "东"] } });
  (input.nodeAssets as Record<string, unknown>).filter = { fonts: ["font"], textStyle: data.layout.textBoxes[0]!.style };
  const metric = { value: 25, samples: [] };
  const filterData = [{ value: "全部", data: { kpi: data } }, { value: "东", data: { kpi: { ...data, metric,
    source: { ...data.source, contentSha256: runtimeContentSha256(metric) } } } }];
  const initialMetric = { value: 99, samples: [] };
  const initialData = baselineMatches ? input.data! : { kpi: { ...data, metric: initialMetric,
    source: { ...data.source, contentSha256: runtimeContentSha256(initialMetric) } } };
  const result = await compileDashboardRasterContent({ ...input, data: initialData, filterData }, host);
  expect(validateDeepRuntimePackage(result.package).valid).toBe(true);
  const dashboard = result.package.payloads[result.package.entrypoints.dashboard!] as any;
  expect(dashboard.filter.options).toHaveLength(2);
  const [first, second] = dashboard.filter.options;
  expect(first.updates).toEqual([]);
  expect(first.visibility.map((item: any) => item.nodeId)).toEqual(second.visibility.map((item: any) => item.nodeId));
  expect(first.visibility.filter((item: any) => item.visible).length).toBeGreaterThan(0);
  const baselineIds = dashboard.pages.flatMap((page: any) => page.nodes)
    .filter((node: any) => node.visible && first.visibility.some((item: any) => item.nodeId === node.id)).map((node: any) => node.id);
  if (baselineMatches) expect(first.visibility.filter((item: any) => item.visible).map((item: any) => item.nodeId)).toEqual(baselineIds);
  else expect(baselineIds).toEqual([]);
  expect(first.visibility.filter((item: any) => item.visible).map((item: any) => item.nodeId))
    .not.toEqual(second.visibility.filter((item: any) => item.visible).map((item: any) => item.nodeId));
  expect(rasterizeText.mock.calls.map(([request]) => request.text)).toContain("25");
  const atlasIds = result.producerEvidence.map(item => item.atlasId);
  expect(new Set(atlasIds).size).toBe(atlasIds.length);
});
