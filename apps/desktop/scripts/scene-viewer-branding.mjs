import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseClientPackageBranding } from "../../api/src/clientPackageBranding.ts";
import { verifySceneClientArchive, sceneClientArchiveLimits } from "../../../scripts/lib/sceneClientArchive.mjs";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const JSZip = requireWeb("jszip");

/** 仅消费同一发布版本的品牌，不将归档的能力声明当作 WebView 运行证明。 */
export async function resolveSceneViewerBranding(options, publication) {
  let applicationName, iconDataUrl;
  if (options.clientBrandingPackage) {
    const archivePath = path.resolve(options.clientBrandingPackage);
    if ((await stat(archivePath)).size > sceneClientArchiveLimits.archiveBytes) throw new Error("客户端 ZIP 超过读取限额");
    const bytes = await readFile(archivePath);
    const { manifest } = await verifySceneClientArchive(bytes, { expectedTarget: "three-webview" });
    if (manifest.purpose !== "delivery" || manifest.projectId !== publication.projectId
      || manifest.sceneId !== publication.sceneId || manifest.publishedAt !== publication.publishedAt) {
      throw new Error("品牌归档必须与待构建的项目、场景和发布版本一致");
    }
    applicationName = manifest.branding?.applicationName;
    if (manifest.branding?.iconPath) {
      const zip = await JSZip.loadAsync(bytes);
      const icon = await zip.file(manifest.branding.iconPath).async("nodebuffer");
      iconDataUrl = asDataUrl(icon, manifest.branding.iconPath);
    }
  }
  if (options.iconFile) {
    const iconPath = path.resolve(options.iconFile);
    if ((await stat(iconPath)).size > 2 * 1024 ** 2) throw new Error("图标不能超过 2 MiB");
    iconDataUrl = asDataUrl(await readFile(iconPath), iconPath);
  }
  return parseClientPackageBranding({
    applicationName: options.productName ?? applicationName,
    ...(iconDataUrl ? { iconDataUrl } : {}),
  });
}

function asDataUrl(bytes, name) {
  const extension = path.extname(name).toLowerCase();
  if (![".png", ".ico"].includes(extension)) throw new Error("图标只支持 PNG 或 ICO");
  return `data:image/${extension === ".png" ? "png" : "x-icon"};base64,${bytes.toString("base64")}`;
}

export async function stageSceneViewerIcon(branding, buildRoot) {
  if (!branding.iconIco) return undefined;
  const file = path.join(buildRoot, "client-icon.ico");
  await writeFile(file, branding.iconIco);
  return file.replaceAll("\\", "/");
}
