import type { BimSpaceRecord, ComponentRecord } from "./viewer/ViewerEngine";

export type BimQuestionIntent = "count" | "location" | "property" | "dimension" | "placement" | "overview";

export interface BimBoundsValue {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
}

export interface BimAssistantComponentEvidence {
  id: string;
  stableId: string;
  modelId: string;
  modelName: string;
  name: string;
  type: string;
  category?: string;
  level?: string;
  properties: Record<string, string>;
  bounds?: BimBoundsValue;
  space?: { id: string; name: string; number?: string; level: string };
}

export interface BimPlacementEvidence {
  requestedSizeMetres: { length: number; width: number; height: number };
  source?: Pick<BimAssistantComponentEvidence, "id" | "stableId" | "modelId" | "name">;
  target?: Pick<BimAssistantComponentEvidence, "id" | "stableId" | "modelId" | "name">;
  status: "fits" | "blocked" | "insufficient-data";
  availableGapMetres?: number;
  requiredGapMetres?: number;
  clearanceMetres?: number;
  axis?: "x" | "z";
  candidateCenter?: { x: number; y: number; z: number };
  note: string;
}

export interface BimAssistantPreparedContext {
  schema: "bim-studio/bim-assistant-context@1";
  question: string;
  intents: BimQuestionIntent[];
  confidence: "exact" | "inferred" | "insufficient";
  scene: {
    modelCount: number;
    componentCount: number;
    spaceCount: number;
    levels: string[];
    levelCounts: Array<{ name: string; count: number }>;
    categories: Array<{ name: string; count: number }>;
    systems: Array<{ name: string; count: number }>;
  };
  query: { aliases: string[]; requestedSizeMetres?: { length: number; width: number; height: number } };
  matchCount: number;
  matches: BimAssistantComponentEvidence[];
  placement?: BimPlacementEvidence;
  limitations: string[];
}

export interface BimQuestionPlan {
  intents: BimQuestionIntent[];
  aliases: string[];
  requestedSizeMetres?: { length: number; width: number; height: number };
  matches: ComponentRecord[];
  matchCount: number;
}

const ALIAS_GROUPS: string[][] = [
  ["摄像头", "监控", "camera", "cctv", "ipc", "video surveillance"],
  ["墙", "墙体", "墙面", "wall", "ifcwall", "basic wall"],
  ["门", "door", "ifcdoor"],
  ["窗", "window", "ifcwindow"],
  ["楼板", "地板", "floor", "slab", "ifcslab"],
  ["梁", "beam", "ifcbeam"],
  ["柱", "column", "ifccolumn"],
  ["管道", "管线", "pipe", "ifcpipe"],
  ["风管", "duct", "ifcduct"],
  ["阀门", "valve"],
  ["泵", "pump"],
  ["传感器", "sensor", "探测器", "detector"],
  ["灯", "灯具", "light", "lighting fixture"],
  ["消防栓", "消火栓", "hydrant"],
  ["喷淋", "喷头", "sprinkler"],
  ["配电柜", "电柜", "switchboard", "panelboard"],
  ["变压器", "transformer"],
  ["开关柜", "switchgear"],
  ["配电箱", "distribution board", "distribution panel"],
  ["桥架", "电缆桥架", "cable tray", "cable carrier"],
  ["电缆", "cable", "wire"],
  ["母线", "busbar", "busway"],
  ["插座", "socket", "receptacle"],
  ["发电机", "generator", "genset"],
  ["ups", "不间断电源", "uninterruptible power"],
  ["空调", "ahu", "air handling", "hvac"],
  ["冷水机", "冷水机组", "chiller"],
  ["冷却塔", "cooling tower"],
  ["风机", "fan", "blower"],
  ["排风", "exhaust", "extract air"],
  ["新风", "fresh air", "outdoor air"],
  ["水管", "给水", "water supply", "domestic water"],
  ["排水", "污水", "废水", "drain", "wastewater", "sewage"],
  ["压缩空气", "空压", "compressed air", "cda"],
  ["天然气", "燃气", "gas pipe", "natural gas"],
  ["蒸汽", "steam"],
  ["机台", "生产设备", "equipment", "machine", "tool"],
  ["基础", "foundation", "footing"],
  ["桩", "pile", "ifcpile"],
  ["屋顶", "屋面", "roof", "ifcroof"],
  ["幕墙", "curtain wall", "ifccurtainwall"],
  ["钢筋", "rebar", "reinforcing bar"],
  ["支吊架", "支架", "hanger", "support"],
  ["电梯", "elevator", "lift"],
  ["楼梯", "stair", "ifcstair"],
  ["房间", "空间", "room", "space", "ifcspace"]
];

