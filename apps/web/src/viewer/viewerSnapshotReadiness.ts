/** 场景身份属于具体 Viewer；模型数量为零不能用于判断是否加载完成。 */
export class ViewerSnapshotReadiness {
  private sceneId: string | undefined;
  private restoring = false;
  private generation = 0;

  begin(sceneId: string): number {
    this.sceneId = sceneId; this.restoring = true;
    return ++this.generation;
  }
  complete(generation: number): void {
    if (generation === this.generation) this.restoring = false;
  }
  cancelRestore(): void { this.generation += 1; this.restoring = false; }
  bindSaved(sceneId: string): void { if (!this.restoring) this.sceneId = sceneId; }
  ready(expectedSceneId: string | undefined, disposed: boolean, pendingModels: boolean): boolean {
    return !disposed && !pendingModels && !this.restoring && (!expectedSceneId || this.sceneId === expectedSceneId);
  }
}
