import { validateDeep2dDisplayList, type Deep2dDisplayList } from "@bim-studio/deep-engine";
import { buildExperimentalXRuntimePackage, runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import type { ChartCommandBatch, ChartRectCommand } from "./zrenderPainterCommandBatch";

type Rect = Omit<ChartRectCommand, "op">;
const MAX_RECTS = 256, MAX_COMMANDS = 512;
const assert = (valid: boolean, message: string): void => { if (!valid) throw new Error(message); };

/** 作者端实验桥：完整快照验证后才推进 delta 游标，不把 ECharts 引入原生 N0。 */
export class ZRenderXDisplayBridge {
  #rects = new Map<string, Rect>();
  #epoch = 0;
  #chartId: string | null = null;

  freeze(batch: ChartCommandBatch): ReturnType<typeof buildExperimentalXRuntimePackage> {
    assert(batch.schemaVersion === 1 && Number.isSafeInteger(batch.epoch) && batch.epoch === this.#epoch + 1,
      "ZRender batch must be the next sequential epoch");
    assert(this.#chartId === null || this.#chartId === batch.chartId, "ZRender chart identity changed");
    assert(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(batch.chartId), "Invalid ZRender chart identity");
    assert(batch.dependencies.echarts === "6.1.0" && batch.dependencies.zrender === "6.1.0", "Uncertified ZRender dependency");
    assert(batch.commands.length <= MAX_COMMANDS, "ZRender command budget exceeded");
    const next = new Map(this.#rects), seen = new Set<string>();
    for (const command of batch.commands) {
      assert(/^bar\.(0|[1-9][0-9]*)$/.test(command.id) && Number(command.id.slice(4)) < MAX_RECTS,
        "Invalid ZRender bar identity");
      assert(!seen.has(command.id), "Duplicate ZRender command identity");
      seen.add(command.id);
      if (command.op === "remove") {
        assert(next.delete(command.id), "Cannot remove an unknown ZRender bar");
      } else {
        assert(command.op === "upsert-rect", "Unsupported ZRender command");
        const { op: _op, ...rect } = command;
        next.set(command.id, structuredClone(rect));
      }
    }
    const snapshot = [...next.values()].sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
    assert(snapshot.length <= MAX_RECTS && snapshot.length === batch.retainedRectCount, "ZRender snapshot count mismatch");
    assert(snapshot.every((rect, index) => rect.id === `bar.${index}`), "ZRender snapshot has missing bars");
    assert(runtimeContentSha256(snapshot) === batch.outputHash, "ZRender complete snapshot hash mismatch");
    const identity = `zrender.${runtimeContentSha256(batch.chartId)}`;
    const display = lower(snapshot, batch, identity);
    const result = buildExperimentalXRuntimePackage({
      packageId: identity, packageVersion: "1.0.0",
      renderPacket: { id: "scene.empty", revision: 1, value: {
        geometries: [], materials: [], instances: [],
      } },
      experimentalX: { id: "x:zrender", revision: batch.epoch, request: {
        schemaVersion: 1, expectedEpoch: batch.epoch, startedAtMs: 0, randomSeed: 0,
        resources: [], events: [], calls: [{ op: "emit-display-list", args: display }],
      } },
    });
    this.#rects = next;
    this.#epoch = batch.epoch;
    this.#chartId = batch.chartId;
    return result;
  }
}

function lower(rects: readonly Rect[], batch: ChartCommandBatch, id: string): Deep2dDisplayList {
  const list: Deep2dDisplayList = {
    schemaVersion: 1, id, revision: batch.epoch, logicalWidth: batch.logicalWidth,
    logicalHeight: batch.logicalHeight, scaleFactor: 1,
    // ECharts 的柱高可为负数；直接保留端点和绕向，不能取绝对值后移动基线。
    resources: rects.map(rect => ({ kind: "path", id: `path.${rect.id}`, revision: batch.epoch, verbs: [
      { op: "move", x: rect.x, y: rect.y }, { op: "line", x: rect.x + rect.width, y: rect.y },
      { op: "line", x: rect.x + rect.width, y: rect.y + rect.height },
      { op: "line", x: rect.x, y: rect.y + rect.height }, { op: "close" },
    ] })),
    commands: rects.map(rect => ({ kind: "path", id: `paint.${rect.id}`, pathId: `path.${rect.id}`,
      transform: [1, 0, 0, 1, 0, 0], zOrder: rect.zOrder, fill: [...rect.fill] })),
  };
  const checked = validateDeep2dDisplayList(list);
  assert(checked.valid, `Invalid ZRender display layer: ${checked.issues[0]?.message ?? "unknown"}`);
  return list;
}
