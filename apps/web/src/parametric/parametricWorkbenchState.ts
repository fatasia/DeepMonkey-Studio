import type { ParametricCadDefinition } from "@bim-studio/contracts";

/** 名称和数据绑定不改变几何，不要求重建；尺寸与特征必须匹配成功结果。 */
export function parametricGeometryKey(definition: ParametricCadDefinition): string {
  return JSON.stringify({ unit: definition.unit, parameters: definition.parameters.map(({ id, value }) => ({ id, value })), features: definition.features, edgeTreatment: definition.edgeTreatment });
}

/** 同步占用与世代校验覆盖双击、取消、迟到响应和卸载。 */
export class ParametricOperationGate {
  private sequence = 0;
  private active: number | undefined;
  begin(): number | undefined {
    if (this.active !== undefined) return undefined;
    this.active = ++this.sequence;
    return this.active;
  }
  current(ticket: number): boolean { return this.active === ticket; }
  finish(ticket: number): boolean {
    if (!this.current(ticket)) return false;
    this.active = undefined;
    return true;
  }
  cancel(): void { this.active = undefined; this.sequence += 1; }
}
