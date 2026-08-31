import type { DeliveryStepId } from "./deliveryWorkflowModel";

const STORAGE_PREFIX = "bim-studio.delivery-workflow.v1";

export interface DeliveryWorkflowMemory {
  activeStep?: DeliveryStepId;
  previousStep?: DeliveryStepId;
  updatedAt: string;
}

/** 只保存导航上下文，不保存项目数据；项目内容仍由服务端草稿和应用会话负责。 */
export function readDeliveryWorkflowMemory(projectId: string, storage: Storage | undefined = browserStorage()): DeliveryWorkflowMemory | undefined {
  if (!storage || !projectId.trim()) return undefined;
  try {
    const raw = storage.getItem(storageKey(projectId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<DeliveryWorkflowMemory>;
    return {
      ...(isStepId(value.activeStep) ? { activeStep: value.activeStep } : {}),
      ...(isStepId(value.previousStep) ? { previousStep: value.previousStep } : {}),
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
    };
  } catch {
    // 浏览器禁用存储或旧值损坏时，流程仍应正常打开。
    return undefined;
  }
}

export function writeDeliveryWorkflowMemory(projectId: string, memory: DeliveryWorkflowMemory, storage: Storage | undefined = browserStorage()): void {
  if (!storage || !projectId.trim()) return;
  try {
    storage.setItem(storageKey(projectId), JSON.stringify(memory));
  } catch {
    // 存储容量不足不应阻断编辑操作。
  }
}

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}:${projectId}`;
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    // 隐私模式或嵌入式 WebView 可能拒绝访问 localStorage。
    return undefined;
  }
}

function isStepId(value: unknown): value is DeliveryStepId {
  return value === "data" || value === "assets" || value === "design" || value === "linkage" || value === "behavior" || value === "simulation" || value === "validate" || value === "publish";
}
