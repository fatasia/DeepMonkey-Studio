# S4 私有 SDK 外部消费者验收（2026-09-06）

## 范围与当前状态

**已完成：三个私有 SDK 的本地包外部消费验收。** 修复真实打包缺陷后，两次全新工作区外消费者均通过离线安装、双模式类型检查、Node 执行、浏览器打包和真实 Chrome 运行。未公开发布任何包，未 push。

本项对应 S4 的一个前置子集：三个 SDK 包在 monorepo 之外可安装、可获得真实类型、可运行并可浏览器打包。`scene-sdk` 是协议、校验、兼容协商与纯生命周期时钟，**不是完整可嵌入 ViewerSDK，更不是已完成的 ThingJS 插件生态**。

保留用户最新范围：第 3 项统一语义消费/授权版本治理、第 6 项专项性能/大模型稳定性/长文件治理暂停。这里仅做 SDK 可消费性和必要构建回归，不恢复暂停项目。

## 验证设计

执行 `node scripts/gate-sdk-consumer.mjs`，使用现有已构建 `dist`，不再构建或清理共享产物。脚本按职责分为包归档/安装、类型与 Node 运行编排、浏览器打包/运行三部分，源码样例在 `scripts/fixtures/sdk-consumer/`。

1. 核对当前 `private: true` 与默认 `dist/index.js`、`dist/index.d.ts` 实物。只执行 `pnpm pack`，不执行 publish，不修改任何源包 manifest。
2. 把三个归档放到工作区外新建的系统临时目录，直接读取归档 manifest，核验 `workspace:*` 已转换成普通精确版本，默认出口确实存在。
3. 新消费者仅使用三份本地 `file:` tarball，全新外部 store/cache、离线安装、禁止生命周期脚本。消费者自己的 `pnpm-workspace.yaml` 覆盖把 contracts 的传递精确版本指向同一 tarball；包内部仍保留正常精确 semver 声明。配置只含本临时消费者，不连接主 monorepo。
4. 用 `NodeNext` 和 `Bundler` 两种模式检查声明，开启 strict 与 `skipLibCheck: false`；四个反向类型样例防止意外退化为 `any`。记录实际声明和 Node 默认入口路径，不能落到工作区源码或 `development` 条件。
5. 同一消费者代码运行资源 ID、命令复制/非法值/访问器拒绝、API/权限协商、生命周期时钟，以及模拟传输的成功、204、409、跨源拒绝、预先取消分支。
6. 使用现有 esbuild 浏览器构建，检查输入图只含消费者和已安装 SDK `dist`，不引入源仓库、React/Three/UI/Node 内建；独立 Chrome 真实运行后与 Node JSON 精确对比。
7. 浏览器只允许本测试页的 loopback GET 请求，错误/警告应为零。不读取凭据、不连正常 API、不改正常场景、不改存储配置。产物和临时消费者保留供复核，不做递归清理。

## 真实缺陷、修复与失败记录

**已完成：修复 SDK 默认入口漏打包。** 首轮 `sdk-consumer-mOD3GA` 失败在 `contracts` 的默认出口实物断言：工作区中 `dist/index.js` 存在，但 tarball 没有 `dist`。另行检查同目录中的 scene-sdk/server-sdk 原始 tarball，也均没有 `dist`。根因是三包没有 `files` 白名单，打包受仓库 `dist/` 忽略规则影响。只在三份包 manifest 增加 `files: ["dist", "src", "README.md"]`，既保留默认构建产物，也保留既有 `development` 源码出口；未改变 private、版本、出口合同或运行 API。

门禁开发中的两次失败不算产品缺陷：`sdk-consumer-YyrFnM` 暴露 pnpm 11 不再读取 `package.json` 中旧 `pnpm.overrides` 配置，已迁到临时消费者 `pnpm-workspace.yaml`；`sdk-consumer-t7f9AQ` 已通过安装/类型/Node，随后因门禁自身对 Playwright CommonJS 使用命名导入而失败，改为项目既有 default 导入模式。上述记录均保留，没有覆盖成成功报告。

## 首次双轮证据（r4 构建）

主任务先完成共享依赖/API 的第四轮构建与 Web `r4b` 构建，再冻结 `dist`。本子任务只打包读取，没有重建或清理共享产物。

两轮命令均为 `node scripts/gate-sdk-consumer.mjs`，退出码均为 0：

| 轮次 | 仓库内证据目录 | 工作区外消费者 |
|---|---|---|
| 第 1 轮 | `test-output/codex-2026-09-06/sdk-consumer-cGONEo/` | `C:/Users/rain/AppData/Local/Temp/bim-sdk-consumer-cGONEo/consumer` |
| 第 2 轮 | `test-output/codex-2026-09-06/sdk-consumer-lKsvLC/` | `C:/Users/rain/AppData/Local/Temp/bim-sdk-consumer-lKsvLC/consumer` |

每轮均核验三份归档的 `private: true`、源 manifest 不变、默认 JS/声明与 development 出口实物；scene-sdk/server-sdk 的 contracts 依赖均从 `workspace:*` 转写为 `0.1.0`。

| 包（均 0.1.0） | 归档文件数 | SHA-256（两轮一致） |
|---|---:|---|
| contracts | 141 | `46febd6ad54fb8670cedd3d78225bbd34808e0d04aad4f7eb98d389eec7db2dd` |
| scene-sdk | 27 | `063bacbb8f707a9c61204ed651f0cdbfaf5c76eb6e047f56165907355959c63f` |
| server-sdk | 25 | `949511b2e57585db504ddb4193c38ce53ee73176587f52c2d3098e21f3e55b0c` |

