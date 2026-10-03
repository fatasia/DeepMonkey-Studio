# 引擎能力 → 上层消费审计(2026-10-03,GLM 主线程)

> 用户指令:检查底层引擎能力,上层要全部消费接入。本文是审计结论与剩余缺口。
> 方法:deep-engine 全部 16 个公共子路径的宿主导入分布 + 能力级 grep(非测试文件)+ 渲染能力登记表(33 项)消费链核对。

## 1. 子路径消费分布(apps/web/src 导入计数)

`@bim-studio/deep-engine` 89、`/runtime-package` 88、`/webgpu` 36、`/three-bridge` 14、`/shader-package` 14、`/scene` 14、`/gltf` 7、`/physics` 5、`/lighting` 5、`/shader-authoring` 3、`/textures` 2、`/particles` 2、`/hlod` 2、`/postprocess` 1、`/browser-image-decoder` 1 —— **16 个子路径全部有宿主消费,无零消费子路径**。

## 2. 能力级消费(非测试文件数)

| 引擎能力 | 上层消费 | 判定 |
|---|---|---|
| 渲染能力登记表(33 项,J4) | 诊断面板"渲染能力清单"折叠区 + AI platformContext(hc5-k17) | 已接入 |
| 高级材质 lobe(clearcoat/sheen/iridescence/transmission) | 合同/校验/桥 6–9 文件 | **作者入口缺(P1-1,见 §4)** |
| T14 根运动(平移+旋转) | 5(开关/复位 UI、播放头) | 已接入 |
| T20 粒子(曲线 LUT/排序/预算) | 15(曲线编辑器/预算面板) | 已接入 |
| 体积雾(散射反照率作者入口) | 7 | 已接入 |
| FixedStepClock(60Hz 物理) | 6 | 已接入 |
| T12 资产陈旧/再导入/删除影响面 | 12(陈旧徽标/更新流) | 已接入 |
| 路径追踪(并行分块/PNG 回执) | 12(导出场景→物理光照出图) | 已接入 |
| IK/FK(T15) | 17 | 已接入 |
| HLOD(T26/T27) | 4 | 已接入 |
| 接触阴影(C10,默认开) | 2 | 已接入 |
| instance outline(Deep 描边) | 12(勾选即生效,P0-4 真机复核过) | 已接入 |
| auto exposure / 虚拟纹理 / 遮挡剔除 | 1 / 1 / 5 | 已接入 |

符号级粗筛(5239 个导出、386 个被宿主直接点名)不作为缺口依据:WGSL 文本常量、ABI 常量与聚合类型由包内组合与 checksum 门消费,不要求宿主点名。

## 3. 渲染能力登记表缺口

- `instance-outline`(Deep 实例描边,`packages/deep-engine/src/postprocess/instanceOutline*.ts`)已实现并经真机验收,但 **J4 登记表未收录**(交接 §5.6)。待 native crate 拆分完成后登记(web=supported;native 无该 pass=degraded),同步 Rust 同形声明与金样 fixture 三方对拍。

## 4. 剩余缺口(P1-1,唯一"引擎有、上层无"项)——已复核为已完成,文档滞后

deep-material-gaps-20261003 §6-6/6-7 的"编辑器 UI、持久化、runtime package 未接"**已过时**(该文档写作早于收尾提交)。逐项复核(2026-10-03 真机):

1. 作者 UI:`apps/web/src/components/MaterialAdvancedLobes.tsx`(折叠分组默认收起,已被 ObjectAppearanceEditor 渲染);真机截图 `test-output/p1-1-advanced-material-20261003/02-clearcoat-set.png` 显示"高级材质 已启用 1 项 + 清漆 0.6"。
2. 持久化/撤销/复制:字段在 `SceneMaterialState`(contracts),场景快照序列化自动覆盖;材质复制走 three 原生 `copy`(lobe 全带,materialIor.ts `copyOwnedMaterialSurface`)。
3. three 投影:`apps/web/src/viewer/materialPhysicalLobes.ts`(readPhysicalLobes/applyPhysicalLobes + standard→physical 晋升),`declarativeMaterial.ts` clearcoat 路径配套。
4. 对拍:`pnpm --filter @bim-studio/deep-engine test:advanced-material-three-parity` PASS(sheen 0.09%/clearcoat 0.10%/iridescence 2.7%/组合 0.14%)。
5. manifest:`material-clearcoat`/`material-advanced` 已在登记表;runtime package:`renderPacketBrowserMaterial.ts` 已解析携带 `advancedParameters`(browserProfile 白名单含该键)。

遗留的真实待办仅:§3 的 instance-outline 登记三项同步(TS/Rust/金样),以及变体创建后新开 lobe 的桥拒绝提示文案核对。
