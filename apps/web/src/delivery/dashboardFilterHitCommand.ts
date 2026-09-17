import type { DashboardDataWidgetNode, JsonValue } from "@bim-studio/contracts";

const FILTER_OPTION_LIMIT = 16;
const FILTER_HIT = /^(.*):option:(0|[1-9]\d*)$/;

export type DashboardFilterActivation =
  | Readonly<{ source: "pointer"; nodeId: string; widgetKey: string; hitId: string }>
  | Readonly<{ source: "key"; nodeId: string; widgetKey: string; hitId: string; key: string }>;

export interface DashboardSetFilterCommand {
  readonly kind: "setFilter";
  readonly key: string;
  readonly value: JsonValue;
}

export type DashboardFilterHitRejection = "foreign-node" | "foreign-key" | "invalid-hit" | "out-of-range"
  | "hidden" | "parent-not-ready" | "unsupported-mode" | "unsupported-key";

export type DashboardFilterHitResult = Readonly<{ ok: true; command: DashboardSetFilterCommand }>
  | Readonly<{ ok: false; reason: DashboardFilterHitRejection }>;

/**
 * G02 切片 2 的无状态白名单：只把当前 select 节点自己的 option hit 转成 setFilter。
 * filters 只用于核对父参数就绪，不在此处复制或修改运行状态。
 */
export function dashboardFilterHitCommand(
  node: DashboardDataWidgetNode,
  activation: DashboardFilterActivation,
  filters: Readonly<Record<string, JsonValue>>,
): DashboardFilterHitResult {
  if (activation.nodeId !== node.id) return reject("foreign-node");
  if (activation.widgetKey !== node.widget.key) return reject("foreign-key");
  if (node.visible === false) return reject("hidden");
  if ((node.widget.filterMode ?? "select") !== "select") return reject("unsupported-mode");
  if (node.widget.parentFilterKey) {
    const parent = node.widget.parentFilterKey;
    if (!Object.prototype.hasOwnProperty.call(filters, parent) || !activeFilterValue(filters[parent])) {
      return reject("parent-not-ready");
    }
  }
  if (activation.source === "key" && activation.key !== "Enter" && activation.key !== " ") {
    return reject("unsupported-key");
  }
  const match = FILTER_HIT.exec(activation.hitId);
  if (!match || match[1] !== node.id) return reject(match ? "foreign-node" : "invalid-hit");
  const index = Number(match[2]);
  const options = node.widget.options ?? [];
  if (!Number.isSafeInteger(index) || index >= options.length || index >= FILTER_OPTION_LIMIT) {
    return reject("out-of-range");
  }
  return { ok: true, command: { kind: "setFilter", key: node.widget.key, value: options[index]! } };
}

function reject(reason: DashboardFilterHitRejection): DashboardFilterHitResult {
  return { ok: false, reason };
}

/** 与 applyDashboardFilters 的父参数激活口径逐项一致；留在本切片避免提前改动切片 3 数据流。 */
function activeFilterValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.some(activeFilterValue);
  return !/^(全部|all)$/i.test(String(value));
}
