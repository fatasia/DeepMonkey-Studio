import { useEffect, useRef, useState } from "react";
import type { PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";

/** 弹窗拥有加载/恢复事务，过期响应不能覆盖新场景的版本列表。 */
export function useScenePublicationHistory(
  projectId: string | undefined,
  locale: AppLocale,
  restore: (sceneId: string, publishedAt: string) => Promise<void>,
) {
  const [versionTarget, setTarget] = useState<SceneSnapshot>();
  const [publicationVersions, setVersions] = useState<PublishedSceneRecord[]>([]);
  const [versionBusy, setBusy] = useState(false);
  const [versionError, setError] = useState<string>();
  const generation = useRef(0);
  const restoring = useRef(false);

  function setVersionTarget(target: SceneSnapshot | undefined) {
    generation.current++;
    setTarget(target);
    setVersions([]);
    setError(undefined);
    setBusy(false);
  }

  useEffect(() => {
    setVersionTarget(undefined);
    return () => { generation.current++; };
  }, [projectId]);

  async function openVersions(scene: SceneSnapshot) {
    if (!projectId) return;
    const request = ++generation.current;
    setTarget(scene);
    setVersions([]);
    setError(undefined);
    setBusy(true);
    try {
      const versions = await api.listScenePublications(projectId, scene.id);
      if (generation.current === request) setVersions(versions);
    } catch {
      if (generation.current === request) setError(tr(locale, "版本记录加载失败，请重试", "Unable to load versions. Try again."));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }

  async function restoreVersion(publishedAt: string) {
    if (!projectId || !versionTarget || restoring.current) return;
    const request = ++generation.current;
    restoring.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await restore(versionTarget.id, publishedAt);
      const versions = await api.listScenePublications(projectId, versionTarget.id);
      if (generation.current === request) setVersions(versions);
    } catch {
      // 恢复可能已成功而随后的读取失败：不诱导重复发布，先重新读取确认。
      if (generation.current === request) setError(tr(locale, "未能确认恢复结果，请重新加载版本记录后再操作", "Unable to confirm restoration. Reload versions before trying again."));
    } finally {
      restoring.current = false;
      if (generation.current === request) setBusy(false);
    }
  }

  return { versionTarget, publicationVersions, versionBusy, versionError, setVersionTarget, openVersions, restoreVersion };
}
