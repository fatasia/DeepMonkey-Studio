# 八项遗留任务进度（2026-09-19）

这里的百分比是“验收门槛覆盖率”的保守估计，不是代码行数，也不是产品完成承诺。计算依据是已关闭的证据门槛 / 当前列出的全部门槛；项目级真实运行、跨端和 OS 门槛未因单测通过而折算为完成。

| 项目 | 最终验收覆盖率 | 实现切片进度 | 已完成 | 剩余硬门槛 |
|---|---:|---|---|
| ① 剖切 E2E | **100%** | **100%** | Native 双变体双轮、裁切差异、重复像素证据 | 无；后续只需回归 |
| ② 动态场景运行包 | **65%** | **86%** | TS ABI、Runtime Package v7 resource/entrypoint、编译器 TRS 映射、Native 离线解码与 PlayerContent 动态通道传播、Web 编译产物 entrypoint 消费、TRS 采样/四元数归一化/帧应用测试；动态解析/采样 4 项与 PlayerContent carry 测试通过 | WebGPU/Native 帧驱动、发布实窗、确定性重放 |
| ③ V11 Nature Kit | **55%** | **92%** | 48 模板、素材 SHA、缩略图审计、grounded 派生件、geometry gate；浏览器门禁通过目录导入、项目资产插入、保存与刷新重开，1024px 响应式证据也通过；场景资源面板已接入资产专用 MIME、模型卡 draggable 和受信 drop target | 本轮真实 `dragTo` 已执行但未形成场景插入持久化证据；仍以显式按钮路径作为主验收证据，保持 partial |
| ④ 发布链 OS 级证据 | **100%** | **100%** | 四窗像素一致、停 API 无 sidecar、六次隔离启动、本机模拟无网 | 用户已明确不要求干净 Windows 防火墙硬门槛 |
| ⑤ GI 跨端一致性 | **65%** | **100%（矩阵门槛）** | r14 当前 Native 播放器双格矩阵；on normalized SSIM 0.999376 / MAE 0.005833 / edge F1 1.000；off normalized SSIM 0.986417 / MAE 0.007929 / edge F1 0.999 | 已满足固定收口门槛；复杂几何扩展仍是后续增强，不阻塞本项目矩阵 |
| ⑥ D24–D28 后验收 | **30%** | **55%** | A04/A08 配对性能/视觉证据、V01–V05 卡门禁、后验收证据脚本与 4 条配对行绑定 | 独立多资产、跨端几何/材质/阴影/后处理/文字、长稳、全通道综合签核 |
| ⑦ 工业 S1–S6 | **55%** | **80%** | S1–S5 聚焦 API/Worker、Tiles/X_T/RVT 真实语料、矩阵门禁、6 阶段/26 报告 SHA 证据绑定 | 独立保留集、混合场景、格式 profile 晋级、版本矩阵和视觉终验 |
| ⑧ DE26 资产/readiness | **70%** | **80%** | 8 个场景角色 manifest、source hash、轨迹、缓存/许可；load class 6/6、task kind 4/4，真实 GLB animation fixture 和派生统计边界已记录；BIMFACE 单一源身份/版本审计已校验报告哈希并绑定 manifest | 两个 RVT 源级几何 stats、V11 产品拖放/保存门 |

## 总体口径

当前机器闭环为 **3/8 通过、5/8 partial、0 blocked**；分项表中的覆盖率仍按各自验收门槛统计，不能简单替代项目通过率。剩余工作集中在真实产品链、跨端播放、项目级后验收和源级资产统计，不是重复编码。

2026-09-19 素材中心增量：48 个 GLB、192 个缩略图通过后端 `AssetLibraryCatalog` 进入既有目录和项目导入链，没有新增前端专用入口。真实 fence gate GLB 已通过 API 导入测试；拖放、保存、刷新、重开仍待产品链验证。

已从待办移出的条目为 ①、④、⑤；其余项目仍按 `partial`、`bounded-deferred`、`blocked` 或 `passed-with-boundary` 保留。动态项已从 `bounded-deferred` 前进为 `partial`；当前机器收口为：`passed=3`、`passed-with-boundary=0`、`partial=5`、`bounded-deferred=0`、`blocked=0`。

## 收尾顺序

1. 先补 V11 产品链和发布 OS 断网证据，这两项最可能快速改变状态。
2. 再补 GI-off/复杂几何矩阵和 D24–D28 独立项目证据。
3. 动态运行包已接正式 resource/entrypoint；继续接编译器映射和消费者后再跑实窗。
4. DE26 缺失资产类别和工业混合场景/OS 矩阵最后统一补齐；缺源级证据继续保持阻断。
