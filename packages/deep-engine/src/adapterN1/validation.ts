/**
 * N1 适配器共享校验:数值、颜色与 id 的 fail-closed 规则(拒绝即带原因)。
 * 与 Native `adapter_n1/validate.rs` 及 `behavior_ir/contract.rs::stable_node_id`
 * 同一规则、同一上限,错误文案逐条对齐以便跨语言比对。
 */

import { DEEP2D_ID, MAX_DRAW_VALUE, MAX_IMAGE_DIMENSION } from "../deep2dValidationPrimitives.js";

export { MAX_DRAW_VALUE, MAX_IMAGE_DIMENSION };

/** Deep2d 描边宽度上界(与 deep2d `strokeWidth` 合同一致)。 */
export const MAX_STROKE_WIDTH = 65_536;

/**
 * Deep2d 兼容 id:`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`(复用 deep2d 合同
 * 同一条正则,禁止第二套拼写)。
 */
export function requireId(value: string, label: string): void {
  if (!DEEP2D_ID.test(value)) throw new N1Rejection(`${label} '${value}' is not a stable display id`);
}

/** behavior_ir 稳定节点身份:非空、≤128 字符、仅 ASCII 字母数字与 `._:-`(无 `/`)。 */
export const STABLE_NODE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function stableNodeId(value: string): boolean {
  return STABLE_NODE_ID.test(value);
}

/** 适配器各校验步骤的统一失败形状:reason 进 `blocked`,永不部分产出。 */
export class N1Rejection extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "N1Rejection";
  }
}

export function requireColor(color: readonly number[], label: string): void {
  for (const channel of color) {
    if (!Number.isFinite(channel) || channel < 0 || channel > 1) {
      throw new N1Rejection(`${label} must be four finite RGBA channels in [0, 1]`);
    }
  }
}

export function requireBoundedCoordinate(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_DRAW_VALUE) {
    throw new N1Rejection(`${label} must be finite within ±${MAX_DRAW_VALUE}`);
  }
}

export function requirePositive(value: number, label: string): void {
  requirePositiveBounded(value, MAX_DRAW_VALUE, label);
}

export function requirePositiveBounded(value: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new N1Rejection(`${label} must be finite in (0, ${max}]`);
  }
}
