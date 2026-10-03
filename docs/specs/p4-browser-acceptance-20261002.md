# P4 浏览器域验收报告(H-C7-P4 四题:A4 / B1 / B2 / C2,2026-10-02)

规格:`docs/specs/h-c7-p4-three-migration-bench-20261002.md`。本报告补齐 20 题基准中四题的
**既有正式测试跑绿 + 编辑器产品链真实浏览器操作证据**,不重建任何测试与宿主。

- 执行脚本:`apps/web/scripts/p4-browser-acceptance.mjs <round>`(round=1|2,两轮独立)。
- 基建:复用 `apps/web/scripts/isolatedStudioGate.mjs`——独立端口、独立临时数据目录、
  `OBJECT_STORE=local`、不触碰用户数据;playwright-core + 本机 Chrome headless,
  1920×1080 深色(`data-theme` 断言非 light),用完即关(结束后 4100/5173 无监听、无 Chrome 残留)。
- 全程未运行 cargo;未 commit/push/reset/clean/stash;未改 jc-i-continuation。
- 证据:`test-output/p4-browser-20261002/round{1,2}/`(每轮 22 张截图 + report-roundN.json),
  里程碑 `test-output/p4-browser-20261002/progress-0{1,2,3}.json`。

## 总判定

| 题 | 正式测试(既有,vitest) | 浏览器产品链(真实操作,两轮) | 判定 |
|---|---|---|---|
| A4 场景快照往返 | 5 文件 **38/38** 绿 | 保存→重开→models+primitives 规范化逐字节一致;编组往返保持 | **通过** |
| B1 材质升级 clearcoat | 5 文件 **31/31** 绿(I23/C9/C23 层栈 + DeepSL 入口) | clearcoat 双路 fail-closed 证 + DeepSL 作者态持久化链证;**clearcoat 渲染链被 ABI v2/v3 缺口阻断(登记)** | **部分通过(缺口登记)** |
| B2 颜色分级 | 3 文件 **25/25** 绿 | 亮度/对比度调整→保存(入快照)→重开保持;零重置恒等;与 customShader 同材质共存 | **通过** |
| C2 撤销重做链 | 5 文件 **23/23** 绿 | 5 步编辑全部入栈;深度 1 Ctrl+Z/Ctrl+Y 值级往返通过;**深度≥2 连续撤销静默失效(缺陷登记)** | **部分通过(缺陷登记)** |

---

## A4 场景快照往返 —— 通过

**既有正式测试(命令 `pnpm --filter @bim-studio/web test -- <files>`,2026-10-02 实跑):**

| 文件 | 结果 |
|---|---|
| `apps/web/src/controllers/sceneSnapshotFactory.test.ts` | 1/1 |
| `apps/web/src/delivery/applySceneViewerSnapshot.test.ts` | 4/4 |
| `apps/web/src/controllers/sceneWorkspaceSave.test.ts` | 17/17 |
| `apps/web/src/hooks/useAppSceneSyncEffects.test.ts` | 10/10 |
| `apps/web/src/studio/sceneApplicationSync.test.ts` | 6/6 |

**产品链(复用既有入口,一次真实往返,两轮各一遍):**

1. UI 建项目→`项目场景`→`新建场景`→`创建并进入` 进入三维编辑器;
2. 上传自制 glTF 夹具(父节点 P4-底盘 + 子节点 P4-立柱,两套 PBR 材质)→`直接插入`;
   `创建`→`插入基础元素`→`立方体` 画布点放 ×2(真实图元创建入口);
3. 检查器真实输入位置 X=3(变换基准)→ `保存项目`(捕获保存链响应,断言 OK);
4. `page.reload()` 重开(useAppSceneSyncEffects→applyScene 恢复)→ 平铺列表逐行比对 + API 读快照。

**一致性判定**:`models`(glTF 实例)与 `primitives`(图元)两数组按 B2 链的零调整恒等契约
规范化后**逐字节一致**(对象集/名称/变换/透明度/显隐/材质),两轮均过;
`a4-before-transform-moved` 证明 X=3 已持久化;UI 行集合前后一致。

