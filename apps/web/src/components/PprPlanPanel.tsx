import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { SceneSnapshot } from "@bim-studio/contracts";
import type { OperationsSnapshot } from "../api";
import { PprPlanDetails } from "./PprPlanDetails";
import { type PprPlanReferenceContext } from "./pprPlanDraftModel";
import type { PprPlantLiteReadyDraft } from "./pprPlantLiteDraft";

export function PprPlanPanel({
  projectId,
  scenes,
  snapshot,
  onCreatePlantLiteDraft,
}: {
  projectId: string;
  scenes: SceneSnapshot[];
  snapshot: OperationsSnapshot | undefined;
  onCreatePlantLiteDraft: (result: PprPlantLiteReadyDraft) => void;
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
          <strong>工艺规划</strong>
          <small>按产品、工序和资源三步建立计划，并生成现场可用的电子作业指导书。</small>
        </div>
        <button onClick={() => setExpanded((current) => !current)}>
          {expanded ? "关闭工作台" : "打开工作台"}
        </button>
      </header>
      {expanded && typeof document !== "undefined" && createPortal(
        <PprPlanDetails
          projectId={projectId}
          references={references}
          onClose={() => setExpanded(false)}
          onCreatePlantLiteDraft={(result) => {
            onCreatePlantLiteDraft(result);
            setExpanded(false);
          }}
        />,
        document.body,
      )}
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
