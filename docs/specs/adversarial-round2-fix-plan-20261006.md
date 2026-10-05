# 对抗测试第二轮修复任务书(2026-10-06)

> 来源:`docs/reports/adversarial-testing-round2-20261006.md`。用户指令:同步解决报告问题。
> 与 deep2D 线(`deep2d-gpui-parity-plan-20261005.md`)/Semantica 线并行推进,P1 插队最前。

## 批次与 owner 域(互斥)

### 修复 A(P1-2 编辑器崩溃 + P2-5 模式切换)— 批 2 派
- **P1-2 STUDIO_RENDER_FAILED**:复现序列=快速创建 5 球体→连续撤销清栈→播放→错误边界。疑似撤销清空与放置写路径竞态,或播放快照遇中间态。修复:放置在途时禁止清栈(或清栈等待在途写完成);播放入口对中间态 fail-safe(等待/拒绝而非崩溃)。必写复现测试(useSceneHistoryActions/play 链)。
- **P2-5 模式切换**:二维↔三维 10-20s 无进度指示;一次自动回跳(疑 `/applications/...` 路由与 `/studio/:id` 守卫竞争)。修复:切换进度指示;守卫竞争定位与消除;"返回二维"延迟生效修复。
- owner:apps/web 编辑器 history/play/route 域。

### 修复 B(P1-1 离线包断链 + P3 错误转译 + P2-6 a11y + P2-8 MCP 版本 + P2-7 发布说明)— 批 3 派
- **P1-1**:`dashboard-candidates` 路由处理在 `apps/api/src/dashboardPublicationCandidateRoutes.ts:33` 存在,但 `dashboardNativeCandidateRouteRuntime.ts:51` 的装配依赖 runtime 依赖,core-only 未装配而前端入口照常可点。修复:①未装配时前端隐藏/禁用离线包入口并说明原因(能力探测端点或装配态透出);②错误转译(P3 同项):原始 404 文案→用户语言+错误码(参考视觉中心/Harness 错误呈现标准)。
- **P2-6**:`/view/:sceneId` 工具栏 7 按钮中 6 个补 aria-label/可见文本(与编辑器按钮对齐)。
- **P2-8**:MCP 设置页协议版本与握手版本同源化(读同一常量)或 UI 注明差异含义。
- **P2-7**:一键"发布应用"补零配置语义说明(默认值:后端/画布/打包形态是什么),UI 说明或 tooltip;完整构建配置属产品决策,仅记录不实施。
- owner:apps/api 路由装配+apps/web 入口门控/视图页/设置页。禁碰 apps/api/src/ai/(S1 在跑)。

### 修复 C(P1-3 AI 会话历史恢复)— 批 4 派(等 S1 完成,同 ai/ 域)
- 恢复条目按消息 id 去重(重复×2-6);无法校验证据的恢复条目给中性标注(非"服务中断");会话按 scope(场景)隔离或明确标注来源场景。

### 修复 D(P1-4 WebGPU 资源回收专项)— 批 5,主线程+专项
- 守卫双跑失败(两轮一致,非环境)= 代码缺陷:资源释放→3s 内 GPU 回收断言失败。定位:release 路径是否漏 destroy/池未 shrink(参考 release-soak-20261005 峰值堆 1458MB+42/62 窗 P95>50ms+pipeline-compile 长任务 261)。
- 帧 229.8/400.3ms 恒定单值疑 headless 节流伪影:非 headless 复跑定标后归因。
- 证据:test-output/viewer-soak-adversarial-*.log、release-soak-20261005/report.json。

## 纪律
- 每项修复带复现测试;不放宽门;800 行体量门;提交不 push。
- P2-7 的"完整构建配置"仅记录待产品决策,不擅自实施。
