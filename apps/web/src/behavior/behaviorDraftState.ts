import type { ScriptModule } from "@bim-studio/contracts";

export function sameBehaviorDraft(left: ScriptModule | undefined, right: ScriptModule | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 保存回声与外部更新只替换未编辑的基线，不吞掉请求发出后的输入。 */
export function reconcileBehaviorDraft(
  draft: ScriptModule | undefined,
  previous: ScriptModule | undefined,
  incoming: ScriptModule | undefined,
): ScriptModule | undefined {
  if (draft?.id !== incoming?.id || sameBehaviorDraft(draft, previous)) {
    return incoming ? structuredClone(incoming) : undefined;
  }
  return draft;
}
