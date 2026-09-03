import { FileImage, FileUp, FileVideo, RefreshCw, WandSparkles } from "lucide-react";
import { ACCEPTED_MODELS } from "../appDefaults";
import { translate as tr } from "../i18n";
import type { SceneManagerController } from "./SceneManager";

const ACCEPTED_IMAGES = ".jpg,.jpeg,.png,.webp,.gif,.svg";
const ACCEPTED_VIDEOS = ".mp4,.webm,.ogv,.mov";

export function ProjectAssetToolbar({ controller }: { controller: SceneManagerController }) {
  const {
    imageUploadRef,
    locale,
    modelLibraryBusy,
    modelUploadRef,
    project,
    refreshLibraryModels,
    setParametricSourceModel,
    setParametricWorkbenchOpen,
    uploadLibraryImages,
    uploadLibraryModels,
    uploadLibraryVideos,
    videoUploadRef,
  } = controller;
  return (
    <div className="model-library-toolbar">
      <button className="button primary" disabled={modelLibraryBusy} onClick={() => modelUploadRef.current?.click()}>
        <FileUp size={16} />{tr(locale, "上传模型", "Upload models")}
      </button>
      <button className="button" disabled={modelLibraryBusy || !project} onClick={() => { setParametricSourceModel(undefined); setParametricWorkbenchOpen(true); }}>
        <WandSparkles size={16} />{tr(locale, "参数化生成", "Parametric asset")}
      </button>
      <button className="button" disabled={modelLibraryBusy} onClick={() => imageUploadRef.current?.click()}>
        <FileImage size={16} />{tr(locale, "上传图片", "Upload images")}
      </button>
      <button className="button" disabled={modelLibraryBusy} onClick={() => videoUploadRef.current?.click()}>
        <FileVideo size={16} />{tr(locale, "上传视频", "Upload videos")}
      </button>
      <button className="manager-icon-button resource-refresh-control" aria-label={tr(locale, "刷新资源状态", "Refresh asset status")} title={tr(locale, "刷新资源状态", "Refresh asset status")} disabled={modelLibraryBusy} onClick={() => void refreshLibraryModels()}>
        <RefreshCw className={modelLibraryBusy ? "spin" : ""} size={15} />
      </button>
      <input ref={modelUploadRef} hidden multiple type="file" accept={ACCEPTED_MODELS} onChange={(event) => void uploadLibraryModels(event.target.files)} />
      <input ref={imageUploadRef} hidden multiple type="file" accept={ACCEPTED_IMAGES} onChange={(event) => void uploadLibraryImages(event.target.files)} />
      <input ref={videoUploadRef} hidden multiple type="file" accept={ACCEPTED_VIDEOS} onChange={(event) => void uploadLibraryVideos(event.target.files)} />
    </div>
  );
}
