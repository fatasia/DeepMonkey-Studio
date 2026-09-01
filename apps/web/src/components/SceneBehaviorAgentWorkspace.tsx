import type { ScriptModule } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import type { SceneScriptAnalysis } from "../studio/sceneScriptAnalysis";
import { IndustrialAgentWorkspace } from "./IndustrialAgentWorkspace";

/** 脚本工作区只提供目标上下文，Agent 的运行、审批和证据仍复用统一组件。 */
export function SceneBehaviorAgentWorkspace(props: {
  locale: AppLocale;
  projectId?: string;
  draft?: ScriptModule;
  analysis?: SceneScriptAnalysis;
  onBack: () => void;
}) {
  const script = props.draft ? {
    id: props.draft.id,
    name: props.draft.name,
    target: props.draft.target,
    enabled: props.draft.enabled,
    permissions: props.draft.permissions,
    capabilities: props.draft.capabilities,
    diagnostics: props.analysis?.issues.map((issue) => ({ severity: issue.severity, message: issue.message })),
  } : undefined;
  return (
    <div className="behavior-agent-workspace">
      <IndustrialAgentWorkspace
        locale={props.locale}
        {...(props.projectId ? { projectId: props.projectId } : {})}
        surface="script"
        context={{ workspace: "behavior-script", script }}
        onBack={props.onBack}
      />
    </div>
  );
}
