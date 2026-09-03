import type { PprBopVersionDraft } from "@bim-studio/contracts";
import { PprOperationEditor } from "./PprOperationEditor";
import { PprProductEditor } from "./PprProductEditor";
import { PprResourceEditor } from "./PprResourceEditor";
import type { PprPlanSection } from "./pprPlanDraftModel";

export function PprPlanEditor({
  section,
  draft,
  onChange,
}: {
  section: PprPlanSection;
  draft: PprBopVersionDraft;
  onChange: (draft: PprBopVersionDraft) => void;
}) {
  if (section === "product") return <PprProductEditor draft={draft} onChange={onChange} />;
  if (section === "operations") return <PprOperationEditor draft={draft} onChange={onChange} />;
  return <PprResourceEditor draft={draft} onChange={onChange} />;
}
