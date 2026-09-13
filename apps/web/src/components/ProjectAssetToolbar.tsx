import { FileImage, FileUp, FileVideo, Gauge, RefreshCw, WandSparkles } from "lucide-react";
import { ModelImportInput } from "./ModelImportInput";
import { translate as tr } from "../i18n";
import type { SceneManagerController } from "./SceneManager";
import { ProjectAppearanceUpload } from "./ProjectAppearanceUpload";

const ACCEPTED_IMAGES = ".jpg,.jpeg,.png,.webp,.gif,.svg";
const ACCEPTED_VIDEOS = ".mp4,.webm,.ogv,.mov";

export function ProjectAssetToolbar({ controller }: { controller: SceneManagerController }) {
  const {
    imageUploadRef,
    locale,
    modelLibraryBusy,
    modelUploadRef,
    onParametric,
    onReturnToScene,
    onOptimizer,
    project,
    refreshLibraryModels,
    uploadLibraryImages,
    uploadLibraryModels,
    uploadLibraryVideos,
    videoUploadRef,
  } = controller;
  const modelWorkflowAvailable = Boolean(onReturnToScene);
  return (
    <div className="model-library-toolbar">
      {modelWorkflowAvailable && (
        <button className="button primary" disabled={modelLibraryBusy} onClick={() => modelUploadRef.current?.click()}>
          <FileUp size={16} />{tr(locale, "上传模型", "Upload models")}
        </button>
      )}
      <button className="button" disabled={modelLibraryBusy || !project} onClick={onParametric}>
        <WandSparkles size={16} />{tr(locale, "参数化生成", "Parametric asset")}
      </button>
      {modelWorkflowAvailable && (
        <button className="button" disabled={modelLibraryBusy || !project} onClick={() => onOptimizer()}>
          <Gauge size={16} />{tr(locale, "导入与优化", "Import & optimize")}
        </button>
      )}
      <button className="button" disabled={modelLibraryBusy} onClick={() => imageUploadRef.current?.click()}>
        <FileImage size={16} />{tr(locale, "上传图片", "Upload images")}
      </button>
      <button className="button" disabled={modelLibraryBusy} onClick={() => videoUploadRef.current?.click()}>
        <FileVideo size={16} />{tr(locale, "上传视频", "Upload videos")}
      </button>
      <button className="manager-icon-button resource-refresh-control" aria-label={tr(locale, "刷新资源状态", "Refresh asset status")} title={tr(locale, "刷新资源状态", "Refresh asset status")} disabled={modelLibraryBusy} onClick={() => void refreshLibraryModels()}>
        <RefreshCw className={modelLibraryBusy ? "spin" : ""} size={15} />
      </button>
      {project && <ProjectAppearanceUpload key={project.id} projectId={project.id} locale={locale} disabled={modelLibraryBusy} onUploaded={refreshLibraryModels} onResourcesUploaded={controller.setUploadedResources} />}
      {modelWorkflowAvailable && <ModelImportInput inputRef={modelUploadRef} locale={locale} scopeKey={project?.id} multiple onFiles={uploadLibraryModels} />}
      <input ref={imageUploadRef} hidden multiple type="file" accept={ACCEPTED_IMAGES} onChange={(event) => void uploadLibraryImages(event.target.files)} />
      <input ref={videoUploadRef} hidden multiple type="file" accept={ACCEPTED_VIDEOS} onChange={(event) => void uploadLibraryVideos(event.target.files)} />
    </div>
  );
}
