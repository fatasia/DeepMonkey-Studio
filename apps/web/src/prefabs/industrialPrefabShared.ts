import type {
  IndustrialPrefabActionDefinition,
  IndustrialPrefabDefinition,
  IndustrialPrefabKind,
  IndustrialPrefabParameterDefinition,
  IndustrialPrefabParameterValue,
} from "@bim-studio/contracts";

export const STATE_ACTIONS = actions([
  ["start", "启动", "Start"],
  ["pause", "暂停", "Pause"],
  ["stop", "停止", "Stop"],
  ["reset", "复位", "Reset"],
]);

export const ROUTE_ACTIONS = actions([
  ["dispatch", "派发任务", "Dispatch"],
  ["pause", "暂停", "Pause"],
  ["resume", "继续", "Resume"],
  ["stop", "停止", "Stop"],
  ["return", "返回起点", "Return"],
  ["replay", "从头重播", "Replay"],
  ["clear-fault", "清除故障", "Clear fault"],
]);

export function definition(
  id: string,
  kind: IndustrialPrefabKind,
  name: string,
  englishName: string,
  parameters: IndustrialPrefabParameterDefinition[],
  prefabActions: IndustrialPrefabActionDefinition[],
  dataPorts: string[],
  options: { routeCapable?: boolean; pathCapable?: boolean; rigCapable?: boolean; description?: string } = {},
): IndustrialPrefabDefinition {
  return {
    id,
    version: "1.0.0",
    kind,
    name,
    englishName,
    description: options.description ?? `${name}可配置运行预制体`,
    englishDescription: `Configurable ${englishName.toLowerCase()} prefab`,
    parameters,
    actions: prefabActions,
    dataPorts,
    routeCapable: options.routeCapable ?? false,
    pathCapable: options.pathCapable ?? false,
    rigCapable: options.rigCapable ?? false,
  };
}

export function actions(items: ReadonlyArray<readonly [string, string, string]>): IndustrialPrefabActionDefinition[] {
  return items.map(([id, name, englishName]) => ({ id, name, englishName, changesState: true }));
}

export function fixed(key: string, name: string, englishName: string, value: IndustrialPrefabParameterValue): IndustrialPrefabParameterDefinition {
  return {
    key,
    name,
    englishName,
    kind: typeof value === "number" ? "number" : "text",
    defaultValue: value,
    advanced: true,
  };
}

export function number(key: string, name: string, englishName: string, defaultValue: number, unit: string, min: number, max: number, step: number): IndustrialPrefabParameterDefinition {
  return { key, name, englishName, kind: "number", defaultValue, unit, min, max, step };
}

export function bool(key: string, name: string, englishName: string, defaultValue: boolean): IndustrialPrefabParameterDefinition {
  return { key, name, englishName, kind: "boolean", defaultValue };
}

export function text(key: string, name: string, englishName: string, defaultValue: string): IndustrialPrefabParameterDefinition {
  return { key, name, englishName, kind: "text", defaultValue };
}

export function select(key: string, name: string, englishName: string, defaultValue: string, options: string[]): IndustrialPrefabParameterDefinition {
  return { key, name, englishName, kind: "select", defaultValue, options };
}
