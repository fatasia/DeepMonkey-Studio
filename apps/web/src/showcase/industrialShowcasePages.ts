import type {
  DashboardDataWidgetConfig,
  DashboardDataWidgetNode,
  DashboardPageDocument,
  DirectBindingSpec,
  SceneDataBindingState,
  SceneViewportWidgetNode,
  WidgetFrame,
} from "@bim-studio/contracts";

const PAGE_WIDTH = 3_840;
const PAGE_HEIGHT = 2_160;

interface ShowcasePageIds {
  readonly campus: string;
  readonly workshop: string;
  readonly line: string;
  readonly robot: string;
}

/** 集中维护案例的 2D 页面编排，避免布局调整与三维场景构造互相耦合。 */
export function createIndustrialShowcasePages(prefix: string, pageIds: ShowcasePageIds, sceneIds: ShowcasePageIds): DashboardPageDocument[] {
  return [
    page(pageIds.campus, "01 · 园区运营总览", [
      sceneViewport(`${prefix}-viewport-campus`, sceneIds.campus, { x: 0, y: 0, width: 2_520, height: PAGE_HEIGHT }, 0),
      textNode(
        `${prefix}-campus-title`,
        { x: 72, y: 68, width: 1_560, height: 140 },
        "智造园区 · 运营驾驶舱",
        "从总览下钻到车间、产线与设备；所有内容可编辑、发布并离线复现。",
        10,
      ),
      metricNode(`${prefix}-kpi-output`, { x: 2_590, y: 80, width: 540, height: 260 }, "当班产量", "factory.output", "value", "件", httpBinding("$.factory.output"), 2),
      metricNode(`${prefix}-kpi-plan`, { x: 3_210, y: 80, width: 540, height: 260 }, "计划达成率", "factory.planRate", "gauge", "%", httpBinding("$.factory.planRate"), 3),
      metricNode(
        `${prefix}-kpi-utilization`,
        { x: 2_590, y: 390, width: 540, height: 260 },
        "设备利用率",
        "factory.utilization",
        "gauge",
        "%",
        websocketBinding("$.factory.utilization"),
        4,
      ),
      metricNode(
        `${prefix}-kpi-alarm`,
        { x: 3_210, y: 390, width: 540, height: 260 },
        "活动告警",
        "factory.alarmCount",
        "value",
        "条",
        websocketBinding("$.factory.alarmCount"),
        5,
        "#f26b5e",
      ),
      dataNode(`${prefix}-campus-trend`, { x: 2_590, y: 710, width: 1_160, height: 420 }, 6, {
        title: "产量趋势",
        key: "factory.history",
        type: "area",
        unit: "件",
        color: "#54d69a",
        backgroundColor: "#152126",
        backgroundOpacity: 0.92,
        directBinding: httpBinding("$.history[23].output"),
        animation: "fade",
      }),
      dataNode(`${prefix}-campus-layout`, { x: 2_590, y: 1_190, width: 720, height: 830 }, 7, {
        title: "园区平面与下钻路径",
        key: "media.layout",
        type: "image",
        unit: "",
        imageUrl: "/showcase/plant-layout.svg",
        imageFit: "contain",
        backgroundColor: "#101a1f",
        backgroundOpacity: 0.96,
      }),
      dataNode(`${prefix}-campus-monitor`, { x: 3_350, y: 1_190, width: 400, height: 520 }, 8, {
        title: "一号车间 · 实时监控",
        key: "media.monitor",
        type: "monitor",
        unit: "",
        monitorProtocol: "webrtc",
        videoUrl: "/showcase/live-monitor.html",
        videoFit: "cover",
        videoAutoplay: true,
        videoMuted: true,
        backgroundColor: "#101a1f",
        backgroundOpacity: 0.96,
      }),
      actionNode(`${prefix}-nav-workshop`, { x: 3_350, y: 1_750, width: 400, height: 270 }, "进入一号车间", "楼层拆解 · 第一/第三人称", 9),
    ]),
    page(pageIds.workshop, "02 · 一号物流车间", [
      sceneViewport(`${prefix}-viewport-workshop`, sceneIds.workshop, { x: 0, y: 0, width: 3_020, height: PAGE_HEIGHT }, 0),
      textNode(
        `${prefix}-workshop-title`,
        { x: 72, y: 68, width: 1_620, height: 140 },
        "一号物流车间 · 楼层与巡检",
        "使用三维视口右下角播放控件控制楼层拆解，巡检视角可在第一/第三人称间切换。",
        10,
      ),
      actionNode(`${prefix}-camera-first`, { x: 3_090, y: 100, width: 660, height: 230 }, "第一人称巡检", "碰撞、重力、台阶与斜坡配置已启用", 2),
      actionNode(`${prefix}-camera-third`, { x: 3_090, y: 370, width: 660, height: 230 }, "第三人称巡检", "跟随角色并保留空间上下文", 3),
      metricNode(`${prefix}-workshop-wip`, { x: 3_090, y: 650, width: 310, height: 260 }, "在制品 WIP", "factory.wip", "value", "件", websocketBinding("$.factory.wip"), 4),
      metricNode(`${prefix}-workshop-cycle`, { x: 3_440, y: 650, width: 310, height: 260 }, "平均节拍", "factory.cycleTime", "value", "s", httpBinding("$.factory.cycleTime"), 5),
      dataNode(`${prefix}-workshop-video`, { x: 3_090, y: 970, width: 660, height: 640 }, 6, {
        title: "产线作业视频",
        key: "media.video",
        type: "video",
        unit: "",
        videoUrl: "/showcase/line-loop.mp4",
        videoFit: "cover",
        videoAutoplay: true,
        videoMuted: true,
        backgroundColor: "#101a1f",
        backgroundOpacity: 0.96,
      }),
      actionNode(`${prefix}-nav-line`, { x: 3_090, y: 1_670, width: 660, height: 350 }, "下钻总装产线", "Source / Process / Buffer / Sink / AGV", 7),
    ]),
    page(pageIds.line, "03 · 总装产线与 AGV", [
      sceneViewport(`${prefix}-viewport-line`, sceneIds.line, { x: 0, y: 0, width: 2_790, height: PAGE_HEIGHT }, 0),
      textNode(
        `${prefix}-line-title`,
        { x: 72, y: 68, width: 1_700, height: 140 },
        "总装产线 · 物流与 AGV",
        "AGV-01 位置由 HTTP 轮询驱动，状态颜色与速度由 WebSocket 实时推送。",
        10,
      ),
      metricNode(
        `${prefix}-agv-speed`,
        { x: 2_860, y: 90, width: 430, height: 260 },
        "AGV-01 速度",
        "agv.speed",
        "value",
        "m/s",
        websocketBinding("$.agvs[0].speed"),
        2,
        "#54d69a",
      ),
      metricNode(`${prefix}-agv-status`, { x: 3_340, y: 90, width: 410, height: 260 }, "AGV-01 状态", "agv.status", "status", "", websocketBinding("$.agvs[0].status"), 3),
      metricNode(`${prefix}-line-cycle`, { x: 2_860, y: 400, width: 430, height: 260 }, "产线节拍", "line.cycle", "gauge", "s", httpBinding("$.factory.cycleTime"), 4),
      metricNode(`${prefix}-line-wip`, { x: 3_340, y: 400, width: 410, height: 260 }, "缓冲区 WIP", "line.wip", "value", "件", httpBinding("$.factory.wip"), 5),
      dataNode(`${prefix}-equipment-table`, { x: 2_860, y: 710, width: 890, height: 610 }, 6, {
        title: "设备健康明细",
        key: "equipment.rows",
        type: "table",
        unit: "",
        field: "health",
        backgroundColor: "#142027",
        backgroundOpacity: 0.96,
        directBinding: websocketBinding("$.equipment"),
      }),
      actionNode(`${prefix}-data-evidence`, { x: 2_860, y: 1_370, width: 430, height: 300 }, "直连证据", "HTTP + WebSocket · 同一服务器网关", 7),
      actionNode(`${prefix}-nav-robot`, { x: 3_340, y: 1_370, width: 410, height: 300 }, "定位机器人 A", "部件拆解与健康告警", 8),
      textNode(
        `${prefix}-line-topology-note`,
        { x: 2_860, y: 1_720, width: 890, height: 300 },
        "物流拓扑已内置",
        "在顶部切换到“拓扑”可编辑 Source、Process、Buffer、Sink、AGV 节点与边。",
        9,
      ),
    ]),
    page(pageIds.robot, "04 · 机器人单元", [
      sceneViewport(`${prefix}-viewport-robot`, sceneIds.robot, { x: 0, y: 0, width: 2_760, height: PAGE_HEIGHT }, 0),
      textNode(
        `${prefix}-robot-title`,
        { x: 72, y: 68, width: 1_700, height: 140 },
        "机器人 A · 部件拆解与健康",
        "播放拆解时间线检查部件层级；温度、振动、健康与告警来自同一份可追踪模拟数据。",
        10,
      ),
      metricNode(
        `${prefix}-robot-temperature`,
        { x: 2_830, y: 90, width: 430, height: 280 },
        "轴承温度",
        "robot.temperature",
        "gauge",
        "°C",
        websocketBinding("$.equipment[0].temperature"),
        2,
        "#f1b45b",
      ),
      metricNode(
        `${prefix}-robot-vibration`,
        { x: 3_320, y: 90, width: 430, height: 280 },
        "振动 RMS",
        "robot.vibration",
        "gauge",
        "mm/s",
        websocketBinding("$.equipment[0].vibration"),
        3,
        "#63a7ff",
      ),
      metricNode(
        `${prefix}-robot-health`,
        { x: 2_830, y: 430, width: 430, height: 280 },
        "健康度",
        "robot.health",
        "gauge",
        "%",
        httpBinding("$.equipment[0].health"),
        4,
        "#54d69a",
      ),
      metricNode(`${prefix}-robot-alarm`, { x: 3_320, y: 430, width: 430, height: 280 }, "告警状态", "robot.alarm", "status", "", websocketBinding("$.equipment[0].alarm"), 5),
      dataNode(`${prefix}-robot-monitor`, { x: 2_830, y: 780, width: 920, height: 690 }, 6, {
        title: "机器人单元 · 实时监控",
        key: "robot.monitor",
        type: "monitor",
        unit: "",
        monitorProtocol: "webrtc",
        videoUrl: "/showcase/live-monitor.html?camera=robot-a",
        videoFit: "cover",
        videoAutoplay: true,
        videoMuted: true,
        backgroundColor: "#101a1f",
        backgroundOpacity: 0.96,
      }),
      dataNode(`${prefix}-robot-history`, { x: 2_830, y: 1_530, width: 920, height: 490 }, 7, {
        title: "温度趋势",
        key: "robot.temperature.history",
        type: "line",
        unit: "°C",
        color: "#f1b45b",
        backgroundColor: "#142027",
        backgroundOpacity: 0.96,
        directBinding: websocketBinding("$.equipment[0].temperature"),
      }),
    ]),
  ];
}

