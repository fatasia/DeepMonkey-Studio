# 0.2.0 SDK、代码包与 Docker 交付

沿用现有离线 SDK 验收与 API 托管 Web，补应用容器交付；主线程统一版本、提交、推送与 Release。

## 当前交付状态

- SDK、Windows壳/API sidecar、Native ZIP和Docker部署附件已有本地构建/验证证据。Deep源材质、高光贴图和GPU变形绑定仍在正式场景回归，统一Deep/Web冻结后重打最终包。
- Docker daemon已恢复，原有Dify容器和卷保留；应用镜像仍是旧revision64cd090b，不能作为最新发行镜像。最终OCI revision随主任务提交生成。
- SDK现有final4快照为7,163,789B、SHA `a5b64f37098b3ad082672df2ba295c05550a94fd3193b6d2fcf3ff93a4f7a25f`；后续Deep材质/GI修复尚未装入此快照，发布前须重新pack及离线消费者验证。
- Windows安装包、SDK、Docker镜像/离线部署包和代码包的最终版本清单由主任务统一，Android已取消。

以下现状核查与分轮日志保留各次执行时点，旧SHA和版本不代表当前发行冻结。

## 现状核查

1. 全仓源码、脚本与未跟踪文件已查 sdk/docker/release/pack 关键词；SDK pack helper、空仓 consumer gate、基础设施 compose 均已有。当前没有应用 Dockerfile、.dockerignore 或容器发布流水线。
2. 合同：contracts 与 scene-sdk/protocol 的公开 API 已存在；默认 exports 均指向 dist，development 指向 src。API productionConfig 强制 PostgreSQL+MinIO 与有效凭据；productionWeb 正式托管 Web 并已有静态压缩/SPA 回退，不改这条合同。
3. 依赖：Node 24、pnpm 11.18.0、锁文件、SDK workspace 依赖、Fastify static 均在用；Docker 29.7.2 CLI 已安装，desktop-linux daemon 当前未启动。API 构建在非 Windows 跳过 Job host，Linux 使用已有进程隔离。
4. 消费方：gate-sdk-consumer→packSdks→空缓存/空 store 离线安装→NodeNext/Bundler 类型→Node/浏览器运行已完整；API dist/index.js→productionWeb 已是原生生产服务入口。docker-compose.yml 只消费 PostgreSQL/MinIO，应用镜像尚未消费。
5. 测试/证据：SDK gate 已检查 dist exports、精确 contracts 依赖、无 workspace 残留、归档秘密与安装目录；API productionConfig/productionWeb 已有测试。容器现有文档明确仅交付基础设施，没有本轮应用镜像证据。
6. 规格：已查 docs/specs、handoffs、recovery ledger 与 open-source-release-checklist；0.2.0 remote Release 查无，本地各包仍 0.1.0。主线程负责统一版本；不写 README。

**已有（不重建）**：SDK 的完整 tarball/离线消费门、生产 API 同源 Web、生产配置与存储迁移、基础设施 Compose 与健康检查。

**真实缺口**：0.2.0 SDK 归档最终版本/内容证据，正式应用 Dockerfile/构建上下文裁剪/三服务 compose、Linux 应用启动与数据恢复证据、发行归档清单与 SHA-256。

外部 Deep SDK CPU gate 补查发现正式 dgcEncoder/dgcLoader import 已有 `fflate@0.8.3`，但清单只把它放在 devDependencies。Node/type 门已过，自包含浏览器 bundle 因离线包找不到 fflate 失败。真实缺口是运行依赖分组与离线依赖归档，不引入新库/版本；Deep consumer、八模板 gate 与 standalone examples 的本地 overrides 同族补齐后重跑，旧 SDK 发行归档作废。

## 执行边界

### 离线 Docker 部署附件现状核查

六步复查：源码和未跟踪项已有镜像归档、Compose、SDK 的 JSZip 依赖及校验工具；镜像 JSON 合同已有 version/revision/sha256/savedImages；复用 Node、JSZip、Docker Compose，无新增运行依赖；当前 docs 要求另取同版代码包才能部署；已有镜像/三服务 QA，没有独立部署附件测试；已核对 0.2.0 发行与离线规格。已有镜像格式与 Compose 不重建；真实缺口是下载镜像后还缺配置、SHA 核验和 Windows/Linux 启动入口。增加小型部署 ZIP，复制正式 Compose 和许可，生成空凭据样例，启动时仅首次创建随机本地凭据，校验镜像后 docker load，再以 --no-build --pull never 启动。

部署附件已接入 export-release-docker，4 个测试通过：同版 Compose/全部文件 SHA、无效镜像身份拒绝、实际 PowerShell 5.1 与 POSIX 启动脚本、首次随机凭据/已有凭据保留、错误 SHA 在 Docker 调用前阻断。测试里的 Docker 调用全部隔离拦截，不替代实际容器启动证据。

