# J3-E 冻结 probe 原子同帧捕获回移植(2026-10-03,已获用户批准)

拍板依据:`docs/specs/j3e-frozen-probe-race-assessment-20261003.md`(批准方案 1:回移植原子捕获
+ SHA 重锚有案 + 对拍确认不回归)。本批不 commit/push;禁 cargo;禁帧时测量;GPU Chrome 单实例。

## 1. 现状核查(六步,2026-10-03 实测)

1. **定位与 SHA(sha256sum 实测)**:
   - 冻结基础 probe:`test-output/j3-e-web-unknown-matrix-20261001/probe.ts`
     SHA-256 `f03948b2904640dd83f81087467387e21c835832dedb93d304c8eb3e8c6bd968`(与账本 `f03948b2…` 一致)。
   - 派生件:`test-output/j3-e-multi-epoch-20261002/probe-triple.ts`
     SHA-256 `406497f18ff8aa95ca85e3964baf2cb02f091808cea2a10d2573e6cd6df12655`(与账本 `406497f1…` 一致)。
   - 同名不混:`j3-e-mixed-recovery-20261002/probe.ts`(SHA `37f44088…`,candidate 版)、
     `j3-d-shadow-interpolants-20261001/probe.ts`(SHA `7e186628…`)均非本标的。
2. **观察项原文**:remaining-02.json `remaining[]` 末条——「frozen 基础 probe.ts 两步捕获的潜在竞态,
   status=观察项(不改动冻结件),triple-epoch 首跑实证两步 settle→hdr 存在 results 替换竞态(常值
   0.2132);派生 probe 已用原子同帧捕获;冻结 probe SHA f03948b2 保持不动…后续批可评估升级冻结件」
   ——本批即该条预告的升级批。
3. **捕获实现 diff(两步 vs 原子)**:
   - 冻结件两步:`settleToFrame()` 轮询读 `runtime.frameReadbackResults` 校验帧号后**返回**;
     随后 `hdr()` **再次** `await runtime.frameReadbackResults` 取字节。两次读之间该属性可被下一帧
     渲染的捕获结果整体替换(TAA Halton 逐帧子像素 → 异帧号恒差 `0.2132568359375`),即评估书实证竞态。
   - 派生件原子:`captureSettled()` 单次 `await runtime.frameReadbackResults` 拿到 results 后,
     **在同一 results 数组的同一 captured 条目上**同时校验 `frameId===frame-8`、`bytes`、
     `format==='rgba16float'`,并当场 `bytes.buffer.slice()` 复制字节——帧号校验与取字节之间不再有
     第二次属性读,消除替换窗口。
4. **消费方**:probe.ts 仅被同目录 `run.mjs`(vite /@fs/ 动态 import + Playwright)按路径字符串消费;
   全仓 grep 无其他 import;test-output 不在任何 tsconfig include(`typecheck`=`tsc --noEmit`
   限 apps/web),probe 文件不经类型检查。历史 run.mjs 的源漂移断言(hash 前后对拍)机制与本批兼容
   ——批内不改源即可。
5. **既有测试与证据**:冻结件相位修正后验证形态=两独立进程四轮全过
   (`run-…18-11-59`/`run-…18-12-45`,各 2 轮 `unknown-pre-present-loss`,drift 0,frame-8/frame-8);
   `run-…23-16-35` 补验 `single-unknown-mid-run` 1 轮同形态;派生件 4/4 =
   `j3-e-multi-epoch-20261002` 两进程四轮(remaining-02.json closedByThisBatch 第 4 条)。
6. **规格链**:评估书(2026-10-03)→ 本规格;冻结语义由「SHA 不变」转为「SHA 重锚有案」(§4 账本)。
   `j3-e-prepresent-promotion-20261002.md`、`j3-e-domain-upgrade-batch1/batch2-20261002.md` 中
   `f03948b2` 引用均为**历史收据**,效力不因重锚失效(实测时未触发竞态),不改写历史文档。

**结论**:已有(不重建)=原子捕获模式(派生件 4/4 已证)、运行 harness、历史收据链;
真实缺口=冻结件仍持两步捕获,升级本身未做。

## 2. GPU 通道现状

