# E57 属性点块与隔离执行（2026-09-18）

已有 libE57Format Reader 已补属性、扫描姿态和有界点块输出，并经 API 共用 Windows Job 真实执行。产物保持 `inspect`，未开放正式点云模型。

## 实现

- 原单参数资格接口保持不变；新增 `--output <new-directory>`。4096 点一块，NDJSON 保留 scan 索引、源点序号、姿态变换后的 Float64 世界米制坐标、原始 16 位 RGB、有效强度及属性/坐标无效状态。无效位置为 null，不生成伪坐标。
- 元数据保留 scan GUID/name、WXYZ 单位四元数、平移、颜色/强度范围、局部/世界包围盒、原始 coordinateMetadata。CRS 未解析时明确 null，不从文件名或坐标猜测。
- 继续校验全部 CRC，输入 1 GiB / 4096 scans / 1 亿点；点文件另限 1 GiB。中间目录全文件成功后 rename，失败只清理本次文件；已有目标拒绝覆盖。stdout 只发小回执，详细元数据留 manifest。
- `builtinE57Inspection.ts` 复用 `runIndustrialJob`，无新进程框架；取消/超时等待进程树退出后清理独占 attempt。再次核对源 hash，点块审计验证姿态、源序号、有限坐标、有效性、点数、世界 bounds 和文件 hash。返回 `inspect` / `productionReady:false`，不移动活动模型指针。

## 验证

- MSVC Release / 静态依赖增量构建通过，无新第三方依赖。原 Reader 8 正例 / 5 损坏例各两轮仍通过。
- Reader 为 2,892,288 字节，SHA `7da63e1fccf809cf7c669d33e84e293c918c650bd26f886174d0a02399a32078`；另限制扫描元数据 3 MiB、完整 manifest 4 MiB。
- 新资格 3 正例各两轮：上游 double/float 彩色立方体各 7680 点，RGB 精确保留为三种源颜色；受控两 scan 夹具逐点验证百万坐标、90°旋转、65535/1234 RGB、12.5 强度、颜色/强度无效与坐标 invalidState=2。
- 5 损坏源没有成功或 partial 目录；拒绝覆盖后旧点文件 SHA 不变。两轮点块及 manifest 完全一致。最终证据：`test-output/industrial-e57-attributes-20260918-final/evidence.json`；原资格复测：`test-output/industrial-e57-reader-final-20260918/evidence.json`。
- API 6 项真实 Job 回归通过：正常 Reader、损坏源、启动后取消、预取消、零时限、截断块/源序号/世界 bounds 篡改。API 类型检查通过。

## 剩余范围

仓内尚无产品 PointCloudManifest、点云 Provider 或 Native point primitive。这里的 NDJSON 是资格中间产物，不冒充现成点云渲染协议。正式上传任务接线、格式包分发审计、Web/Native 点云空间调度/拾取、独立来源多站大样本、真实球坐标文件、完整属性/CRS 解释及峰值 RSS 仍待；S3 不关闭。

本次没有新增 UI 或画面，不以代码测试替代点云视觉验收。来源和许可证沿用 [Reader 固定来源报告](./industrial-e57-native-reader-2026-09-18.md)；两 scan 文件仅为合成边界证据，不计独立真实扫描来源。
