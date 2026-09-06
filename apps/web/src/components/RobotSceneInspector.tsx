import { useState } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { RobotJointPreview } from "./RobotJointPreview";
import { RobotConnectionPanel } from "./RobotConnectionPanel";

/** 场景只持久化作者姿态；连接和遥测的生命周期属于当前检查器实例。 */
export function RobotSceneInspector({ locale, engine, modelId, disabled, onChange }: {
  locale: AppLocale; engine: ViewerEngine; modelId: string; disabled: boolean; onChange(): void;
}) {
  const [following, setFollowing] = useState(false);
  const definition = engine.getRobotDefinition(modelId);
  if (!definition) return null;
  const jointNames = definition.joints.filter(joint => joint.type !== "fixed" && !joint.mimic).map(joint => joint.name);
  return <>
    <RobotJointPreview locale={locale} engine={engine} modelId={modelId} disabled={disabled || following}
      disabledReason={following ? tr(locale, "取消跟随遥测后可编辑", "Turn off telemetry following to edit") : tr(locale, "当前实例不可编辑", "This instance is not editable")} onChange={onChange} />
    <RobotConnectionPanel locale={locale} owner={engine} modelId={modelId} jointNames={jointNames} disabled={disabled}
      onFollowingChange={setFollowing}
      readPose={() => engine.getRobotPose(modelId) ?? {}}
      onTelemetry={values => { engine.applyRobotTelemetry(modelId, { ...values }); }}
      onRestorePose={() => engine.restoreRobotPose(modelId)} />
  </>;
}