环境为 Node `24.18.1`、pnpm `11.18.0`、TypeScript `5.9.3`、Chrome `152.0.7977.76`，浏览器打包复用既有 Vite 依赖中的 esbuild。每轮结果：

- 全新 store/cache 中离线安装 3 个本地包；所有已安装 SDK 路径均在临时消费者内，不是指向源码仓库的 workspace 链接。pnpm 输出中的 `downloaded 3` 是它对本地 tarball 导入的计数，不是三次远程下载；依赖均为 `file:` 且使用 `--offline`。
- NodeNext/Bundler 严格类型检查均通过，四个反向类型样例生效；实际读取 48 个已安装 SDK 声明文件，全部来自 `dist`。Node 默认解析的三个入口均为已安装 `dist/index.js`。
- 运行样例验证 API `1.0`、命令副本隔离、非法坐标/访问器拒绝、主版本/权限拒绝、3 个生命周期 tick、暂停/恢复/释放；模拟传输记录只包含 `/api/meta`、`/api/empty`、`/api/failure` 三次调用，409 的 `currentRevision: 7` 保留，外域与预取消调用不会进入传输。
- 浏览器包 65,813 字节，输入图 56 项（54 个已安装 SDK dist 模块和 2 个消费者源码），没有源仓库/React/Three/Node 内建或输出外部导入。这只是当前样例包的实物大小，不是专项性能/P95 验收。
- Chrome 执行结果与 Node JSON 精确一致；每轮观察到本地 HTML 与 bundle 两个 GET、0 真实 API 请求、0 业务写请求、0 外部请求、0 控制台警告/错误。页面和服务在每轮 finally 中关闭。
- 两轮均保存 `sdk-consumer-browser.png`；首轮亲审为完整 JSON 成功结果，第二轮截图字节完全一致，SHA-256 为 `150611c3e7efb0b3f23780c19155687dc6fdb065740449626cc2d2e71515146e`。这是技术运行结果页，不是产品 UI 演示。

当前为兼容已有 development 条件而保留 `src`，归档也包含源测试文件（contracts 16、scene-sdk 4、server-sdk 5）。它们没有进入默认运行或浏览器输出。真实 registry 分发前可另做产物最小化与开发出口分层决策；本轮不悄悄更改出口语义或将其包装成公开发行完成。

## r5 最终复核（目录取消接线后）

主任务为管理目录恢复给 `ServerClient.listApplications` 增加可选 `AbortSignal` 后，统一 `r5` 构建再次冻结。本门禁另跑 `sdk-consumer-si8fTx` 通过，随后在同一外部样例补充 `listApplications("project-1", { signal })` 的预取消分支，最终 `sdk-consumer-wgdpKJ` 再次完整通过。

最终权威证据目录为 `test-output/codex-2026-09-06/sdk-consumer-wgdpKJ/`，消费者为 `C:/Users/rain/AppData/Local/Temp/bim-sdk-consumer-wgdpKJ/consumer`。三包默认出口与严格类型仍通过，48 个 SDK 声明、56 个浏览器构建输入不变；运行结果新增 `canceledCatalogRead: true`，确认该可选参数经真实包边界传递，并在进入传输前取消。Node 与 Chrome 结果一致，仍为 0 控制台问题、仅本地 HTML/bundle 两个 GET。

contracts 与 scene-sdk 归档 SHA-256 不变；**最终 server-sdk 归档 SHA-256** 为 `ca203cc68671f17a2cf8d75a8a22613199db0926da8ba30426d2dc7b05ce5968`。增加该检查后的样例浏览器产物为 66,167 字节；这不与前节不同检查内容的 65,813 字节混用。最终浏览器截图已亲审，完整呈现 `canceledCatalogRead: true`，SHA-256 为 `994406478d5db6abef7ebd4f1bc69f41e433b7bded09676edc2ad3407ded1aca`。

## 官方机制与对标依据

pnpm 官方描述了打包时 `workspace:` 的改写机制；本门禁以仓库固定 pnpm 版本的真实 tarball 为证，不用网站版本说明代替实测。[pnpm workspace package packing](https://pnpm.io/workspaces#publishing-workspace-packages)

消费者配置按当前 pnpm 的 `pnpm-workspace.yaml` 机制放置，并由本地 `11.18.0` 离线安装实测确认；未继续使用已被该版本忽略的 package.json 配置。[pnpm settings](https://pnpm.io/settings)

默认运行入口与自定义条件必须分开验证，避免开发时源码出口掩盖交付缺陷。[Node.js conditional exports](https://nodejs.org/api/packages.html#conditional-exports) TypeScript 的 `NodeNext` 与 `Bundler` 面向不同解析环境，因此两者都验声明，不只做仓库原有 Bundler 类型检查。[TypeScript moduleResolution](https://www.typescriptlang.org/tsconfig/moduleResolution.html)

## 明确边界及后续

- **已完成**：私有归档缺 dist 根因修复、三包 README、独立可运行消费者、两轮真实外部消费证据和失败记录。
- **本轮待办**：S4 仍需 SDK 参考在文档中心的产品入口、一键插入并修改运行样例、插件打包/安装/启停/兼容性 UI，以及另一项目真实安装闭环；本门禁不能替代这些。
- **明确排除**：当前不公开发布 registry，不改三个包的 private；不创建完整 ViewerSDK 或复制 ThingJS 平台，不增加运行依赖，不接入真实凭据/云端服务。
- **项目级后验收**：任意客户插件、任意构建器/浏览器、Tauri 与云渲染服务兼容矩阵。仅测试固定样例，不作普适承诺。

此次为非可视化 SDK 验收夹具，不改产品 UI/3D；运行截图只作为浏览器实际执行证据，不给其套用 Kimi-95 产品视觉通过结论。
