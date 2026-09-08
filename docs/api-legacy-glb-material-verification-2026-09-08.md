# API 旧 GLB 材质兼容验证（2026-09-08）

状态：已完成——限定后端旧 SG 兼容和隔离上传验证；新构建浏览器由主线程统一执行，本报告不冒称前端视觉已通过。

## 根因与实现

`glbOptimizer.ts` 原 NodeIO 仅注册 Draco，`converterOutputAudit.ts` 仅注册 Draco/Meshopt。因此原 GLB 的必需 `KHR_materials_pbrSpecularGlossiness`，以及 Web 派生的 WebP/IOR/specular 均可能被拒绝。现两处注册官方 `ALL_EXTENSIONS`，解码依赖包含既有 Draco 与 Meshopt。

`legacyGlbMaterials.ts` 在重写前检查声明的 used/required 扩展，未知 vendor 明确拒绝，不让 NodeIO 静默丢弃。仅实际旧材质命中时执行官方 [metalRough](https://gltf-transform.dev/modules/functions/functions/metalRough)，复用 [旧 SG 扩展](https://gltf-transform.dev/modules/extensions/classes/KHRMaterialsPBRSpecularGlossiness) 的官方解释；没有新写着色器或转换算法。读小模型只取 JSON chunk 判别，现代小模型不启动解码/重写。旧材质不受 1 MB 压缩门槛或关闭 Draco 选项阻断，派生文件略增大也不能退回不可解释的旧材质。原上传文件不覆盖，仍在 `output/geometry.glb` 派生路径处理。

LOD 共用兼容读取；旧 SG 转换后保留单色贴图，避免旧 prune 对 specular 槽的“不支持裁剪”提示及不必要材质再解释；现代压缩路径原配置不变。几何审计只读支持扩展，不执行材质转换或修改原字节。

## 聚焦测试

- API `glbOptimizer.test.ts`、`converterOutputAudit.test.ts`、`industrialFormatWaitingAcceptance.test.ts`、`jtInspectionAcceptance.test.ts`：4 文件 20 项通过。
- 新增 6 项：因子/alpha cutoff/双面/extras/署名，diffuse 原图字节与 UV 偏移，gloss alpha→roughness 精确像素，现代小 GLB 含 clearcoat 字节不变，关闭 Draco 仍迁移，两个 LOD 派生且原文件 SHA 不变，unknown vendor 拒绝写入（相关断言合并在上述 6 用例内）。
- API `tsc --noEmit` 退出 0；未自行 build、commit 或 push，未改 Web、账号、`.env` 或正常存储配置。

## 三原文件与两份实际 Web 派生上传

运行 `apps/api/scripts/verifyLegacyGlbUpload.ts`，直接调用真实 Fastify 上传路由与 ConversionQueue，隔离 JsonStore/LocalObjectStore，使用 source-b 三原 GLB 及 `legacy-material-workflow-W5bUES/r1-dark-*` 的油泵/输送机实际 Web 下载文件。权威证据：`test-output/codex-2026-09-05/api-legacy-glb-9bmBRu/report.json`；5/5 通过，源路径 SHA 与 API 上传 source 路径 SHA 均不变，所有输出无旧 SG，实际基色贴图存在，几何审计通过。

| 输入 | 输入→API输出字节 | 场景实例三角数（前后相同） | 输出扩展 |
|---|---:|---:|---|
| 钢厂 `06cec0…` | 3,316,628→762,820 | 52,664 | Draco / IOR / specular |
| 油泵 `07f04e…` | 2,648,360→2,656,868 | 4,479 | Draco / IOR / specular |
| 输送机 `0819b5…` | 3,080,048→2,634,724 | 9,195 | Draco / IOR / specular |
| 油泵 Web 派生 | 2,981,512→2,981,512 | 3,117 | WebP / Draco / IOR / specular |
| 输送机 Web 派生 | 2,620,816→2,620,816 | 6,358 | WebP / Draco / IOR / specular |

两份现代 Web 派生经 API 后整个输出 SHA 与上传字节相同。原三项 SHA 详见报告，与原缓存目录记录一致。油泵略增加 8,508 字节是材质兼容派生，不宣称每次转换都减小体积。

历史失败目录 `api-legacy-glb-nxShGj/e2v0Z3` 保留：前者测试错误地要求 dedup 前后独立材质数相等，后者错误地要求独立 mesh 三角数相等；实际官方 dedup 合并共享网格，场景实例三角数才是此处保几何的有效计数。最终改为实例遍历，不降低三角数量要求。首次 LOD 单测对 8 MB Buffer 作逐元素深比较导致测试超时，改为精确 SHA 后 6 项 118ms；没有放宽超时或修改产品规避问题。

## 边界

这是实际上传路由/队列/文件派生与审计验证，不是浏览器画质证明，不自动批准素材，也不下载/迁移缓存。官方工作流转换不保证任意旧渲染器逐像素一致。原三份文件均小于 8 MB，实际资源没有触发 LOD；LOD 仅用带未引用尺寸 accessor 的隔离合成 GLB 验证两级路径，不能外推为大型工业模型 LOD 质量认证。