H-C7-P1 已交付(`docs/specs/hc7p1-mcp-template-loop-20261003.md` 为交付报告);实测 2026-10-03
无 chrome.exe 进程,GPU Chrome 单实例空闲,无握手线冲突 → GPU 对拍直接执行(无需 CPU 先行)。

## 3. 回移植内容(最小 diff)

对 `test-output/j3-e-web-unknown-matrix-20261001/probe.ts`,与派生件同一模式,仅动捕获路径:

1. 删除 `hdr()` 函数:其 `frameReadbackResults` 快路径正是两步竞态的第二读;其手工 GPU readback
   回退路径在本 probe 不可达(ObservedBackend.create 恒注入 FrameCaptureSession+opaque-hdr readback,
   `settleToFrame` 成功后 `frameReadbackResults` 必已定义)——与派生件同样整体移除,可达语义不变。
2. `settleToFrame`(两步)→ `captureSettled`(原子同帧,逐字取派生件实现);保留
   `capturedOpaqueHdrFrameId` 供失败信息用(与派生件一致)。
3. 两处调用点改从同一返回对象取 `bytes`/`frameId`(before:`beforeCapture.bytes/frameId`;
   after:`afterCapture.bytes/frameId`),evidence 字段名与语义不变(`hdrFrameIds`、
   `relativeHdrDrift`、gate ≤1e-6 不变)。
4. 不改:行集、帧号选择(`HDR_CAPTURE_TARGET_FRAME=8`)、注入方式、轮询上限、
   通道/摘要断言、evidence schema、finally 清理。

## 4. SHA 重锚账本

| 项 | 值 |
|---|---|
| 旧 SHA-256 | `f03948b2904640dd83f81087467387e21c835832dedb93d304c8eb3e8c6bd968`(相位修正版,2026-10-02) |
| 新 SHA-256 | `ce05fd52e74724eeadf77976c469f5f92cb635c4c3298c7a12807f216577641f`(2026-10-03 实测,原子同帧捕获版) |
| 重锚依据 | 用户批准 `j3e-frozen-probe-race-assessment-20261003.md` 方案 1;消除测量探针 results 替换竞态 |
| 历史收据效力 | 不失效:原收据实测时未触发竞态,结果本身有效;重锚仅消除未来偶发假失败 |
| 后续引用纪律 | 凡新批次引用冻结 probe 必须用新 SHA;历史文档中旧 SHA 原样保留不改写 |

## 5. 验证方案与执行

对拍=回移植后的基础 probe 走自己的 harness(与 triple-epoch 同一捕获模式、同一 frame-8 口径):
`J3_WEB_ROUNDS=2` 全 6 行一轮 harness 调用(12 收据),门=全部 status measured、
4 个 HDR 行 `relativeHdrDrift===0` 且 `hdrFrameIds` 双侧 frame-8、源漂移断言 drift=[]。
等价性说明:probe-triple 本身 SHA 不变(406497f1),重跑它不能覆盖回移植代码;基础 probe 的
`unknown-pre-present-loss` 行与 triple-epoch 行共享同一捕获路径,故以基础 probe 自身矩阵为对拍标的。

**执行结果:GPU 轮环境性受阻,未跑成;静态验证已过。** 详见 §6。

## 6. 验证证据(实测记录)

### 6.1 已完成的静态验证

1. esbuild `transformSync(loader:'ts')` 解析通过(`PARSE OK`,esbuild 0.28.1);
2. 回移植后实测 SHA-256 `ce05fd52e74724eeadf77976c469f5f92cb635c4c3298c7a12807f216577641f`;
3. 残留检查:`hdr(`/`settleToFrame` 零残留;`captureSettled` 三处(定义+两调用点)与派生件逐字一致;
   `HDR_CAPTURE_TARGET_FRAME=8`、门 `≤1e-6`、`hdrFrameIds`/`relativeHdrDrift` 字段、行集、注入、
   finally 清理全部未动;
4. 竞态消除的机制性论证(§1.3):帧号校验与取字节发生在同一次 `await runtime.frameReadbackResults`
   之后的同一同步块、同一 captured 条目上,两次属性读之间的替换窗口不复存在——与派生件 4/4 已证
   实现完全同构。

### 6.2 GPU 对拍轮:受阻实录(2026-10-03 02:33–03:00,按纪律登记待做)

