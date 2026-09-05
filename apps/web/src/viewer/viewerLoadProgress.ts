/** 只读预览与发布页共享的场景加载生命周期，区别未知进度、失败与真正可用。 */
export interface ViewerLoadProgress {
  phase: "shell" | "fetching" | "essential" | "streaming" | "ready" | "error";
  loaded: number;
  total: number;
  current: string;
}
