import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const productName = "Deep Monkey Studio";
const webBrand = path.join(root, "apps/web/public/brand");
const desktopIcons = path.join(root, "apps/desktop/src-tauri/icons");
const issues = [];

await expectImage(path.join(webBrand, "app-icon.png"), 1024, 1024);
await expectImage(path.join(webBrand, "app-icon-chroma.png"), 1024, 1024);
await expectImage(path.join(webBrand, "logo-transparent.png"), 1216, 224);
await expectImage(path.join(desktopIcons, "32x32.png"), 32, 32);
await expectImage(path.join(desktopIcons, "128x128.png"), 128, 128);
await expectImage(path.join(desktopIcons, "128x128@2x.png"), 256, 256);

const iconSvg = await read("apps/web/public/brand/app-icon-industrial.svg");
const logoSvg = await read("apps/web/public/brand/logo-industrial.svg");
if (!iconSvg.includes(productName) || !logoSvg.includes(productName)) issues.push("SVG 品牌名称未统一");
if (!logoSvg.includes("Deep Monkey") || !logoSvg.includes(">Studio<")) issues.push("Logo 字标不是当前产品名");

const legacyIconHash = await hash(path.join(webBrand, "app-icon-chroma.png"));
const primaryIconHash = await hash(path.join(webBrand, "app-icon.png"));
if (legacyIconHash !== primaryIconHash) issues.push("兼容 PNG 与主图标不一致");

const ico = await readFile(path.join(desktopIcons, "icon.ico"));
const icoSizes = readIcoSizes(ico);
for (const size of [16, 24, 32, 48, 64, 256]) {
  if (!icoSizes.includes(size)) issues.push(`Windows ICO 缺少 ${size}x${size}`);
}

const tauri = JSON.parse(await read("apps/desktop/src-tauri/tauri.conf.json"));
if (tauri.productName !== productName || tauri.app?.windows?.[0]?.title !== productName) issues.push("Tauri 产品名或窗口标题未统一");
if (tauri.bundle?.windows?.nsis?.startMenuFolder !== productName) issues.push("安装包开始菜单名称未统一");
if (tauri.bundle?.windows?.nsis?.installerIcon !== "icons/icon.ico" || tauri.bundle?.windows?.nsis?.uninstallerIcon !== "icons/icon.ico") {
  issues.push("安装器与卸载器未使用统一 ICO");
}
for (const icon of tauri.bundle?.icon ?? []) {
  try { await readFile(path.join(root, "apps/desktop/src-tauri", icon)); }
  catch { issues.push(`Tauri 缺少图标：${icon}`); }
}

const html = await read("apps/web/index.html");
if (!html.includes(`<title>${productName}</title>`)) issues.push("Web 默认页签标题未统一");
if (!html.includes('href="/brand/app-icon-industrial.svg"')) issues.push("Web favicon 未使用统一矢量图标");

if (issues.length) {
  console.error("产品品牌与图标门禁失败：");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`产品品牌与图标门禁通过：${productName} · ICO ${icoSizes.join("/")} px`);
}

async function expectImage(file, width, height) {
  const metadata = await sharp(file).metadata();
  if (metadata.width !== width || metadata.height !== height) issues.push(`${path.relative(root, file)} 尺寸应为 ${width}x${height}`);
}

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function hash(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function readIcoSizes(buffer) {
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => buffer[6 + index * 16] || 256).sort((left, right) => left - right);
}
