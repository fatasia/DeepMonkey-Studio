# 冻结页面背景图生成器

页面背景图在构建阶段生成透明 RGBA 图集，离线播放器直接绘制，不携带浏览器、Node 或 sharp。

## 合同

- `decodePageBackground` 为独立可选能力；旧 host 没有该方法时由核心保持 deferred，不会误用 widget 的居中 cover。
- `background` 必须显式提供 `fit: cover | contain | stretch | original`、`position: center | top | bottom | left | right` 与布尔 `repeat`。基类 `fit` 不决定页面布局；widget `decodeImage` 未改。
- 网页权威实现为 `dashboardCanvasStyle.ts`：默认 cover、center、no-repeat；stretch 对应 `100% 100%`，original 对应 auto。透明区域保留 alpha，由下层页面底色绘制。
- 复用 sharp 0.35.3 与已有冻结字节 SHA 校验、EXIF 方向、sRGB、straight alpha。输入、解码像素及输出各受 64 MiB 上限约束；取消前置检查与异步阶段检查均保留。动画/多页图片拒绝。
- 平铺按行复制并倍增已完成周期，不创建海量 composite 描述对象；时间与输出字节数线性相关。1×1 图案生成 2048² 图集的聚焦用例本次约 18 ms（单次测试，不是性能基准）。

## 验证

`node --test scripts/lib/dashboardPageBackgroundRaster.test.mjs scripts/lib/dashboardRasterHost.test.mjs`：15 项通过，覆盖五定位、四种 fit、透明边界、原尺寸裁剪、负偏移与奇数尺寸平铺、布局证据哈希、输入快照、取消、篡改、非法合同、2048² 小图平铺及原 widget 回归。

`pnpm exec tsc -p scripts/tsconfig.dashboard-acceptance.json` 与 `pnpm gate:repository` 通过。

视觉入口：`pnpm exec tsx --conditions=development scripts/verify-dashboard-page-background.mts`，本机 `http://127.0.0.1:5293/`。生成 80 个固定输入（240×160 / 239×159 × 四 fit × 五定位 × repeat），左侧调用正式 CSS 样式函数，右侧显示正式 host 生成图集；素材是脚本内合成的透明色块，不是客户资产。

本轮浏览器截图位于 `test-output/dashboard-page-background/`：

1. `round1-dark-center.png`：cover/contain/stretch 对照；原尺寸样本超出可见区，因此未将该图作为 original 证据。
2. `round2-light-original-odd.png`：发现偏移平铺倍增时复制了不完整周期，增加奇数尺寸测试后修复。
3. `round3-light-original-odd-fixed.png`：修复后的原尺寸/平铺复检。
4. `round4-dark-contain-right.png`：右定位 contain 与平铺复检。

对标采用项目已冻结的 FVS 画布一致性与西门子克制原则；此片不新增产品样式或令牌。10 维自检：布局 9、令牌 9、排版 9、交互状态不适用、动效不适用、3D 不适用、信息设计 9、反馈不适用、主题 9、语义 9。工程十维自检均为 9，证据对应合同、聚焦回归、取消/篡改失败路径及上述视觉修复。

## 边界

- 本片提交的是生成器与独立视觉验收；正式页面资源归属、编译背景层和 Native window evidence 由主线另片提交。
- 居中落点量化到整数像素，缩放滤波由 sharp 执行；不承诺与任意浏览器的亚像素插值逐像素一致，`appearance.crossHost` 继续 deferred。
- 截图覆盖本片固定色块、双主题及上述布局，不代表任意客户图片、全部页面尺寸或整套编辑器视觉验收。