Docker Desktop 本次重开遇到既有 Windows AF_UNIX 失效 socket：先在 Docker/run 的 sailor-ingest.sock，再在 docker-secrets-engine/engine.sock；单文件 rename/query 均返回 ERROR_CANT_ACCESS_FILE。核对官方 Docker desktop-feedback #554/#625 后，在 Desktop/backend 全退出、边界和含隐藏项枚举核验后，仅将两个运行端点目录可逆改名留备份；secrets-engine 目录确认唯一条目是0B socket。未删除或修改卷/VHDX/密钥。重新启动后 daemon 29.7.2，原 15 个 Dify 容器运行，既有 init_permissions 保持 Exited0。证据 `test-output/studio-020-docker-recovery.json`；正式 tag 仍为旧 revision 64cd090b / 313,091,871B，不当作最终镜像。

本轮 SDK CPU 快照：7,163,789B，SHA-256 `a5b64f37098b3ad082672df2ba295c05550a94fd3193b6d2fcf3ff93a4f7a25f`，归档日志为 `test-output/studio-sdk-020-final4-pack.log`。Deep 与八模板 CPU 离线消费通过（final4 日志），新一轮用户 Deep 拖动/视觉问题修复尚在进行；此快照不标为最终发行。

### 最终八模板验收拆分核查

六步复查：源码与未跟踪项已查模板 gate 和消费者；模板版本/模板目录合同及八个模板均已有；沿用 pnpm、tsc、esbuild；唯一模板 gate 把 CPU 安装/双类型/Node/bundle 和浏览器绑定，基础 SDK gate 已有 cpu-only；已有八模板版本测试与历史浏览器证据，最新 dist 尚需重验；本轮规格要求最终版本并串行 GPU 窗口。已有消费者与像素断言不重建；真实缺口是模板门缺少与既有 SDK 相同的 CPU-only 入口，补该开关后保留全部八份浏览器 bundle 供统一 CUA 浏览器验收，CPU 通过不声明 GPU 通过。

最终 CPU 轮（三基础 SDK、Deep SDK、八模板）已通过仓外空 cache/store 离线安装、NodeNext/Bundler 类型、dist 解析、Node 运行与自包含浏览器 bundle。日志：`test-output/studio-sdk-020-final3-consumer-cpu.log`、`studio-deep-sdk-020-final3-consumer-cpu.log`、`studio-sdk-020-templates-final-cpu.log`。打包/平台裁剪/版本分发 13 测试通过。对应 Deep dist 为本日 18:09 构建；浏览器像素检查与最终 SDK 归档等待源码冻结，后续 source 改动须按身份重验。

同一 dist 的八模板 CUA GPU 轮通过：每模板正式 deep-webgpu 两帧有实际 draw，RGBA16float present-color readback 非背景像素 57,320–149,000；取消、相同 dispose Promise、资源释放均通过。证据 `test-output/hc7p2-templates-20261002/cua-gpu-final3.json` 与八张 `*-cua.png`。最终 dist 若改变，本轮身份不再视作最终发行验收。

容器复用正式 API/Web 构建与原有存储合同。版本由主线程改；SDK 归档必须在版本固定且 dist 新鲜后生成。Docker daemon 与 Linux 构建会占 CPU/内存，先协调排查窗口再启动；发布由主线程执行。

## 本轮检查

0.2.0 contracts/scene-sdk/server-sdk 已顺序 build；现有 gate 加 `--cpu-only` 复用离线安装、类型和 Node 运行链，报告状态为 `cpu-passed`，浏览器执行待串行窗口。空 cache/store、NodeNext/Bundler、dist 解析、Node 结果与自包含浏览器 bundle 均通过。

3D 模板唯一 references、canonical skill 与 API surface 版本同步 0.2.0，原分发器同步仓内 Codex/Claude 两套技能；version-pin/distributor 8 tests 通过。八模板实际消费清单由 gate 读取同一 references 生成，没有八份独立旧 package pin。未改 README。

Docker 增加固定 Node digest、多阶段生产依赖裁剪、API/Web 构建和 WASM 新鲜度门；MinIO 客户端复用既有固定镜像，官方 registry config 已验证其 PATH 包含 `/opt/bitnami/minio-client/bin`。三服务 compose overlay 保持 PostgreSQL/MinIO 参数与强凭据、健康依赖、应用持久卷、普通用户/只读 root。实际 compose 配置与构建上下文 2 tests 通过；daemon 尚未启动，Linux 镜像启动与恢复未验。

SDK 归档工具复用既有 pack，产出六份 tgz、八模板和许可文件，隔离 stage 防止旧输出混包。fflate 使用上游原始 tarball、按锁文件 SHA512 核对，避免 pnpm pack 运行上游 prepack。Deep consumer/8模板/standalone 本地 overrides 同族补齐；修后 Deep SDK 空 store 离线安装、NodeNext/Bundler、Node、自包含浏览器 bundle CPU 门通过。