const STOP_WORDS = new Set(["请", "帮我", "查询", "查找", "告诉我", "一下", "这个", "那个", "某个", "多少", "有", "哪些", "什么", "哪里", "位置", "位于", "是否", "可以", "能否", "放下", "设备", "构件", "模型", "场景", "属性", "信息", "的", "和", "与", "之间"]);

export function planBimQuestion(question: string, records: ComponentRecord[]): BimQuestionPlan {
  const normalized = normalize(question);
  const intents = detectIntents(normalized);
  const requestedSizeMetres = parseRequestedSize(question);
  if (requestedSizeMetres && !intents.includes("placement")) intents.push("placement");
  const aliasGroups = ALIAS_GROUPS.filter((group) => group.some((alias) => normalized.includes(normalize(alias))));
  const explicit = extractExplicitTerms(question, records);
  const aliases = unique([...aliasGroups.flat(), ...explicit]);
  const requestedLevels = unique(records.map((record) => record.level).filter((value): value is string => Boolean(value && normalized.includes(normalize(value)))));
  const scored = records
    .filter((record) => requestedLevels.length === 0 || Boolean(record.level && requestedLevels.includes(record.level)))
    .map((record) => ({ record, score: componentScore(record, normalized, aliases) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name, "zh-CN"));
  const matches = scored.map((item) => item.record);
  return { intents, aliases, ...(requestedSizeMetres ? { requestedSizeMetres } : {}), matches, matchCount: matches.length };
}

export function parseRequestedSize(question: string): { length: number; width: number; height: number } | undefined {
  const match = question.match(/(\d+(?:\.\d+)?)\s*(mm|cm|m|毫米|厘米|米)?\s*[×xX*＊]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|毫米|厘米|米)?\s*[×xX*＊]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|毫米|厘米|米)?/i);
  if (!match) return undefined;
  const sharedUnit = match[6] || match[4] || match[2] || "m";
  return {
    length: toMetres(Number(match[1]), match[2] || sharedUnit),
    width: toMetres(Number(match[3]), match[4] || sharedUnit),
    height: toMetres(Number(match[5]), match[6] || sharedUnit)
  };
}

export function associateSpace(bounds: BimBoundsValue | undefined, modelId: string, spaces: BimSpaceRecord[]): BimSpaceRecord | undefined {
  if (!bounds) return undefined;
  const candidates = spaces.filter((space) => space.modelId === modelId && space.bounds && containsPoint(space.bounds, bounds.center));
  return candidates.sort((a, b) => boundsVolume(a.bounds!) - boundsVolume(b.bounds!))[0];
}

export function evaluatePlacement(size: { length: number; width: number; height: number }, components: BimAssistantComponentEvidence[]): BimPlacementEvidence {
  const [source, target] = components.filter((item) => item.bounds).slice(0, 2);
  if (!source?.bounds || !target?.bounds) return { requestedSizeMetres: size, status: "insufficient-data", note: "需要明确两个具有几何边界的构件，才能计算中间净空。" };
  const deltaX = Math.abs(source.bounds.center.x - target.bounds.center.x);
  const deltaZ = Math.abs(source.bounds.center.z - target.bounds.center.z);
  const axis = deltaX >= deltaZ ? "x" : "z";
  const first = source.bounds.center[axis] <= target.bounds.center[axis] ? source : target;
  const second = first === source ? target : source;
  const firstBounds = first.bounds!;
  const secondBounds = second.bounds!;
  const gap = Math.max(0, secondBounds.min[axis] - firstBounds.max[axis]);
  const horizontalSizes = [size.length, size.width];
  const required = Math.min(...horizontalSizes);
  const orthogonal = axis === "x" ? "z" : "x";
  const overlap = Math.max(0, Math.min(source.bounds.max[orthogonal], target.bounds.max[orthogonal]) - Math.max(source.bounds.min[orthogonal], target.bounds.min[orthogonal]));
  const requiredOrthogonal = Math.max(...horizontalSizes);
  const heightAvailable = Math.max(source.bounds.max.y, target.bounds.max.y) - Math.max(source.bounds.min.y, target.bounds.min.y);
  const fits = gap >= required && (overlap === 0 || overlap >= requiredOrthogonal) && heightAvailable >= size.height;
  const candidateCenter = {
    x: axis === "x" ? (firstBounds.max.x + secondBounds.min.x) / 2 : (source.bounds.center.x + target.bounds.center.x) / 2,
    y: Math.max(source.bounds.min.y, target.bounds.min.y) + size.height / 2,
    z: axis === "z" ? (firstBounds.max.z + secondBounds.min.z) / 2 : (source.bounds.center.z + target.bounds.center.z) / 2
  };
  return {
    requestedSizeMetres: size,
    source: evidenceRef(source),
    target: evidenceRef(target),
    status: fits ? "fits" : "blocked",
    availableGapMetres: gap,
    requiredGapMetres: required,
    clearanceMetres: gap - required,
    axis,
    candidateCenter,
    note: fits ? "轴对齐包围盒初筛通过；落位前仍需进行精确碰撞检测。" : "轴对齐包围盒初筛未通过，当前净空不足或横向/高度重叠范围不足。"
  };
}