export function httpBinding(jsonPath: string): DirectBindingSpec {
  return {
    version: 1,
    gateway: "server",
    transport: "http",
    endpoint: "/api/public/demo/industrial",
    access: "read-only",
    selection: { jsonPath },
    http: { method: "GET", refresh: { intervalMs: 1_000, immediate: true } },
  };
}

export function websocketBinding(jsonPath: string): DirectBindingSpec {
  return {
    version: 1,
    gateway: "server",
    transport: "websocket",
    endpoint: "/api/public/demo/industrial/ws",
    access: "read-only",
    selection: { jsonPath },
    websocket: { reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 8_000, multiplier: 2 } },
  };
}

export function directSceneBinding(
  id: string,
  name: string,
  directBinding: DirectBindingSpec,
  field: string,
  modelId: string,
  action: SceneDataBindingState["action"],
): SceneDataBindingState {
  return { id, name, enabled: true, directBinding, field, target: { modelId }, action, refreshSeconds: 2 };
}

function page(id: string, name: string, nodes: Array<SceneViewportWidgetNode | DashboardDataWidgetNode>): DashboardPageDocument {
  return {
    id,
    name,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    viewportFit: "contain",
    appearance: { backgroundColor: "#0a1115", backgroundOpacity: 1, blur: 0, borderRadius: 0 },
    nodes,
  };
}