前一轮 SDK 验证归档 `DeepMonkey-Studio-SDK-0.2.0.tar.gz` 为 7,139,995B，SHA-256 `c840385a56f4ff23e92020bc7dac9949224ee1ccb4065946fc5902eccca9fb45`。随后 Deep 网格 mip 优化已重建 dist，此归档待最终冻结后重打包，尚不用于发布；旁 JSON 含六归档 hash。GPU 像素门等待引擎冷启动排查独占窗口结束。

上一轮 SDK 归档 7,146,037B、SHA-256 `d0dce29da3f83b5b2d5bbd1b7c3a490171c69a11e7fe585613d54585a78fb04f` 在 packet cooperative/worker 接线前生成，已替换。

当前冻结 dist 重打包：SDK 总归档 7,158,122B，SHA-256 `93023888e46fe58d32abe4a0a14019a89c5bf4a87cb7f483d8ca748ae0792992`；Deep tgz 6,358,252B、SHA-256 `53f5280dba52adf77a6b9a25a0eed3e62d69bb2c70a3fe134b985a204ca01612`。最新压缩包与六归档 manifest 在 `artifacts/releases/0.2.0/`，日志 `test-output/studio-sdk-020-final2-pack.log`。三基础 SDK 与 Deep SDK 仓外空 cache/store 离线安装、NodeNext/Bundler、dist 解析、Node 运行与自包含浏览器 bundle CPU 门均通过（`studio-sdk-020-final2-consumer-cpu.log`、`studio-deep-sdk-020-final2-consumer-cpu.log`），浏览器像素门待串行窗口。后续 Deep source 改动必须再打包核对。

Docker 归档工具构建后核对 OCI 版本/commit，流式保存应用与两个存储镜像并记录大小、SHA-256；MinIO 固定本地 tag 供离线 load，原 digest 留清单。镜像归档在最终 dist/WASM 稳定后生成。

已检查本地 onnxruntime-node 安装脚本：Linux/x64 默认另下载 CUDA 12 与 TensorRT，CPU 二进制已随包提供。容器构建设置其正式 `ONNXRUNTIME_NODE_INSTALL=skip` 开关，避免下载未使用的 GPU 包；运行层保留 `libgomp1`。API deploy 后按 dist 内容复制，兼容 deploy 已包含 dist 的情况，避免二次嵌套目录。

Linux 初轮应用镜像构建已通过（`studio-docker-020-build3.log`）：Node 24、固定 pnpm、正式 API/Web、WASM 新鲜度门、普通用户 runtime 与 ONNX binding 实际加载均通过，移除其他平台/架构二进制 232,353,832B。Web Brotli quality 11 预压缩 293 产物，85.15MiB→19.87MiB（77%）。此镜像是较早 COPY 的 QA 快照，OCI revision 为旧基线；最终发行须在最新源码和最终提交固定后重新构建，初轮启动证据不能替代最终发布身份。

初次三服务 QA 找到既有 Compose 健康检查缺口：容器环境定义 `POSTGRES_DB`，健康命令却读取未定义的 `POSTGRES_DATABASE`，实际 `pg_isready` 返回 3，导致已正常启动的数据库一直 unhealthy，应用依赖不能启动。只修健康检查读取正式容器变量，不改宿主环境配置名称或数据库。

修后三服务真实 QA 通过（`test-output/docker-020-qa-f44799a4/report.json`）：生产 Web 与仓内 WASM 同 SHA、管理员登录、GLB 上传/转换、MinIO 原字节 SHA、场景保存与发布、全部容器重建且 `--pull never` 后 PostgreSQL/MinIO/场景/发布历史恢复。QA 容器已 down，持久卷留作证据；原 15 个用户容器未改动。初镜像大小 313,091,871B，仍仅是旧源码快照验证，最终镜像须重建并重验身份。

## 运行依赖体积核查

### 最终容器入口资源验收核查

六步复查：正式 productionWeb wildcard:false 路由修复已有；Vite index 的 JS/CSS URL 合同已有；复用 Node fetch/hash 无依赖；Docker QA 当前只取 HTML/WASM，漏查编译入口资源；正式资源路由已补回归测试，但初轮 Docker QA 因此未发现入口 JS/CSS 404；已核对 production-web-assets 规格。已有容器部署链不重建；真实缺口是最终 Docker QA 必须请求 index 引用的全部入口 JS/CSS 并与仓内正式文件 SHA 对比，确保页面能启动。

### ONNX 平台裁剪

六步复查：全仓打包脚本没有 ONNX 平台裁剪；onnxruntime-node 正式 binding.js 只消费 napi-v6 下当前 process.platform/process.arch，公共 Tensor/InferenceSession 合同不变；既有固定依赖不新增；API 电池推理与生产入口消费同一包；尚无平台裁剪测试/证据；本轮发行要求离线 CPU 与体积优化，保持 GPU worker 独立边界。

**已有（不重建）**：CPU binding、库、正式 JS loader 与许可。

**真实缺口**：安装包同时携带 darwin 77.9MB、win32 134.1MB、linux 58.8MB。仅裁剪当前发行系统/架构以外目录；保留当前架构全部文件、JS、模型及许可。Docker 构建后实际 require Native binding 验证。
