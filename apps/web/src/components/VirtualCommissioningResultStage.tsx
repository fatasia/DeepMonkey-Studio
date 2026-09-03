import type {
  IndustrialValidationStudyRecord,
  VirtualDebugResult,
  VirtualDebugSuiteCaseResult,
  VirtualDebugSuiteResult,
} from "@bim-studio/contracts";
import { ArrowLeft, RotateCcw } from "lucide-react";
import type { CapabilityInvocationResult } from "../api";
import { VirtualCommissioningEvidence } from "./VirtualCommissioningEvidence";
import { VirtualCommissioningSuiteEvidence } from "./VirtualCommissioningSuiteEvidence";

interface Props {
  invocation: CapabilityInvocationResult<VirtualDebugResult> | undefined;
  suiteResult: VirtualDebugSuiteResult | undefined;
  previousResult: IndustrialValidationStudyRecord["latestResult"] | undefined;
  playheadMs: number;
  onInspectSuiteCase: (testCase: VirtualDebugSuiteCaseResult) => void;
  onExportSuite: () => void;
  onPlayheadChange: (value: number) => void;
  onExportEvidence: () => void;
  onOpenTarget: (sceneId: string, objectId: string) => void;
  onEditCase: () => void;
  onCheckTask: () => void;
}

export function VirtualCommissioningResultStage(props: Props) {
  return <section className="commissioning-result-stage" aria-labelledby="commissioning-result-title">
    <header className="commissioning-control-stage-header">
      <div>
        <span>当前任务</span>
        <h3 id="commissioning-result-title">查看结果并定位问题</h3>
        <p>失败项可直接定位到场景对象；本次运行已保存为运行记录，便于复现与对比。</p>
      </div>
      <div className="commissioning-title-actions">
        <button type="button" className="commissioning-suite-run" onClick={props.onCheckTask}><ArrowLeft size={15} />重新检查任务</button>
        <button type="button" className="commissioning-run" onClick={props.onEditCase}><RotateCcw size={15} />调整并重跑</button>
      </div>
    </header>
    <VirtualCommissioningSuiteEvidence
      result={props.suiteResult} previousResult={props.previousResult}
      onInspect={props.onInspectSuiteCase} onExport={props.onExportSuite}
    />
    <VirtualCommissioningEvidence
      invocation={props.invocation} playheadMs={props.playheadMs} onPlayheadChange={props.onPlayheadChange}
      onExport={props.onExportEvidence} onOpenTarget={props.onOpenTarget}
    />
  </section>;
}
