import type { SimulationEntityState, Vector3Value } from "@bim-studio/contracts";

export interface SimulationOverlayPath { id: string; points: Array<[number, number, number]>; kind: "flowLink" | "path" }
export interface SimulationOverlayPort {
  replacePaths(paths: readonly SimulationOverlayPath[]): void;
  clear(): void;
}

/** 只派生可解析的世界坐标路径；断链保留在检查器，不渲染伪造的原点连线。 */
export function simulationOverlayPaths(
  entities: readonly SimulationEntityState[],
  resolvePosition: (modelId: string) => Vector3Value | undefined,
): SimulationOverlayPath[] {
  const paths: SimulationOverlayPath[] = [];
  for (const entity of entities) {
    if (entity.kind === "collisionPair" || entity.kind === "flowNode") continue;
    let points: SimulationOverlayPath["points"];
    if (entity.kind === "flowLink") {
      const from = resolvePosition(entity.fromModelId);
      const to = resolvePosition(entity.toModelId);
      if (!from || !to) continue;
      points = [[from.x, from.y, from.z], [to.x, to.y, to.z]];
    } else {
      if (!resolvePosition(entity.targetModelId)) continue;
      points = entity.points.map((point) => [...point]);
      if (entity.loopMode === "loop" && points.length > 1) points.push([...points[0]!]);
    }
    if (points.length < 2 || points.some((point) => point.length !== 3 || point.some((value) => !Number.isFinite(value)))) continue;
    paths.push({ id: entity.id, points, kind: entity.kind });
  }
  return paths;
}
