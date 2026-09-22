import { api } from "../api";
import { downloadBlob } from "../browserDownload";
import { freezeSceneClientBranding } from "./sceneClientBranding";
import { exportSceneClientPackage, type SceneClientPackageOptions, type SceneClientPackageResult } from "./sceneClientPackage";

export async function exportSceneStandaloneExecutable(options: SceneClientPackageOptions): Promise<SceneClientPackageResult> {
  if (!options.publication?.version || options.prepared) throw new Error("Scene EXE 需要已验证的正式发布版本");
  const publication = structuredClone(options.publication), branding = freezeSceneClientBranding(options.branding);
  if (publication.projectId !== options.projectId || publication.sceneId !== options.scene.id) throw new Error("客户端发布身份不一致");
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (options.target === "three-webview") {
    return exportSceneClientPackage({ ...options, archiveConsumer: async (archive, _archiveName, counts) => {
      const executable = await api.downloadThreeSceneExecutable(publication.projectId, publication.sceneId,
        publication.version!, archive, signal);
      signal.throwIfAborted();
      const product = (branding?.applicationName ?? publication.snapshot.name ?? "DeepMonkey Studio")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "") || "DeepMonkey Studio";
      const fileName = `${product}.exe`;
      downloadBlob(executable, fileName);
      return { fileName, target: "three-webview", ...counts };
    } });
  }
  if (options.target !== "deep-native") throw new Error("不支持的 Scene EXE 目标");
  const blob = await api.downloadSceneExecutable(publication.projectId, publication.sceneId, publication.version!, signal, branding);
  signal.throwIfAborted();
  const name = (branding?.applicationName ?? "DeepMonkey Studio").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "") || "DeepMonkey Studio";
  const fileName = `${name}.exe`; downloadBlob(blob, fileName);
  return { fileName, target: "deep-native", assetCount: publication.snapshot.models.length, applicationCount: 0, connectionCount: 0 };
}
