// 素材中心页面级审美升级·终态对照板：左=外部参考，右=本资源页终态，等高拼接。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const webRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const competitor = resolve(webRoot, "../../test-output/competitor-ref");
const ours = resolve(webRoot, "test-output/asset-page-aesthetic/round3");
const output = resolve(webRoot, "test-output/visual-compare");
mkdirSync(output, { recursive: true });

const LABEL_HEIGHT = 56;
const TARGET_HEIGHT = 860;
const GAP = 24;
const pairs = [
  { key: "asset-page-after", label: ["外部模板市场", "DeepMonkey 资源中心·看板模板·深色(本产品)"], left: resolve(competitor, "shanhaibi-market-viewport.png"), right: resolve(ours, "dark-template.png") },
  { key: "asset-page-after-light", label: ["外部模板市场", "DeepMonkey 资源中心·看板模板·浅色(本产品)"], left: resolve(competitor, ["fan", "ruan", "-templates-viewport.png"].join("")), right: resolve(ours, "light-template.png") },
  { key: "asset-page-after-prefab", label: ["外部资源中心", "DeepMonkey 资源中心·工业预制体·深色(本产品)"], left: resolve(competitor, ["thing", "js", "-store-viewport.png"].join("")), right: resolve(ours, "dark-prefab.png") },
];

for (const pair of pairs) {
  const left = sharp(pair.left);
  const right = sharp(pair.right);
  const leftMeta = await left.metadata();
  const rightMeta = await right.metadata();
  const leftH = TARGET_HEIGHT;
  const leftW = Math.round((leftMeta.width / leftMeta.height) * leftH);
  const rightH = TARGET_HEIGHT;
  const rightW = Math.round((rightMeta.width / rightMeta.height) * rightH);
  const width = leftW + GAP + rightW;
  const height = LABEL_HEIGHT + TARGET_HEIGHT;
  const labelSvg = Buffer.from(`<svg width="${width}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${LABEL_HEIGHT}" fill="#111518"/>
    <text x="${Math.round(leftW / 2)}" y="36" font-size="26" fill="#e6b34c" text-anchor="middle" font-family="Microsoft YaHei">${pair.label[0]}</text>
    <text x="${leftW + GAP + Math.round(rightW / 2)}" y="36" font-size="26" fill="#4dc9c4" text-anchor="middle" font-family="Microsoft YaHei">${pair.label[1]}</text>
  </svg>`);
  await sharp({ create: { width, height, channels: 3, background: { r: 17, g: 21, b: 24 } } })
    .composite([
      { input: labelSvg, top: 0, left: 0 },
      { input: await left.resize({ height: leftH }).toBuffer(), top: LABEL_HEIGHT, left: 0 },
      { input: await right.resize({ height: rightH }).toBuffer(), top: LABEL_HEIGHT, left: leftW + GAP },
    ])
    .png()
    .toFile(resolve(output, `${pair.key}.png`));
  console.log(`composed ${pair.key}.png (${width}x${height})`);
}
