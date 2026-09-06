import { ROBOT_IMPORT_LIMITS, type ModelRecord } from "@bim-studio/contracts";
import { loadViewerAssetBuffer } from "../viewer/viewerAssetTransport";
import { readRobotPackage } from "../viewer/urdfPackageResources";

/** 只改变 ZIP 压缩，不改变 XML、网格字节和关节层级。 */
export async function compressRobotPackage(model: ModelRecord, signal: AbortSignal): Promise<File> {
  if (!model.manifest?.robot || !["urdf", "zip"].includes(model.format)) throw new Error("请选择 URDF 机器人素材");
  const { default: JSZip } = await import("jszip");
  const binary = await loadViewerAssetBuffer(model.sourceUrl, "机器人包", { signal });
  signal.throwIfAborted();
  if (binary.byteLength > ROBOT_IMPORT_LIMITS.compressedBytes) throw new Error("机器人包超过压缩限制");
  const files = await readRobotPackage(binary, model.manifest.robot, model.format === "zip", signal);
  const output = new JSZip();
  for (const [path, data] of files) {
    signal.throwIfAborted();
    output.file(path, data);
  }
  const compressed = await output.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 9 } }, () => signal.throwIfAborted());
  signal.throwIfAborted();
  return new File([compressed], `${model.name.replace(/\.[^.]+$/, "")}.compressed.zip`, { type: "application/zip" });
}
