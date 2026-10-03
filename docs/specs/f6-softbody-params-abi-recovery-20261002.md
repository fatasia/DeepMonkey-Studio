# F6 软体并行 Params ABI 与障碍验收续作（2026-10-02）

## 现状核查

1. 全仓及未跟踪源码：软体障碍 GPU 已落盘 `softBodyGpuDispatch.softbodyParallel.ts`、`softBodyParallelSolverWgsl.ts`、`softBodyParallelMirror.ts`、pack/校验与 probe/runner；中断前未完成有效收口，不重建新 dispatch 或另一份镜像。
2. 契约：`SoftBodyGpuStepInput` 已含可选 obstacles，params 48B，粒子 48B、边 16B、tet 32B、障碍 80B×64；contracts 的软体定义已存在，不改公共合同。
3. 依赖：WebGPU、esbuild、Vitest、Playwright 都在用；零新依赖，禁 cargo。该软体并行 WGSL 当前本身是 TS 内嵌单源，`syncSharedWgsl.mjs` 无软体映射，不能凭布料先例错误断言存在 .wgsl 真源。
4. 消费方：串行和并行 dispatch 共用 `packSoftBodyGpuParams`；公共 physics 导出、既有 clothParallelGpuProbe 中软体对拍与独立障碍 runner 都调用正式并行入口。不得改变共享 pack 去迎合错误并行声明，串行 WGSL 字段顺序已正确。
5. 测试与证据：已有 pack 字节测试只锁 4 粒子/4子步的巧合输入；前批真正 GPU 用 8 粒子/8子步，同样掩盖部分错位。障碍 evidence.json 原门两项失败，adapter={}，直接执行烟测未生效，测试加尾部 dummy 粒子并谎称浏览器怪癖，不能当验收。
6. 规格：读 F6 parallel-coloring、softbody-parallel-divergence、root 台账与61行清单。本续作与两子线（F5 渲染、C2 历史）文件不重叠；当前 GPU 窗口归 C2，本线先 CPU。

**已有（不重建）**：约束着色、镜像、共享 pack、障碍投影、正式编排与黄金参考。

**真实缺口/根因（P1）**：共享 pack 的头四字段是 `[particleCount, edgeCount, tetCount, substeps]`，并行 WGSL 错写 `[substeps, particleCount, edgeCount, tetCount]`。因此零边场景粒子数读成 0，N粒子/N−1边漏处理末尾粒子，并且实际子步宽度 dt/N 而非 dt/substeps。现有“auto layout/SwiftShader/末粒子怪癖”的归因均没有独立证据，ABI 足以解释这些症状。

## 最小方案

- 先补异值字段回归：粒子13、边7、tet3、子步2，读取实际 WGSL 声明顺序并与共享 pack 逐字段核对；不能只锁两个独立字符串。
- 仅修并行 WGSL 字段顺序，保 pack/串行/字节48B合同不变，重跑障碍/着色/镜像同族。
- 删除 probe 内重复类型 import；撤除“空色批垫假约束”和“尾部dummy点”作为通过路径，直接使用正式编排零约束场景验证全部真实粒子含尾部生效，保留旧失败文件不覆盖。
- 相位与障碍参数双方需用同 f32 pack：尤其球心/半径/旋转要与实际 GPU 一致。此前黄金只量化粒子不量化球心，分支不同会制造 0.19 伪差。新证据逐槽记录，原容差1e-5不放。
- 新证据必须记录真实 adapter 与实际源 SHA；GPU 错误/执行烟测失败不得退出成功，也不得标为不可用跳过。
- C2 释放后才占 GPU 双 fresh；不测帧时、不跑 cargo、不闭整项F6，不增加61行计数。

## 验证与根因收口

### 实测失败保全

- `before-abi.json`：3/3 红，实际WGSL字段解析与共享pack异值对照，不靠mock。
- `before-postcontact.json`：约束将自由粒子从球面拉回半径0.5，非穿透反例红；无障碍原行为负控通过。
- `round1/evidence.json`：ABI修复后NVIDIA真实GPU，公式/执行/镜像/重放/接触均过，黄金边际门0.0516>0.05失败，保留原值。
- `postcontact-round1/evidence.json`：补约束后接触仍0.0517超门，证明单改接触不是旧0.2m黄金差的主因。未放门。

