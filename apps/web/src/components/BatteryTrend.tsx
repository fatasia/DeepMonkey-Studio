import type { BatteryTrendPoint } from "./batteryResultPresentation";
import type { BatteryTask } from "./batteryIntelligenceConfig";

export function BatteryTrend({ task, points, reference = [], thresholdY }: {
  task: BatteryTask;
  points: BatteryTrendPoint[];
  reference?: BatteryTrendPoint[] | undefined;
  thresholdY?: number | undefined;
}) {
  const width = 520;
  const height = 110;
  const padding = 10;
  const xValues = points.map((point) => point.x);
  const yValues = [
    ...points.map((point) => point.y),
    ...reference.map((point) => point.y),
    ...(thresholdY !== undefined ? [thresholdY] : []),
  ];
  const xMin = Math.min(...xValues);
  const xRange = Math.max(Math.max(...xValues) - xMin, 1);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const yPadding = Math.max((yMax - yMin) * 0.12, 0.5);
  const yFloor = yMin - yPadding;
  const yRange = Math.max(yMax + yPadding - yFloor, 1);
  const buildPath = (series: BatteryTrendPoint[]) => series.map((point, index) => {
    const x = padding + (point.x - xMin) / xRange * (width - padding * 2);
    const y = height - padding - (point.y - yFloor) / yRange * (height - padding * 2);
    return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const path = buildPath(points);
  const referencePath = reference.length > 1 ? buildPath(reference) : "";
  const thresholdLine = thresholdY === undefined
    ? undefined
    : height - padding - (thresholdY - yFloor) / yRange * (height - padding * 2);
  const label = task === "soc" ? "SOC 估计轨迹" : "SOH 退化预测轨迹";
  return (
    <figure className="battery-trend">
      <figcaption>
        <span>{label}</span>
        <small>{[
          `${points.length.toLocaleString()} 个模型输出点`,
          ...(referencePath ? ["虚线 参考 SOC"] : []),
          ...(thresholdLine !== undefined ? [`虚线 阈值 ${thresholdY!.toFixed(0)}%`] : []),
        ].join(" · ")}</small>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((ratio) => <line key={ratio} x1={padding} x2={width - padding} y1={height * ratio} y2={height * ratio} />)}
        {thresholdLine !== undefined && <line className="is-threshold" x1={padding} x2={width - padding} y1={thresholdLine} y2={thresholdLine} />}
        <path d={path} />
        {referencePath && <path className="is-reference" d={referencePath} />}
      </svg>
      <div><span>{points[0]!.x.toFixed(0)}</span><b>{yMin.toFixed(1)}–{yMax.toFixed(1)}%</b><span>{points.at(-1)!.x.toFixed(0)}</span></div>
    </figure>
  );
}
