// 真实视觉对照板:左=竞品实机截图,右=本产品同区位实机截图,等高拼接供逐维目检。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const webRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const competitor = resolve(webRoot, "../../test-output/competitor-ref");
const oursTemplate = resolve(webRoot, "test-output/assets-template/round4");
const ours2d = resolve(webRoot, "test-output/assets-2d");
const oursPrefab = resolve(webRoot, "test-output/ui-upgrade-prefab/round4");
const output = resolve(webRoot, "test-output/visual-compare");
mkdirSync(output, { recursive: true });

const LABEL_HEIGHT = 56;
const TARGET_HEIGHT = 860;
const GAP = 24;
const pairs = [
  { key: "1-template-market-dark", label: ["山海鲸 模板市场(竞品)", "Deep Monkey 模板库·深色(本产品)"], left: resolve(competitor, "shanhaibi-market-viewport.png"), right: resolve(oursTemplate, "library-all-dark.png") },
  { key: "2-template-market-light", label: ["帆软 模板市场(竞品)", "Deep Monkey 模板库·浅色(本产品)"], left: resolve(competitor, "fanruan-templates-viewport.png"), right: resolve(oursTemplate, "assets-templates-light.png") },
  { key: "3-2d-assets", label: ["帆软 视觉资源页(竞品)", "Deep Monkey 2D 资源页(本产品)"], left: resolve(competitor, "fanruan-visuals-viewport.png"), right: resolve(ours2d, "r3-dark-manager-2d.png") },
  { key: "4-3d-assets", label: ["ThingJS 资源中心(竞品)", "Deep Monkey 预制体库(本产品)"], left: resolve(competitor, "thingjs-store-viewport.png"), right: resolve(oursPrefab, "manager-prefab-tab.png") },
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
