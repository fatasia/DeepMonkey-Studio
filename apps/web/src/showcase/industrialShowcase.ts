import type {
  ApplicationDocument,
  CameraState,
  DashboardDataWidgetConfig,
  DashboardDataWidgetNode,
  DashboardPageDocument,
  DirectBindingSpec,
  InteractionFlow,
  ModelTransform,
  PrimitiveKind,
  PrimitiveState,
  SceneAnimationState,
  SceneDataBindingState,
  SceneDocument,
  SceneSnapshot,
  SceneViewportWidgetNode,
  WidgetFrame
} from "@bim-studio/contracts";

export interface IndustrialShowcaseBundle {
  application: ApplicationDocument;
  scenes: SceneSnapshot[];
  entryPageId: string;
}

interface ShowcaseOptions {
  projectId: string;
  showcaseId: string;
  createdAt: string;
}

const PAGE_WIDTH = 3_840;
const PAGE_HEIGHT = 2_160;
const BASE_CAMERA_CONSTRAINTS = {
  minDistance: 0.5,
  maxDistance: 280,
  minPolarAngle: 0.05,
  maxPolarAngle: Math.PI - 0.05,
  nearClip: 0.05,
  farClip: 5_000,
  collisionEnabled: true,
  collisionRadius: 0.42
};
const BASE_NAVIGATION = {
  walkSpeed: 3.4,
  flySpeed: 10,
  sprintMultiplier: 2,
  eyeHeight: 1.68,
  gravity: 16,
  jumpSpeed: 5.5,
  stepHeight: 0.42,
  maxSlopeAngle: 48
};
const BASE_LIGHTING = {
  enabled: true,
  intensity: 1,
  shadowsEnabled: true,
  reflectionsEnabled: true,
  globalIlluminationEnabled: true,
  globalIlluminationIntensity: 0.52,
  lights: [
    { id: "showcase-key", name: "园区主光", type: "directional" as const, enabled: true, color: "#fff4d6", intensity: 2.1, position: { x: 24, y: 36, z: 18 }, target: { x: 0, y: 0, z: 0 }, castShadow: true },
    { id: "showcase-fill", name: "环境补光", type: "hemisphere" as const, enabled: true, color: "#b8dcff", groundColor: "#283126", intensity: 0.75 }
  ]
};
const BASE_ENVIRONMENT = { gridVisible: true, backgroundColor: "#0c171d", skybox: "clear" as const };
const BASE_POST_PROCESSING = {
  enabled: true,
  smaa: true,
  ssao: true,
  ssaoIntensity: 0.85,
  bloom: true,
  bloomStrength: 0.28,
  bloomThreshold: 0.82,
  outline: true,
  outlineStrength: 1.2,
  vignette: true,
  vignetteDarkness: 0.28
};
const EMPTY_ANIMATION: SceneAnimationState = { duration: 10, loop: false, camera: [], models: [] };

