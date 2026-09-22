import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import type { Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import type { rasterNode } from "./dashboardRasterNode";
import type { DashboardRasterCompileInput, DashboardRasterHost } from "./dashboardRasterTypes";
import { DASHBOARD_CONTENT_INSET } from "./dashboardShapeContent";

/** Reuses the production frozen-font text raster, without estimating glyph positions. */
export async function rasterFilterOptions(node: DashboardDataWidgetNode, content: Deep2dRuntimePackage,
  input: DashboardRasterCompileInput, host: DashboardRasterHost, raster: typeof rasterNode) {
  const options = node.widget.options ?? [], inset = DASHBOARD_CONTENT_INSET;
  if ((node.widget.filterMode ?? "select") !== "select" || !options.length || options.length > 256
    || node.frame.height - inset * 2 < 32 || node.frame.width <= 58) throw new Error("Unsupported select-v1 filter layout (1–256 options, minimum 59×66)");
  const rowHeight = 32;
  const evidence = [], atlases = [], quads = [];
  for (const [index, option] of options.entries()) {
    const textNode: DashboardDataWidgetNode = { ...node,
      frame: { ...node.frame, x: 0, y: 0, width: node.frame.width - 24, height: rowHeight + inset * 2 },
      widget: { ...node.widget, type: "text", content: option, title: option } };
    let result = await raster(textNode, `${content.id}.option.${index}`, content.revision, input, host);
    if (!result.report.contentCompiled) throw new Error(`Filter text unavailable: ${result.report.reasons.join("; ")}`);
    const fits = (value: typeof result) => value.evidence.every(item => !item.clipped && (item.lines?.length ?? 0) <= 1);
    if (!fits(result)) {
      const page = input.document.application.pages.find(page => page.nodes.some(item => item.id === node.id))!;
      const tipNode = { ...textNode, frame: { ...textNode.frame, width: Math.min(Math.max(node.frame.width, 480), page.width - 8) + inset * 2,
        height: Math.min(512, page.height - 8) + inset * 2 } };
      const tip = await raster(tipNode, `${content.id}.tooltip.${index}`, content.revision, input, host);
      if (!tip.report.contentCompiled || tip.evidence.some(item => item.clipped)) throw new Error(`Filter option ${index} tooltip exceeds supported layout`);
      for (const layer of tip.layers) {
        atlases.push(...layer.content.atlases);
        quads.push(...layer.content.quads.map(quad => {
          const lines = tip.evidence.find(item => item.atlasId === quad.atlasId)?.lines ?? [];
          const top = Math.max(0, Math.floor(Math.min(...lines.map(line => line.top)))),
            bottom = Math.min(quad.source[3], Math.ceil(Math.max(...lines.map(line => line.top + line.height))));
          if (!lines.length || bottom <= top) throw new Error(`Filter option ${index} tooltip lacks measured lines`);
          return { ...quad, zOrder: 1001 + index,
            source: [quad.source[0], quad.source[1] + top, quad.source[2], bottom - top] as const,
            destination: [quad.destination[0], quad.destination[1], quad.destination[2], (bottom - top) * quad.destination[3] / quad.source[3]] as const };
        }));
      }
      evidence.push(...tip.evidence.map(item => ({ ...item, nodeId: node.id })));
      const glyphs = Array.from(new Intl.Segmenter(input.locale, { granularity: "grapheme" }).segment(option), item => item.segment);
      let low = 0, high = glyphs.length - 1, best: typeof result | undefined;
      while (low <= high) {
        const count = Math.floor((low + high) / 2), label = `${glyphs.slice(0, count).join("")}…`;
        const candidate = await raster({ ...textNode, widget: { ...textNode.widget, content: label, title: label } }, `${content.id}.option.${index}`, content.revision, input, host);
        if (candidate.report.contentCompiled && fits(candidate)) { best = candidate; low = count + 1; } else high = count - 1;
      }
      if (!best) throw new Error(`Filter option ${index} cannot fit an ellipsis`);
      result = best;
    }
    // Row padding and clipping are fixed by the existing select lowering contract.
    for (const layer of result.layers) {
      atlases.push(...layer.content.atlases);
      quads.push(...layer.content.quads.map(quad => {
        const width = Math.min(quad.source[2], Math.floor((node.frame.width - inset * 2 - 24) * quad.source[2] / quad.destination[2]));
        const height = Math.min(quad.source[3], Math.floor(rowHeight * quad.source[3] / quad.destination[3]));
        return { ...quad, zOrder: index + 1, source: [quad.source[0], quad.source[1], width, height] as const,
          destination: [quad.destination[0], quad.destination[1], width * quad.destination[2] / quad.source[2], height * quad.destination[3] / quad.source[3]] as const };
      }));
    }
    evidence.push(...result.evidence.map(item => ({ ...item, nodeId: node.id })));
  }
  // 字形池按原选项下标标识；Native 只合成选中项与弹层可见窗口，避免截断选项。
  const displayList = { ...content.displayList, commands: content.displayList.commands.filter(command => !command.hitId?.startsWith(`${node.id}:option:`)) };
  return { content: { ...content, displayList, atlases, quads }, evidence };
}
