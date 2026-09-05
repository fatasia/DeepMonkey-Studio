import type { Camera, Object3D, Scene, WebGLRenderer } from "three";

/** 截取实际模型帧；不采集按钮、网格或操控器，不修改素材内容。 */
export function captureModelThumbnail(renderer: WebGLRenderer, scene: Scene, camera: Camera, helpers: Object3D[]): Promise<Blob> {
  const visibility = helpers.map(helper => helper.visible);
  try {
    helpers.forEach(helper => { helper.visible = false; });
    renderer.render(scene, camera);
    // toBlob 在调用时快照像素；UI 只在读取完成后触发普通文件下载。
    return new Promise((resolve, reject) => renderer.domElement.toBlob(blob => {
      if (blob) resolve(blob); else reject(new Error("预览图生成失败，请重试"));
    }, "image/png"));
  } finally {
    helpers.forEach((helper, index) => { helper.visible = visibility[index]!; });
    renderer.render(scene, camera);
  }
}