export function createIndustrialShowcaseBundle(options: ShowcaseOptions): IndustrialShowcaseBundle {
  const prefix = options.showcaseId;
  const sceneIds = {
    campus: `${prefix}-campus`,
    workshop: `${prefix}-workshop`,
    line: `${prefix}-line`,
    robot: `${prefix}-robot`
  };
  const pageIds = {
    campus: `${prefix}-page-campus`,
    workshop: `${prefix}-page-workshop`,
    line: `${prefix}-page-line`,
    robot: `${prefix}-page-robot`
  };

  const campus = createCampusScene(options, sceneIds.campus);
  const workshop = createWorkshopScene(options, sceneIds.workshop);
  const line = createLineScene(options, sceneIds.line);
  const robot = createRobotScene(options, sceneIds.robot);
  const scenes = [campus, workshop, line, robot];

  const interactions: InteractionFlow[] = [
    navigationFlow(`${prefix}-flow-campus-workshop`, `${prefix}-nav-workshop`, sceneIds.workshop),
    navigationFlow(`${prefix}-flow-workshop-line`, `${prefix}-nav-line`, sceneIds.line),
    navigationFlow(`${prefix}-flow-line-robot`, `${prefix}-nav-robot`, sceneIds.robot),
    navigationFlow(`${prefix}-flow-building-workshop`, `${prefix}-building-workshop`, sceneIds.workshop, sceneIds.campus),
    navigationFlow(`${prefix}-flow-line-robot-object`, `${prefix}-line-robot`, sceneIds.robot, sceneIds.line),
    cameraFlow(`${prefix}-flow-first-person`, `${prefix}-camera-first`, sceneIds.workshop, `${prefix}-workshop-first`),
    cameraFlow(`${prefix}-flow-third-person`, `${prefix}-camera-third`, sceneIds.workshop, `${prefix}-workshop-third`),
    messageFlow(`${prefix}-flow-data-evidence`, `${prefix}-data-evidence`, "HTTP 与 WebSocket 均通过服务器网关直接驱动 2D 指标和 3D AGV。")
  ];

  const pages: DashboardPageDocument[] = [
    campusPage(prefix, pageIds.campus, sceneIds.campus),
    workshopPage(prefix, pageIds.workshop, sceneIds.workshop),
    linePage(prefix, pageIds.line, sceneIds.line),
    robotPage(prefix, pageIds.robot, sceneIds.robot)
  ];
  const application: ApplicationDocument = {
    schemaVersion: 2,
    metadata: {
      id: `${prefix}-application`,
      projectId: options.projectId,
      name: "智造园区综合案例",
      revision: 1,
      createdAt: options.createdAt,
      updatedAt: options.createdAt
    },
    pages,
    topologies: [{
      id: `${prefix}-factory-flow`,
      name: "总装线物流拓扑",
      nodes: [
        { id: "source-orders", kind: "source", x: 120, y: 280, properties: { name: "订单上线", cycleSeconds: 42 } },
        { id: "process-assembly", kind: "process", x: 420, y: 180, properties: { name: "总装工位", capacity: 2, sceneObjectId: `${prefix}-line-process` } },
        { id: "buffer-wip", kind: "buffer", x: 720, y: 280, properties: { name: "WIP 缓冲", capacity: 48, sceneObjectId: `${prefix}-line-buffer` } },
        { id: "sink-finished", kind: "sink", x: 1_020, y: 180, properties: { name: "成品下线", targetPerShift: 960 } },
        { id: "agv-fleet", kind: "agv", x: 570, y: 480, properties: { name: "AGV 车队", count: 2, sceneObjectId: `${prefix}-agv-01` } }
      ],
      edges: [
        { id: "edge-source-process", sourceNodeId: "source-orders", targetNodeId: "process-assembly", properties: { route: "conveyor" } },
        { id: "edge-process-buffer", sourceNodeId: "process-assembly", targetNodeId: "buffer-wip", properties: { route: "agv" } },
        { id: "edge-buffer-sink", sourceNodeId: "buffer-wip", targetNodeId: "sink-finished", properties: { route: "conveyor" } },
        { id: "edge-agv-process", sourceNodeId: "agv-fleet", targetNodeId: "process-assembly", properties: { dispatch: "nearest" } },
        { id: "edge-agv-buffer", sourceNodeId: "agv-fleet", targetNodeId: "buffer-wip", properties: { dispatch: "nearest" } }
      ]
    }],
    scenes: scenes.map(sceneDocument),
    geo: { providerIds: [], layers: [] },
    data: {
      connectionIds: [],
      datasetIds: [],
      transforms: [{ id: `${prefix}-plan-rate`, expression: "factory.output / factory.target * 100" }],
      variables: [
        { id: "showcase.mode", value: "simulated-live" },
        { id: "agv.source", value: "http+websocket" },
        { id: "showcase.seed", value: "industrial-v1" }
      ]
    },
    interactions,
    scripts: [{
      id: `${prefix}-evidence-script`,
      name: "案例数据证据记录器",
      enabled: true,
      apiVersion: "1.0",
      entrypoint: "behavior",
      runtime: "worker-sandbox",
      code: `function onStart(context) { context.state.samples = 0; context.log("智造园区案例脚本已启动", { sceneId: context.sceneId }); }\nfunction onData(context) { context.state.samples = Number(context.state.samples || 0) + 1; if (context.state.samples % 30 === 0) context.log("已审计数据样本", { samples: context.state.samples }); }`,
      lifecycle: ["onStart", "onData"],
      capabilities: ["studio.scene", "studio.object", "studio.data", "studio.runtime"],
      permissions: ["scene.read", "data.read"]
    }],
    assets: [
      { id: `${prefix}-layout-image`, kind: "image", projectId: options.projectId, sourceName: "内置原创园区平面图", contentHash: "builtin-industrial-layout-v1" },
      { id: `${prefix}-line-video`, kind: "video", projectId: options.projectId, sourceName: "内置原创产线循环视频", contentHash: "builtin-industrial-line-video-v1" }
    ],
    timelines: [
      { id: `${prefix}-workshop-explode`, name: "楼层展开", duration: workshop.animation?.duration ?? 10, trackIds: workshop.animation?.models.map((frame) => frame.id) ?? [] },
      { id: `${prefix}-robot-explode`, name: "机器人部件拆解", duration: robot.animation?.duration ?? 10, trackIds: robot.animation?.models.map((frame) => frame.id) ?? [] }
    ],
    publicationProfiles: [
      { id: `${prefix}-browser`, name: "浏览器演示", target: "browser-preview", entryPageId: pageIds.campus, renderer: "auto" },
      { id: `${prefix}-server`, name: "服务器发布", target: "server-web", entryPageId: pageIds.campus, renderer: "auto" }
    ],
    spatialNavigation: {
      rootNodeIds: [`${prefix}-space-campus`],
      cacheLimit: 3,
      nodes: [
        { id: `${prefix}-space-campus`, name: "智造园区", kind: "campus", sceneId: sceneIds.campus, dashboardPageId: pageIds.campus, entryCameraViewId: `${prefix}-campus-overview`, loadPolicy: "replace" },
        { id: `${prefix}-space-workshop`, name: "一号物流车间", kind: "workshop", parentId: `${prefix}-space-campus`, sceneId: sceneIds.workshop, dashboardPageId: pageIds.workshop, entryCameraViewId: `${prefix}-workshop-third`, loadPolicy: "additive" },
        { id: `${prefix}-space-line`, name: "总装产线", kind: "production-line", parentId: `${prefix}-space-workshop`, sceneId: sceneIds.line, dashboardPageId: pageIds.line, loadPolicy: "replace" },
        { id: `${prefix}-space-robot`, name: "机器人 A", kind: "equipment", parentId: `${prefix}-space-line`, sceneId: sceneIds.robot, dashboardPageId: pageIds.robot, target: { modelId: `${prefix}-robot-base` }, loadPolicy: "focus" }
      ]
    }
  };

  return { application, scenes, entryPageId: pageIds.campus };
}

