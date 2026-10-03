# E3/T23-time 帧率档位对拍（2026-10-02，主线程）

## 行定义

「30/60/120Hz 和非整倍帧率工业时间/余量/事件对拍，复用 C4 已有三轴单测」（remaining-tasks-estimates-20260930.md E3/T23-time，3–6h）。

## 现状核查（六步）

1. 时间域文件：`packages/deep-engine/src/physics/fixedStepDriver.ts`（79 行，T18 统一固定步长协议）+既有测试 89 行；`packages/contracts/src/eventRecording.ts`（C4 双轴合同，frameMapping 帧轴桥接）。
2. 契约层：FixedStepClockConfig/fixedStepSim 已存在；EventRecordingFrameMapping（frameStepMs+floor/nearest）已存在。
3. 依赖：**deep-engine 有意零依赖 contracts**（textOrder.ts 先例：同语义副本模式）；`./physics` 子路径导出存在。
4. **消费方：FixedStepClock 在全产品源码零消费——且根因抓到：`physics/index.ts` 导出面遗漏 FixedStepClock/stepSimSeconds，协议交付后产品不可达**。
5. 既有测试：只有 hz=60 短序列；hz=30/120 零覆盖；事件帧轴与时钟档位零联动。
6. 规格：fixedStepDriver.ts:7 声明「1/45 这类非整倍帧率会整体放慢」——**经实测证伪**。

## 交付

1. **导出缺口修复**：`physics/index.ts` 增导出 `FixedStepClock`/`stepSimSeconds`/`FixedStepClockConfig`（T18 交付遗漏的接线，非重建）。
2. **对拍测试** `apps/web/src/viewer/fixedStepRateParity.test.ts` 15 例（落点 apps/web：两包互不依赖，组合域同时消费）：
   - 30/60/120Hz 标准档：3600 帧精确整倍 dt 长程零漂移+余量归零；±4ms 确定性抖动流总 tick 误差 ≤1；120hz×1/60 输入=2 tick/帧整倍关系。
   - 非整倍：1/45fps@60hz round 序列 1,2,1 循环、3000 帧恰 4000 tick 零漂移（tick 轴精确，余量残渣 f64 ~1e-13 非时间语义漂移）；1/144@60hz 长程偏差 ≤1 tick、单帧 0/1 tick、余量封顶 ≤1。
   - 事件帧轴×时钟同构：nearest 帧轴与 round 量化在三档全档同构（工业时间轴毫秒精度下的整毫秒采样）；floor/nearest 0.5 步长边界差异窗口钉死；eventsAtFrame 帧窗不串帧；未声明帧映射 fail-closed。
3. **注释纠偏（诚实条款）**：fixedStepDriver.ts 头注释「非整倍帧率整体放慢」按实测修正（放慢只来自 maxCatchUpTicks 积压丢弃；非整倍 round 量化长程平均=理想）；fixedStepDriver.test.ts 既有用例「理想 4.8 ticks」算术错误修正（1/45s=22.2ms 而非 80ms，断言 4 本身正确不动）。

## 验证

- 对拍 15/15；physics 域 199 passed+3 skipped（既有 fixedStepDriver 测试注释修正后全绿）；apps/web tsc 0（并行线两文件除外，既有登记）。

## 边界与未验证

- FixedStepClock 产品宿主接线仍零（协议可达但无宿主消费）——宿主接线属 T19/Play 域后续，不属本对拍行。
- 帧时/性能测量未做（多线并行禁令）；Native/Rust 侧时间合同未触碰（cargo 禁）。
- E3 行剩余=无（对拍四要素全覆盖）；T19 同族声明（本仓无第二处措辞，已 grep 确认唯一）。
