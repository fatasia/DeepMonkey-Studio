import type { SceneModelAnimationPlaybackState } from "@bim-studio/contracts";
import {
  applyModelAnimationLoopPolicy, controlAnimation, getAnimationPlayback, getModelAnimationPlaybackState,
  hasAnimation, listAnimationClips, restartModelAnimationActions, setModelAnimationPlaybackState,
  transitionAnimationClip, updateCompletedModelAnimations,
  type AnimationControl, type AnimationPlayback, type AnimationContext,
} from "./viewerEngineAnimation";
import { ViewerEngineCore } from "./viewerEngineCore";

/**
 * 模型动画控制域宿主层（F6 结构治理切片）。
 *
 * 职责边界：承接 `viewerEngineInteraction.ts` 中全部模型动画控制公开 API
 * （查询/播放状态/循环策略/控制指令/片段过渡），实现体委托给
 * `viewerEngineAnimation.ts` 的纯函数（该文件不含引擎状态，可独立测试）。
 * 本层只做“宿主状态(AnimationContext) → 纯函数”的绑定，不含动画算法。
 *
 * 继承关系：ViewerEngineCore → 本类 → ViewerEngineInteraction，
 * 公开/保护方法签名与拆分前逐字一致，宿主（ViewerEngine 叶子类）API 不变。
 */
export abstract class ViewerEngineAnimationControl extends ViewerEngineCore {
  hasAnimation(id: string): boolean { return hasAnimation(this as unknown as AnimationContext, id); }
  listAnimationClips(id: string): Array<{ id: string; name: string; duration: number }> { return listAnimationClips(this as unknown as AnimationContext, id); }
  getAnimationPlayback(id: string): AnimationPlayback | undefined { return getAnimationPlayback(this as unknown as AnimationContext, id); }
  getModelAnimationPlaybackState(id: string): SceneModelAnimationPlaybackState {
    return getModelAnimationPlaybackState(this as unknown as AnimationContext, id);
  }
  setModelAnimationPlaybackState(id: string, state: SceneModelAnimationPlaybackState): void {
    setModelAnimationPlaybackState(this as unknown as AnimationContext, id, state);
  }
  protected applyModelAnimationLoopPolicy(id: string, clips = this.animationClips.get(id) ?? []): void {
    applyModelAnimationLoopPolicy(this as unknown as AnimationContext, id, clips);
  }
  protected restartModelAnimationActions(id: string): void {
    restartModelAnimationActions(this as unknown as AnimationContext, id);
  }
  protected updateCompletedModelAnimations(): void {
    updateCompletedModelAnimations(this as unknown as AnimationContext);
  }
  controlAnimation(id: string, control: AnimationControl): boolean { return controlAnimation(this as unknown as AnimationContext, id, control); }
  transitionAnimationClip(id: string, fromClipId: string, toClipId: string, durationSeconds: number): boolean {
    return transitionAnimationClip(this as unknown as AnimationContext, id, fromClipId, toClipId, durationSeconds);
  }
}