function createCampusScene(options: ShowcaseOptions, sceneId: string): SceneSnapshot {
  const prefix = options.showcaseId;
  const primitives: PrimitiveState[] = [
    primitive(`${prefix}-campus-ground`, "园区地坪", "box", "#243239", [0, -0.3, 0], [42, 0.5, 30]),
    primitive(`${prefix}-campus-road-x`, "东西物流道路", "box", "#3b464b", [0, 0.02, -7], [40, 0.08, 4]),
    primitive(`${prefix}-campus-road-z`, "南北物流道路", "box", "#3b464b", [-12, 0.03, 4], [5, 0.09, 24]),
    primitive(`${prefix}-building-workshop`, "一号物流车间", "box", "#577a8a", [7, 3.6, 4], [18, 7, 12], { effects: "#64c8ff" }),
    primitive(`${prefix}-building-warehouse`, "智能仓库", "box", "#6f7f78", [-22, 3, -1], [11, 6, 10]),
    primitive(`${prefix}-building-office`, "研发办公楼", "box", "#735f57", [21, 4.5, -10], [10, 9, 8]),
    primitive(`${prefix}-campus-tower`, "能源中心", "cylinder", "#8b8f72", [-24, 4, 11], [5, 8, 5]),
    ...Array.from({ length: 12 }, (_item, index) => primitive(`${prefix}-tree-${index + 1}`, `景观树 ${index + 1}`, "cylinder", index % 2 ? "#4f7b62" : "#58866b", [-33 + index * 5.8, 1.1, 14 + (index % 2) * 2], [0.8, 2.2, 0.8]))
  ];
  const camera: CameraState = { position: { x: 54, y: 38, z: 50 }, target: { x: 0, y: 2, z: 0 }, mode: "orbit" };
  return baseScene(options, sceneId, "智造园区总览", camera, primitives, {
    cameraViews: [{ id: `${prefix}-campus-overview`, name: "园区鸟瞰", camera, createdAt: options.createdAt }],
    defaultCameraViewId: `${prefix}-campus-overview`,
    selectionSets: [{ id: `${prefix}-campus-buildings`, name: "园区建筑", objectIds: [`${prefix}-building-workshop`, `${prefix}-building-warehouse`, `${prefix}-building-office`, `${prefix}-campus-tower`] }]
  });
}

function createWorkshopScene(options: ShowcaseOptions, sceneId: string): SceneSnapshot {
  const prefix = options.showcaseId;
  const floors = [0, 1, 2].map((level) => primitive(`${prefix}-floor-${level + 1}`, `${level + 1} 层结构`, "box", ["#3d6674", "#4b7480", "#5b8290"][level]!, [0, level * 3.1, 0], [28, 0.35, 18], { opacity: 0.88 }));
  const columns = Array.from({ length: 8 }, (_item, index) => primitive(`${prefix}-workshop-column-${index + 1}`, `结构柱 ${index + 1}`, "box", "#7c8c91", [-11 + (index % 4) * 7.3, 4.5, -6 + Math.floor(index / 4) * 12], [0.55, 9, 0.55]));
  const primitives = [
    ...floors,
    ...columns,
    primitive(`${prefix}-workshop-line-shell`, "总装线区域", "box", "#c29a4f", [0, 1.2, 0], [18, 1.2, 5], { opacity: 0.72 }),
    primitive(`${prefix}-workshop-avatar-marker`, "巡检起点", "cylinder", "#54d69a", [-9, 0.5, 5], [0.6, 1, 0.6])
  ];
  const firstPerson: CameraState = { position: { x: -9, y: 1.68, z: 6 }, target: { x: 5, y: 1.55, z: 0 }, mode: "firstPerson", avatarVisible: false };
  const thirdPerson: CameraState = { position: { x: -13, y: 5, z: 12 }, target: { x: -7, y: 1.3, z: 4 }, mode: "thirdPerson", avatarVisible: true };
  const animation = floorExplosionAnimation(prefix, floors);
  return baseScene(options, sceneId, "一号物流车间 · 楼层拆解", thirdPerson, primitives, {
    cameraViews: [
      { id: `${prefix}-workshop-first`, name: "第一人称巡检", camera: firstPerson, createdAt: options.createdAt },
      { id: `${prefix}-workshop-third`, name: "第三人称巡检", camera: thirdPerson, createdAt: options.createdAt },
      { id: `${prefix}-workshop-floors`, name: "楼层拆解", camera: { position: { x: 30, y: 20, z: 26 }, target: { x: 0, y: 4, z: 0 }, mode: "orbit" }, createdAt: options.createdAt }
    ],
    defaultCameraViewId: `${prefix}-workshop-third`,
    animation,
    selectionSets: [{ id: `${prefix}-floor-set`, name: "车间楼层", objectIds: floors.map((floor) => floor.modelId) }]
  });
}

