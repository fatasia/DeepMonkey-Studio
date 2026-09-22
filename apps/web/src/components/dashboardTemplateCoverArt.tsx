import type { ReactNode } from "react";
import type { SceneDashboardWidgetType, WidgetFrame } from "@bim-studio/contracts";

/**
 * 商用封面图形层(纯函数、无状态):按真实插入版式的 frame 渲染"净化图形本体"。
 *
 * 封面对标外部参考模板市场的"成品大屏截图"观感(大屏参考 图表规范 + 外部参考氛围):
 * - 中心主视觉铺满 frame 并带辉光(Halo 双描边 + feGaussianBlur 滤镜,全部从域 accent 派生);
 * - 背景数据纹理(角部光晕括弧 + 地平线辉光 + 稀疏点阵 + 流线)消灭空白感;
 * - 按 layout 视角差异化构图:地图类=区域块+飞线、监控类=仪表簇+状态灯阵、
 *   分析类=大曲线+峰值标注、表格类=斑马纹+迷你条内嵌;
 * - 无坐标轴线、无图例(大屏参考 净化清单);文字一律浅色固定值(深底对比 ≥4.5:1),
 *   语义状态色取 base.css 深色主题令牌的固定值(封面是"深色大屏孤岛",不随主题翻转)。
 * 所有示意数字仅是封面装饰(确定性伪随机,同一模板恒定),不进入插入节点的数据。
 */

export type CoverRandom = () => number;

/** 封面语义状态色(= base.css 深色主题 --success/--warning/--danger 固定值,深色孤岛内恒定)。 */
const COVER_STATUS = { success: "#59c58d", warning: "#d8ac52", danger: "#e27478" } as const;

