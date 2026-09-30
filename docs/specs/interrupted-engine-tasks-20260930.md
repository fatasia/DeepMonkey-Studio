# 0930 中断任务续接

执行顺序：J → C → I → G → F → 其他 → 最终验收。本批先补 J2-B2、J3 Gate D/E 和 C8 首刀。

## 现状核查

已核查源代码与未跟踪文件、契约、依赖、消费方、测试证据、规格与交接。

- **已有（不重建）**：C18 已由 `a4c12e10` 收口，44 测与类型检查有提交记录；交接状态过期。体积光生产 GPU 接线与视觉验收不得从该提交推断为完成。
- **已有（不重建）**：J2-B2 的三份未跟踪 WGSL 草稿、`lab/j2b2OutputFamilyAudit.test.ts` 六项漂移台账、共享 WGSL 同步器和 checksum 门。TS 生产消费方为 `pbrShader`、输出管线和直出管线；native 输出仍有四个带语义差异的 shader。
- **真实缺口**：三份输出家族未进单源登记，无 sidecar，无生成镜像。迁移须保留组合产物字节与动态组成依赖，禁止将已展开字符串中的公共库再复制一份。
- **已有（不重建）**：C8 已有 `shaderCompute` DCIR 的 WGSL/GLSL 发射器、三端 HiZ GPU 验证、WGSL-first surface compiler 与 Shader Graph。没有理由再建第二套 IR。
- **真实缺口**：surface 数学尚无 WGSL/GLSL 共同消费的首刀；先对比复用现有 IR、双真源数值漂移门、外部转译三路线，做可运行 POC 后再扩大范围。
- **已有（不重建）**：J3 Gate A/B/C、RenderPacket 黄金包、TS 正式 PbrRenderer 离屏读回、native 输出 GPU 测试、`scripts/lib/pixelParity.mjs`、J5 双端门。
- **真实缺口**：Gate D 缺直接读取双端同输入输出的入口及预注册阈值；Gate E 缺共同阶段/转移合同与真实宿主轨迹比较。复用现有资源发布/渲染恢复路径，禁止用独立模拟器冒充宿主。
- **依赖**：现有 esbuild、playwright-core、Chrome、wgpu 30、serde 已覆盖首刀需要；不新增运行依赖。contracts 尚无上述对拍合同；frame ABI 已单源化，旧规格的双 ABI 阻塞描述过期。

## 执行准则

用户决定能力、质量、自动化程度和权限范围。默认提供可用的高质量路径，也允许预设、细调和专业脚本。AI 在已授权范围内自主推进，不对可逆动作逐步审批；只有越过用户授权、破坏性操作或明确要求确认的外部发布才请求确认。隔离、预算、取消、回滚和轨迹留存服务于自由操作与排障，不能代替用户决策。

性能改动用同机前后数据证明；视觉/体验对标 Unity、UE、Godot、Three.js、Babylon.js 和 Siemens PS/PD/Plant；AI Harness 对标 Claude Code、Codex、pi 和 KWeaver。对标是设计方向，未测数据不得写成已达标。

## 第一波验收记录（提交 `0a0b26fa`）

- J2-B2：三份 WGSL 真源、sidecar、生成镜像和消费切换已完成；组合输出 SHA-256 与迁移前逐字节一致。207 文件专项回归 1,712 passed / 23 既有 skipped，包含 C18 44 测。记录：`test-output/interrupted-0930/j2b2-tests.log`。
- C8 / Gate D：真实 WebGPU、WebGL2 与 native OutputPass 两轮对拍通过。TS/native 最大字节差 0、最差块 SSIM 1；WGSL/GLSL 最大浮点差 1.1920928955078125e-7，GPU 错误 0。不含整场景几何、深度、阴影和完整后处理。记录：`display-parity/evidence.json`。
- Gate E：真实 TS 资源执行器与 native 发布/邮箱/监视器的五场景两轮轨迹一致，每轮 28 条阶段样本，dispose 后 CPU 测试资源 0。修复未提交未来代次可获得 Publish 的缺陷。GPU 丢失恢复、显存、上传和首帧仍列后续。记录：`lifecycle-parity/evidence.json`。
- 集成：`node scripts/j5-dual-end-gate.mjs --require-gpu` 七组双端判据全部通过，`degraded=false`；修复原 GPU 探测器 CommonJS 导出与安全上下文两处错误。新增 Node 比较/编排测试 30 passed。
- 工程：最终 6 文件聚焦回归 37 passed，core/lab/examples 类型检查、Deep Engine 构建和 runtime artifact freshness 均通过；WASM 已重建。按职责拆分 native 输出对拍测试，source-size 新增失败 0。C8 使用纯语言目标 `glsl-es-300`，不向核心引入 WebGL 宿主；purity 门剩余五项为 HEAD 已有的 performance 访问，两个来源文件与 HEAD 哈希相等，见 `c8-runtime-purity-baseline.json`。该历史门未通过，不记为本轮全绿。

第一波迁移保留输出组合字节；后继数学提取有意改变源码，验证口径见下。证据均位于 `test-output/interrupted-0930/`；J5 证据位于 `test-output/j5-dual-end-gate/`。完整剩余范围与工时见 [剩余任务与估时](remaining-tasks-estimates-20260930.md)。

## 第二、三波生产接线与验证

- CSM 边界：提交 `e7892afc` 补齐无混合区间的保护和第二次 PCF 早退，复用生产 shader 工厂修复过期 GPU 测试装配。三生产族双轮 GPU、137 项 TS 回归及 Native GPU/合同验证通过；未测得帧时收益，旧 Chrome 零宽输入本身有限。
- C8：实际 Three OutputPass 使用成对 GLSL 的 ACES 数学。两轮十档输出、20 帧与原 Three 字节差 0，GLSL ES 100/300 编译通过。保留其他 tone mapping、曝光与调色自由度；材质、光照和整场景不在此切片。
- Native 输出：四变体装配同一 displayColor 和作者分级源，曝光留在 HDR 上游。11 项合同/ABI 测试通过，RTX4060/Vulkan 的 96 组输出矩阵通过；CPU 最大误差 0.00048822165（RGBA16F 阈值 0.002），跨变体/轮次和 alpha 差 0。既有 Bloom、Fog 实际 GPU 测试通过，compact/full 40 情景 41,032 像素相同，非均匀输入 6 情景 2,382 像素保持来源坐标。
- GI storage：十情景两轮 Chrome/Native 实际 GPU 对拍最大差 `5.96e-8`；默认 runner 清旧证据并执行本次命名 Native GPU 测试，5 项失败/空跑/旧证据回归通过。最终证据 `nativeRunFresh=true`；Web texture 与完整帧仍为后继范围。
- 最终集成：严格 J5 七对/十四腿通过，`degraded=false`，证据 `evidence-20260930044442.json`。Deep Engine/core/lab/examples 与 Web 类型检查、构建和 runtime artifact freshness 通过，WASM 已重建。

本轮新增/修改文件未引入体量失败。全仓 `scripts/check-source-size.mjs` 仍有 18 个既有超 800 行文件，核心 purity 门仍有 5 处既有 performance 访问；两项工程债已进入剩余表。数值对拍、输出截图和 CPU 生命周期证明各自切片，不替代完整视觉、GPU 生命周期或产品最终验收。
