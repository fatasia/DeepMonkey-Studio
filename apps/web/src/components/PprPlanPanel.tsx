import { useMemo, useState } from "react";
import type { SceneSnapshot } from "@bim-studio/contracts";
import type { OperationsSnapshot } from "../api";
import { PprPlanDetails } from "./PprPlanDetails";
import { type PprPlanReferenceContext } from "./pprPlanTemplate";

export function PprPlanPanel({
  projectId,
  scenes,
  snapshot,
}: {
  projectId: string;
  scenes: SceneSnapshot[];
  snapshot: OperationsSnapshot | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const references = useMemo(
    () => referenceContext(scenes, snapshot),
    [scenes, snapshot],
  );

  return (
    <section className="operations-panel ppr-plan-panel">
      <header>
        <div>
          <strong>工艺计划 · PD Lite</strong>
          <small>保存不可变 BOP 快照，检查工序、资源与版本影响；不含审批、报价或完整 PLM。</small>
        </div>
        <button onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起" : "打开"}
        </button>
      </header>
      {expanded && <PprPlanDetails projectId={projectId} references={references} />}
    </section>
  );
}

function referenceContext(
  scenes: SceneSnapshot[],
  snapshot: OperationsSnapshot | undefined,
): PprPlanReferenceContext {
  const scene = scenes[0];
  const objectId = scene?.models[0]?.modelId ?? scene?.primitives[0]?.modelId;
  const studyId = snapshot?.validationStudies[0]?.id
    ?? snapshot?.plantLiteStudies[0]?.id
    ?? snapshot?.whatIfStudies[0]?.id;
  return {
    ...(scene?.id ? { sceneId: scene.id } : {}),
    ...(objectId ? { objectId } : {}),
    ...(scene?.interactions?.[0]?.id ? { scriptId: scene.interactions[0].id } : {}),
    ...(studyId ? { studyId } : {}),
  };
}
