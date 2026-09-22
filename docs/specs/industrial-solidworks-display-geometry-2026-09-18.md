# SolidWorks 真实显示网格验证

固定的 cadmpeg 0.6.0 已能从本轮 5 个真实 SLDPRT 读取 B-Rep 和显示网格；先前“只有容器检查”的描述不再适用于这批样本。当前产物是诊断预览，未开放生产导入。

## 实际结果

| 样本 | 体 | B-Rep 面 | 显示网格 | 三角形 | 网格归属未闭合 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 穿孔圆筒 | 1 | 6 | 35 | 8,872 | 31 |
| 安装支架 | 1 | 61 | 61 | 1,292 | 5 |
| 通风护罩 | 1 | 96 | 224 | 4,236 | 153 |
| 楼梯焊件 | 63 | 486 | 520 | 24,880 | 208 |
| 支撑夹具 | 1 | 103 | 114 | 1,712 | 15 |

源样本、哈希和 MIT 来源记录沿用 `data/external-assets/industrial-format-plan/samples/solidworks-sheetmetal-20260918/manifest.json`。固定 CLI SHA-256 为 `14de5287e42a27569e0fab333a99522a455c92502fbfd62cde26d1d0e31d4568`，未重新下载或替换解析器。

`scripts/fixtures/sldprt-glb-preview.mts` 复用现有 indexedTriangleMesh 和 glTF-Transform。只消费明确的 CADIR 6/mm/唯一活动配置；保留源显示网格顶点、索引、法线、ID 和可确定的体/面关系。未知归属网格仍保留几何，不猜测关联；不使用包围盒或合成网格替代。

## 已验证

- 五件全部重复导出 SHA 一致；NodeIO 重新读取 GLB，逐顶点、逐索引、逐法线比对源显示网格，确认没有漏掉显示 primitive。
- 毫米通过根节点 0.001 转米，源轴不旋转；Float32 最大误差 0.0000718871 mm，小于 0.01 mm。此项仅证明转换精度，不证明源显示网格对精确曲面的误差。
- 三项测试覆盖未知归属、错误索引/坐标/法线/身份、配置歧义、装配拒绝、源诊断保留和非活动配置不混入。
- 真实 Chrome 两轮共 10 图：1280/980 两尺寸、相反方位，逐件加载 GLB，浏览器实际网格/三角计数与源一致，无 pageerror。人工复核可见穿孔、护罩格栅、折弯支架、楼梯台阶/栏杆和支撑夹具；不据此推断完整源 B-Rep 或装配支持。脚本 `scripts/fixtures/verify-sldprt-preview.mjs`，截图在证据目录 `visual/`。
- 四件 CADIR 检查无 finding；楼梯有配置参数引用缺失 `sldprt:model:parameter#1307483:32:5`，已保留到预览诊断。不能用退出码 1 的产物宣布拓扑完整。
- 可复现命令：`node --test scripts/fixtures/sldprt-glb-preview.test.mts`；`node scripts/fixtures/qualify-industrial-sw-geometry.mjs`。完整 evidence、解码报告、GLB 和 sidecar 在 `test-output/industrial-solidworks/geometry-20260918/full/`，不提交运行产物。

## 本轮待办

### API 几何桥接线准备

显示网格桥已移入 `apps/api/src/solidworksDisplayPreview.ts`，原研究脚本改为复用导出，不保留第二份实现。配置体集合和显示材质绑定改用 Map/Set 查询，避免大集合平方级扫描；新增损坏集合、重复配置体、重复/未知外观目标及诊断结构检查。

4 项专项测试与 API 类型检查通过；固定 CLI 重新解码 5 件实样，逐顶点/法线/索引复核全部通过，5 个 GLB SHA-256 与迁移前完全相同。证据在 `test-output/industrial-solidworks/geometry-20260918/api-bridge/`。复测使用 `node --import ./apps/api/node_modules/tsx/dist/loader.mjs --test scripts/fixtures/sldprt-glb-preview.test.mts`。

该模块迁移不是上传入口完成；内置 Worker 分发、任务注册与私有预览消费仍需接线。

### 隔离执行与产物审计

`solidworksPreviewExecutor.ts` 已复用共享 Windows Job 宿主，Node Worker 和固定 cadmpeg 子进程均在同一受限进程树内。Reader SHA 固定为上方已验证版本；源文件按 SHA 核验后复制成独立快照再解码。输入限 256 MiB，Job 2 GiB / 180 秒，Node 堆 1 GiB；这不是峰值 RSS 实测。

输出先写本次 staging，完整成功后 rename 到新目录；已有目录拒绝覆盖。Reader 的 fidelity 与 check findings 保存在 preview sidecar。父进程重新校验 GLB hash、来源、质量标记、计数、误差及现有 GLB 几何审计，拒绝将 sidecar 改写成 ready。

真实隔离 Worker 8 项测试通过：5 件实样 GLB 哈希与原证据一致、原检查失败保留、旧输出不覆盖、错误 Reader/源身份拒绝、启动前和运行中取消、产物哈希及质量篡改拒绝。连同 E57 和共用 Job 测试，三文件 24 项通过；API 类型通过。

测试仍使用已固定的本机构建 Reader，尚未完成格式包安装与生产入口注册，不能将该隔离执行片标记为完整导入功能。

网格和 B-Rep 面归属、保存配置/显示缓存的一致性、源外观颜色编码/纹理、SLDASM 装配、多来源留出集及产品导入/离线安装仍待完成。全部产物保持 `partial-geometry-preview`。几何计数一致不等于形状完整。

## 视觉范围

使用 design-taste-digitaltwin 的令牌与两轮截图流程；参考 Unity 的 ACES/PBR，检查环境保持中性，不用 Bloom/雾遮掩孔洞。此页是证据工具，不是新产品查看器。十维自评：布局 9、令牌 9、排版 9、信息设计 9、诊断语义 9；3D 8（源颜色编码与精确几何尚未认证）、响应式/主题 8（验证了两尺寸，未验浅色）；交互状态、动效、即时反馈不在该静态诊断工具的验收范围。未通过完整产品视觉门槛，继续保持研究预览。