/** FNV-1a → mulberry32:同一输入恒定同序列,保证全部封面在重渲染间不闪变。 */
export function coverRandom(seed: string): CoverRandom {
  let h = 2166136261;
  for (let index = 0; index < seed.length; index += 1) h = Math.imul(h ^ seed.charCodeAt(index), 16777619);
  let state = h >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 封面共用渐变与辉光滤镜;id 需带模板派生前缀,避免同页多个 SVG 的 defs 冲突。 */
export function CoverDefs({ id }: { id: string }) {
  return <defs>
    {/* 面积填充:强入场渐隐,主视觉的"体块感"来源 */}
    <linearGradient id={`cover-area-${id}`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="var(--template-accent)" stopOpacity=".58" />
      <stop offset="55%" stopColor="var(--template-accent)" stopOpacity=".16" />
      <stop offset="100%" stopColor="var(--template-accent)" stopOpacity="0" />
    </linearGradient>
    {/* 柱体:亮顶深底 */}
    <linearGradient id={`cover-bar-${id}`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="var(--template-accent)" />
      <stop offset="100%" stopColor="var(--template-accent)" stopOpacity=".2" />
    </linearGradient>
    {/* 地平线/描边渐隐 */}
    <linearGradient id={`cover-line-${id}`} x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stopColor="var(--template-accent)" stopOpacity=".55" />
      <stop offset="100%" stopColor="var(--template-accent)" stopOpacity="0" />
    </linearGradient>
    <linearGradient id={`cover-rise-${id}`} x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stopColor="var(--template-accent)" stopOpacity=".2" />
      <stop offset="100%" stopColor="var(--template-accent)" stopOpacity="0" />
    </linearGradient>
    {/* 顶部高光带:成品面板的玻璃质感 */}
    <linearGradient id={`cover-sheen-${id}`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="#ffffff" stopOpacity=".13" />
      <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
    </linearGradient>
    {/* 热点光斑:飞线端点/图心 */}
    <radialGradient id={`cover-hot-${id}`}>
      <stop offset="0%" stopColor="var(--template-accent)" stopOpacity=".9" />
      <stop offset="45%" stopColor="var(--template-accent)" stopOpacity=".34" />
      <stop offset="100%" stopColor="var(--template-accent)" stopOpacity="0" />
    </radialGradient>
    {/* 流向带:左亮右暗的横向渐隐(桑基/飞线语言的"流动感") */}
    <linearGradient id={`cover-flow-${id}`} x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stopColor="var(--template-accent)" stopOpacity=".6" />
      <stop offset="100%" stopColor="var(--template-accent)" stopOpacity=".14" />
    </linearGradient>
    {/* 辉光滤镜:halo 只留模糊(垫在锐利图形下),glow 用 feMerge 保留原图(文字/单元素发光) */}
    <filter id={`cover-halo-${id}`} x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="7" />
    </filter>
    <filter id={`cover-glow-${id}`} x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="3.2" result="b" />
      <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  </defs>;
}

/** Catmull-Rom 转贝塞尔的平滑曲线。 */
function smoothPath(points: readonly (readonly [number, number])[]): string {
  if (points.length < 2) return "";
  const head = points[0]!;
  const parts = [`M ${head[0].toFixed(1)} ${head[1].toFixed(1)}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)]!, p1 = points[index]!, p2 = points[index + 1]!, p3 = points[Math.min(points.length - 1, index + 2)]!;
    parts.push(`C ${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)}, ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`);
  }
  return parts.join(" ");
}

function ringSlice(cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number): string {
  const point = (radius: number, angle: number): string => `${(cx + radius * Math.cos(angle)).toFixed(1)} ${(cy + radius * Math.sin(angle)).toFixed(1)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${point(rOuter, a0)} A ${rOuter} ${rOuter} 0 ${large} 1 ${point(rOuter, a1)} L ${point(rInner, a1)} A ${rInner} ${rInner} 0 ${large} 0 ${point(rInner, a0)} Z`;
}

function arcStroke(cx: number, cy: number, radius: number, a0: number, a1: number): string {
  const point = (angle: number): string => `${(cx + radius * Math.cos(angle)).toFixed(1)} ${(cy + radius * Math.sin(angle)).toFixed(1)}`;
  return `M ${point(a0)} A ${radius} ${radius} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${point(a1)}`;
}

/** 数值角标:实心 accent 胶囊 + 深色数值(分析类封面的峰值/离群标注)。 */
function valueTag(x: number, y: number, label: string, key: string, defsId: string): ReactNode {
  const width = label.length * 13 + 26;
  return <g key={key}>
    <path d={`M ${x + 14} ${y + 34} l 6 9 l 6 -9 Z`} fill="var(--template-accent)" opacity=".9" />
    <rect x={x} y={y} width={width} height={34} rx={9} fill="var(--template-accent)" filter={`url(#cover-glow-${defsId})`} />
    <text x={x + width / 2} y={y + 23.5} fontSize={19} fontWeight={700} textAnchor="middle" fill="#07131a">{label}</text>
  </g>;
}

/** 语义状态灯(静态呼吸模拟:核心点 + 扩散环)。 */
function statusLight(cx: number, cy: number, color: string, key: string, defsId: string, pulse = false): ReactNode {
  return <g key={key}>
    {pulse && <circle cx={cx} cy={cy} r={11} fill="none" stroke={color} strokeWidth={2} opacity=".38" />}
    {pulse && <circle cx={cx} cy={cy} r={19} fill="none" stroke={color} strokeWidth={1.4} opacity=".16" />}
    <circle cx={cx} cy={cy} r={5} fill={color} filter={`url(#cover-glow-${defsId})`} />
  </g>;
}

function trendPoints(frame: WidgetFrame, rand: CoverRandom, count: number): [number, number][] {
  const x0 = frame.x + frame.width * 0.05, x1 = frame.x + frame.width * 0.97;
  const yBase = frame.y + frame.height * 0.88, yTop = frame.y + frame.height * 0.12;
  let level = 0.42;
  return Array.from({ length: count }, (_, index) => {
    level = Math.min(0.96, Math.max(0.1, level + (rand() - 0.46) * 0.36));
    const ease = index > count - 3 ? 1.06 : 1;
    return [x0 + (x1 - x0) * (index / (count - 1)), yBase - (yBase - yTop) * Math.min(0.98, level * ease)] as [number, number];
  });
}

/**
 * 整页氛围层(CoverScene):角部光晕括弧 + 地平线辉光 + 稀疏点阵 + 流线,把
 * 版式间隙与页边变成"数据空气",对标外部参考的场景氛围(雾/渐隐网格/辉光)。
 */
export function CoverScene({ id, width, height, seed }: { id: string; width: number; height: number; seed: string }) {
  const rand = coverRandom(seed);
  const accent = "var(--template-accent)";
  const inset = 16, arm = 52;
  const corner = (x: number, y: number, sx: number, sy: number, key: string): ReactNode => {
    const d = `M ${x + sx * arm} ${y} L ${x} ${y} L ${x} ${y + sy * arm}`;
    return <g key={key}>
      <path d={d} fill="none" stroke={accent} strokeWidth={9} strokeLinecap="round" opacity=".2" filter={`url(#cover-halo-${id})`} />
      <path d={d} fill="none" stroke={accent} strokeWidth={5} strokeLinecap="round" opacity=".75" />
    </g>;
  };
  const dots: ReactNode[] = [];
  const cols = 14, rows = 6;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (rand() < 0.4) continue;
      dots.push(<circle key={`d${row}-${col}`} cx={width * (0.06 + (col / (cols - 1)) * 0.88)} cy={height * (0.1 + (row / (rows - 1)) * 0.8)} r={2.6} fill={accent} opacity={0.1 + rand() * 0.16} />);
    }
  }
  const flow = (yRatio: number, bend: number, key: string): ReactNode => {
    const y = height * yRatio;
    return <path key={key} d={`M ${width * 0.02} ${y} C ${width * 0.3} ${y - height * bend}, ${width * 0.62} ${y + height * bend}, ${width * 0.98} ${y - height * bend * 0.4}`} fill="none" stroke={accent} strokeWidth={2.6} strokeDasharray="3 13" opacity=".2" strokeLinecap="round" />;
  };
  return <g aria-hidden="true">
    {/* 顶部极光带:外部参考头图语言的"场景辉光",横贯页顶再渐隐 */}
    <path d={`M ${-width * 0.05} ${height * 0.16} C ${width * 0.25} ${height * 0.02}, ${width * 0.6} ${height * 0.2}, ${width * 1.05} ${height * 0.06} L ${width * 1.05} ${-height * 0.1} L ${-width * 0.05} ${-height * 0.1} Z`}
      fill={accent} opacity=".2" filter={`url(#cover-halo-${id})`} />
    <path d={`M ${-width * 0.05} ${height * 0.15} C ${width * 0.25} ${height * 0.03}, ${width * 0.6} ${height * 0.19}, ${width * 1.05} ${height * 0.07}`}
      fill="none" stroke={accent} strokeWidth={3.4} strokeDasharray="2 12" opacity=".38" strokeLinecap="round" />
    {/* 双角氛围光斑(halo 模糊)+ 底部两侧贴边副光斑,压住"空白感" */}
    <ellipse cx={width * 0.2} cy={height * 0.1} rx={width * 0.26} ry={height * 0.2} fill={accent} opacity=".16" filter={`url(#cover-halo-${id})`} />
    <ellipse cx={width * 0.84} cy={height * 0.9} rx={width * 0.22} ry={height * 0.2} fill={accent} opacity=".13" filter={`url(#cover-halo-${id})`} />
    <ellipse cx={width * 0.06} cy={height * 0.97} rx={width * 0.1} ry={height * 0.08} fill={accent} opacity=".15" filter={`url(#cover-halo-${id})`} />
    {/* 地平线辉光 */}
    <rect x={0} y={height * 0.78} width={width} height={height * 0.22} fill={`url(#cover-rise-${id})`} opacity=".9" />
    {dots}
    {flow(0.3, 0.06, "f0")}
    {flow(0.7, -0.05, "f1")}
    {/* 四角括弧(成品大屏的取景语言)+ 底部数据刻度线 */}
    {corner(inset, inset, 1, 1, "c0")}
    {corner(width - inset, inset, -1, 1, "c1")}
    {corner(inset, height - inset, 1, -1, "c2")}
    {corner(width - inset, height - inset, -1, -1, "c3")}
    <rect x={width * 0.5 - 110} y={height - 10} width={220} height={3} rx={1.5} fill={`url(#cover-line-${id})`} opacity=".6" />
  </g>;
}

/** 中心主视觉与环绕次级块:全部按 frame 相对几何绘制,天然适配横屏/竖屏画布。 */
function coverChart(type: SceneDashboardWidgetType, frame: WidgetFrame, rand: CoverRandom, defsId: string, hero: boolean): ReactNode {
  const pad = Math.max(8, frame.height * 0.06);
  const innerX = frame.x + pad, innerY = frame.y + pad;
  const innerW = frame.width - pad * 2, innerH = frame.height - pad * 2;
  const clipId = `clip-${defsId}-${type}-${Math.round(frame.x)}-${Math.round(frame.y)}`;
  const accent = "var(--template-accent)";
  switch (type) {
    case "line":
    case "area":
    case "combo": {
      const points = trendPoints({ ...frame, x: frame.x + pad * 0.5, width: frame.width - pad, y: frame.y + pad * 0.5, height: frame.height - pad }, rand, 9);
      const linePath = smoothPath(points);
      const baseY = frame.y + frame.height * 0.9;
      const areaPath = `${linePath} L ${points.at(-1)![0].toFixed(1)} ${baseY.toFixed(1)} L ${points[0]![0].toFixed(1)} ${baseY.toFixed(1)} Z`;
      const peak = points.reduce((top, point) => (point[1] < top[1] ? point : top), points[0]!);
      const peakValue = Math.round(860 + rand() * 4200).toLocaleString("en-US");
      const bars = type === "combo" ? points.map(([x, y], index) => {
        const width = Math.min(26, innerW / 14);
        return <g key={index}>
          <rect x={x - width / 2} y={y + 16} width={width} height={Math.max(6, baseY - y - 16)} rx={3} fill={`url(#cover-bar-${defsId})`} opacity=".55" />
          <rect x={x - width / 2} y={y + 16} width={width} height={4} rx={2} fill="#ffffff" opacity=".55" />
        </g>;
      }) : null;
      return <g>
        <clipPath id={clipId}><rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx={10} /></clipPath>
        <g clipPath={`url(#${clipId})`}>
          {type !== "line" && <path d={areaPath} fill={`url(#cover-area-${defsId})`} />}
          {bars}
          {/* 辉光三连:halo 垫层 → 主线 → 内芯高光 */}
          <path d={linePath} fill="none" stroke={accent} strokeWidth={14} strokeLinecap="round" opacity={hero ? ".24" : ".15"} filter={`url(#cover-halo-${defsId})`} />
          <path d={linePath} fill="none" stroke={accent} strokeWidth={hero ? 7 : 5} strokeLinecap="round" />
          <path d={linePath} fill="none" stroke="#ffffff" strokeWidth={1.8} strokeLinecap="round" opacity=".36" />
          {/* 峰值标注:分析类封面的记忆点 */}
          {hero && valueTag(Math.min(frame.x + frame.width - 150, Math.max(frame.x + 12, peak[0] - 60)), Math.max(frame.y + 10, peak[1] - 66), `峰值 ${peakValue}`, "peak", defsId)}
          {points.map(([x, y], index) => <g key={index}>
            <circle cx={x} cy={y} r={8.5} fill={accent} opacity=".22" />
            <circle cx={x} cy={y} r={4.2} fill="#eef6f7" />
          </g>)}
          <rect x={frame.x + 10} y={baseY} width={frame.width - 20} height={2.4} rx={1.2} fill={`url(#cover-line-${defsId})`} opacity=".6" />
        </g>
      </g>;
    }
    case "bar": {
      const count = 8, slot = innerW / count;
      const heights = Array.from({ length: count }, () => 0.24 + rand() * 0.74);
      const heroIndex = heights.indexOf(Math.max(...heights));
      return <g>
        {heights.map((level, index) => {
          const x = innerX + index * slot + slot * 0.2, width = slot * 0.6;
          const height = innerH * level, y = innerY + innerH - height;
          const isHero = index === heroIndex;
          return <g key={index}>
            {isHero && <rect x={x - 3} y={y - 6} width={width + 6} height={height + 10} rx={6} fill={accent} opacity=".3" filter={`url(#cover-halo-${defsId})`} />}
            <rect x={x} y={y} width={width} height={height} rx={4} fill={`url(#cover-bar-${defsId})`} opacity={isHero ? 1 : 0.74} />
            <rect x={x} y={y} width={width} height={5} rx={2.5} fill="#ffffff" opacity={isHero ? ".85" : ".4"} />
            {(isHero || index === 0) && <text x={x + width / 2} y={y - 12} fontSize={20} fontWeight={700} textAnchor="middle" fill="#eef6f7" className="cover-num">{Math.round(180 + level * 3600).toLocaleString("en-US")}</text>}
          </g>;
        })}
        <rect x={innerX} y={innerY + innerH + 6} width={innerW} height={2.4} rx={1.2} fill={`url(#cover-line-${defsId})`} opacity=".55" />
      </g>;
    }
    case "scatter": {
      const spots = Array.from({ length: 26 }, () => ({ dx: rand(), dy: 0.15 + rand() * 0.8, r: 5 + rand() * 9 }));
      const heroDot = spots.reduce((top, spot) => (spot.r > top.r ? spot : top), spots[0]!);
      const hx = innerX + heroDot.dx * (innerW - 24) + 8, hy = innerY + heroDot.dy * (innerH - 24) + 8;
      return <g>
        <clipPath id={clipId}><rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx={10} /></clipPath>
        <g clipPath={`url(#${clipId})`}>
          {/* 象限参考虚线(分析语言,弱化不抢戏) */}
          <rect x={innerX + innerW / 2} y={innerY} width={1.6} height={innerH} fill={accent} opacity=".1" />
          <rect x={innerX} y={innerY + innerH / 2} width={innerW} height={1.6} fill={accent} opacity=".1" />
          {spots.map((spot, index) => {
            const cx = innerX + 8 + spot.dx * (innerW - 24), cy = innerY + 8 + spot.dy * (innerH - 24);
            return <g key={index}>
              <circle cx={cx} cy={cy} r={spot.r * 1.7} fill={`url(#cover-hot-${defsId})`} opacity=".5" />
              <circle cx={cx} cy={cy} r={spot.r * 0.55} fill={accent} opacity={0.5 + spot.r / 28} />
            </g>;
          })}
          {/* 离群点标注:密度云的记忆点 */}
          {hero && <g>
            <circle cx={hx} cy={hy} r={18} fill="none" stroke={accent} strokeWidth={2.4} opacity=".8" />
            {valueTag(Math.min(frame.x + frame.width - 140, hx + 24), Math.max(frame.y + 8, hy - 52), "离群 3.2σ", "outlier", defsId)}
          </g>}
        </g>
      </g>;
    }
    case "pie": {
      const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
      const radius = Math.min(innerW, innerH) / 2;
      const shares = [0.42, 0.24, 0.16, 0.1, 0.08];
      let angle = -Math.PI / 2;
      const slices = shares.map((share, index) => {
        const sweep = share * Math.PI * 1.72;
        const isHero = index === 0;
        const explode = isHero ? 10 : 0;
        const ex = cx + Math.cos(angle + sweep / 2) * explode, ey = cy + Math.sin(angle + sweep / 2) * explode;
        const path = ringSlice(ex, ey, radius, radius * 0.56, angle + 0.03, angle + sweep - 0.03);
        angle += sweep;
        return <path key={index} d={path} fill={accent} opacity={0.95 - index * 0.18} filter={isHero ? `url(#cover-halo-${defsId})` : undefined} />;
      });
      return <g>
        {slices}
        <circle cx={cx} cy={cy} r={radius * 0.34} fill="var(--template-surface)" opacity=".92" />
        <text x={cx} y={cy + radius * 0.1} fontSize={radius * 0.3} fontWeight={720} textAnchor="middle" fill="#f4f8f9" className="cover-num" filter={`url(#cover-glow-${defsId})`}>{Math.round(52 + rand() * 40)}%</text>
      </g>;
    }
    case "sunburst": {
      const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
      const radius = Math.min(innerW, innerH) / 2;
      let angle = -Math.PI / 2;
      const inner = [0.34, 0.3, 0.22, 0.14].map((share, index) => {
        const sweep = share * Math.PI * 1.9;
        const path = ringSlice(cx, cy, radius * 0.64, radius * 0.32, angle + 0.03, angle + sweep - 0.03);
        angle += sweep;
        return <path key={`i${index}`} d={path} fill={accent} opacity={0.85 - index * 0.16} />;
      });
      angle = -Math.PI / 2;
      const outer = [0.2, 0.16, 0.14, 0.12, 0.1, 0.09, 0.1, 0.09].map((share, index) => {
        const sweep = share * Math.PI * 1.9;
        const path = ringSlice(cx, cy, radius, radius * 0.7, angle + 0.04, angle + sweep - 0.04);
        angle += sweep;
        return <path key={`o${index}`} d={path} fill={accent} opacity={index === 0 ? 0.62 : 0.46 - index * 0.045} />;
      });
      return <g>
        {outer}
        <path d={ringSlice(cx, cy, radius * 1.02, radius * 0.98, -Math.PI / 2, -Math.PI / 2 + Math.PI * 0.44)} fill={accent} opacity=".5" filter={`url(#cover-halo-${defsId})`} />
        {inner}
        <text x={cx} y={cy + radius * 0.09} fontSize={radius * 0.2} fontWeight={720} textAnchor="middle" fill="#f4f8f9" className="cover-num">{Math.round(60 + rand() * 36)}%</text>
      </g>;
    }
    case "gauge": {
      // 监控类"仪表簇":主表 + 双联副表 + 状态灯排,填满次级 frame。
      const cx = frame.x + frame.width / 2, cy = frame.y + frame.height * 0.36;
      const radius = Math.min(frame.width / 3.4, frame.height * 0.3);
      const a0 = Math.PI * 0.78, sweep = Math.PI * 1.44;
      const valueSweep = sweep * (0.52 + rand() * 0.4);
      const ticks = Array.from({ length: 9 }, (_, index) => {
        const angle = a0 + (sweep * index) / 8;
        const p1x = cx + Math.cos(angle) * radius * 1.12, p1y = cy + Math.sin(angle) * radius * 1.12;
        const p2x = cx + Math.cos(angle) * radius * 1.22, p2y = cy + Math.sin(angle) * radius * 1.22;
        return <path key={index} d={`M ${p1x.toFixed(1)} ${p1y.toFixed(1)} L ${p2x.toFixed(1)} ${p2y.toFixed(1)}`} stroke={accent} strokeWidth={3} opacity=".4" strokeLinecap="round" />;
      });
      const mini = (mx: number, my: number, level: number, key: string): ReactNode => {
        const r = radius * 0.5;
        return <g key={key}>
          <path d={arcStroke(mx, my, r, a0, a0 + sweep)} fill="none" stroke={accent} opacity=".2" strokeWidth={Math.max(6, r * 0.22)} strokeLinecap="round" />
          <path d={arcStroke(mx, my, r, a0, a0 + sweep * level)} fill="none" stroke={accent} strokeWidth={Math.max(6, r * 0.22)} strokeLinecap="round" opacity=".95" filter={`url(#cover-glow-${defsId})`} />
          <text x={mx} y={my + r * 0.55} fontSize={r * 0.5} fontWeight={700} textAnchor="middle" fill="#eef6f7" className="cover-num">{Math.round(40 + level * 55)}%</text>
        </g>;
      };
      return <g>
        <path d={arcStroke(cx, cy, radius, a0, a0 + sweep)} fill="none" stroke={accent} opacity=".15" strokeWidth={Math.max(9, radius * 0.17)} strokeLinecap="round" />
        <path d={arcStroke(cx, cy, radius, a0, a0 + valueSweep)} fill="none" stroke={accent} strokeWidth={Math.max(9, radius * 0.17)} strokeLinecap="round" filter={`url(#cover-glow-${defsId})`} />
        {ticks}
        <text x={cx} y={cy + radius * 0.42} fontSize={radius * 0.42} fontWeight={720} textAnchor="middle" fill="#f4f8f9" className="cover-num" filter={`url(#cover-glow-${defsId})`}>{Math.round(52 + rand() * 44)}%</text>
        {mini(frame.x + frame.width * 0.28, frame.y + frame.height * 0.78, 0.4 + rand() * 0.5, "m0")}
        {mini(frame.x + frame.width * 0.72, frame.y + frame.height * 0.78, 0.4 + rand() * 0.5, "m1")}
        {[0, 1, 2, 3, 4].map(index => statusLight(
          frame.x + frame.width * (0.34 + index * 0.08), frame.y + frame.height * 0.955,
          index === 3 ? COVER_STATUS.warning : COVER_STATUS.success, `s${index}`, defsId, index === 3,
        ))}
      </g>;
    }
    case "radar": {
      const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
      const radius = Math.min(innerW, innerH) / 2;
      const vertex = (level: number, index: number): [number, number] => [cx + radius * level * Math.cos(-Math.PI / 2 + index * Math.PI / 3), cy + radius * level * Math.sin(-Math.PI / 2 + index * Math.PI / 3)];
      const grid = [1, 0.66, 0.33].map((level, index) => <polygon key={`g${index}`} points={Array.from({ length: 6 }, (_, i) => vertex(level, i).map(v => v.toFixed(1)).join(",")).join(" ")} fill="none" stroke={accent} opacity=".14" />);
      const values = Array.from({ length: 6 }, () => 0.36 + rand() * 0.6);
      const heroVertex = vertex(values[0]!, 0);
      return <g>
        {grid}
        <polygon points={values.map((level, index) => vertex(level, index).map(v => v.toFixed(1)).join(",")).join(" ")} fill={accent} opacity=".34" stroke={accent} strokeWidth={3.4} />
        <polygon points={values.map((level, index) => vertex(level, index).map(v => v.toFixed(1)).join(",")).join(" ")} fill="none" stroke="#ffffff" strokeWidth={1.2} opacity=".3" />
        {values.map((level, index) => {
          const [x, y] = vertex(level, index);
          return <circle key={index} cx={x} cy={y} r={4.6} fill="#eef6f7" stroke={accent} strokeWidth={2} />;
        })}
        <circle cx={heroVertex[0]} cy={heroVertex[1]} r={11} fill="none" stroke={accent} strokeWidth={2} opacity=".7" />
      </g>;
    }
    case "sankey": {
      const leftX = innerX + 4, rightX = frame.x + frame.width - pad - 4;
      const band = (ly: number, lh: number, ry: number, rh: number, key: string, glow = false): ReactNode => {
        const midX = (leftX + rightX) / 2;
        return <g key={key}>
          {glow && <path d={`M ${leftX} ${ly} C ${midX} ${ly}, ${midX} ${ry}, ${rightX} ${ry} L ${rightX} ${ry + rh} C ${midX} ${ry + rh}, ${midX} ${ly + lh}, ${leftX} ${ly + lh} Z`} fill={accent} opacity=".3" filter={`url(#cover-halo-${defsId})`} />}
          <path d={`M ${leftX} ${ly} C ${midX} ${ly}, ${midX} ${ry}, ${rightX} ${ry} L ${rightX} ${ry + rh} C ${midX} ${ry + rh}, ${midX} ${ly + lh}, ${leftX} ${ly + lh} Z`} fill={`url(#cover-flow-${defsId})`} />
          <path d={`M ${leftX} ${ly} C ${midX} ${ly}, ${midX} ${ry}, ${rightX} ${ry}`} fill="none" stroke="#ffffff" strokeWidth={1.4} opacity=".3" />
        </g>;
      };
      const particles = (ly: number, lh: number, ry: number, rh: number, keyBase: string): ReactNode => Array.from({ length: 3 }, (_, index) => {
        const t = 0.24 + index * 0.26;
        const x = leftX + (rightX - leftX) * t;
        const yTop2 = ly + (ry - ly) * t + lh * 0.5;
        return <g key={`${keyBase}p${index}`}>
          <circle cx={x} cy={yTop2} r={7} fill={`url(#cover-hot-${defsId})`} opacity=".8" />
          <circle cx={x} cy={yTop2} r={3.6} fill="#eef6f7" opacity=".9" />
        </g>;
      });
      return <g>
        {band(innerY + innerH * 0.06, innerH * 0.2, innerY + innerH * 0.02, innerH * 0.3, "b0", true)}
        {band(innerY + innerH * 0.44, innerH * 0.15, innerY + innerH * 0.44, innerH * 0.21, "b1")}
        {band(innerY + innerH * 0.74, innerH * 0.17, innerY + innerH * 0.75, innerH * 0.19, "b2")}
        {particles(innerY + innerH * 0.06, innerH * 0.2, innerY + innerH * 0.02, innerH * 0.3, "a")}
        {particles(innerY + innerH * 0.44, innerH * 0.15, innerY + innerH * 0.44, innerH * 0.21, "b")}
        {[0, 1, 2].map(index => <rect key={`l${index}`} x={leftX - 4} y={innerY + innerH * (0.06 + index * 0.34)} width={5} height={innerH * (0.2 - index * 0.02)} rx={2.5} fill={accent} opacity={0.9 - index * 0.22} />)}
        {[0, 1, 2].map(index => <rect key={`r${index}`} x={rightX - 1} y={innerY + innerH * (0.02 + index * 0.34)} width={5} height={innerH * (0.3 - index * 0.05)} rx={2.5} fill={accent} opacity={0.75 - index * 0.18} />)}
      </g>;
    }
    case "treemap": {
      const blocks: [number, number, number, number, number][] = [
        [0, 0, 0.46, 1, 0.8], [0.48, 0, 0.52, 0.52, 0.5], [0.48, 0.54, 0.3, 0.46, 0.34], [0.8, 0.54, 0.2, 0.22, 0.26], [0.8, 0.78, 0.2, 0.22, 0.2],
      ];
      return <g>
        {blocks.map(([bx, by, bw, bh, opacity], index) => {
          const x = innerX + innerW * bx, y = innerY + innerH * by;
          const w = innerW * bw - 5, h = innerH * bh - 5;
          const isHero = index === 0;
          return <g key={index}>
            {isHero && <rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={8} fill={accent} opacity=".35" filter={`url(#cover-halo-${defsId})`} />}
            <rect x={x} y={y} width={w} height={h} rx={6} fill={`url(#cover-bar-${defsId})`} opacity={opacity} />
            <rect x={x} y={y} width={w} height={5} rx={2.5} fill="#ffffff" opacity=".34" />
            {isHero && <text x={x + 14} y={y + 34} fontSize={Math.min(26, w * 0.2)} fontWeight={720} fill="#f4f8f9" className="cover-num">{Math.round(32 + rand() * 40)}%</text>}
          </g>;
        })}
      </g>;
    }
    case "map": {
      // 地图类封面:抽象区域块 + 枢纽热点 + 飞线(预制体参考 飞线语言,静态分镜)。
      // 区域多边形横纵半径分轴计算,避免把宽度单位半径塞进高度分数造成"压扁叶片"。
      const regions = Array.from({ length: 5 }, (_, index) => {
        const cxr = 0.16 + rand() * 0.68, cyr = 0.2 + rand() * 0.6;
        const rx = innerW * (0.09 + rand() * 0.1), ry = innerH * (0.16 + rand() * 0.16);
        const points = Array.from({ length: 7 }, (_, vertexIndex) => {
          const angle = (vertexIndex / 7) * Math.PI * 2;
          return `${(innerX + innerW * cxr + Math.cos(angle) * rx * (0.7 + rand() * 0.6)).toFixed(1)},${(innerY + innerH * cyr + Math.sin(angle) * ry * (0.7 + rand() * 0.6)).toFixed(1)}`;
        }).join(" ");
        return <polygon key={index} points={points} fill={accent} opacity={0.12 + rand() * 0.12} stroke={accent} strokeWidth={2.2} strokeOpacity=".45" />;
      });
      const spots = Array.from({ length: 8 }, (_, index) => ({ dx: 0.08 + rand() * 0.84, dy: 0.14 + rand() * 0.7, r: 6 + rand() * 8, o: 0.4 + rand() * 0.5 }));
      const center = spots[0]!;
      const px = (spot: { dx: number; dy: number }): [number, number] => [innerX + innerW * spot.dx, innerY + innerH * spot.dy];
      const [cx0, cy0] = px(center);
      return <g>
        <clipPath id={clipId}><rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx={10} /></clipPath>
        <g clipPath={`url(#${clipId})`}>
          {/* 底纹点阵:地图的"数据土地" */}
          {Array.from({ length: 40 }, (_, index) => <circle key={index} cx={innerX + (index % 10) * (innerW / 9)} cy={innerY + Math.floor(index / 10) * (innerH / 3.4)} r={2.2} fill={accent} opacity=".18" />)}
          {regions}
          <ellipse cx={cx0} cy={cy0} rx={46} ry={36} fill={`url(#cover-hot-${defsId})`} />
          {spots.map((spot, index) => {
            const [x, y] = px(spot);
            const isHub = index === 0;
            return <g key={index}>
              {isHub ? <g>
                <circle cx={x} cy={y} r={spot.r + 20} fill="none" stroke={accent} strokeWidth={2.6} opacity=".5" />
                <circle cx={x} cy={y} r={spot.r + 38} fill="none" stroke={accent} strokeWidth={1.6} opacity=".24" />
                <circle cx={x} cy={y} r={spot.r} fill={accent} filter={`url(#cover-glow-${defsId})`} />
              </g> : <g>
                <circle cx={x} cy={y} r={spot.r + 9} fill="none" stroke={accent} strokeWidth={1.8} opacity=".36" />
                <circle cx={x} cy={y} r={spot.r * 0.75} fill={accent} opacity={spot.o} />
              </g>}
            </g>;
          })}
          {spots.slice(1, 5).map((spot, index) => {
            const [x, y] = px(spot);
            const midX = (cx0 + x) / 2, midY = (cy0 + y) / 2 - Math.hypot(x - cx0, y - cy0) * 0.24;
            const fly = `M ${cx0.toFixed(1)} ${cy0.toFixed(1)} Q ${midX.toFixed(1)} ${midY.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
            const angle = Math.atan2(y - midY, x - midX);
            const arrow = `M ${x.toFixed(1)} ${y.toFixed(1)} L ${(x - 13 * Math.cos(angle - 0.42)).toFixed(1)} ${(y - 13 * Math.sin(angle - 0.42)).toFixed(1)} L ${(x - 13 * Math.cos(angle + 0.42)).toFixed(1)} ${(y - 13 * Math.sin(angle + 0.42)).toFixed(1)} Z`;
            return <g key={index}>
              <path d={fly} fill="none" stroke={accent} strokeWidth={7} opacity=".2" filter={`url(#cover-halo-${defsId})`} />
              <path d={fly} fill="none" stroke={accent} strokeWidth={3} strokeDasharray="12 8" opacity=".85" />
              <path d={arrow} fill={accent} opacity=".9" />
              <circle cx={x} cy={y} r={9} fill="none" stroke={accent} strokeWidth={2.2} opacity=".55" />
            </g>;
          })}
        </g>
      </g>;
    }
    case "funnel": {
      const layers = 4, gap = 6, layerH = (innerH - gap * (layers - 1)) / layers;
      return <g>{Array.from({ length: layers }, (_, index) => {
        const wTop = innerW * (0.94 - index * 0.17), wBottom = innerW * (0.94 - (index + 1) * 0.17);
        const y = innerY + index * (layerH + gap);
        const cxMid = frame.x + frame.width / 2;
        const isHero = index === 0;
        return <g key={index}>
          {isHero && <rect x={cxMid - wTop / 2 - 4} y={y - 4} width={wTop + 8} height={layerH + 8} rx={8} fill={accent} opacity=".3" filter={`url(#cover-halo-${defsId})`} />}
          <path d={`M ${cxMid - wTop / 2} ${y} L ${cxMid + wTop / 2} ${y} L ${cxMid + wBottom / 2} ${y + layerH} L ${cxMid - wBottom / 2} ${y + layerH} Z`} fill={`url(#cover-bar-${defsId})`} opacity={0.92 - index * 0.18} />
          <rect x={cxMid - wTop / 2} y={y} width={wTop} height={5} rx={2.5} fill="#ffffff" opacity={isHero ? ".7" : ".3"} />
          {index > 0 && <text x={cxMid + wTop / 2 + 12} y={y + layerH * 0.62} fontSize={18} fontWeight={700} fill={COVER_STATUS.success} className="cover-num">{(88 - index * 7)}.{9 - index}%</text>}
        </g>;
      })}</g>;
    }
    default:
      return coverChart("bar", frame, rand, defsId, hero);
  }
}

/** KPI 卡:发光大数字 tabular-nums + 顶部高光带 + 迷你走势/进度/状态灯(按真实指标类型差异化)。 */
function coverMetric(frame: WidgetFrame, title: string, unit: string, kind: string, rand: CoverRandom, defsId: string): ReactNode {
  const padX = frame.width * 0.08, padY = frame.height * 0.13;
  const nameSize = Math.max(12, Math.min(19, frame.height * 0.16));
  const numSize = Math.max(26, Math.min(56, frame.height * 0.44));
  const isPercent = unit.includes("%");
  const value = isPercent ? (52 + rand() * 44).toFixed(1) : Math.round(180 + rand() * 4200).toLocaleString("en-US");
  const rising = rand() > 0.34;
  const delta = (rand() * 9 + 0.4).toFixed(1);
  const hasDot = kind === "status" || kind === "progress";
  const arrowY = frame.y + padY + nameSize + numSize * 0.72;
  const chipWidth = 74;
  const spark: ReactNode[] = [];
  if (kind !== "status") {
    const sy = frame.y + frame.height - padY - 14;
    const points: [number, number][] = Array.from({ length: 8 }, (_, index) => [
      frame.x + padX + ((frame.width - padX * 2) * index) / 7,
      sy - (kind === "progress" ? 18 : 10) - rand() * (kind === "progress" ? 12 : 16),
    ]);
    const path = smoothPath(points);
    spark.push(<path key="sp" d={`${path} L ${points.at(-1)![0].toFixed(1)} ${sy + 6} L ${points[0]![0].toFixed(1)} ${sy + 6} Z`} fill={`url(#cover-area-${defsId})`} opacity=".4" />);
    spark.push(<path key="sl" d={path} fill="none" stroke="var(--template-accent)" strokeWidth={2.6} strokeLinecap="round" opacity=".9" />);
    spark.push(<circle key="sd" cx={points.at(-1)![0]} cy={points.at(-1)![1]} r={4} fill="var(--template-accent)" filter={`url(#cover-glow-${defsId})`} />);
  }
  return <g>
    {/* 顶部高光带:成品面板的玻璃反光 */}
    <rect x={frame.x} y={frame.y} width={frame.width} height={Math.max(16, frame.height * 0.17)} rx={10} fill={`url(#cover-sheen-${defsId})`} />
    {hasDot && <circle cx={frame.x + padX + 5} cy={frame.y + padY + nameSize * 0.34} r={4.6} fill="var(--template-accent)" filter={`url(#cover-glow-${defsId})`} />}
    <text className="cover-text-sub" x={frame.x + padX + (hasDot ? 15 : 0)} y={frame.y + padY + nameSize * 0.9} fontSize={nameSize}>{title}</text>
    {/* 发光大数字:feMerge 辉光滤镜,tabular-nums 由 .cover-num 保证 */}
    <text className="cover-num" x={frame.x + padX} y={frame.y + padY + nameSize + numSize * 0.92} fontSize={numSize} fontWeight={720} filter={`url(#cover-glow-${defsId})`}>{value}</text>
    <text className="cover-text-sub" x={frame.x + padX} y={frame.y + padY + nameSize + numSize + 15} fontSize={Math.max(11, nameSize * 0.78)}>{unit}</text>
    {/* 涨跌胶囊:语义色 + 深底 */}
    <g>
      <rect x={frame.x + frame.width - padX - chipWidth} y={arrowY - 14} width={chipWidth} height={26} rx={13}
        fill={rising ? "rgba(89,197,141,.16)" : "rgba(226,116,120,.14)"} stroke={rising ? COVER_STATUS.success : COVER_STATUS.danger} strokeOpacity=".45" strokeWidth={1.4} />
      <path d={rising ? `M ${frame.x + frame.width - padX - chipWidth + 12} ${arrowY + 1} l 4.5 -7 l 4.5 7 Z` : `M ${frame.x + frame.width - padX - chipWidth + 12} ${arrowY - 6} l 4.5 7 l 4.5 -7 Z`}
        fill={rising ? COVER_STATUS.success : COVER_STATUS.danger} />
      <text x={frame.x + frame.width - padX - 12} y={arrowY + 5} fontSize={15} fontWeight={700} textAnchor="end" fill={rising ? COVER_STATUS.success : COVER_STATUS.danger} className="cover-num">{delta}%</text>
    </g>
    {kind === "digital-flip" && <g>{[0, 1, 2, 3].map(index => <g key={index}>
      <rect x={frame.x + padX + index * (numSize * 0.36 + 5)} y={frame.y + frame.height - padY - 8} width={numSize * 0.32} height={7} rx={3} fill="var(--template-accent)" opacity={index === 0 ? 0.85 : 0.26} />
    </g>)}</g>}
    {kind === "progress" && <g>
      <rect x={frame.x + padX} y={frame.y + frame.height - padY - 10} width={frame.width - padX * 2} height={7} rx={3.5} fill="var(--template-accent)" opacity=".16" />
      <rect x={frame.x + padX} y={frame.y + frame.height - padY - 10} width={(frame.width - padX * 2) * (0.45 + rand() * 0.4)} height={7} rx={3.5} fill="var(--template-accent)" filter={`url(#cover-glow-${defsId})`} />
      {[0.25, 0.5, 0.75].map((tick, index) => <rect key={index} x={frame.x + padX + (frame.width - padX * 2) * tick} y={frame.y + frame.height - padY - 13} width={2} height={13} fill="#eef6f7" opacity=".3" />)}
    </g>}
    {kind === "status" && <g>
      {[0, 1, 2, 3, 4].map(index => statusLight(
        frame.x + padX + 12 + index * (numSize * 0.42), frame.y + frame.height - padY - 8,
        index === 3 ? COVER_STATUS.warning : COVER_STATUS.success, `sl${index}`, defsId, index === 3,
      ))}
    </g>}
    {kind !== "status" && spark}
  </g>;
}

/** 明细区:表格类封面语言——斑马纹 + 行内迷你条 + 排行奖牌,行数按 frame 高度自适应填满。 */
function coverDetail(frame: WidgetFrame, type: string, rand: CoverRandom, defsId: string): ReactNode {
  const padX = frame.width * 0.03, padY = frame.height * 0.09;
  const rows = Math.max(3, Math.min(6, Math.floor(frame.height / 52)));
  const rowH = (frame.height - padY * 2) / rows;
  const size = Math.max(11, Math.min(17, rowH * 0.4));
  const accent = "var(--template-accent)";
  return <g>
    {type !== "rank" && <rect x={frame.x + padX} y={frame.y + padY - 8} width={frame.width - padX * 2} height={2.4} fill={`url(#cover-line-${defsId})`} opacity=".7" />}
    {Array.from({ length: rows }, (_, index) => {
      const y = frame.y + padY + index * rowH + rowH / 2;
      const rankPad = type === "rank" ? size * 1.9 : 0;
      const barW = (frame.width - padX * 2 - rankPad) * (0.3 + rand() * 0.34);
      const isStripe = index % 2 === 1;
      const value = Math.round(60 + rand() * 900).toLocaleString("en-US");
      return <g key={index}>
        {isStripe && <rect x={frame.x + padX * 0.4} y={y - rowH / 2 + 2} width={frame.width - padX * 0.8} height={rowH - 4} rx={6} fill={accent} opacity=".07" />}
        {type === "rank" && <g>
          <circle cx={frame.x + padX + size * 0.66} cy={y} r={size * 0.66} fill={accent} opacity={0.92 - index * 0.22} filter={index === 0 ? `url(#cover-glow-${defsId})` : undefined} />
          <text className="cover-rank-num" x={frame.x + padX + size * 0.66} y={y + size * 0.38} fontSize={size * 0.82} textAnchor="middle">{index + 1}</text>
        </g>}
        <rect x={frame.x + padX + rankPad} y={y - size * 0.3} width={barW * 0.52} height={size * 0.58} rx={size * 0.29} fill="#c9d6da" opacity=".3" />
        {/* 行内迷你条:表格类封面的密度语言 */}
        <rect x={frame.x + frame.width * 0.44} y={y - 4} width={frame.width * 0.3} height={8} rx={4} fill={accent} opacity=".14" />
        <rect x={frame.x + frame.width * 0.44} y={y - 4} width={frame.width * 0.3 * (0.35 + rand() * 0.6)} height={8} rx={4} fill={accent} opacity={0.9 - index * 0.16} />
        <text className="cover-num cover-text-soft" x={frame.x + frame.width - padX} y={y + size * 0.38} fontSize={size} textAnchor="end">{value}</text>
      </g>;
    })}
    {type === "scroll-table" && <g>
      <rect x={frame.x + frame.width - padX * 0.5} y={frame.y + padY} width={4} height={frame.height - padY * 2} rx={2} fill={accent} opacity=".16" />
      <rect x={frame.x + frame.width - padX * 0.5} y={frame.y + padY} width={4} height={(frame.height - padY * 2) * 0.34} rx={2} fill={accent} opacity=".7" filter={`url(#cover-glow-${defsId})`} />
    </g>}
  </g>;
}

function coverTitleBar(frame: WidgetFrame, title: string, defsId: string): ReactNode {
  const size = Math.max(17, Math.min(42, frame.height * 0.52));
  const barW = Math.max(6, frame.height * 0.12);
  const barH = frame.height * 0.58;
  return <g>
    <rect x={frame.x + 10} y={frame.y + (frame.height - barH) / 2} width={barW} height={barH} rx={barW / 2} fill="var(--template-accent)" filter={`url(#cover-glow-${defsId})`} />
    <text className="cover-text-title" x={frame.x + 10 + barW + size * 0.55} y={frame.y + frame.height / 2 + size * 0.36} fontSize={size} fontWeight={650}>{title}</text>
    {/* 右端语义状态灯组:成品大屏标题行的"系统活着"信号 */}
    {[0, 1, 2].map(index => statusLight(
      frame.x + frame.width - 30 - index * 30, frame.y + frame.height / 2,
      [COVER_STATUS.success, COVER_STATUS.warning, COVER_STATUS.danger][index]!, `tl${index}`, defsId, index === 0,
    ))}
    <rect x={frame.x + 10} y={frame.y + frame.height - 4} width={frame.width - 20} height={2.4} fill={`url(#cover-line-${defsId})`} opacity=".65" />
  </g>;
}

function coverFilter(frame: WidgetFrame, label: string): ReactNode {
  const height = Math.min(38, frame.height * 0.58);
  const y = frame.y + (frame.height - height) / 2;
  const width = Math.min(frame.width * 0.82, Math.max(96, label.length * height * 0.62 + height * 1.6));
  const x = frame.x + (frame.width - width) / 2;
  const size = Math.max(11, height * 0.42);
  return <g>
    <rect x={x} y={y} width={width} height={height} rx={height / 2} fill="rgba(5,10,13,.42)" stroke="var(--template-accent)" strokeOpacity=".5" strokeWidth={1.6} />
    <text className="cover-text-sub" x={x + height * 0.55} y={y + height / 2 + size * 0.36} fontSize={size}>{label}</text>
    <path d={`M ${x + width - height * 0.85} ${y + height * 0.42} l ${height * 0.16} ${height * 0.2} l ${height * 0.16} ${-height * 0.2}`} fill="none" stroke="var(--template-accent)" strokeOpacity=".8" strokeWidth={2.2} strokeLinecap="round" />
  </g>;
}

/** 单节点封面渲染入口:按组件类型分发;hero 标记主视觉位(主图),辉光与标注只在主位全力。 */
export function coverNodeContent(type: SceneDashboardWidgetType, frame: WidgetFrame, options: {
  title: string;
  unit: string;
  seed: string;
  defsId: string;
  hero?: boolean;
}): ReactNode {
  const rand = coverRandom(options.seed);
  switch (type) {
    case "decoration": return coverTitleBar(frame, options.title, options.defsId);
    case "filter": return coverFilter(frame, options.title);
    case "value":
    case "digital-flip":
    case "progress":
    case "status": return coverMetric(frame, options.title, options.unit, type, rand, options.defsId);
    case "table":
    case "scroll-table":
    case "rank": return coverDetail(frame, type, rand, options.defsId);
    default: return coverChart(type, frame, rand, options.defsId, options.hero ?? false);
  }
}
