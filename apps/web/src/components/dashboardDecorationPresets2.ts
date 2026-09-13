import type { DashboardComponentPreset } from "./dashboardComponentPresetTypes";
import { decorationPreset } from "./dashboardComponentPresetFactory";

/** 装饰预设第二批:补齐标题条、边框、分隔线与角标的差异化形态,颜色取自 family 配色。 */
export const DASHBOARD_DECORATION_PRESETS_2: readonly DashboardComponentPreset[] = [
  decorationPreset({ id: "sweep-title-bar", zh: "扫光标题条", en: "Sweep title bar", descriptionZh: "标题条带扫光动效用于分区页首", family: "title", mark: "SWEEP", style: "scan", content: "分区标题", width: 480, height: 68, color: "#e0a44e" }),
  decorationPreset({ id: "neon-panel-title", zh: "霓虹面板标题条", en: "Neon panel title", descriptionZh: "为功能面板提供强调色标题", family: "title", mark: "NEON", style: "neon", content: "面板标题", width: 460, height: 66, color: "#e8785c" }),
  decorationPreset({ id: "tech-border-frame", zh: "科技细线边框", en: "Tech hairline frame", descriptionZh: "轻量细线边框包裹通用图表区", family: "frame", mark: "TECH", style: "border", content: "", width: 560, height: 300, color: "#52b2c8" }),
  decorationPreset({ id: "bracket-panel-frame", zh: "括号面板边框", en: "Bracket panel frame", descriptionZh: "括号角强调面板并保留轻量底", family: "frame", mark: "PANEL", style: "bracket", content: "", width: 480, height: 280, color: "#58a0e8" }),
  decorationPreset({ id: "glow-divider-line", zh: "光晕分隔线", en: "Glow divider line", descriptionZh: "带光晕的分区线用于深色大屏", family: "divider", mark: "GLOW", style: "neon", content: "", width: 460, height: 20, color: "#6a9fe8" }),
  decorationPreset({ id: "peak-alert-badge", zh: "峰值提醒角标", en: "Peak alert badge", descriptionZh: "标注峰值时段或最高负荷数据区", family: "badge", mark: "PEAK", style: "neon", content: "峰值", width: 120, height: 42, color: "#e89850" }),

  // 科技风边框族:在既有装饰样式上以动效、翼型与警示语义扩展造型节奏。
  decorationPreset({ id: "scan-panel-frame", zh: "扫描动效边框", en: "Scanning frame", descriptionZh: "框内扫描线营造设备巡检氛围", family: "frame", mark: "SCAN", style: "scan", content: "", width: 560, height: 320, color: "#4cc4d4", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 2600 } }),
  decorationPreset({ id: "neon-glow-frame", zh: "霓虹呼吸边框", en: "Neon breathing frame", descriptionZh: "呼吸光晕突出核心大屏分区", family: "frame", mark: "NEON", style: "neon", content: "", width: 520, height: 300, color: "#52b2c8", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 3200 } }),
  decorationPreset({ id: "target-lock-frame", zh: "目标锁定框", en: "Target lock frame", descriptionZh: "锁定地图、视频或三维联动目标", family: "frame", mark: "LOCK", style: "corner", content: "锁定", width: 300, height: 200, color: "#ee7a68", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 1400 } }),
  decorationPreset({ id: "wing-panel-frame", zh: "双翼面板边框", en: "Wing panel frame", descriptionZh: "机械翼造型承载左右对称面板", family: "frame", mark: "WING", style: "header-wing", content: "", width: 620, height: 300, color: "#52b2c8" }),
  decorationPreset({ id: "ladder-notch-frame", zh: "阶梯缺口边框", en: "Ladder notch frame", descriptionZh: "阶梯缺口层次适合嵌套分区", family: "frame", mark: "STEP", style: "frame-notch", content: "", width: 540, height: 280, color: "#58a0e8" }),
  decorationPreset({ id: "hatch-warning-frame", zh: "斜纹警示边框", en: "Hazard hatch frame", descriptionZh: "斜纹语义标识高风险作业区", family: "frame", mark: "HATCH", style: "diagonal", content: "", width: 520, height: 280, color: "#dcb258" }),
  decorationPreset({ id: "dot-breath-frame", zh: "点阵呼吸边框", en: "Dot breathing frame", descriptionZh: "点阵边线为数据墙提供轻边框", family: "frame", mark: "DOTS", style: "dots", content: "", width: 480, height: 260, color: "#6a9fe8", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 2800 } }),

  // 科技风标题族:双翼、机械臂、立柱、灯塔、雷达、铆接与横幅七种造型语言。
  decorationPreset({ id: "wing-support-title", zh: "展翼标题条", en: "Wing support title", descriptionZh: "双翼展开造型用于总览页首", family: "title", mark: "WING", style: "title", content: "运营总览", width: 520, height: 72, color: "#e0a44e" }),
  decorationPreset({ id: "mechanical-arm-title", zh: "机械臂标题条", en: "Mechanical arm title", descriptionZh: "机械臂支撑造型用于单元页首", family: "title", mark: "ARM", style: "header-wing", content: "单元总览", width: 540, height: 72, color: "#58a0e8" }),
  decorationPreset({ id: "pillar-title", zh: "立柱标题条", en: "Pillar title", descriptionZh: "立柱托举造型用于质量主题区", family: "title", mark: "PILLAR", style: "bracket", content: "质量管理", width: 480, height: 68, color: "#a083e8" }),
  decorationPreset({ id: "beacon-title", zh: "灯塔标题条", en: "Beacon title", descriptionZh: "灯塔光束造型并带呼吸动效", family: "title", mark: "BEACON", style: "neon", content: "能源监控", width: 500, height: 70, color: "#e8785c", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 2400 } }),
  decorationPreset({ id: "radar-sweep-title", zh: "雷达标题条", en: "Radar sweep title", descriptionZh: "雷达扫掠造型用于设备监测区", family: "title", mark: "RADAR", style: "scan", content: "设备监测", width: 520, height: 72, color: "#52b2c8", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 2800 } }),
  decorationPreset({ id: "rivet-notch-title", zh: "铆接标题条", en: "Rivet notch title", descriptionZh: "铆接缺口造型用于仓储物流区", family: "title", mark: "RIVET", style: "frame-notch", content: "仓储物流", width: 500, height: 70, color: "#719bb2" }),
  decorationPreset({ id: "banner-title", zh: "横幅标题条", en: "Banner title", descriptionZh: "宽幅横幅承载指挥中心页首", family: "title", mark: "BANNER", style: "title", content: "指挥中心", width: 760, height: 80, color: "#52c18a" }),

  // 光效与粒子点缀族:流光、星点、脉冲、光晕与角部闪光,营造大屏空气感。
  decorationPreset({ id: "particle-flow-band", zh: "粒子流光带", en: "Particle flow band", descriptionZh: "点阵流动表达数据持续更新", family: "light", mark: "FLOW", style: "dots", content: "", width: 520, height: 22, color: "#f0c25a", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 2000 } }),
  decorationPreset({ id: "starfield-strip", zh: "星点装饰条", en: "Starfield strip", descriptionZh: "静态星点点缀标题或页脚区域", family: "light", mark: "STARS", style: "dots", content: "", width: 420, height: 18, color: "#f09a5c" }),
  decorationPreset({ id: "energy-pulse-band", zh: "能源脉冲光带", en: "Energy pulse band", descriptionZh: "分段脉冲表达能源稳定流动", family: "light", mark: "PULSE", style: "segment", content: "", width: 560, height: 22, color: "#52c18a", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 2200 } }),
  decorationPreset({ id: "halo-accent-ring", zh: "光晕点缀环", en: "Halo accent ring", descriptionZh: "小尺寸光晕突出关键指标角落", family: "light", mark: "HALO", style: "neon", content: "", width: 180, height: 90, color: "#f0c25a" }),
  decorationPreset({ id: "sweep-highlight-band", zh: "扫光高亮条", en: "Sweep highlight band", descriptionZh: "扫掠高亮提示重点区域状态", family: "scan", mark: "SHINE", style: "scan", content: "重点区域", width: 480, height: 48, color: "#4cc4d4", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 2400 } }),
  decorationPreset({ id: "corner-spark-mark", zh: "角部闪光点缀", en: "Corner spark mark", descriptionZh: "角部闪光强调新增或提醒信息", family: "light", mark: "SPARK", style: "corner", content: "", width: 140, height: 80, color: "#f09a5c", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 1600 } }),

  // ── 科技风边框族补深(波次 F):电路纹 / 样条流线 / 井格藻井,mark 均为全新造型 ──
  decorationPreset({ id: "circuit-corner-frame", zh: "电路纹角框边框", en: "Circuit corner frame", descriptionZh: "电路走线角标呼应电子车间主题", family: "frame", mark: "CIRCUIT", style: "corner", content: "", width: 540, height: 280, color: "#52b2c8" }),
  decorationPreset({ id: "spline-flow-frame", zh: "样条流线边框", en: "Spline flow frame", descriptionZh: "样条弧线流动造型柔化数据分区", family: "frame", mark: "SPLINE", style: "border", content: "", width: 600, height: 300, color: "#58a0e8" }),
  decorationPreset({ id: "coffer-lattice-frame", zh: "井格藻井边框", en: "Coffer lattice frame", descriptionZh: "井格纹理承载指挥中心嵌套分区", family: "frame", mark: "COFFER", style: "dots", content: "", width: 520, height: 280, color: "#6a9fe8", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 3000 } }),

  // ── 科技风标题族补深(波次 F):齿轮传动 / 涡轮叶栅 / 桁架承托 ───────────
  decorationPreset({ id: "gear-drive-title", zh: "齿轮传动标题条", en: "Gear drive title", descriptionZh: "齿轮啮合造型用于装配制造分区", family: "title", mark: "GEAR", style: "bracket", content: "装配制造", width: 500, height: 70, color: "#e0a44e" }),
  decorationPreset({ id: "turbine-vane-title", zh: "涡轮叶栅标题条", en: "Turbine vane title", descriptionZh: "涡轮叶栅造型用于动力车间分区", family: "title", mark: "TURBINE", style: "header-wing", content: "动力车间", width: 540, height: 72, color: "#58a0e8" }),
  decorationPreset({ id: "truss-lattice-title", zh: "桁架承托标题条", en: "Truss lattice title", descriptionZh: "桁架结构造型用于工程总览页首", family: "title", mark: "TRUSS", style: "frame-notch", content: "工程总览", width: 520, height: 70, color: "#719bb2" }),

  // ── 光效点缀族补深(波次 F):彗尾流光 / 极光帷幕 / 流萤簇 / 网格扫掠 ────
  decorationPreset({ id: "comet-tail-band", zh: "彗尾流光带", en: "Comet tail band", descriptionZh: "彗尾扫掠表达数据流持续注入", family: "light", mark: "COMET", style: "scan", content: "", width: 540, height: 22, color: "#f0c25a", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 2400 } }),
  decorationPreset({ id: "aurora-veil-band", zh: "极光帷幕光带", en: "Aurora veil band", descriptionZh: "极光渐变帷幕为大屏顶部收边", family: "light", mark: "AURORA", style: "neon", content: "", width: 620, height: 26, color: "#58c0d0", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 3600 } }),
  decorationPreset({ id: "firefly-dot-cluster", zh: "流萤点缀簇", en: "Firefly dot cluster", descriptionZh: "疏密点簇点缀关键指标角落", family: "light", mark: "FIREFLY", style: "dots", content: "", width: 320, height: 90, color: "#f09a5c" }),
  decorationPreset({ id: "grid-sweep-overlay", zh: "网格扫掠标注", en: "Grid sweep overlay", descriptionZh: "网格扫掠标注网格化巡查区域", family: "scan", mark: "GRIDS", style: "scan", content: "网格巡查", width: 480, height: 52, color: "#4cc4d4", widget: { animation: "pulse", animationAutoplay: true, animationLoop: true, animationDuration: 2600 } }),
] as const;
