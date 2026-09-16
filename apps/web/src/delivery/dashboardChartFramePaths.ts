import { DEEP_2D_DISPLAY_LIST_BUDGETS, type Deep2dColor, type Deep2dCommand, type Deep2dPathVerb, type Deep2dResource } from "@bim-studio/deep-engine";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { clamp, type Point, type Rect } from "./dashboardChartFrameGeometry";
export class ChartPaths {
  readonly resources: Deep2dResource[] = [];
  readonly commands: Deep2dCommand[] = [];
  private seriesKey = "";
  private local = 0;
  dataIndex: number | undefined;
  private clip: Rect | undefined;
  private clipPathId: string | undefined;
  constructor(private width: number, private height: number) {}
  series(chartId: string, seriesId: string, clip?: Rect) {
    this.seriesKey = runtimeContentSha256(["chart-series", chartId, seriesId]); this.local = 0; this.dataIndex = undefined; this.clip = clip; this.clipPathId = undefined;
  }
  fill(points: Point[], color: Deep2dColor) { this.emit(points, true, color); }
  stroke(points: Point[], color: Deep2dColor) {
    // Matches Native's 160-point stroke-outline budget and chunk boundaries.
    for (let offset = 0; offset < points.length; offset += 160) this.emit(points.slice(offset, offset + 160), false, color);
  }
  private emit(points: Point[], close: boolean, color: Deep2dColor) {
    const kept: Point[] = [];
    for (const point of points) {
      const [x, y] = this.clip ? point : point.map((value, index) => Number.isNaN(value) ? 0 : clamp(value, 0, index ? this.height : this.width)) as Point;
      const last = kept[kept.length - 1];
      if (!last || Math.abs(last[0] - x) >= 1e-9 || Math.abs(last[1] - y) >= 1e-9) kept.push([x, y]);
    }
    if (close && kept.length > 1 && kept[0]![0] === kept[kept.length - 1]![0] && kept[0]![1] === kept[kept.length - 1]![1]) kept.pop();
    if (kept.length < (close ? 3 : 2)) return;
    if (this.clip && !this.clipPathId) {
      const [x,y,w,h] = this.clip; this.clipPathId = `clip-${this.seriesKey}`;
      this.resources.push({kind:"path",id:this.clipPathId,revision:0,verbs:[{op:"move",x,y},{op:"line",x:x+w,y},
        {op:"line",x:x+w,y:y+h},{op:"line",x,y:y+h},{op:"close"}]});
    }
    if (this.resources.length >= DEEP_2D_DISPLAY_LIST_BUDGETS.resources || this.commands.length >= DEEP_2D_DISPLAY_LIST_BUDGETS.commands)
      throw new Error("Chart frame exceeds Deep2d resource budget");
    const verbs: Deep2dPathVerb[] = kept.map(([x, y], index) => ({ op: index ? "line" : "move", x, y }));
    if (close) verbs.push({ op: "close" });
    const local = this.local++, pathId = `path-${this.seriesKey}-${local}`;
    this.resources.push({ kind: "path", id: pathId, revision: 0, verbs });
    this.commands.push({ kind: "path", id: `cmd-${this.seriesKey}-${local}`, zOrder: this.commands.length,
      transform: [1, 0, 0, 1, 0, 0], pathId, ...(this.clipPathId ? {clipPathIds:[this.clipPathId]} : {}), hitId: `hit-${this.seriesKey}-${this.dataIndex ?? "series"}`,
      ...(close ? { fill: color, fillRule: "nonzero" as const }
        : { stroke: color, strokeWidth: 2, lineCap: "round" as const, lineJoin: "round" as const }) });
  }
}