function sceneViewport(id: string, sceneId: string, frame: WidgetFrame, zIndex: number): SceneViewportWidgetNode {
  return { id, kind: "scene-viewport", frame, zIndex, sceneId, renderMode: "realtime", interactionPolicy: "full-navigation", overlaySlot: "page" };
}

function metricNode(
  id: string,
  frame: WidgetFrame,
  title: string,
  key: string,
  type: DashboardDataWidgetConfig["type"],
  unit: string,
  directBinding: DirectBindingSpec,
  zIndex: number,
  color = "#d9ad55",
): DashboardDataWidgetNode {
  return dataNode(id, frame, zIndex, {
    title,
    key,
    type,
    unit,
    min: 0,
    max: type === "gauge" && unit === "s" ? 60 : 100,
    color,
    backgroundColor: "#142027",
    backgroundOpacity: 0.96,
    textColor: "#f1f5f6",
    directBinding,
    animation: "slide-up",
    animationDuration: 0.5,
  });
}

function textNode(id: string, frame: WidgetFrame, title: string, content: string, zIndex: number): DashboardDataWidgetNode {
  return dataNode(id, frame, zIndex, {
    title,
    key: id,
    type: "text",
    unit: "",
    content: `${title}\n${content}`,
    fontSize: 42,
    fontWeight: 720,
    textAlign: "left",
    textColor: "#eef5f6",
    backgroundColor: "#0d171c",
    backgroundOpacity: 0.88,
  });
}

function actionNode(id: string, frame: WidgetFrame, title: string, content: string, zIndex: number): DashboardDataWidgetNode {
  return dataNode(id, frame, zIndex, {
    title,
    key: id,
    type: "text",
    unit: "",
    content: `${title}\n${content}`,
    fontSize: 34,
    fontWeight: 700,
    textAlign: "left",
    textColor: "#f3e4bf",
    backgroundColor: "#263027",
    backgroundOpacity: 0.98,
    borderColor: "#8e7647",
    borderWidth: 2,
    animation: "scale",
    animationDuration: 0.35,
  });
}

function dataNode(id: string, frame: WidgetFrame, zIndex: number, widget: DashboardDataWidgetConfig): DashboardDataWidgetNode {
  return { id, kind: "data-widget", frame, zIndex, widget };
}