**层级**:平铺目录 Ctrl 多选 glTF 实例+图元 1 → 选中栏`编组所选对象`→ 编组 1(2 成员)→
保存→重开→`selectionSets` 中编组及 2 成员保持,目录树显示嵌套(截图 `05-a4-group-after-reload.png`,
轮 2 `08-b1-deepsl-bound.png` 左栏可见 编组 1→p4-fixture.gltf 嵌套)。

**revision 说明**:编辑器 runtime revision 链由保存链 CAS 收据承担(保存被接受即 baseRevision
匹配);服务端场景记录 updatedAt 在项目级保存路径下不单独前进,已如实记录,不改判据。

**截图**:`round{1,2}/01-a4-before-objects.png`、`02-a4-before-viewport.png`、`03-a4-after-viewport.png`、`04-a4-group-created.png`、`05-a4-group-after-reload.png`。

---

## B1 材质升级 clearcoat —— 部分通过(缺口登记)

**既有正式测试(SDK 层栈,I23/C9/C23,`pnpm --filter @bim-studio/deep-engine test -- <files>` + web):**

| 文件 | 结果 |
|---|---|
| `packages/deep-engine/src/shader/clearcoatSemantics.test.ts`(C9 语义+Disney 对拍+守卫) | 7/7 |
| `packages/deep-engine/src/shader/materialLayered.test.ts`(C23 逐位/白炉/fail-closed) | 14/14 |
| `packages/deep-engine/src/shader/materialLayeredSurface.test.ts` | 4/4 |
| `packages/deep-engine/src/shaderAuthoring/packageClearcoat.test.ts` | 4/4 |
| `apps/web/src/delivery/sceneCustomShader.test.ts`(编辑器 DeepSL 入口) | 2/2 |

**产品链(作者页 ObjectAppearanceEditor → DeepSL 编辑器,真实浏览器):**

1. **fail-closed 证据 1(活动层参数越界)**:`clearcoatFactor 1.5` → `绑定到材质` →
   编译失败,诊断精确到字段:`$.source: out-of-range: clearcoatFactor must be between 0 and 1.`,
   且材质保持未绑定(不静默丢弃)。截图 `06-b1-failclosed-invalid.png`。
2. **缺口登记(v2 ABI 拒 clearcoat)**:合法 `clearcoatFactor 0.85; clearcoatRoughness 0.08` 在
   编辑器入口被拒:`$.source.clearcoatFactor: Clearcoat scalar materials require deep.pbr.mesh.v3.`
   (截图 `07-b1-clearcoat-v3-gap-registered.png`)。根因链:
   - 编辑器编译入口 `apps/web/src/delivery/sceneCustomShader.ts:24` 钉 `targetAbi:"deep.pbr.mesh.v2"`;
   - 包适配器 `packages/deep-engine/src/shaderAuthoring/packageAdapter.ts:126` 将 clearcoat 限定 v3;
   - Deep 运行时材质 `packages/deep-engine/src/runtimePackage/deepSlMaterial.ts:15`、
     `materialBindings.ts:37` 硬性要求 v2 包(运行时不消费 v3)。
   即:解析器/包 v3/I23 层栈(正式测试)全部就绪,但**编辑器到运行时的 clearcoat 渲染链未接通**,
   入口 fail-closed 行为正确(拒绝而非静默降级)。属 deep-engine 运行时域,本浏览器域不越权修改,登记待修。
3. **作者态持久化链证(v2 合法源)**:绑定含自定义 metallic/roughness 的 DeepSL → `编译通过·包预览`
   (PassCacheKey)→ 保存 → 重开 → DeepSL 面板`已绑定`且源码**逐字节一致**
   (`b1-persisted-customshader`/`b1-reload-still-bound`/`b1-reload-source-identical`)。
   截图 `08-b1-deepsl-bound.png`(轮 2,含编组树+绑定态)、`09-b1-deepsl-after-reload.png`。

**判定**:I23 层栈与 DeepSL 作者态持久化链通过;clearcoat 专有渲染链阻断于 ABI v2/v3 缺口,
fail-closed 正确,缺口已登记——**不虚报 done**。

---

## B2 颜色分级 —— 通过

**既有正式测试:**

| 文件 | 结果 |
|---|---|
| `apps/web/src/delivery/sceneSnapshotRenderPacket.test.ts`(含作者覆盖保持) | 22/22 |
| `apps/web/src/components/ObjectAppearanceEditor.test.tsx`(亮度/对比度控件) | 1/1 |
| `apps/web/src/viewer/sourceMaterialReset.test.ts`(恢复源材质参数) | 2/2 |

