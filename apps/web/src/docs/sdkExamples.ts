import type { ScriptModule } from "@bim-studio/contracts";

export type SdkExampleId = "lifecycle" | "read-variable" | "scene-events";

export interface SdkExample {
  id: SdkExampleId;
  title: string;
  fileName: string;
  summary: string;
  context: string;
  expectedResult: string;
  editHint: string;
  apis: readonly string[];
  code: string;
  lifecycle: ScriptModule["lifecycle"];
  capabilities: ScriptModule["capabilities"];
  permissions: ScriptModule["permissions"];
}

/** 可插入样例与展示源码共用一个来源；只使用当前 Worker 合同中的只读能力。 */
export const SDK_EXAMPLES: readonly SdkExample[] = [
  {
    id: "lifecycle",
    title: "认识脚本生命周期",
    fileName: "sdk-lifecycle.js",
    summary: "启动时读取 API 版本，结束时进入统一的资源清理函数。",
    context: "整个场景 · 无需模型、变量或项目依赖",
    expectedResult: "运行后出现“SDK 样例已启动”，日志详情包含 API 版本和场景标识。",
    editHint: "修改 message，再点“运行”即可核对最新草稿输出。",
    apis: ["studio.version", "studio.log(message, payload?)", "ctx.sceneId"],
    lifecycle: ["onStart", "onDispose"],
    capabilities: ["studio.runtime"],
    permissions: [],
    code: `const message = "SDK 样例已启动";

function onStart(ctx) {
  studio.log(message, {
    apiVersion: studio.version,
    sceneId: ctx.sceneId
  });
}

function onDispose() {
  // 在这里清理脚本自己创建的资源；本例没有额外资源。
}`,
  },
  {
    id: "read-variable",
    title: "读取应用变量",
    fileName: "sdk-read-variable.js",
    summary: "读取当前运行副本的变量，明确处理缺值和非数值。",
    context: "整个场景 · 可先无数据运行，再替换为项目已有变量键",
    expectedResult: "没有变量时提示“变量尚无数据”；数值有效时输出数值、阈值与判断结果。",
    editHint: "将 dataKey 改为项目数据键，按实际单位设置 threshold。",
    apis: ["studio.getData(key)", "studio.log(message, payload?)"],
    lifecycle: ["onStart", "onData"],
    capabilities: ["studio.runtime", "studio.data"],
    permissions: ["data.read"],
    code: `const dataKey = "device.temperature";
const threshold = 80;

function reportValue() {
  const raw = studio.getData(dataKey);
  if (raw === undefined || raw === null || raw === "") {
    studio.log("变量尚无数据", { dataKey });
    return;
  }
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value)) {
    studio.log("变量不是有效数值", { dataKey });
    return;
  }
  studio.log("变量读取结果", {
    dataKey, value, threshold, aboveThreshold: value > threshold
  });
}

function onStart() { reportValue(); }
function onData() { reportValue(); }`,
  },
  {
    id: "scene-events",
    title: "观察场景点击事件",
    fileName: "sdk-scene-events.js",
    summary: "在生命周期中接收场景事件，按名称筛选并查看目标。",
    context: "整个场景 · 空场景可启动，有对象时可验证点击事件",
    expectedResult: "启动后提示等待事件；在试运行视口点击对象，输出“收到场景事件”。",
    editHint: "调整 eventName 可观察其他事件；用日志中的目标信息继续编写业务逻辑。",
    apis: ["ctx.event.name", "ctx.event.target", "studio.log(message, payload?)"],
    lifecycle: ["onStart", "onEvent"],
    capabilities: ["studio.runtime", "studio.input"],
    permissions: [],
    code: `const eventName = "click";

function onStart() {
  studio.log("正在等待场景事件", { eventName });
}

function onEvent(ctx) {
  if (ctx.event?.name !== eventName) return;
  studio.log("收到场景事件", {
    name: ctx.event.name,
    target: ctx.event.target ?? null
  });
}`,
  },
];

export function getSdkExample(id: string): SdkExample | undefined {
  return SDK_EXAMPLES.find(example => example.id === id);
}
