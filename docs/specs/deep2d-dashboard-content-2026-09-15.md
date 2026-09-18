# Dashboard 形状内容编译与二维显存分配

供后续发布编译和 Native 渲染开发使用。当前实现作者形状内容 pass，完整组件发布仍未完成。

## 作者内容到运行包

`apps/web/src/delivery/compileDashboardContent.ts` 复用 DashboardDocument 校验和既有外框布局；内容框按当前网页组件的 1px 边框与 16px 内边距解析。矩形、圆角矩形、椭圆输出矢量路径，保留 z 序、可见性和稳定命令 ID。

当前子集要求显式十六进制填色、borderWidth=0、无文字、无语义绑定。线形、文字、CSS 变量、渐变、边框及其他组件输出对象级 blocked；可编译形状输出 degraded，列出未消费字段。容器背景、阴影、动画和交互未完成，publicationReady 固定为 false。

输出分别计算完整作者源的 sourceSemanticHash、pass 版本/参数绑定的 compileGraphHash、实际显示列表的 targetArtifactHash。修改标题改变源与编译 hash，不改变未使用该标题的目标路径 hash。

生成器 `packages/deep-engine/scripts/generateDashboardContentGolden.mjs` 使用真实 TS 编译器及运行包 builder，产出 source/content/runtime 三份共享 fixture；临时 bundle 写入 test-output。Native 读取同一运行包进行曲线离散与三角化，未引入截图占位或三维模型。

验证：Web 内容/布局 17 项通过，Native 内容 2 项通过；RTX 4060 Vulkan 窗口冒烟得到 3 条绘制命令、116 条离散路径段、110 个填充三角形、330 个顶点，GPU scopes/callbacks clean。包 hash：`9e61ac0688ffb6e830ffd22be61c0aca4134561b36e72e594bbd2884a0a4f84e`。

## 二维空场景的阴影分配

此前二维包的空 RenderPacket 仍创建 2048²×4 层 Depth32Float 阴影贴图，名义纹理数据 67,108,864 字节。当前在存在 Deep2D、实例为空且未启用阴影/IBL 差分探测时使用 64²×4 层，降到 65,536 字节。保留现有绑定 ABI 和级联数；不是完全删除三维管线。

二维与三维分配配置发生变化时，文件打开和包热更新走完整候选 renderer 校验；不得把新三维场景增量提交到小阴影贴图。相同配置继续使用原增量路径。底层场景更新 API 对配置变化显式拒绝，调用方需要创建新 renderer epoch。

GPU 回归实际验证 2D→3D→2D 的分配为 65,536→67,108,864→65,536 字节，并验证拒绝跨配置增量更新后旧帧仍可绘制。此指标来自纹理描述符，不是进程总显存或驱动实际分配峰值；尚无帧率提升结论。

同一配置选择还跳过了二维启动时的 12 个 mesh 和 9 个 shadow pipeline，以及其 mesh shader 模块；启动诊断改为报告实际创建数量。真实 GPU 验证管线数量 0/0→12/9→0/0。文件打开完整回归验证 3D→2D→3D，并通过既有 IBL/Shader/源域像素差分和失败恢复检查。IBL、前向目标和空背景 pass 仍存在，继续按测量结果优化。

## 后续验收

- 完成容器样式、字体/图片/图表/数据和行为编译，接入正式发布对象报告。
- 将三种 hash 与权威发布清单、loader 和可信平台证据绑定。
- 双主题/分辨率像素对照与真实输入尚未完成；当前 GPU 测试不是正式发布的可信窗口证据。
- 性能继续测量 CPU 提交、GPU 分段、重复上传、显存峰值和失败恢复，不以低分辨率冒烟宣称最终性能。
