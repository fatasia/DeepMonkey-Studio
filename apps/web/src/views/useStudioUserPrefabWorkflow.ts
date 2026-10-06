import { useMemo, useState } from "react";
import { translate as tr } from "../i18n";
import type { AppStudioController } from "./AppStudioShell";
import { buildUserPrefabTreeMarks } from "../prefabs/userPrefabModel";

/**
 * AppStudioShellView 用户组合预制体域(T0 刀 2:存为预制体 / 实例化 / 应用更新
 * diff / 覆盖)。状态与派生量自视图原文机械迁出,语句与求值顺序逐一保留。
 */
export function useStudioUserPrefabWorkflow(controller: AppStudioController) {
  const { userPrefab, userPrefabs, userPrefabInstances } = controller;
  const { revision, showError, setMessage, locale } = controller;
  const [savePrefabOpen, setSavePrefabOpen] = useState(false);
  const [applyPrefabInstanceId, setApplyPrefabInstanceId] = useState<string>();
  const prefabTreeMarks = useMemo(() => buildUserPrefabTreeMarks(userPrefabInstances, userPrefabs), [userPrefabInstances, userPrefabs]);
  const applyPrefabDiff = useMemo(
    () => (applyPrefabInstanceId ? userPrefab.diffUserPrefabInstance(applyPrefabInstanceId) : undefined),
    // revision 变化（实例应用/成员编辑）后重算，保证预览与场景事实一致。
    [applyPrefabInstanceId, revision, userPrefab], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const instanceIdByMemberId = useMemo(() => {
    const map = new Map<string, string>();
    for (const record of userPrefabInstances) for (const objectId of Object.values(record.memberObjectIds)) map.set(objectId, record.instanceId);
    return map;
  }, [userPrefabInstances]);
  const insertUserPrefab = (prefabId: string) => {
    userPrefab.instantiateUserPrefab(prefabId).catch(showError);
  };
  const runPrefabRowAction = (objectId: string, action: "apply-update" | "refresh-overrides" | "reset-member" | "update-prototype") => {
    const instanceId = instanceIdByMemberId.get(objectId);
    if (!instanceId) return;
    const record = userPrefabInstances.find((item) => item.instanceId === instanceId);
    if (!record) return;
    if (action === "apply-update") {
      if (!userPrefab.diffUserPrefabInstance(instanceId)) {
        setMessage(tr(locale, "该实例已是最新版本，无需应用更新", "This instance is already up to date"));
        return;
      }
      setApplyPrefabInstanceId(instanceId);
    } else if (action === "update-prototype") userPrefab.updateUserPrefabFromInstance(record.prefabId, instanceId);
    else if (action === "refresh-overrides") userPrefab.refreshUserPrefabOverrides(instanceId);
    else userPrefab.resetUserPrefabMember(instanceId, objectId);
  };
  return { savePrefabOpen, setSavePrefabOpen, applyPrefabInstanceId, setApplyPrefabInstanceId,
    applyPrefabDiff, prefabTreeMarks, insertUserPrefab, runPrefabRowAction };
}
