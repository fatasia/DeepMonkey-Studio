# 对标优化阶段规划 + 包体积第一轮分析（2026-10-03，主线程）

> 用户指令：61 行清完后进入优化阶段——架构/包体积/极致性能/最佳效果/UX/全量视觉/bug 修复；
> 对标 Unity/Babylon/Three/西门子 PS/PD/Plant；最后检查保证无屎山、最高质量。

## 包体积第一轮分析（vite build 实测）

- dist/assets 总 **76M**（含全部懒加载 chunk）；首屏 301.9KiB/gzip 96.9KiB（hc6s3 实测，预算内）。
- Top chunk：monacoTypescript.worker 6.6M、ts.worker 6.6M（**两者同 hash 字节全同=双份**）、主包 4.0M、SceneBehaviorPanel 3.5M、editor.api 2.7M、rapier 2.2M、共享 chunk "toggleHighContrast" 1.14M（rolldown 以首导出符号命名，实为 monaco 公共贡献模块，非功能异常）。

### 已知债与结论

1. **ts.worker 双份 6.6M（已知债）**：vite alias（pnpm worker 上下文解析必需）与 worker 入口打包机制交互导致同一模块两 chunk。删除 alias 构建失败（rolldown 无法从 worker 上下文解析 monaco-editor）——需 rolldown 层方案（advancedChunks 对 worker 生效性验证/worker 入口改直引 alias 绝对路径），**登记待办不阻塞**。
2. 其余大项均为功能合理的懒加载 chunk；真正的体积刀=monaco 按需语言/worker 合并，归对标优化阶段。

## 对标优化阶段批次规划（61 行清完后）

| 批次 | 内容 | 对标 |
|---|---|---|
| A 架构 | ENG-source-size 11 文件拆分（**进行中**，sourceSizeGate failures 11→0）；模块边界审计（architecture.test 边界清零） | Unity 模块化/Babylon 包结构 |
| B 包体积 | ts.worker 双份消除；monaco 按需；首屏预算复核 | Babylon 按需加载 |
| C 极致性能 | B2/T11 帧时批（冻结树/输入 P95/99/有效首帧/进出内存）+Z2/Z3.5 自动档真机+瓶颈处置 | Unity 帧时纪律 |
| D 最佳效果 | F5 L1 方向可见度（实现中）+默认预设档真机调优 | Unity/西门子画质语义 |
| E UX+全量视觉 | 全页面深/浅两轮终验（e2-z4 runner 复跑）+交互动线复核 | 西门子信息密度纪律 |
| F 质量清剿 | lighting WGSL 4 失败清理；architecture 边界 2 文件；屎山扫描门禁化（sourceSizeGate 进 CI） | — |

## 统一验收批次（测试/视觉最后统一）与上述批次合并执行；拍板项解锁即插队。
