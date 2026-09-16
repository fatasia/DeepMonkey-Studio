import { buildDeepRuntimePackage } from "./builder.js";
import { runtimeContentSha256 } from "./hash.js";
import type { DeepRuntimePackage, RuntimeJson } from "./types.js";

/**
 * 动态图表独立包:空三维场景 + 版本化 ChartIR(+ 可选离线回放载荷)。
 * 与静态 dashboard 包同构;Native 侧从包重建 ChartRuntime 并驱动既有交互/回放管线。
 */
export function buildChartRuntimePackage(input: {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly chart: { readonly id: string; readonly revision: number; readonly value: unknown };
  readonly chartSim?: { readonly id: string; readonly revision: number; readonly value: unknown };
}): DeepRuntimePackage {
  if (!input.chart) throw new Error("Validated ChartIR is required.");
  const packetId = `chart.scene.${runtimeContentSha256([input.packageId, input.chart.id])}`;
  return buildDeepRuntimePackage({
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    chart: { id: input.chart.id, revision: input.chart.revision, value: input.chart.value as RuntimeJson },
    ...(input.chartSim ? { chartSim: { id: input.chartSim.id, revision: input.chartSim.revision, value: input.chartSim.value as RuntimeJson } } : {}),
    materialBindings: [],
    renderPacket: { id: packetId, revision: input.chart.revision,
      value: { geometries: [], materials: [], instances: [], textures: [] } },
  });
}
