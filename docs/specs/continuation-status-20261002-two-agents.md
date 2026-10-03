# 2026-10-02 继续批进度（主线程＋两路）

## 用户体验与执行约束

保持原有简洁页面，不增加面板/按钮堆砌/内部参数必填步骤。主线程＋最多两路后台智能体；GPU按owner串行。禁止commit/push/reset/clean/stash，保护behaviorGraphDraft与全部用户资产；源尺寸拆分最后。

## 整项计数

按61个唯一ID去重：**32/61=52.5%**登记范围完成，29行开放。该数不是全部32项当前fresh，也不以测试条数换进度。

已纠正旧计数：T24不在61执行表，不能作为一行增加；ENG-runtime-purity原已关闭但基数17漏计，当前实际门通过；K8与D2既有交付独立核对后计一次。机器依据 `test-output/progress-audit-20261002/61-row-status.json`，完整口径 `docs/specs/progress-61-row-reconciliation-20261002.md`。

## 主线程已实测的推进

- **OPC UA模式保真**：修正显式加密错误退仅签名、预览漏透传、非法模式删键降级，证书manager释放；API73/73、Web11/11、两个完整类型门。实际IAB表单保存→刷新→重开加密保持；非法配置明确拒绝→修正→保存恢复。远端CA/CRL产品信任未接、完整UI键盘/480未测，T24不宣全链完成。
- **F6软体障碍核**：修params字段错序、约束后再接触、黄金checkpoint错时相、tet负体积/正目标不同物理问题、CPU障碍未传的假测试；199物理passed+3既有skip、三types0，NVIDIA双fresh七原门全true。后续注释导致三源SHA变化记录为measured batch，非数学变化；不把旧receipt说当前完整fresh。Native/GPU互碰/产品session仍后继，F6整项不闭。
- **J/C/I四红**：分层+变形shader函数限定替换/真实metalTangent、变形fail-fast顺序、能力manifest漏feature、旧强度锚点；42owned/68neighbor+Naga实际组合、22三方manifest、完整广域2948/2948（随后第一路新增两测试2950/2950）与5types0。原CPU失败记录保留。组合GPUdraw尚未本批单独跑，不认证C8原HDR门。
- **B1命令源码子集**：复用现contracts.customShader；SDKbounded32KiB/安全getter检查/permission/scenemismatch，Viewer编译/lock预检；SDK123/123、Web73/73+真实Viewer源码readback2/2、types0。只是作者保存，不冒充即时clearcoat画面。
- **B5失败原子性**：lighting/weather第一条生效第二条失败时旧收据回滚实际却残留，红3/3；补已有逆栈快照与scope守卫，266/266studio+behavior与types0。零UI改动。
- **P3引用清理家族**：未知kind夹target字段绕拒绝、timeline-only事件悬空、共享clip事件误删三反例红3/3；修既有registry，实际本次命中的正式108/108与types0，其他主作者/Native后继不冒称。

## 两路子智能体

1. **F5真实距离统计消费**：不加UI，内部同代moments纹理捕获/发布/消费；2950CPU及Naga、1187实际源SHA双fresh稳定，16点moment改变响应从0变3.85705，GPUtexture/CPU差4.88e-5。原sealed比值退化、完整oracle2贴边点失败、动态恢复/Native/帧时保持开放；当前沿原完整域CPU查边界射线，未删点放门。
2. **P4迁移与B1后台profile**：已补A4/A5/B2/C2四题、245去重CPU、严格颜色双fresh42×2；连续undo幻影+author颜色被重复分级根因已修，原UI快捷键不变。P4共17登记done/1partial/2blocked（含CPU/合同范围，非GPU全认证）。B1新增显式v3 CPUprofile/160Bstream及沿原CSM实际包draw双fresh成功；Studio即时包consumer与Native默认v2限制仍在，B1仍partial。

## 尚未关闭的29个执行行

- J/C：J3-E-GPU；C8-S3 / I-C8。
- F：F5/G3/T02；F6/T18-collision。
- Harness：H-C6-S1；H-C6-S3-inventory；H-C6-S3-connect；H-autonomy；H-C5-K9；H-C5-K10/K11；H-C5-K13；H-C5-K15/K16；H-C5-K17；H-C5-K18；H-C5-T1/T4；H-C5-T5；H-C5-T7。
- 作者/格式：N5-material-import；H-C7-P1；H-C7-P2；H-C7-P3/C24；H-C7-P4。
- 最后验收：B2/T11；E1；E2/Z4；E3/T23-time；Z2/Z3/Z3.5；Z5。
- 工程债最后：ENG-source-size。

本报告是持续执行的进度收据，不是收官。真实失败、未验证边界与后续最小可执行刀均保留在各spec；不以汇报代替开发。
