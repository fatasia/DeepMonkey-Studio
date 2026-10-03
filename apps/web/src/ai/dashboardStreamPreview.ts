/**
 * H-C5-T7:dashboard 流式布局预览。
 *
 * 流式期(`dashboardAssistantStreamText` 剥离出的可见文本之外)服务端在产出结构化
 * JSON;此前用户在 shimmer 与"查看并应用"按钮之间只能看到文字,布局形态不可感知。
 * 本解析器对**截断中的**流式 JSON 做容错提取:已完整闭合的 widget 对象逐个收录,
 * 半截对象与外层残缺一律忽略(fail-quiet——预览是增强面,坏数据绝不冒充可用草稿)。
 */

export interface DashboardStreamPreview {
  /** 已完整解析出的 widget 标题/类型(流式顺序)。 */
  readonly labels: string[];
  /** 已完整解析出的 widget 类型集合(去重,保序)。 */
  readonly types: string[];
  /** 是否已见到 widgets 数组开势(还在产出中)。 */
  readonly inProgress: boolean;
}

/** 容错补齐外层括号后尝试 parse;失败返回 undefined。 */
function tryParseTruncated(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  for (const suffix of ["", "}", "]}", '"}]}']) {
    try { return JSON.parse(`${trimmed}${suffix}`); } catch { /* 继续补齐 */ }
  }
  return undefined;
}

/** 从截断文本中逐个提取已完整闭合的 { ... } 对象字面量(字符串感知)。 */
function* completeObjects(text: string): Generator<Record<string, unknown>> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") { if (depth === 0) start = index; depth += 1; continue; }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { yield JSON.parse(text.slice(start, index + 1)) as Record<string, unknown>; } catch { /* 单对象坏,跳过 */ }
        start = -1;
      }
    }
  }
}

export function parseDashboardStreamPreview(rawStream: string): DashboardStreamPreview {
  const labels: string[] = [];
  const types: string[] = [];
  let inProgress = false;
  // 服务端结构两种形态:整页对象 { widgets: [...] } 或 widgets 直接数组文本。
  const widgetsStart = rawStream.indexOf('"widgets"');
  const arrayStart = rawStream.indexOf("[", widgetsStart >= 0 ? widgetsStart : 0);
  if (widgetsStart >= 0 || (arrayStart >= 0 && rawStream.trimStart().startsWith("["))) inProgress = true;
  if (arrayStart < 0) {
    // 数组未开:外层对象或标量字段流式期,无 widget 可预览。
    return { labels, types, inProgress };
  }
  const arrayText = rawStream.slice(arrayStart);
  for (const object of completeObjects(arrayText)) {
    const title = typeof object.title === "string" ? object.title : undefined;
    const type = typeof object.type === "string" ? object.type : undefined;
    if (title) labels.push(title);
    else if (type) labels.push(type);
    if (type && !types.includes(type)) types.push(type);
  }
  return { labels, types, inProgress };
}