说明:`studioUngradedColor`/`studioColorAdjustment` userData 链的生产实现在
`apps/web/src/viewer/viewerEngineObjectState.ts:478 applyMaterialColorAdjustment`,无独立单测,
其行为由下方浏览器链 + 快照持久化断言(`b2-persisted-grading` 直接断言快照中的
`material.brightness/contrast`)覆盖。

**产品链(真实浏览器,作用于 glTF 实例)**:

1. 外观面板`颜色调整`→ 亮度 0.30、对比度 -0.25(range 真实事件)→ 输出读数 `0.30`/`-0.25`;
2. 保存 → API 快照断言 `material.brightness=0.3, contrast=-0.25` 已持久化(与 B1 的
   `customShader` 同一材质状态共存);
3. 重开 → 检查器读数保持 `0.30`/`-0.25`;
4. 零恒等:`重置颜色调整` → 读数 `0.00`/`0.00`(zero 调整恒等的产品入口复核),再恢复 0.30/-0.25。

**截图**:`round{1,2}/10-b2-color-adjusted.png`、`11-b2-after-reload.png`、`12-b2-restored-values.png`。

---

## C2 撤销重做链 —— 部分通过(缺陷登记)

**既有正式测试:**

| 文件 | 结果 |
|---|---|
| `apps/web/src/hooks/useSceneHistoryState.test.ts` | 7/7 |
| `apps/web/src/hooks/useSceneHistoryActions.test.ts`(T27 事务窗守卫) | 6/6 |
| `apps/web/src/studio/sceneAuthoringHistory.test.ts` | 7/7 |
| `apps/web/src/studio/sceneHistoryTransaction.test.ts` | 3/3 |

**产品链(独立新场景「P4 撤销重做链场景」,纯画布点放图元,真实键盘 Ctrl+Z/Ctrl+Y):**

- 5 步编辑全部真实入栈:`创建(创建菜单→立方体→画布点放)`、`位置 X=2`、`旋转 Z=45°`、
  `亮度 0.35`、`对比度 -0.3`(间隔>220ms 防抖,`c2-can-undo-after-5-edits` + 编辑后状态断言全过);
- **深度 1 Ctrl+Z**:对比度 -0.30→0.00 值级回退通过(`c2-undo1-contrast`,截图 `15-c2-undo1.png`);
- **深度 1 Ctrl+Y**:-0.30 恢复通过(`c2-redo1-contrast`,截图 `16-c2-redo1.png`,toast「已重做三维编辑」);
- **缺陷登记(钉住行为,修复后断言翻红强制复审)**:第二次连续撤销被**静默拒绝**——
  按钮与键盘双路、纯图元与含上传模型场景一致复现;redo 正常、undo-after-redo 正常。
  机理:撤销/重做的 applyScene 恢复后,迟到的 recordSceneEdit 以引擎恢复态再记一条指纹不一致的
  **幻影条目**,深度≥2 的撤销弹到幻影上不再产生可见回退。证据:`17-c2-depth2-refused.png`、
  探针 `apps/web/scripts/p4-probe-undo2.mjs`(两次创建后 undo#1 行数 3→2,undo#2/#3 行数不变、
  redo 正常消费重做栈)。该区域(useSceneHistoryState/Actions)有在途改造
  (未跟踪 `SceneGraphTransactionDriver.*` 属并行车道),本域不越权修改。
- 基准行 C2 的「10 步编辑全链可逆」在缺陷修复前**不可判 done**;本报告按实测登记。

---

## 如实边界

1. B1 clearcoat 渲染链、C2 深度≥2 撤销为**产品缺陷/缺口**,已精确登记(文件:行 + 复现 + 截图),
   不属浏览器验收域可修,未越权改代码。
2. A4 的「层级」取证 = 场景级编组(selectionSets)+ glTF 内部节点树渲染;实例级快照逐字节对拍
   不含 glTF 内部节点(该层级由素材确定性重建),已如实注明。
3. 隔离 gate 的 API 为 `apps/api/dist` 生产构建(与既有各验收轮一致);两轮使用各自独立临时数据目录。
4. 本报告不回填基准表状态位(ready→done 的回填属主线程);四题证据与判定以上表为准。