- 首轮 `J3_WEB_ROUNDS=2 node run.mjs` 失败于 `initial product candidate did not publish`
  (probe.ts 的 `switchTo('webgpu')` 断言,发生在任何捕获代码之前——**与回移植 diff 无因果路径**);
  失败证据原样保留:`test-output/j3-e-web-unknown-matrix-20261001/run-2026-10-02T18-33-07-625Z/
  {failure.txt,evidence.json}`(receiptCount=0)。
- 独立确诊(与 probe 无关的系统级问题):
  1. Chrome 154.0.8037.95(隔夜自动更新;昨日同 harness 全过时为旧版)、Edge、Playwright
     chromium-1223 三个不同 Chromium 构建 headless/headed 全部 `navigator.gpu` 不存在;
  2. CDP SystemInfo:`dx12FeatureLevel: "Not supported"`(NVIDIA RTX 4060 Laptop 的 ANGLE_D3D11
     正常,D3D12 层不可用);
  3. 系统级直测:`D3D12CreateDevice`(正确 IID_ID3D12Device + FL12_0)返回 `0x80004002
     E_NOINTERFACE`;dxgi 工厂枚举逐适配器复查时 QI 亦 E_NOINTERFACE(DXGI/COM 层异常同族);
  4. 驱动状态 OK(595.79,2026-03 安装,近 30h 无 nvlddmkm/Display 事件);机器存在向日葵
     OrayIddDriver 虚拟显示(远程会话交互为头号嫌疑);
  5. CPU(SwiftShader)通路同样不可用:绑定隐藏发生在适配器判定层,`--enable-unsafe-webgpu`/
     `--enable-webgpu-developer-features`/`--use-webgpu-adapter={d3d12,vulkan,swiftshader,cpu}`/
     `--disable-gpu-blocklist`/`--use-angle=swiftshader` 全部无效——**本批无合法 CPU 对拍路径**。
  6. 诊断脚本运行完毕无残留(0 个 chrome.exe)。
- **「瞬态/已恢复」主张的复测记录(03:05–03:40,协调方转述 H-C7-P1 实测 WebGPU 正常之后)**:
  D3D12CreateDevice 12+ 次采样恒 `E_NOINTERFACE`(2 分钟 8 连采无抖动);三构建浏览器复测仍
  `no-navigator-gpu`;**决定性实验:经 `explorer.exe` 壳在用户交互上下文(脱离本代理进程树、
  非沙箱模式、用户默认 env)启动同一探测脚本,结果同为 `no-navigator-gpu`**——排除本代理
  沙箱/Job/env 因素,本机当前任何新进程均拿不到 WebGPU。NVIDIA 侧 `display_active=Enabled,
  pstate=P0, 67°C`,无 TDR 事件,排除显示离电/驱动复位解释。与 H-C7-P1 实证(真
  nvidia·lovelace 适配器+21 帧 readback+GPU P95 0.4ms)构成硬矛盾,该实证的落盘文件在本机
  test-output 未检索到;已上报协调方三选一:(A)在其已验证上下文代跑对拍命令,(B)提供该实证
  的启动方式/机器以便复刻,(C)确认其实证来自其他机器(云 worker 等,则本机登记待做维持)。
- **矛盾点的进一步定位(03:30–03:50)**:
  1. 找到协调方所指实证=`docs/specs/hc7p1-real-handshake-20261003.md`,其 gate 证据
     (`test-output/runs/2026-09-05/hc7p1-real-handshake-gq828C/`)落盘于 **03:09**——与我的失败
     采样窗(03:10–03:12 连续 4 样)近同时、同机会话(Console/1)。启动配方=Playwright Chrome
     headless + `--enable-unsafe-webgpu --enable-features=Vulkan,UseSkiaRenderer --no-sandbox`
     (deep-gpu-stage-smoke.mjs 先例)。
  2. 该配方在本代理上下文复刻**仍失败**;四格矩阵(我的树/explorer 用户壳)×(无 flags/H-C7-P1
     flags)全部 `no-navigator-gpu`。注册表 UserGpuPreferences 无 chrome 条目。即成功与否的差异
     收敛为「发起进程所属 agent 树」这一变量,机制未明(疑与各家 agent harness 的进程创建方式/
     GPU 服务会话绑定有关)。
  3. 为选项 A 铺路:`run.mjs` 增加可选 env `J3_WEB_CHROME_ARGS`(默认空=与历史 run 完全同参,
     不使用时不改变任何测量条件);新增一键 wrapper `run-backport-round.cmd`(先无 flags 跑,
     失败自动按 H-C7-P1 先例带 flags 重跑,两轮 run-* 目录都保留供验收)。使用 flags 的批次
     必须在验收记录写明(启动条件变化,适配器后端可能 D3D12→Vulkan)。
