# 第二会话车道启动包(2026-09-19)

目的:绕开本会话的 2 子代理并发上限——在第二个 ZCode 会话里由主线程直接执行车道(或其自己的子代理,若配额按会话计)。

## 使用方法

新开一个 ZCode 会话(工作区仍是 D:\Documents\bim),把下面任意一个车道块整段粘贴给主线程即可。车道间文件互斥已核对,与本会话在跑的 R2(着色)/P1(delivery 面板)不冲突。

---

## 车道 β1:P2 OPC UA 网关前置(P2 的 MQTT 切片未抢到槽,此处做 OPC UA 调研+核心)

```
你在 D:\Documents\bim\bim-studio 工作。任务:apps/api 的 OPC UA ingestion 前置切片。
1. 审计 apps/api 的 dataset 写入路径与现有外部数据接入模式;
2. 实现"可注入传输层"的 OPC UA 订阅核心(monitored item → 数值信号 → dataset 写入),
   不引云服务;node-opcua 若离线装不上(pnpm --dir apps/api add node-opcua 失败就记录精确错误),
   则核心逻辑+假 socket 测试先行;
3. 单测覆盖:订阅映射、数据类型规范化、断线重连退避;
4. 证据写 test-output/p2-opcua-gateway-20260919-r1/evidence.json。
纪律:不 git commit;文件≤800行;禁止 reset --hard/清理 test-output;不碰 delivery/shaderAuthoring/webgpu/deep-engine-native。
```

## 车道 β2:烘焙一期(探针烘焙+增量重烘)

```
你在 D:\Documents\bim\bim-studio 工作。任务:烘焙轴切片一(五轴定档:超越 Babylon/Three = 探针烘焙+增量重烘落地即超越)。
1. 审计 apps/web/src/optimizer/lightmapBaker.ts 与 lightmapIndirect.ts(已用 MeshBVH)及 native baked GI 证据链(test-output/native-baked-gi-20260918-r2);
2. 实现"探针烘焙 + 增量重烘"切片:烘焙结果按区域缓存,只有脏区域重烘(复用 B02 脏域语义),光照状态变化驱动重烘焙;
3. 单测:脏域触发正确性、未变区域字节级复用、重烘后与全量烘焙一致(阈值档);
4. 证据 test-output/baking-probe-20260919-r1/evidence.json。
纪律:不 git commit;不碰 delivery/shaderAuthoring(R2 在用)/webgpu;禁止 reset --hard/清理 test-output。
```

## 与本会话的协调

- 本会话保留车道:R2(着色 IR)、P1(集成)、主线门禁、soak 窗口、统一提交。
- 第二会话的车道完成后把报告贴回本会话即可,我来审阅并统一提交(避免 git index 冲突,第二会话不要自己 commit)。
- 若第二会话也能跑自己的子代理(配额按会话计),把 β1/β2 分给它的子代理,主线程做第三车道 β3(P7 QTO 导出/评审 UI)。

## 车道 β3:R6-0/R6-1 wgpu 开销实测与零成本档(已排定今晚 01:30 自动执行;若你手动开新会话想提前做,先删 test-output/r6-0-wgpu-overhead-20260919/ 判重标记)

```
你在 D:\Documentsimim-studio 工作。执行 R6-0/R6-1 车道(DeepSeek 式 wgpu 白盒优化,见 de26-high-value-scope-analysis 第 10 节 R6-1 卡)。阶段一测量先行:审计 packages/deep-engine-native 的 wgpu 版本/特性/提交通路;release(校验关)vs debug(校验开)帧时间与 CPU encode+submit 细分,样本≥5 取中位数;证据 test-output/r6-0-wgpu-overhead-20260919/evidence.json,含 CPU 提交占比判定(30%/10% 阈值)。阶段二零成本档:Cargo.toml features 与 profile.release 审查,实施零语义风险项并记录前后对比。纪律:不 commit;不碰 delivery/optimizer/webgpu/lighting/runtimePackage/shaderCompute 在途车道文件;禁止 reset --hard/清理 test-output;测量先行不许凭感觉。
```
