import type { SceneSnapshot } from "@bim-studio/contracts";
import { sceneOptionLabel } from "./sceneOptionPresentation";

export type CommissioningWorkflowStage = "screening" | "control" | "result";

interface Props {
  scenes: SceneSnapshot[];
  sceneId: string;
  robotOptions: SceneSnapshot["models"];
  robotModelId: string;
  selectionConfirmed: boolean;
  stage: CommissioningWorkflowStage;
  quickScreenDone: boolean;
  quickScreenHasIssues: boolean;
  controlRunDone: boolean;
  controlHasIssues: boolean;
  controlStudySaved: boolean;
  onSceneChange: (sceneId: string) => void;
  onRobotChange: (robotId: string) => void;
  onConfirm: () => void;
  onStageChange: (stage: CommissioningWorkflowStage) => void;
}

/** 工位验证的稳定入口与进度视图；首访只暴露一个确认动作。 */
export function VirtualCommissioningWorkflowHeader(props: Props) {
  return <>
    <header className="commissioning-titlebar">
      <div>
        <h2>工位验证</h2>
        <p>选择工位和机器人，检查任务，再验证控制逻辑；失败项可直接定位并保存证据。</p>
      </div>
    </header>

    {props.scenes.length > 0 && <section className={`commissioning-selection${props.selectionConfirmed ? " confirmed" : ""}`} aria-label="选择验证对象">
      <label><span>工位</span><select value={props.sceneId} onChange={(event) => props.onSceneChange(event.target.value)}>
        {props.scenes.map((item) => <option key={item.id} value={item.id}>{sceneOptionLabel(item, "zh-CN")}</option>)}
      </select></label>
      <label><span>机器人</span><select value={props.robotModelId} onChange={(event) => props.onRobotChange(event.target.value)}>
        <option value="">通用工位检查</option>
        {props.robotOptions.map((robot) => <option key={robot.modelId} value={robot.modelId}>{robot.name}</option>)}
      </select></label>
      {!props.selectionConfirmed && <button type="button" onClick={props.onConfirm}>检查任务</button>}
    </section>}

    {props.selectionConfirmed && <nav className="commissioning-steps" aria-label="工位验证流程">
      <Step active={props.stage === "screening"} complete={props.quickScreenDone && !props.quickScreenHasIssues} attention={props.quickScreenDone && props.quickScreenHasIssues} number="1" label="检查任务" hint="目标、约束和可定位问题" onClick={() => props.onStageChange("screening")} />
      <Step active={props.stage === "control"} complete={props.controlRunDone && !props.controlHasIssues} attention={props.controlRunDone && props.controlHasIssues} disabled={!props.quickScreenDone} number="2" label="验证控制逻辑" hint="按预设直接运行" onClick={() => props.onStageChange("control")} />
      <Step active={props.stage === "result"} complete={props.controlStudySaved && !props.controlHasIssues} attention={props.controlStudySaved && props.controlHasIssues} disabled={!props.controlStudySaved} number="3" label="查看结果" hint="定位问题并保存证据" onClick={() => props.onStageChange("result")} />
    </nav>}
  </>;
}

function Step({ active, complete, attention, disabled, number, label, hint, onClick }: {
  active: boolean;
  complete: boolean;
  attention: boolean;
  disabled?: boolean;
  number: string;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  const className = [active && "active", attention && "attention", complete && "complete"].filter(Boolean).join(" ");
  return <button type="button" disabled={disabled} className={className} onClick={onClick}>
    <b>{number}</b><i>{label}</i><small>{hint}</small>
  </button>;
}
