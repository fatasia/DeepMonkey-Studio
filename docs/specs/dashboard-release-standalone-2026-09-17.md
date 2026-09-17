# Dashboard 正式单文件交付验证

2026-09-17，重建当前 Windows x64 静态 CRT Release 播放器后，完成隔离发布快照到无参数单文件 EXE 的实际验证。

- 使用独立磁盘 JsonStore/ObjectStore 创建并发布图表，再重开存储读取发布快照；不修改用户数据库。数据 A=37/B=91 经冻结、编译、Native 窗口验证进入同一 runtime 包。
- 从候选路由取得 ZIP、DMDA、EXE；校验压缩清单、嵌入载荷、哈希、已部署播放器身份，撤销候选后 ZIP/EXE 两个入口拒绝旧候选。
- 单 EXE 目录没有 sidecar，PATH 仅保留 Windows System32。无参数启动后实际呈现并写入与目标包一致的恢复检查点；`--licenses` 可读取嵌入声明。
- 同次静态分发打包通过 27 项 smoke、纯度检查和 44 项文件/ZIP 清单验证。分发 ZIP 为 6,283,726 bytes，SHA-256 `9003233ba7ac22f042af3043fe1b7499eee0e3c36cadf97f45b19188916975cf`。

作者包 EXE SHA-256：`00343702af68c7a30afbeb235509e6d155424023c022d9dc5f354fb6c2bfbb0e`。
runtime 字节 SHA-256：`c22a39124c67416a454d05029966be35ae11c01cf7f3cf5dbe4dd589a3657e11`。

本地证据：`test-output/dashboard-published-current-20260917-r1/evidence.json`、`standalone-validation/evidence.json`；通用分发目录 `test-output/native-delivery-20260917-r1/`。产物与日志不提交。

复跑：先运行 `packages/deep-engine-native/scripts/package-windows-portable.ps1 -OutputRoot <新目录>`，再运行 `pnpm exec tsx --conditions=development scripts/verify-dashboard-published-portable.mts <静态播放器.exe> <实际设备指纹> <新目录> --sample-chart`。

验证主机为 RTX 4060 Laptop / Vulkan。使用路由注入的测试身份，未验证登录 UI；没有关闭操作系统网络适配器，不等于干净断网机验收。图表仍为 `degraded`，标题、交互和跨端外观等差异保留；本片不关闭视觉一致性、跨版本升级回滚或多设备矩阵。

## 单文件故障与还原

`node scripts/verify-dashboard-standalone-recovery.mjs <单文件.exe> <新证据目录>` 在独立目录复制播放器，首次无参数启动至实际呈现，随后分别损坏载荷字节、长度字段和尾部。三次均返回退出码 1，分别出现 `overlay/payload-hash`、`overlay/payload-length`、`overlay/truncated-footer`；没有进入 GPU 初始化，恢复目录所有文件哈希不变。

脚本恢复原 EXE 后再次实际呈现；检查点包哈希及完整包字节与嵌入的原载荷一致。整个过程 PATH 仅 System32，播放器目录只有 EXE；不修改输入 EXE。当前通过证据位于 `test-output/dashboard-standalone-recovery-20260917-r2/evidence.json`，repository gate 通过。

本检查证明损坏拒绝与手动还原后的恢复，不证明安装器自动回滚、版本升级或断电事务。

## 同路径版本切换

`build-dashboard-upgrade-fixture.mts` 从已发布的真实图表 EXE 派生明确标记的测试版本：1.0.0 的 A=37/B=91 改为 1.0.1 的 A=91/B=37，递增图表资源修订并重新计算内容/包/嵌入载荷哈希。新包经公共 RuntimePackage 解析器验证，不作为第二次实际作者发布证据。

向恢复脚本传入可选参数 `<upgrade.exe>`，在同一播放器路径、同一恢复目录依次执行原版呈现→新版呈现→损坏新版拒绝→还原旧版呈现。新旧检查点分别匹配对应包哈希与完整载荷；损坏新版后全部恢复文件保持原样。`test-output/dashboard-version-rollback-20260917-r1/evidence.json` 已通过，新版包哈希 `db58d47615067750a346da99be97ce3e60933c0a34918babb0692b85ba66d5a5`。

这补充了播放器内容版本切换与回退证据；替换由测试脚本执行，自动安装更新、原子切换与断电恢复仍待验收。
