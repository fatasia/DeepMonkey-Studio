# J3-D-full 独立关闭范围复核

2026-10-01 21:00最终裁定：**关闭当前登记 `J3-D-full` 行**。原九层48格、同包32完整场景帧与64后处理帧、715点来源证书已补齐完整共同场景范围；[合法差异登记](j3-d-fullscene-legal-differences-20261001.md)保留原strictfalse及失败附件。关闭Gate D不关闭整个J3或Gate E。

## 最终闭行依据

| 原条件 | 最终证据 | 裁定 |
|---|---|---|
| 同包双宿主、双相机、双fresh与重复稳定 | 固定工业包 `e685bb6e…52d5`，27实例/19几何/11材质/真实纹理，原两角与曲面/遮挡；core实际32帧，完整原图/附件保留 | 满足完整场景共同域，不用独立swatch替代 |
| 几何→深度→法线/阴影→HDR→完整输出 | 当前core `run-2026-10-01T12-19-26-116Z`；32全图原byte1/SSIM、1159材质点含297曲面与原法线门通过；715 receiver旧新实际域精确join | 满足；712正控制、3零控制均保留 |
| 原差异门及独立合法来源 | LD-16–20的107328真实4x覆盖、各host CSM/caster/raster、独立sampler/最后除法规范证书及缺对象/错矩阵/错误bias负控；join的15项证书SHA全部匹配 | 四cross shadow gap、跨AA全图差异及旧strictfalse不改写 |
| 同包合法Fog/Bloom到完整显示 | 最终effects `run-2026-10-01T12-38-40-682Z`：实际64帧/32组/64参考行；最大中间误差 .001953125、最大输出1byte、最低SSIM .999159055723659；原门通过 | Web/Native各自合法profile，不要求跨算法等值 |
| 生产源/原九层与实图 | 20:17实际producer刷新后的九层48格聚合passed/stable/freshnessVerified=true、currentRun=false；最终effects4982记录源当前逐SHA一致且canonical digest正确；前序两轮真实图审查保留 | 旧广域guard后续被无关作者/F6源变化触发时，仅保留measured batch，不冒称当前fresh |

独立CPU收据：`test-output/j3-d-current-complete-audit-20261001/final-closure-review.json` passed=true、gpuExecuted/currentRun=false；该审查没有再次执行GPU/Cargo或更改旧收据。最终effects原receipt SHA `55d6f1cd5e33cab396dd94b6443115b6a16d3be3d94c5b52bbf9176401d2d9c4`；九层receipt SHA `c5901c756c0693144c9038fb4c5e0029489c2c0f43c46210a5a0683baacaade1`。

登记共同域支持opaque基础PBR、真实baseColor纹理、flat/curved几何、单太阳、CSM4与DeepACES/output；原48格继续覆盖UV/MR/MASK/单层BLEND/neutral输出。OIT重叠透明、SSR/TAA/RT、高层材质/normal-map/mip/aniso全排列没有在本工业配置执行，沿I/C支持合同和任务管理。帧时、驱动显存、unknown硬件fault与完整恢复仍归E；T00性能合同不变。当前总进度17/61=27.9%，J/C8/10=80%、I9/10=90%。

## 补齐前的历史审查

以下是此前“完整场景共同输出未补齐”的审查依据，现已由上述同包证据补齐，保留用于追溯。

## 现状核查

1. 源码及未跟踪：检索 packages/apps 的 J3/RenderPacket/输出与 git status；读取 `j3DFullLayerMatrix.ts` 和聚合器。生产渲染、读回、相机及恢复装配已存在；本复核只读，不建立新渲染器。
2. 契约：既有 TS RenderPacket、Native contract、Runtime Package 及 layer/cell catalog 已定义同输入身份与合法差异；没有第二协议需求。
3. 依赖：现有 Node、Playwright、esbuild、wgpu、serde_json 足够；不增加依赖。
4. 消费：九层由 texture、geometry/depth、normal/shadow、HDR、Bloom、Fog、display 的正式宿主 runner 生产；聚合器消费其收据，不运行宿主。
5. 测试与证据：读取 `test-output/interrupted-0930/j3-d-full-layer-matrix/evidence.json`，passed/stable/freshnessVerified=true、currentRun=false。九层格数为14/2/2/2/2/2/6/10/8，共48。生产源随后因 J3-E metadata 修复变化；最后统一重跑与 source identity 更新由root负责，本复核不把旧收据状态认证成修复后的本次运行。
6. 规格：读取权威 `D:/Documents/bim/deliverables/research-20260928/剩余任务清单.md`，仓内 `remaining-tasks-estimates-20260930.md` 第58行、`docs/reports/J3-双端RenderPacket对拍门规格-20260929.md`，以及09-30 geometry/depth、HDR、normal/shadow、texture和10-01矩阵规格。

已有（不重建）：同输入及 source freshness 守卫、九层实际双端附件/统计判据、15项合法差异、两相机重复运行。真实缺口：完整场景共同能力的组合输出与同包身份证据，而非再扩大聚合声明。

## 行范围与结论依据

剩余表第58行文字为“HDR、阴影/法线与后处理逐层双端实渲对拍；扩展合法差异矩阵”。逐层基础交付已经满足登记子集。权威清单第23行仍明确“Gate D 完整场景覆盖”，第295行要求同一包双宿主对拍且“完整场景范围待扩”；不能把该行的 `full` 静默改为九个独立数值夹具。

- HDR实际严格门仍为 single-sun/flat-normal triangles；smooth-cube HDR equality 明确 excluded。C8 单独材质/显示家族证据不能自动证明同包完整场景 HDR 对拍。
- Bloom/Fog 为各宿主合法 profile 的独立附件与各自 CPU reference；display 为共同 neutral swatch。它们已证明相应通道，尚未证明同一 Runtime Package 的场景 HDR→后处理→最终显示组合输出。
- 纹理七配置覆盖实际 UV/MR/MASK/单层 BLEND；规范明确不覆盖完整材质族、normal mapping、layered、线性/mip/各向异性。单独I/C证据须按共同支持域纳入同包场景，或明确登记 unavailable/degraded，不能从未测推为完全支持。
- overlapping transparency/OIT 是已登记非共同能力；不要求改成相等才能关闭共同域。跨宿主不同后处理也不要求最终逐像素相等，应继续使用原合法 profile/reference 判据。

当前聚合明确 excluded：cross-host post-process pixel equality、smooth-cube HDR equality、overlapping transparency/OIT、whole-scene product visual quality、frame performance。前述非共同能力排除合理；完整场景共同输出仍需证据。帧时归 Gate E/最终性能验收，不单独据此阻断 Gate D，不把门限加码。

## 最小后继

复用既有 Runtime Package/renderer/readback，在GPU前固定一个真实有曲面、作者材质/纹理、阴影及已支持后处理的共同场景和两相机。双宿主消费同一包与配置，记录 package/packet/source/quality/light identity；对共同 HDR、normal/depth/shadow 继续使用预登记判据，对不同后处理保留各 profile 的参考门，并采集实际最终场景截图和同宿主重复 hash。非共同能力在清单逐项 supported/degraded/unavailable 登记。

完成这一同包组合证据后，再依据权威范围审查关闭 `J3-D-full`。当前可以记录“九层48格共同子集完成”，整项计数保持不变。本复核未运行GPU或Cargo。
