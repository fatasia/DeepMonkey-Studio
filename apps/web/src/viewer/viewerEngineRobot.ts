import { type RobotAssetDefinition } from "@bim-studio/contracts";
import { ViewerEngineSpatialAudio } from "./viewerEngineSpatialAudio";
import { readRobotDefinition, readRobotPose, restoreAuthoredRobotPose, writeRobotPose } from "./robotPoseRuntime";

/** URDF 关节姿态独立于旧骨骼/IK，遥测路径不触发 React 与作者历史。 */
export abstract class ViewerEngineRobot extends ViewerEngineSpatialAudio {
  getRobotDefinition(id: string): RobotAssetDefinition | undefined { return readRobotDefinition(this.models.get(id)?.object); }
  getRobotPose(id: string): Record<string, number> | undefined { return readRobotPose(this.models.get(id)?.object); }
  setRobotPose(id: string, values: Record<string, number>): boolean {
    const model = this.models.get(id);
    if (!model || this.readOnlyMode || this.isModelLocked(id) || this.isIsolationActive()) return false;
    if (!writeRobotPose(model.object, values, true)) return false;
    this.updateSelectionHelper(); this.updateCollisions(true); this.markShadowMapDirty();
    this.onModelChange?.(model);
    return true;
  }
  applyRobotTelemetry(id: string, values: Record<string, number>): boolean {
    const changed = writeRobotPose(this.models.get(id)?.object, values, false);
    if (changed) this.markShadowMapDirty();
    return changed;
  }
  restoreRobotPose(id: string): void {
    if (restoreAuthoredRobotPose(this.models.get(id)?.object)) this.markShadowMapDirty();
  }
}
