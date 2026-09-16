import type { ChartIR, ChartSeries, ChartDataset, Deep2dColor } from "@bim-studio/deep-engine";
import { arc, circle, envelope, cartesian, numeric, type Rect, type Point } from "./dashboardChartFrameGeometry";
import { heatmap, gauge } from "./dashboardChartFrameExtended";
import { ChartPaths } from "./dashboardChartFramePaths";
// Native renderer colors are linear RGB, not CSS sRGB colors.
const PIE: Deep2dColor[] = [[.33,.44,.78,1],[.57,.8,.46,1],[.98,.78,.35,1],[.93,.4,.4,1],[.45,.75,.87,1],[.23,.64,.45,1]];
export function renderSeries(paths: ChartPaths, ir: ChartIR, series: ChartSeries, dataset: ChartDataset, plot: Rect) {
  if (series.type === "heatmap") { heatmap(paths,ir,series,dataset,plot); return; }
  if (series.type === "gauge") { gauge(paths,series,dataset,plot); return; }
  if (series.type === "pie") { pie(paths, series, dataset, plot); return; }
  const mapped = cartesian(ir, series, dataset, plot); if (!mapped) return;
  const { points, indices, band, baseline } = mapped;
  if (series.type === "line") {
    if (points.length <= 480) paths.stroke(points, [.2,.6,1,1]);
    else paths.fill(envelope(points, Math.max(1, Math.min(256, Math.floor(plot[2])))), [.2,.6,1,1]);
    return;
  }
  points.forEach(([x, y], index) => {
    paths.dataIndex = indices[index];
    if (series.type === "bar") {
      const width = band * .8;
      if (width <= 0 || Math.abs(y - baseline) < 1e-9) return;
      const top = Math.min(y, baseline), bottom = Math.max(y, baseline);
      paths.fill([[x-width*.5,top],[x+width*.5,top],[x+width*.5,bottom],[x-width*.5,bottom]], [.2,.8,.4,1]);
    } else paths.fill(circle([x,y], Math.min(3, plot[2]*.5, plot[3]*.5), 8), [1,.8,.2,1]);
  });
}
function pie(paths: ChartPaths, series: Extract<ChartSeries, {type:"pie"}>, dataset: ChartDataset, [px,py,pw,ph]: Rect) {
  const column = dataset.dimensions.indexOf(series.value ?? ""); if (column < 0) return;
  const values = dataset.rows.flatMap((row, index) => {
    const value = numeric(row[column]); return value !== undefined && value > 0 ? [{ index, value }] : [];
  });
  const total = values.reduce((sum, item) => sum + item.value, 0); if (total <= 0) return;
  const radius = Math.min(Math.max(1, Math.min(pw,ph)*.5-4), pw*.5, ph*.5), center: Point = [px+pw*.5,py+ph*.5];
  let start = -90;
  values.forEach(({index,value}, ordinal) => {
    paths.dataIndex = index;
    const sweep = value / total * 360, color = PIE[ordinal % PIE.length]!;
    paths.fill(sweep >= 360-1e-9 ? circle(center,radius,24)
      : [center, ...arc(center,radius,start,sweep,Math.max(1,Math.ceil(sweep/360*24)))], color);
    start += sweep;
  });
}