### 已纠正的机制族

1. **并行Params字段顺序错位**：最小修WGSL声明，pack/串行/48B不动；原8粒子/8子步对拍掩盖部分错位，不能据历史宣称全面通过。
2. **约束后再穿透**：正式dispatch与f32镜像在积分后/约束后各投影，CPU黄金同边界；没有障碍时原trace/结果不变，缓冲不增，单pass仍一次submit。带障碍每子步增加一次dispatch，未测性能收益不做性能数字外推。
3. **黄金测量错时相**：旧GPU120tick终值被重复比较f64第24/48/72/96tick；现保存同tick checkpoints，逐行对应。
4. **tet环绕夹具不公平**：原Kuhn六tet的signed V=-1/6，却以abs(V)设正目标；CPU构造自动翻正、GPU直接解负→正，根本不同物理问题。夹具仅在构造时交换中间索引（几何不变），初始V正门fail-closed；同族clothParallelGpuProbe与CPU软体夹具做相同规整。不在运行中自动翻转tet，这会掩盖真实物体倒置。新oracle反例固定负输入产生>0.1位移、正确环绕与黄金零重力保持。
5. **球心量化对照偏差**：既有黄金solver继续使用，粒子和障碍center/radius/extents先共享f32 pack；在近球心原f64参数会选非零方向而GPU同f32球心走零距离分支，造成0.28伪差。旋转黄金依旧独立quaternion→matrix，原1e-5容差不变。
6. **伪“浏览器怪癖”**：撤掉公式验收主路径假边/假tet/尾部dummy垫片，零约束正式dispatch和单入口都必须真生效；真实末粒子包含在全部点对照。matrix垫片只留诊断负控，不作为过门。adapter明确NVIDIA Lovelace，旧{}没有SwiftShader证据。
7. **CPU接触测试没传障碍**：补 `obstacles:[sphere]`；正确环绕后旧球位置不在接触轨迹，改为解析接触夹具（p7初始球面，sphere=[1,.5,1],r=.5，其他自由角球外），门限仍原0.06/0.05；保留旧失败JSON。

### 最终验收

- `accepted-round1/evidence.json`、`accepted-round2/evidence.json`：两独立Chrome fresh实际NVIDIA Lovelace，全七门true，GPU错误0、12实际esbuild输入源SHA前后稳定。
- 球20真实点误差 **1.1096636289674929e-7**；旋转盒12真实点 **1.8967170997710786e-7**，原门1e-5未变。无虚假末尾点。
- 120tick镜像最大约1.75e-5，双跑逐位true；黄金±障碍同tick边际差 **3.047252614527302e-4**（原0.05）；无障碍f64最大约4e-4，不能继续把旧0.2差归为扫序结构。
- 物理全族 **199 passed / 3既有skip / 0failed**（总202）；deep-engine src/lab/examples全类型检查exit0；结果 `accepted-physics.json` 与 `tsconfig*.log`。

### 诚实边界

- 本批只闭“软体障碍并行核与可靠验收”子集；Native/WASM、GPU自/互碰、产品session自动换核及长期帧时仍未覆盖，**F6整项未闭**。
- 单次固定序投影对重叠多障碍的收敛仍需原后继，不用单球/盒对拍外推。
- WGSL中previous.w写position.w与镜像prev.w=0仍有非物理padding差异，未以全buffer跨CPU逐位认证，双GPU重放逐位范围另记。
- 无cargo/no商业依赖/无commit或push；完整失败原证保留。

### 门禁评分（本切片）

工程十维9/9/9/9/9/9/9/9/9/9：六步盘点、共用pack不漂移、三个修前反例与两个GPU失败保全、微小ABI补丁/同族三夹具/实际执行证明/生命周期原资源销毁、CPU全族与真机双fresh源身份。测试八维9/9/9/9/9/9/9/9（GPU核算法范围）：原门未改、没有空GPU跑/adapter未知冒充、真实全点含末粒子、原f64参考/负控/失败保全；产品GUI/跨宿主未覆盖不认证。