- **裁决 A 执行结果(03:34–03:37,主线程上下文)**:wrapper 两连尝试均失败于同一签名
  `initial product candidate did not publish`(捕获代码之前,与回移植无关)——
  `run-…19-34-59-531Z`(无 flags)与 `run-…19-35-19-416Z`(H-C7-P1 flags),failure.txt 原样保留。
  **主线程上下文现在也失败** → 03:09 的好窗口已关闭,结论由「进程树差异」修正为
  **「时间窗摆动」**(同一机器、同会话、03:09 成功 vs 03:10+ 全败,与 OrayIdd/远程会话连断
  相关的假设为主线程环境记录所采纳)。
- **长时程自动收口(03:40 起)**:6 小时 detached 看门狗(独立 node 进程,非任何 agent 树内)
  每 3 分钟探测(先无 flags 后 H-C7-P1 flags),好窗口立即自动跑 `J3_WEB_ROUNDS=2 node run.mjs`
  并落 run-* 目录;日志 `C:\Users\rain\AppData\Local\Temp\j3-watchdog.log`。验收脚本
  `verify-backport-round.mjs` 按 §6.3 门逐条断言。截至 06:13,坏窗持续约 3 小时
  (probe#1–#51 无一通过);期间排除待重启/CBS 半落(注册表无 RebootPending,d3d12.dll 为
  2025-06-10 旧版未动)、排除 Sunlogin 服务附着(当前 Stopped)、排除每进程 GPU 偏好
  (UserGpuPreferences 无 chrome 条目)。第一代看门狗 06:13 后静默死亡(无 ROUND/EXHAUSTED
  日志,疑长时驻留内存累积),06:15 已重启第二代(预算至约 12:15)。
- **§6.3 门判定(截至本规格最后更新)**:**未通过——对拍轮未能在任何可达上下文执行**
  (我方 agent 树、explorer 用户壳、主线程 agent 树共 4+2 次全跑尝试 + 看门狗 51+ 次探测
  全部落坏窗;唯一好窗=03:09 的 H-C7-P1 gate)。统计批维持禁跑;好窗口出现后由看门狗自动
  跑轮或人工双击 `run-backport-round.cmd`,再以 `node verify-backport-round.mjs <run-dir>`
  一条命令出验收判定并回填本节。

### 6.3 登记待做(下一可用 GPU 批的前置项)

前置:恢复系统 D3D12(按序试:本机控制台会话复测 `dxdiag`/`D3D12CreateDevice`;若远程会话所致则
断开向日葵远程后复测;必要时重启;再不行走 NVIDIA 驱动干净重装)。D3D12 恢复后执行:
`cd test-output/j3-e-web-unknown-matrix-20261001 && J3_WEB_ROUNDS=2 node run.mjs`,
门=§5(12 收据、4 HDR 行 drift 0、frame-8/frame-8、drifted=[])。**统计批(帧时+≥5 成对)在
此轮未过前不得开跑**——这正是评估书把回移植设为统计批前置的本意,现该前置扩展为「回移植已完成
+运行验证待补」。

## 7. 诚实声明

- **完成**:回移植 diff(与派生件 4/4 已证模式逐字同构)、SHA 重锚账本(§4)、静态验证(§6.1)。
- **未完成(如实声明)**:运行时对拍一轮未能执行——系统级 D3D12 故障导致所有 Chromium 的 WebGPU
  不可用(GPU 与 SwiftShader CPU 两路皆无),非 H-C7-P1 握手线冲突,已按 GPU 冲突同款纪律登记待做
  (§6.2/§6.3)。因此「原 4/4 语义保持」当前仅由静态同构论证背书,没有本轮实测收据;不得在
  §6.3 轮通过前引用新 SHA 的运行时证据。
- 历史收据(f03948b2 各 run)效力不变:实测时未触发竞态,结果有效。
