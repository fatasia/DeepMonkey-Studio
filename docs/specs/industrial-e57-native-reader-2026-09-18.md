# E57 本地 Reader 实读资格检查

此前 E57 只有头文件消费验证。本轮完成静态本地 Reader 构建和真实点数据读取，尚未接入产品导入链。

## 本轮结果

- 固定 libE57Format 3.4.0、Xerces-C 3.3.0，MSVC 19.44.35214 / Windows SDK 10.0.26100，Release 静态 CRT。Xerces 网络访问关闭；E57 深度校验等级 2，Reader 使用 ChecksumAll。
- 8 个正例、5 个损坏例各两轮通过。正例覆盖 double/float/scaled-int、零点/空文件、中文及带空格变音字符文件名；损坏例覆盖 CRC、文件长度、压缩向量头、缺 prototype 和损坏零点段。
- bunnyDouble/bunnyInt32 都读取 30,571 点，逐项统计和局部包围盒相同；两个彩色立方体都读取 7,680 点，边界为 `[-0.5, -0.5, -0.5]` 至 `[0.5, 0.5, 0.5]`。本轮仅读取坐标，未验收颜色保真。
- 每批 4,096 点，不按声明点数一次分配。资格工具另限输入 1 GiB、4,096 scans、总计 1 亿点；拒绝非有限坐标、数量不符和负球面半径。输出在全文件成功后一次提交，失败没有成功 JSON。
- EXE 2,862,592 字节，SHA-256 `4b2d019d11b7c790b5f4daf1ccf83bccec980df237989d74a7d05416c16e4576`。`dumpbin /dependents` 仅 KERNEL32.dll、ADVAPI32.dll；不要求用户安装 Xerces/VC 开发环境。

## 固定来源与使用边界

| 内容 | SHA-256 | 来源 / 许可 |
|---|---|---|
| libE57Format 3.4.0 | `e776c438d8075a538ad38a9f821c920694019cde6a2e6cc2e15bcbfb9116e54e` | 既有上游源码归档；BSL-1.0，内含 CRCpp 独立许可 |
| Xerces-C 3.3.0 | `9555f1d06f82987fbb4658862705515740414fd34b4db6ad2ed76a2dc08d3bde` | [Apache 官方源码](https://downloads.apache.org/xerces/c/3/sources/xerces-c-3.3.0.tar.gz)，Apache-2.0；保留 LICENSE/NOTICE |
| libE57Format 测试数据归档 | `69382e0ab721b80708ce4fe4190921a9c290acb8fff69ede7e5d054a9b1fb404` | 既有固定归档；self 为 CC0，reference 遵循仓内 README 的 Test Data License |

逐样本 SHA、字节数和读取结果记录在 `test-output/industrial-e57-reader-20260918/evidence.json`。本轮只在本机资格目录使用，不把源码许可清单视为已完成产品分发审计。

## 重现

从仓库根目录运行；先准备上述已校验归档及既有 extracted 目录：

```powershell
./scripts/fixtures/e57-reader/build.ps1
node scripts/fixtures/qualify-industrial-e57-reader.mjs
```

构建脚本安装 Xerces 的库/头文件组件，不构建或安装上游示例程序。完整构建日志保存在本轮证据目录 `build.log`。

## 下一步与未覆盖范围

复用工业 worker/Windows Job 限额和点云产物协议接入生产转换，再验收颜色、强度、无效点语义、scan pose 与世界坐标、取消/超时、真实 RSS 和独立来源的大样本。当前包围盒明确为 scan-local，未应用 pose；球坐标分支已有实现但本轮无真实球坐标夹具证据。点缓冲有界不等于整个 XML/解析进程内存有界。S0/点云整阶段保持未关闭。
