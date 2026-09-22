/** 一个拖放只属于发起它的目录；清理后旧载荷不能再次提交。 */
export class SceneLayerDragSession<Scope> {
  private active: { scope: Scope; token: string; ids: string[] } | undefined;
  begin(scope: Scope, ids: readonly string[], token: string): string {
    this.active = { scope, ids: [...new Set(ids)], token }; return token;
  }
  read(scope: Scope, token?: string): string[] | undefined {
    if (!this.active || this.active.scope !== scope || (token !== undefined && token !== this.active.token)) return;
    return [...this.active.ids];
  }
  cancel(): void { this.active = undefined; }
}

/** 目录内成员优先按可见顺序，折叠的已选成员保持原选择顺序。 */
export function orderSceneLayerDragIds(order: readonly string[], selected: readonly string[]): string[] {
  const selectedSet = new Set(selected), visible = new Set(order);
  return [...order.filter(id => selectedSet.has(id)), ...selected.filter(id => !visible.has(id))];
}
