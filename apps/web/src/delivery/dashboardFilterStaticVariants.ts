import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import { runtimeContentSha256, type DashboardFrozenFilterV1, type DashboardRuntimePageV1,
  type DashboardRuntimeNodeV1, type Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { rasterNode } from "./dashboardRasterNode";
import { RASTER_BYTES_LIMIT } from "./dashboardRasterValidation";
import type { DashboardRasterCompileInput, DashboardRasterHost, DashboardRasterEvidence } from "./dashboardRasterTypes";

export async function compileFilterStaticVariants(input: DashboardRasterCompileInput, host: DashboardRasterHost,
  filter: DashboardFrozenFilterV1, pages: DashboardRuntimePageV1[], deep2d: Deep2dRuntimePackage[],
  bindings: Array<{ nodeId: string; runtimeNodeIds: string[]; runtimePageId: string }>, evidence: DashboardRasterEvidence[]) {
  if (!input.filterData?.length) return filter;
  if (input.filterData.length !== filter.options.length || input.filterData.some((option, i) => option.value !== filter.options[i]?.value))
    throw new Error("Measured filter variants differ from frozen select options");
  const allIds: string[] = [], selectedIds: string[][] = filter.options.map(() => []);
  let atlasBytes = deep2d.reduce((total, content) => total + content.atlases.reduce((sum, atlas) => sum + atlas.width * atlas.height * 4, 0), 0);
  let nodeCount = pages.reduce((sum, page) => sum + page.nodes.length, 0);
  const targetIds = Object.keys(input.filterData[0]!.data).filter(id => !input.tableViews?.some(table => table.nodeId === id)).sort();
  if (input.filterData.some(option => JSON.stringify(Object.keys(option.data).filter(id => !input.tableViews?.some(table => table.nodeId === id)).sort()) !== JSON.stringify(targetIds)))
    throw new Error("Measured filter target set changed");
  for (const targetId of targetIds) {
    const node = input.document.application.pages.flatMap(page => page.nodes).find(node => node.id === targetId) as DashboardDataWidgetNode;
    if (!node || node.kind !== "data-widget" || !["value", "table"].includes(node.widget.type)) throw new Error("Invalid static filter target");
    const binding = bindings.find(binding => binding.nodeId === targetId)!;
    if (!binding) throw new Error("Static filter runtime binding missing");
    const page = pages.find(page => page.id === binding.runtimePageId)!;
    const originalIds = [...binding.runtimeNodeIds];
    const baselineIdentity = runtimeContentSha256(input.data?.[targetId]);
    const baselineUsed = input.filterData.some(option => runtimeContentSha256(option.data[targetId]) === baselineIdentity);
    let insertAt = Math.max(...originalIds.map(id => page.nodes.findIndex(node => node.id === id))) + 1;
    if (baselineUsed) allIds.push(...originalIds);
    else {
      // 冻结初值可能不同于 Web 对“全部”的重新聚合；没有选项引用的初值层不进入运行包。
      const contents = new Set(page.nodes.filter(node => originalIds.includes(node.id)).map(node => node.deep2d));
      const atlases = new Set(deep2d.filter(content => contents.has(content.id)).flatMap(content => content.atlases.map(atlas => atlas.id)));
      atlasBytes -= deep2d.filter(content => contents.has(content.id)).reduce((sum, content) => sum
        + content.atlases.reduce((bytes, atlas) => bytes + atlas.width * atlas.height * 4, 0), 0);
      nodeCount -= originalIds.length; insertAt -= originalIds.length;
      (page.nodes as DashboardRuntimeNodeV1[]).splice(0, page.nodes.length, ...page.nodes.filter(node => !originalIds.includes(node.id)));
      deep2d.splice(0, deep2d.length, ...deep2d.filter(content => !contents.has(content.id)));
      evidence.splice(0, evidence.length, ...evidence.filter(item => !atlases.has(item.atlasId)));
      binding.runtimeNodeIds.splice(0);
    }
    const variants: DashboardRuntimeNodeV1[] = [];
    // 相同冻结内容及实测布局复用已生成层，不为“全部”重复占用节点预算。
    const compiled = new Map<string, string[]>();
    if (baselineUsed) compiled.set(baselineIdentity, originalIds);
    for (const [index, option] of input.filterData.entries()) {
      const identity = runtimeContentSha256(option.data[targetId]);
      const reused = compiled.get(identity);
      if (reused) { selectedIds[index]!.push(...reused); continue; }
      const ids: string[] = [];
      const id = `node.${runtimeContentSha256([targetId, "filter-variant", index])}`;
      const result = await rasterNode(node, `${id}.content`, input.document.application.metadata.revision,
        { ...input, data: { ...input.data, [targetId]: option.data[targetId]! } }, host);
      if (!result.report.contentCompiled) throw new Error(`Filter data view ${targetId} unavailable: ${result.report.reasons.join("; ")}`);
      evidence.push(...result.evidence.map(item => ({ ...item, filterOptionIndex: index })));
      result.layers.forEach((layer, layerIndex) => {
        atlasBytes += layer.content.atlases.reduce((sum, atlas) => sum + atlas.width * atlas.height * 4, 0);
        if (atlasBytes > RASTER_BYTES_LIMIT || ++nodeCount > 128)
          throw new Error(`Frozen filter variants exceed the Dashboard node/atlas budget: ${nodeCount} nodes, ${atlasBytes} bytes at ${targetId}/${index}`);
        const runtimeId = `node.${runtimeContentSha256([id, layerIndex])}`;
        ids.push(runtimeId);
        allIds.push(runtimeId); selectedIds[index]!.push(runtimeId); binding.runtimeNodeIds.push(runtimeId);
        deep2d.push(layer.content);
        variants.push({ id: runtimeId, revision: input.document.application.metadata.revision,
          frame: [node.frame.x, node.frame.y, node.frame.width, node.frame.height], clip: layer.clip,
          zOrder: 0, visible: false, hitId: null, deep2d: layer.content.id, chart: null, chartSim: null });
      });
      compiled.set(identity, ids);
    }
    (page.nodes as DashboardRuntimeNodeV1[]).splice(insertAt, 0, ...variants);
  }
  for (const page of pages) {
    const nodes = page.nodes as DashboardRuntimeNodeV1[];
    nodes.splice(0, nodes.length, ...nodes.map((node, index) => ({ ...node, zOrder: index })));
  }
  return { ...filter, options: filter.options.map((option, index) => ({ ...option,
    visibility: allIds.map(nodeId => ({ nodeId, visible: selectedIds[index]!.includes(nodeId) })) })) };
}