function createLineScene(options: ShowcaseOptions, sceneId: string): SceneSnapshot {
  const prefix = options.showcaseId;
  const agvId = `${prefix}-agv-01`;
  const primitives = [
    primitive(`${prefix}-line-ground`, "产线地坪", "box", "#26343a", [0, -0.25, 0], [34, 0.4, 18]),
    primitive(`${prefix}-line-source`, "Source · 上料", "box", "#4d7897", [-12, 1, 0], [3.5, 2, 4]),
    primitive(`${prefix}-line-process`, "Process · 总装", "box", "#b78947", [-3, 1.3, 0], [6, 2.6, 5]),
    primitive(`${prefix}-line-buffer`, "Buffer · WIP", "box", "#6d8794", [6, 0.65, 0], [5, 1.3, 5]),
    primitive(`${prefix}-line-sink`, "Sink · 下线", "box", "#5a8a6f", [13, 1, 0], [3.5, 2, 4]),
    primitive(`${prefix}-line-robot`, "机器人 A", "cylinder", "#d4a84f", [-3, 3.1, 0], [1.1, 3.6, 1.1], { effects: "#f0bd57" }),
    primitive(agvId, "AGV-01 · 实时位置", "box", "#54d69a", [-12, 0.55, -5], [2.1, 0.7, 1.25], { effects: "#54d69a" }),
    primitive(`${prefix}-agv-02`, "AGV-02 · 实时位置", "box", "#d9ad55", [12, 0.55, 1], [2.1, 0.7, 1.25]),
    primitive(`${prefix}-agv-route-north`, "AGV 路网北段", "box", "#3e5660", [0, 0.02, -5], [26, 0.05, 0.3]),
    primitive(`${prefix}-agv-route-south`, "AGV 路网南段", "box", "#3e5660", [0, 0.02, 5], [26, 0.05, 0.3]),
    primitive(`${prefix}-agv-route-east`, "AGV 路网东段", "box", "#3e5660", [12, 0.02, 0], [0.3, 0.05, 10]),
    primitive(`${prefix}-agv-route-west`, "AGV 路网西段", "box", "#3e5660", [-12, 0.02, 0], [0.3, 0.05, 10])
  ];
  const dataBindings: SceneDataBindingState[] = [
    directSceneBinding(`${prefix}-agv-position`, "AGV-01 实时位置", httpBinding("$.agvs[0].position"), "position", agvId, "position"),
    directSceneBinding(`${prefix}-agv-color`, "AGV-01 实时状态色", websocketBinding("$.agvs[0].color"), "color", agvId, "color"),
    directSceneBinding(`${prefix}-robot-health`, "机器人健康状态", httpBinding("$.equipment[0].color"), "color", `${prefix}-line-robot`, "color")
  ];
  const camera: CameraState = { position: { x: 30, y: 22, z: 26 }, target: { x: 0, y: 1, z: 0 }, mode: "orbit" };
  return baseScene(options, sceneId, "总装产线 · 物流与 AGV", camera, primitives, {
    dataBindings,
    cameraViews: [
      { id: `${prefix}-line-overview`, name: "产线总览", camera, createdAt: options.createdAt },
      { id: `${prefix}-line-agv`, name: "AGV 路网", camera: { position: { x: 0, y: 28, z: 0.1 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }, createdAt: options.createdAt }
    ],
    defaultCameraViewId: `${prefix}-line-overview`,
    selectionSets: [{ id: `${prefix}-agv-set`, name: "AGV 车队", objectIds: [agvId, `${prefix}-agv-02`] }]
  });
}

function createRobotScene(options: ShowcaseOptions, sceneId: string): SceneSnapshot {
  const prefix = options.showcaseId;
  const parts = [
    primitive(`${prefix}-robot-base`, "机器人底座", "cylinder", "#455a65", [0, 0.7, 0], [3.6, 1.4, 3.6]),
    primitive(`${prefix}-robot-shoulder`, "机器人肩部", "sphere", "#d4a84f", [0, 2.5, 0], [2.2, 2.2, 2.2], { effects: "#f4c76b" }),
    primitive(`${prefix}-robot-arm-a`, "大臂", "box", "#c8923f", [0, 5.1, 0], [1.6, 4.2, 1.6]),
    primitive(`${prefix}-robot-elbow`, "肘关节", "sphere", "#455a65", [0, 7.4, 0], [1.55, 1.55, 1.55]),
    primitive(`${prefix}-robot-arm-b`, "小臂", "box", "#d3a04c", [2.1, 8.2, 0], [4.2, 1.35, 1.35], { rotation: [0, 0, -0.32] }),
    primitive(`${prefix}-robot-wrist`, "腕部", "sphere", "#455a65", [4.3, 8.9, 0], [1.25, 1.25, 1.25]),
    primitive(`${prefix}-robot-tool`, "末端夹具", "box", "#6d8794", [5.7, 9, 0], [1.8, 0.85, 1.8])
  ];
  const camera: CameraState = { position: { x: 18, y: 12, z: 18 }, target: { x: 1.5, y: 4.5, z: 0 }, mode: "orbit" };
  return baseScene(options, sceneId, "机器人 A · 部件拆解与健康", camera, parts, {
    animation: componentExplosionAnimation(prefix, parts),
    cameraViews: [
      { id: `${prefix}-robot-overview`, name: "机器人总览", camera, createdAt: options.createdAt },
      { id: `${prefix}-robot-exploded`, name: "部件拆解", camera: { position: { x: 25, y: 14, z: 22 }, target: { x: 1, y: 5, z: 0 }, mode: "orbit" }, createdAt: options.createdAt }
    ],
    defaultCameraViewId: `${prefix}-robot-overview`,
    dataBindings: [directSceneBinding(`${prefix}-robot-detail-health`, "机器人健康颜色", websocketBinding("$.equipment[0].color"), "color", `${prefix}-robot-shoulder`, "color")],
    selectionSets: [{ id: `${prefix}-robot-parts`, name: "机器人全部部件", objectIds: parts.map((part) => part.modelId) }]
  });
}

function baseScene(
  options: ShowcaseOptions,
  id: string,
  name: string,
  camera: CameraState,
  primitives: PrimitiveState[],
  overrides: Partial<SceneSnapshot> = {}
): SceneSnapshot {
  return {
    schemaVersion: 1,
    id,
    projectId: options.projectId,
    name,
    camera,
    cameraConstraints: BASE_CAMERA_CONSTRAINTS,
    navigationSettings: BASE_NAVIGATION,
    cameraViews: [],
    models: [],
    primitives,
    measurements: [],
    annotations: [],
    weather: "sunny",
    lighting: BASE_LIGHTING,
    environment: BASE_ENVIRONMENT,
    postProcessing: BASE_POST_PROCESSING,
    physics: { enabled: false, playing: false, gravity: { x: 0, y: -9.81, z: 0 } },
    animation: EMPTY_ANIMATION,
    dataBindings: [],
    interactions: [],
    selectionSets: [],
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
    ...overrides
  };
}

function primitive(
  modelId: string,
  name: string,
  kind: PrimitiveKind,
  color: string,
  position: [number, number, number],
  scale: [number, number, number],
  options: { collisionEnabled?: boolean; opacity?: number; rotation?: [number, number, number]; effects?: string } = {}
): PrimitiveState {
  return {
    modelId,
    name,
    kind,
    color,
    visible: true,
    opacity: options.opacity ?? 1,
    transform: transform(position, options.rotation ?? [0, 0, 0], scale),
    collisionEnabled: options.collisionEnabled ?? false,
    material: { color, roughness: 0.66, metalness: 0.12 },
    ...(options.effects ? { effects: { outline: true, glow: true, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: true, color: options.effects, intensity: 0.52 } } : {})
  };
}

function transform(position: [number, number, number], rotation: [number, number, number], scale: [number, number, number]): ModelTransform {
  return {
    position: { x: position[0], y: position[1], z: position[2] },
    rotation: { x: rotation[0], y: rotation[1], z: rotation[2] },
    scale: { x: scale[0], y: scale[1], z: scale[2] }
  };
}

function floorExplosionAnimation(prefix: string, floors: PrimitiveState[]): SceneAnimationState {
  return {
    duration: 12,
    loop: true,
    pingPong: true,
    playbackSpeed: 0.7,
    cameraInterpolation: "smooth",
    showCameraPath: false,
    camera: [],
    models: floors.flatMap((floor, index) => [
      { id: `${prefix}-floor-${index + 1}-closed`, time: 0, modelId: floor.modelId, transform: structuredClone(floor.transform) },
      { id: `${prefix}-floor-${index + 1}-open`, time: 12, modelId: floor.modelId, transform: { ...structuredClone(floor.transform), position: { ...floor.transform.position, y: floor.transform.position.y + index * 3.4 } } }
    ])
  };
}

function componentExplosionAnimation(prefix: string, parts: PrimitiveState[]): SceneAnimationState {
  return {
    duration: 10,
    loop: true,
    pingPong: true,
    playbackSpeed: 0.65,
    cameraInterpolation: "smooth",
    showCameraPath: false,
    camera: [],
    models: parts.flatMap((part, index) => {
      const angle = index / Math.max(1, parts.length - 1) * Math.PI * 2;
      return [
        { id: `${prefix}-part-${index}-closed`, time: 0, modelId: part.modelId, transform: structuredClone(part.transform) },
        { id: `${prefix}-part-${index}-open`, time: 10, modelId: part.modelId, transform: { ...structuredClone(part.transform), position: { x: part.transform.position.x + Math.cos(angle) * 4.8, y: part.transform.position.y + (index - 2) * 0.8, z: part.transform.position.z + Math.sin(angle) * 4.8 } } }
      ];
    })
  };
}

function campusPage(prefix: string, id: string, sceneId: string): DashboardPageDocument {
  return page(id, "01 · 园区运营总览", [
    sceneViewport(`${prefix}-viewport-campus`, sceneId, { x: 0, y: 0, width: 2_520, height: PAGE_HEIGHT }, 0),
    textNode(`${prefix}-campus-title`, { x: 72, y: 68, width: 1_560, height: 140 }, "智造园区 · 运营驾驶舱", "从总览下钻到车间、产线与设备；所有内容可编辑、发布并离线复现。", 10),
    metricNode(`${prefix}-kpi-output`, { x: 2_590, y: 80, width: 540, height: 260 }, "当班产量", "factory.output", "value", "件", httpBinding("$.factory.output"), 2),
    metricNode(`${prefix}-kpi-plan`, { x: 3_210, y: 80, width: 540, height: 260 }, "计划达成率", "factory.planRate", "gauge", "%", httpBinding("$.factory.planRate"), 3),
    metricNode(`${prefix}-kpi-utilization`, { x: 2_590, y: 390, width: 540, height: 260 }, "设备利用率", "factory.utilization", "gauge", "%", websocketBinding("$.factory.utilization"), 4),
    metricNode(`${prefix}-kpi-alarm`, { x: 3_210, y: 390, width: 540, height: 260 }, "活动告警", "factory.alarmCount", "value", "条", websocketBinding("$.factory.alarmCount"), 5, "#f26b5e"),
    dataNode(`${prefix}-campus-trend`, { x: 2_590, y: 710, width: 1_160, height: 420 }, 6, { title: "产量趋势", key: "factory.history", type: "area", unit: "件", color: "#54d69a", backgroundColor: "#152126", backgroundOpacity: 0.92, directBinding: httpBinding("$.history[23].output"), animation: "fade" }),
    dataNode(`${prefix}-campus-layout`, { x: 2_590, y: 1_190, width: 720, height: 830 }, 7, { title: "园区平面与下钻路径", key: "media.layout", type: "image", unit: "", imageUrl: "/showcase/plant-layout.svg", imageFit: "contain", backgroundColor: "#101a1f", backgroundOpacity: 0.96 }),
    dataNode(`${prefix}-campus-monitor`, { x: 3_350, y: 1_190, width: 400, height: 520 }, 8, { title: "一号车间 · 实时监控", key: "media.monitor", type: "monitor", unit: "", monitorProtocol: "webrtc", videoUrl: "/showcase/live-monitor.html", videoFit: "cover", videoAutoplay: true, videoMuted: true, backgroundColor: "#101a1f", backgroundOpacity: 0.96 }),
    actionNode(`${prefix}-nav-workshop`, { x: 3_350, y: 1_750, width: 400, height: 270 }, "进入一号车间", "楼层拆解 · 第一/第三人称", 9)
  ]);
}

function workshopPage(prefix: string, id: string, sceneId: string): DashboardPageDocument {
  return page(id, "02 · 一号物流车间", [
    sceneViewport(`${prefix}-viewport-workshop`, sceneId, { x: 0, y: 0, width: 3_020, height: PAGE_HEIGHT }, 0),
    textNode(`${prefix}-workshop-title`, { x: 72, y: 68, width: 1_620, height: 140 }, "一号物流车间 · 楼层与巡检", "使用三维视口右下角播放控件控制楼层拆解，巡检视角可在第一/第三人称间切换。", 10),
    actionNode(`${prefix}-camera-first`, { x: 3_090, y: 100, width: 660, height: 230 }, "第一人称巡检", "碰撞、重力、台阶与斜坡配置已启用", 2),
    actionNode(`${prefix}-camera-third`, { x: 3_090, y: 370, width: 660, height: 230 }, "第三人称巡检", "跟随角色并保留空间上下文", 3),
    metricNode(`${prefix}-workshop-wip`, { x: 3_090, y: 650, width: 310, height: 260 }, "在制品 WIP", "factory.wip", "value", "件", websocketBinding("$.factory.wip"), 4),
    metricNode(`${prefix}-workshop-cycle`, { x: 3_440, y: 650, width: 310, height: 260 }, "平均节拍", "factory.cycleTime", "value", "s", httpBinding("$.factory.cycleTime"), 5),
    dataNode(`${prefix}-workshop-video`, { x: 3_090, y: 970, width: 660, height: 640 }, 6, { title: "产线作业视频", key: "media.video", type: "video", unit: "", videoUrl: "/showcase/line-loop.mp4", videoFit: "cover", videoAutoplay: true, videoMuted: true, backgroundColor: "#101a1f", backgroundOpacity: 0.96 }),
    actionNode(`${prefix}-nav-line`, { x: 3_090, y: 1_670, width: 660, height: 350 }, "下钻总装产线", "Source / Process / Buffer / Sink / AGV", 7)
  ]);
}

function linePage(prefix: string, id: string, sceneId: string): DashboardPageDocument {
  return page(id, "03 · 总装产线与 AGV", [
    sceneViewport(`${prefix}-viewport-line`, sceneId, { x: 0, y: 0, width: 2_790, height: PAGE_HEIGHT }, 0),
    textNode(`${prefix}-line-title`, { x: 72, y: 68, width: 1_700, height: 140 }, "总装产线 · 物流与 AGV", "AGV-01 位置由 HTTP 轮询驱动，状态颜色与速度由 WebSocket 实时推送。", 10),
    metricNode(`${prefix}-agv-speed`, { x: 2_860, y: 90, width: 430, height: 260 }, "AGV-01 速度", "agv.speed", "value", "m/s", websocketBinding("$.agvs[0].speed"), 2, "#54d69a"),
    metricNode(`${prefix}-agv-status`, { x: 3_340, y: 90, width: 410, height: 260 }, "AGV-01 状态", "agv.status", "status", "", websocketBinding("$.agvs[0].status"), 3),
    metricNode(`${prefix}-line-cycle`, { x: 2_860, y: 400, width: 430, height: 260 }, "产线节拍", "line.cycle", "gauge", "s", httpBinding("$.factory.cycleTime"), 4),
    metricNode(`${prefix}-line-wip`, { x: 3_340, y: 400, width: 410, height: 260 }, "缓冲区 WIP", "line.wip", "value", "件", httpBinding("$.factory.wip"), 5),
    dataNode(`${prefix}-equipment-table`, { x: 2_860, y: 710, width: 890, height: 610 }, 6, { title: "设备健康明细", key: "equipment.rows", type: "table", unit: "", field: "health", backgroundColor: "#142027", backgroundOpacity: 0.96, directBinding: websocketBinding("$.equipment") }),
    actionNode(`${prefix}-data-evidence`, { x: 2_860, y: 1_370, width: 430, height: 300 }, "直连证据", "HTTP + WebSocket · 同一服务器网关", 7),
    actionNode(`${prefix}-nav-robot`, { x: 3_340, y: 1_370, width: 410, height: 300 }, "定位机器人 A", "部件拆解与健康告警", 8),
    textNode(`${prefix}-line-topology-note`, { x: 2_860, y: 1_720, width: 890, height: 300 }, "物流拓扑已内置", "在顶部切换到“拓扑”可编辑 Source、Process、Buffer、Sink、AGV 节点与边。", 9)
  ]);
}

function robotPage(prefix: string, id: string, sceneId: string): DashboardPageDocument {
  return page(id, "04 · 机器人单元", [
    sceneViewport(`${prefix}-viewport-robot`, sceneId, { x: 0, y: 0, width: 2_760, height: PAGE_HEIGHT }, 0),
    textNode(`${prefix}-robot-title`, { x: 72, y: 68, width: 1_700, height: 140 }, "机器人 A · 部件拆解与健康", "播放拆解时间线检查部件层级；温度、振动、健康与告警来自同一份可追踪模拟数据。", 10),
    metricNode(`${prefix}-robot-temperature`, { x: 2_830, y: 90, width: 430, height: 280 }, "轴承温度", "robot.temperature", "gauge", "°C", websocketBinding("$.equipment[0].temperature"), 2, "#f1b45b"),
    metricNode(`${prefix}-robot-vibration`, { x: 3_320, y: 90, width: 430, height: 280 }, "振动 RMS", "robot.vibration", "gauge", "mm/s", websocketBinding("$.equipment[0].vibration"), 3, "#63a7ff"),
    metricNode(`${prefix}-robot-health`, { x: 2_830, y: 430, width: 430, height: 280 }, "健康度", "robot.health", "gauge", "%", httpBinding("$.equipment[0].health"), 4, "#54d69a"),
    metricNode(`${prefix}-robot-alarm`, { x: 3_320, y: 430, width: 430, height: 280 }, "告警状态", "robot.alarm", "status", "", websocketBinding("$.equipment[0].alarm"), 5),
    dataNode(`${prefix}-robot-monitor`, { x: 2_830, y: 780, width: 920, height: 690 }, 6, { title: "机器人单元 · 实时监控", key: "robot.monitor", type: "monitor", unit: "", monitorProtocol: "webrtc", videoUrl: "/showcase/live-monitor.html?camera=robot-a", videoFit: "cover", videoAutoplay: true, videoMuted: true, backgroundColor: "#101a1f", backgroundOpacity: 0.96 }),
    dataNode(`${prefix}-robot-history`, { x: 2_830, y: 1_530, width: 920, height: 490 }, 7, { title: "温度趋势", key: "robot.temperature.history", type: "line", unit: "°C", color: "#f1b45b", backgroundColor: "#142027", backgroundOpacity: 0.96, directBinding: websocketBinding("$.equipment[0].temperature") })
  ]);
}

function page(id: string, name: string, nodes: Array<SceneViewportWidgetNode | DashboardDataWidgetNode>): DashboardPageDocument {
  return {
    id,
    name,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    viewportFit: "contain",
    appearance: { backgroundColor: "#0a1115", backgroundOpacity: 1, blur: 0, borderRadius: 0 },
    nodes
  };
}

function sceneViewport(id: string, sceneId: string, frame: WidgetFrame, zIndex: number): SceneViewportWidgetNode {
  return { id, kind: "scene-viewport", frame, zIndex, sceneId, renderMode: "realtime", interactionPolicy: "full-navigation", overlaySlot: "page" };
}

function metricNode(id: string, frame: WidgetFrame, title: string, key: string, type: DashboardDataWidgetConfig["type"], unit: string, directBinding: DirectBindingSpec, zIndex: number, color = "#d9ad55"): DashboardDataWidgetNode {
  return dataNode(id, frame, zIndex, { title, key, type, unit, min: 0, max: type === "gauge" && unit === "s" ? 60 : 100, color, backgroundColor: "#142027", backgroundOpacity: 0.96, textColor: "#f1f5f6", directBinding, animation: "slide-up", animationDuration: 0.5 });
}

function textNode(id: string, frame: WidgetFrame, title: string, content: string, zIndex: number): DashboardDataWidgetNode {
  return dataNode(id, frame, zIndex, { title, key: id, type: "text", unit: "", content: `${title}\n${content}`, fontSize: 42, fontWeight: 720, textAlign: "left", textColor: "#eef5f6", backgroundColor: "#0d171c", backgroundOpacity: 0.88 });
}

function actionNode(id: string, frame: WidgetFrame, title: string, content: string, zIndex: number): DashboardDataWidgetNode {
  return dataNode(id, frame, zIndex, { title, key: id, type: "text", unit: "", content: `${title}\n${content}`, fontSize: 34, fontWeight: 700, textAlign: "left", textColor: "#f3e4bf", backgroundColor: "#263027", backgroundOpacity: 0.98, borderColor: "#8e7647", borderWidth: 2, animation: "scale", animationDuration: 0.35 });
}

function dataNode(id: string, frame: WidgetFrame, zIndex: number, widget: DashboardDataWidgetConfig): DashboardDataWidgetNode {
  return { id, kind: "data-widget", frame, zIndex, widget };
}

function httpBinding(jsonPath: string): DirectBindingSpec {
  return {
    version: 1,
    gateway: "server",
    transport: "http",
    endpoint: "/api/public/demo/industrial",
    access: "read-only",
    selection: { jsonPath },
    http: { method: "GET", refresh: { intervalMs: 1_000, immediate: true } }
  };
}

function websocketBinding(jsonPath: string): DirectBindingSpec {
  return {
    version: 1,
    gateway: "server",
    transport: "websocket",
    endpoint: "/api/public/demo/industrial/ws",
    access: "read-only",
    selection: { jsonPath },
    websocket: { reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 8_000, multiplier: 2 } }
  };
}