export function relevantProperties(properties: Record<string, string>, question: string): Record<string, string> {
  const materialQuestion = /(材质|材料|混凝土|concrete|material)/i.test(question);
  const dimensionQuestion = /(尺寸|长|宽|高|厚|直径|半径|标高|面积|体积|length|width|height|thickness|diameter|area|volume)/i.test(question);
  const important = /(name|名称|编号|编码|mark|tag|asset|设备位号|type|类型|category|类别|level|楼层|storey|floor|房间|空间|room|zone|区域|material|材质|材料|混凝土|length|width|height|thickness|diameter|radius|area|volume|长|宽|高|厚|直径|半径|面积|体积|坐标|location|system|系统|回路|circuit|voltage|电压|current|电流|power|功率|capacity|容量|flow|流量|pressure|压力|temperature|温度|fire rating|耐火|phase|相位|manufacturer|厂家|型号|model|serial|序列号|installation|安装|maintenance|检修)/i;
  return Object.fromEntries(Object.entries(properties).filter(([key]) => important.test(key) && (!materialQuestion || /(material|材质|材料|混凝土)/i.test(key) || dimensionQuestion)).slice(0, 40));
}

function detectIntents(question: string): BimQuestionIntent[] {
  const intents: BimQuestionIntent[] = [];
  if (/(多少|数量|几个|统计|count)/i.test(question)) intents.push("count");
  if (/(哪里|位置|位于|楼层|房间|空间|坐标|定位|location|where)/i.test(question)) intents.push("location");
  if (/(材质|材料|属性|参数|信息|类型|编号|material|property)/i.test(question)) intents.push("property");
  if (/(尺寸|长度|宽度|高度|厚度|直径|面积|体积|标高|测量|dimension|length|width|height)/i.test(question)) intents.push("dimension");
  if (/(放下|放置|安装|净空|碰撞|间距|容纳|fit|clearance|place)/i.test(question)) intents.push("placement");
  if (intents.length === 0) intents.push("overview");
  return intents;
}

function extractExplicitTerms(question: string, records: ComponentRecord[]): string[] {
  const quoted = [...question.matchAll(/[“”"']([^“”"']{2,40})[“”"']/g)].flatMap((match) => match[1] ? [match[1]] : []);
  const direct = records.flatMap((record) => {
    const candidates = [record.name, record.id, record.stableId, record.properties.Mark, record.properties["标记"], record.properties["编号"]].filter((value): value is string => Boolean(value && value.length >= 2));
    return candidates.filter((value) => normalize(question).includes(normalize(value)));
  });
  return unique([...quoted, ...direct]);
}

function componentScore(record: ComponentRecord, question: string, aliases: string[]): number {
  const haystack = normalize(record.searchText);
  let score = 0;
  for (const alias of aliases) if (haystack.includes(normalize(alias))) score += alias === record.name ? 12 : 4;
  if (question.includes(normalize(record.name)) && normalize(record.name).length >= 2) score += 15;
  if (question.includes(normalize(record.id)) || question.includes(normalize(record.stableId))) score += 20;
  const tokens = question.split(/[\s,，。；;：:？?、]+/).map(normalize).filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  return score;
}

function evidenceRef(component: BimAssistantComponentEvidence) {
  return { id: component.id, stableId: component.stableId, modelId: component.modelId, name: component.name };
}
function normalize(value: string) { return value.toLocaleLowerCase("zh-CN").replace(/[\s_\-.:：/\\]/g, ""); }
function unique(values: string[]) { return [...new Set(values.filter(Boolean))]; }
function toMetres(value: number, unit: string) { return /mm|毫米/i.test(unit) ? value / 1000 : /cm|厘米/i.test(unit) ? value / 100 : value; }
function containsPoint(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }, point: { x: number; y: number; z: number }) { return point.x >= bounds.min.x && point.x <= bounds.max.x && point.y >= bounds.min.y && point.y <= bounds.max.y && point.z >= bounds.min.z && point.z <= bounds.max.z; }
function boundsVolume(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) { return Math.max(0, bounds.max.x - bounds.min.x) * Math.max(0, bounds.max.y - bounds.min.y) * Math.max(0, bounds.max.z - bounds.min.z); }
