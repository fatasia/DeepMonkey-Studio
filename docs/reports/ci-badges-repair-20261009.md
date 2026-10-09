# 三项 CI 徽标修复（2026-10-09）

目标：修复 Deep Engine、Studio (web + api)、Repository governance 的真实失败，并在 GitHub Actions 验证。

## 现状核查

已完成六项检查：搜索 apps/packages 源码、工作流和未跟踪文件；读取 contracts 导出、renderer capability 与 ontology 合同；读取根与 Web/API/Engine package.json、pnpm workspace 和 Native Cargo.toml；追踪渲染入口、文档目录、样本与 shader 消费方；读取现有测试及三项 Actions 失败日志；检查 specs、handoffs、恢复账本与此前 CI 修复报告。

**已有（不重建）**：三个工作流、治理检查器、文档目录、shader 同源校验、能力清单黄金文件、设备 epoch 门、Kenney 开放资产同步、GPU 对拍证据门。沿用这些能力，不新增业务合同或运行时依赖。

**真实缺口**：

- Governance：文档索引指向已改名的 engine-benchmarks.md；DocsCenter 测试仍使用旧文档 ID。
- Studio：能力清单黄金字节换行不一致；跨包源码深导入；Ontology 预览测试对象缺失合同字段；Deep overlay mock 缺失新增导出；API 测试依赖未提交的 factory.zip。
- Engine：旧 Bloom 测试依赖 shallow checkout 不含的历史提交；CPU 层目录测试依赖未提交 GPU 证据；MegaLights 原始 shader 与镜像跨系统换行不同；PBR 材质校验在设备所有权检查之前；Windows 集成测试编译 gpu_texture_mips 时漏挂支持模块。
- 后续门禁：隔离检查仍禁止已经使用的 fflate，且把 esbuild 裁剪的 Three 导入算作运行代码；Native 存量源码未通过 Rust 1.93 格式化与全目标严格 Clippy。

失败记录：Governance 37822360547、Engine 37821584305、Studio 37819885965。原始日志保存在忽略的 test-output/ci-repair-20261009/。

## 修复与验证

修复保持现有工作流与断言门槛：修正文档与合同夹具；Web 测试使用已登记的公开导出；提交原始历史 Bloom 快照和 22 KB Kenney CC0 样本子集，记录来源与 SHA-256；shader 生成统一 LF；设备 epoch 检查先于材质校验；共享原生 GPU 支持模块与哈希实现。

Lab manifest 保留完整输入哈希并新增实际输出字节数。独立入口拒绝输出 Three 代码；比较入口沿用明确的 Three 边界；生产依赖只接受已有固定版本 fflate 0.8.3。新增负例验证依赖越界、版本漂移和非零 Three 输出。

Native 变更包含 cargo fmt 对存量源码的机械格式化，以及严格 Clippy 要求的测试模块 cfg、重复模块复用、迭代与类型修正。保留 GPU 资源所有权、ABI、黄金精度与现有诊断接口；仅对具体资源持有字段、保留接口和 ABI 参数数量作局部说明。工作流的 `-D warnings` 保持不变。

本机已通过：

- Contracts：516 个测试；Deep Engine：6,867 个测试；Web：6,423 个测试；API：2,344 个测试。沿用各套件原有跳过项。
- Engine/Web/API 类型检查；Engine 构建、Lab 构建及隔离检查；Web 生产构建与包体积预算。
- 治理与 Unity 归档 6 个测试；许可证审计 536 个生产版本；离线文档构建及 5 个测试。
- Native 全目标、全特性 Clippy（Rust 1.93，`-D warnings`）及 cargo fmt 检查。

Native 全量测试、双端验收门和 GitHub Actions 干净环境验证仍在进行；结果随后补充。
