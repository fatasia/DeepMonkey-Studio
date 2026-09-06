# URDF 原包与输入合同验证

状态：后端、合同及素材入口聚焦检查通过，r15 源码冻结。机器人完整 UI、双实例运动和发布浏览器门禁由主任务统一执行；本报告不声明它们已经通过。

## 已实现

- 复用既有模型上传、ConversionQueue、ObjectStore 和项目素材，不新增资源库。`urdf` / `zip` 输出原生 `viewerKind: urdf`，`geometryUrl` 保留原文件地址，不强转静态 GLB。
- `robotAsset.ts` 分离资源定义和 `SceneModelState.robotPose`。长度/位移为 m，角度为 rad；保留 link、任意轴、origin、fixed/revolute/continuous/prismatic、limit、mimic、visual/collision、material 和 inertial。原 XML 与所有包内文件均记录路径、长度、SHA-256，未知原文仍保存在原包中。
- ZIP 唯一 URDF 自动选择，多入口使用 multipart `robotEntryPath`。字段置于文件前后均能校验；重复字段、非机器人字段、非 URDF 入口及危险路径拒绝。
- 共同限额：压缩包 128 MiB、2048 条目、总解压 256 MiB、单文件 64 MiB、XML 8 MiB、关节 512。上传阶段流式限额；取消/超限只清理本次已创建的部分文件，不覆盖或删除旧文件。
- 原始 ZIP 中央/本地目录在 JSZip 之前检查：重复与大小写别名、路径折返/编码歧义、ZIP64/多卷、加密、符号链接、特殊文件、重叠范围、元数据不一致、高压缩率均拒绝。逐项限制实际解压量并校验 CRC、长度和 SHA-256，不执行文件、不外网取资源、不解压到主机目录。
- XML 使用 fast-xml-parser 5.11.1，拒 DTD/实体声明/处理指令、畸形结构、重复名称、多根/环、缺资源、非法数字和轴长度溢出。名称拒成熟 loader 无法安全处理的引号/方括号/反斜线。
- 无损优化只允许机器人来源输出 ZIP，保留既有 optimization 来源。Provider 复核当前来源版本、入口和全部资源 path/size/hash 严格相等；任意 XML/资源改动不能标为无损压缩。通用 Web GLB 优化 helper 同样拒机器人，避免绕过专用入口。
- 素材搜索支持格式、原始名称与机器人入口，不因用户重命名丢失 `urdf`/`zip` 可发现性。原包下载保留字节和扩展名，截图复用真实 Viewer 帧；失败不生成替代缩略图。项目素材仍使用原有格式列表，不增加逐行 GPU 预览。

## 验证记录

- API：`parseRobotUrdf`、`prepareRobotSource`、`RobotSourceProvider`、`robotUpload`、`modelAssetRoutes.robot`、既有 `modelAssetRoutes.optimization` 六文件 58 项通过。
- 合同：`robotAsset`、`sceneValidation`、`modelFormatRobot`、`modelFormatCapability` 四文件 25 项通过。姿态保存/JSON 往返、有限 SI 值、prototype/accessor/symbol/数量约束覆盖。
- Web：`RobotAssetMediaActions`、`robotAssetMedia`、`projectModelSearch`、`modelOptimizerAssets`、`captureModelThumbnail`、`appDefaults` 六文件 29 项通过。含取消后不下载、401/长度改变不交付文件、真实截图委派及失败反馈。
- API、contracts、Web 最近 `tsc --noEmit` 均退出 0；最后轴长度修改后 API 类型检查再次退出 0。未自行构建、安装、提交或推送。
- 独立审查 Viewer 发现成熟 loader 对带空白 axis 解析和 NaN 比较的缺陷，以及 DAE 次级 XML 缺 DTD 拒绝；已交 Viewer 所有者修补。相关真浏览器证据归其报告，不以此处纯逻辑测试替代。

## 明确限制与待验收

- 这不是完整 URDF/ROS 物理仿真器。Xacro 不执行；floating/planar 拒绝；惯性被保留不等于物理求解或承载/节拍验证。网格入口限定 STL/DAE/GLB/glTF/OBJ；实际图片、嵌套 mesh 依赖和模型可视结果需 Viewer 门禁覆盖。
- Web 客户端只读二级资源仍需包内闭合；OBJ 的 MTL 不在本轮支持范围。格式能力目录仅新增范围项，保持 `planned/unverified`，没有伪造完整运行时或保真证据。
- 纯离线桌面上传仍要求连接工程服务完成权威 URDF 校验；未另造浏览器解析 API 或改存储拓扑。
- 待统一真实流程：裸 URDF/ZIP 上传 → 多入口选择/取消/错误反馈 → 素材预览与原包/截图下载 → 无损压缩另存 → 同资源双实例独立关节 → 保存刷新/2D预览/发布读取。控制台、URL/Viewer 释放、双主题 1280/980 截图及故障场景需联合门禁确认。

SDK 样例是另一条已完成入口，正式 r13 两轮证据见 `sdk-example-entry-verification-2026-09-06.md`，不与本次机器人未完成的浏览器验收混用。
