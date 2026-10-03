# J3-E mixed unknown/destroyed 序列验收（2026-10-02）

## 现状核查

1. 全仓/未跟踪及历史证据：现DeviceSession/Studio bridge自动unknown-loss恢复、destroyed终态、prepresent重试、原11矩阵/21域已存在。mixed unknown/destroyed明确仍开放，不重跑源未变旧矩阵。
2. 契约：reason分型/恢复次数/epoch与owner代际、disposed终态、资源释放/严格同帧HDR均已有；不改类型或公共门。
3. 依赖：既有Vite、Chrome/Playwright、FrameCaptureSession、Three，零新增；不cargo/不帧时。
4. 消费：旧official fixture真实Viewer→StudioDeepWebGpuBridge→DeepWebGpuBackend→DeviceSession→恢复整host/回退作者WebGL，改派生probe输入reason sequence，不注入另一套renderer。
5. 测试：旧矩阵每row单一reason或连续unknown；CPU only可覆盖但真实混合未验；旧run已target frame8、source observer、precleanup截图握手。
6. 规格：remaining-03/domain升级2批、原handoff/61表与root账本；严格mixed范围不混同真实driver未知故障（始终excluded）。

**已有（不重建）**：synthetic reason合法输入、旧runner/probe、真实host epoch重建、HDR相位对齐、WebGL作者不变性与disposal0。
**真实缺口**：同realm未知恢复成功后destroyed，及恢复候选未知→destroyed不允许复活/继续retry。

## 最小方案与失败边界

- **候选销毁腿（第四序列）双 fresh 完成**：unknown 恢复候选在发布前被 destroy → prepare 失败只上报一次（"Renderer is not ready."）、**零重试**、一次 fatal 回调、作者回退 WebGL 一次、迟到事件不复活、channels/WebGL digest 不变、全部 owner 资源 0、1119 源 stable（run-2026-10-02T08-27-56-826Z，两轮 passed）。
- **如实缺口登记（不下门）**：上报错误只带 prepare 失败文案，未保留 "destroyed" 根因——排障时无法从错误信息区分"候选被销毁"与"会话未就绪"。属错误原因保真缺口（P3），修复属产品源（bridge/observeRecoveryCandidate 传递 lost reason），本批不动产品源、只按今日实际合同断言；后续小批修根因保真后同步收紧断言。
- J3-E 整项仍开放：帧时定标（产品决策）、11 域升格剩余、竞态升级评估、上传字段跨口径批保持原登记。

- sequence U→U→D：两次unknown每次恢复必须publish新host、原same-frame HDR≤1e-6、作者channel+WebGL原digest不变；最后destroyed必须零新增恢复attempt、回退WebGL一次、retired通知不复活，所有GPUowner释放0。
- 不在本批发明budget阈值/篡改原rows/把synthetic叫真实driver故障。
- 两fresh独立Chrome进程，记录每epoch identity/reason/attempt/callback、原GPUerrors、真实截图；不测帧时。
- GPU owner主线程独占，两子线只CPU；若生产异常仅最小根因修、所有原失败保留，不用等待掩盖。

## 结果

首跑 `run-2026-10-02T07-15-52-746Z` 失败原证保留：两次unknown已成功恢复，最终destroyed按既有合同调用一次onRuntimeFailure；初派生脚本却要求failures恒空，误将预期terminal通知当“mixed失败”。已按原deviceSession/Studio fatal-once合同细分：unknown failures必须0；destroyed failures必须恰1且明确destroyed，其他/重复/前期错误仍拦，不是忽略所有错误。源1119前后stable。冻结原件核对：原 probe/run SHA 前后一致（base-source-manifest.json），派生件在 ignored test-output 目录，J3_MIXED_PROBE 环境变量选探针。两序列双 fresh 通过后 J3-E 整项仍未闭（帧时定标/11 域升格/竞态评估原登记）。