function directSceneBinding(id: string, name: string, directBinding: DirectBindingSpec, field: string, modelId: string, action: SceneDataBindingState["action"]): SceneDataBindingState {
  return { id, name, enabled: true, directBinding, field, target: { modelId }, action, refreshSeconds: 2 };
}

function navigationFlow(id: string, sourceId: string, targetSceneId: string, sourceSceneId?: string): InteractionFlow {
  return {
    id,
    name: "空间下钻",
    source: sourceSceneId ? { kind: "object", sceneId: sourceSceneId, modelId: sourceId } : { kind: "widget", id: sourceId },
    trigger: "click",
    enabled: true,
    actions: [{ id: `${id}-action`, type: "navigateScene", enabled: true, sceneId: targetSceneId }]
  };
}

function cameraFlow(id: string, sourceId: string, sceneId: string, cameraViewId: string): InteractionFlow {
  return { id, name: "巡检视角切换", source: { kind: "widget", id: sourceId }, trigger: "click", enabled: true, actions: [{ id: `${id}-action`, type: "cameraView", enabled: true, sceneId, cameraViewId }] };
}

function messageFlow(id: string, sourceId: string, message: string): InteractionFlow {
  return { id, name: "显示数据证据", source: { kind: "widget", id: sourceId }, trigger: "click", enabled: true, actions: [{ id: `${id}-action`, type: "message", enabled: true, message }] };
}

function sceneDocument(snapshot: SceneSnapshot): SceneDocument {
  const source = structuredClone(snapshot);
  delete (source as Partial<SceneSnapshot>).schemaVersion;
  delete (source as Partial<SceneSnapshot>).projectId;
  delete (source as Partial<SceneSnapshot>).dashboard;
  delete (source as Partial<SceneSnapshot>).interactions;
  delete (source as Partial<SceneSnapshot>).publishedAt;
  delete (source as Partial<SceneSnapshot>).createdAt;
  delete (source as Partial<SceneSnapshot>).updatedAt;
  return source as unknown as SceneDocument;
}
