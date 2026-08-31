import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { decorationPreset } from "./dashboardComponentPresetFactory";

export const DASHBOARD_DECORATION_LINE_PRESETS: readonly DashboardComponentPreset[] = [
  decorationPreset({ id: "scan-divider", zh: "扫描分区线", en: "Scanning divider", descriptionZh: "分隔实时监控区并提供轻量动效", family: "divider", mark: "SCAN", style: "scan", content: "实时监控", width: 420, height: 64 }),
  decorationPreset({ id: "gradient-section-divider", zh: "渐隐分区线", en: "Gradient divider", descriptionZh: "柔和分隔相邻业务模块", family: "divider", mark: "DIV", style: "divider", content: "", width: 520, height: 24, color: "#66828d" }),
  decorationPreset({ id: "segmented-process-divider", zh: "工序分段线", en: "Process segment divider", descriptionZh: "表达离散工序或步骤分界", family: "divider", mark: "STEP", style: "segment", content: "", width: 520, height: 24 }),
  decorationPreset({ id: "dotted-data-divider", zh: "数据点阵分隔", en: "Data dot divider", descriptionZh: "分隔轻量数据说明和辅助区", family: "divider", mark: "DATA", style: "dots", content: "", width: 420, height: 20, color: "#6c8993" }),
  decorationPreset({ id: "hazard-stripe-divider", zh: "安全斜纹分隔", en: "Hazard stripe divider", descriptionZh: "标识安全风险区或禁止区域边界", family: "divider", mark: "SAFE", style: "diagonal", content: "", width: 460, height: 24, color: "#d5a657" }),
  decorationPreset({ id: "timeline-divider", zh: "时间轴分隔线", en: "Timeline divider", descriptionZh: "连接时间趋势与事件列表区域", family: "divider", mark: "TIME", style: "segment", content: "", width: 680, height: 20, color: "#648d9a" }),
  decorationPreset({ id: "alarm-zone-divider", zh: "告警区域分隔", en: "Alarm zone divider", descriptionZh: "把异常处置区与常规信息区分开", family: "divider", mark: "ALM", style: "divider", content: "", width: 520, height: 24, color: "#d36f68" }),
  decorationPreset({ id: "page-footer-divider", zh: "页脚信息分隔", en: "Footer divider", descriptionZh: "分隔数据来源、版本和更新时间", family: "divider", mark: "META", style: "dots", content: "", width: 860, height: 18, color: "#52666e" }),

  decorationPreset({ id: "horizontal-ruler", zh: "水平刻度标尺", en: "Horizontal ruler", descriptionZh: "为距离、时间或容量区提供刻度基线", family: "ruler", mark: "0—100", style: "segment", content: "0  20  40  60  80  100", width: 520, height: 32, color: "#80949c" }),
  decorationPreset({ id: "percent-ruler", zh: "百分比刻度尺", en: "Percent ruler", descriptionZh: "配合进度和达成率组件表达区间", family: "ruler", mark: "%", style: "dots", content: "0%  25%  50%  75%  100%", width: 420, height: 30, color: "#6e929c" }),
  decorationPreset({ id: "temperature-ruler", zh: "温度区间标尺", en: "Temperature ruler", descriptionZh: "标识温度正常、预警和高温区间", family: "ruler", mark: "°C", style: "segment", content: "0°C  40°C  80°C  120°C", width: 460, height: 32, color: "#c98b69" }),
  decorationPreset({ id: "pressure-ruler", zh: "压力区间标尺", en: "Pressure ruler", descriptionZh: "为压力趋势和仪表提供量程提示", family: "ruler", mark: "MPa", style: "dots", content: "0  0.4  0.8  1.2 MPa", width: 460, height: 32, color: "#7093a0" }),
  decorationPreset({ id: "timeline-ruler", zh: "班次时间标尺", en: "Shift timeline ruler", descriptionZh: "标识班次起止和关键换班时间", family: "ruler", mark: "08—20", style: "segment", content: "08:00  12:00  16:00  20:00", width: 620, height: 32, color: "#71868e" }),
  decorationPreset({ id: "capacity-ruler", zh: "库容区间标尺", en: "Capacity ruler", descriptionZh: "标注库容安全线和满载区间", family: "ruler", mark: "CAP", style: "diagonal", content: "空  安全  预警  满载", width: 480, height: 32, color: "#b99b62" }),
  decorationPreset({ id: "quality-band-ruler", zh: "质量等级标尺", en: "Quality band ruler", descriptionZh: "标注优秀、合格、关注和异常区间", family: "ruler", mark: "A—D", style: "segment", content: "优秀  合格  关注  异常", width: 480, height: 32, color: "#74a083" }),
  decorationPreset({ id: "risk-level-ruler", zh: "风险等级标尺", en: "Risk level ruler", descriptionZh: "表达低、中、高和重大风险级别", family: "ruler", mark: "L1—L4", style: "diagonal", content: "低  中  高  重大", width: 480, height: 32, color: "#d17c66" }),
] as const;

