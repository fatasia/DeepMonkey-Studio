# J3 exact CSM 深度参数与缓存修复

## 现状核查

1. 已检索 packages/apps 的 exactProfile、depthPadding、maxShadowDistance 和 git 未跟踪项，读取正式 CascadedShadowResources 与候选逐行差异。现有纹理、资源所有权和矩阵上传已完成，不重建。
2. 已读 shadows/types.ts 与 planner：CascadedShadowOptions 已定义两项参数；资源 exactProfile 未声明/消费它们。原缓存签名遗漏有效 depthPadding。
3. package.json 固定 Three 0.185.1、@webgpu/types 0.1.72，已有 Vitest；不增加依赖。
4. PbrShadowState 快照并转发 exactProfile；正式 PbrRenderer 与完整工业探针消费同一资源类。默认 profile 保留 extent 派生方式，作者单层矩阵保持原路径。
5. 现有资源/ShadowState 测试和实际工业156-float uniform 已读；旧 class 上传与实际 GPU 字节逐值相同，extent8 实际 padding1.6，声明10未消费。冻结 far40 时 extent8→12 还错误缓存旧矩阵。新增测试验证完整 ABI 上传、有效签名、快照、相机 far 与负例。
6. 已读权威剩余行、完整工业独立关闭复核、续接/交接和候选 PROMOTION。六处可观测 shadow gap 仍保留，CPU 修复不推断 GPU 成功。

已有（不重建）：CSM planner、数组深度资源、原 ABI、作者矩阵、提交后缓存与资源回收。真实缺口：exactProfile 两项参数透传及有效 padding 的缓存身份。

两叶按声明 SHA 提升，正式聚焦测试/typecheck/build 后再执行两端两fresh完整工业场景。原默认效果与精确 profile 不含新字段时的矩阵不变；extent 改变有效 padding 时重新计算并上传，已提交相同矩阵才缓存。原715点、失败附件和门限保持，零控制点的可观测性独立说明。

正式资源/ShadowState 聚焦31测、engine源码/lab/examples完整typecheck及SDK build通过。提升收据`test-output/jc-i-20261001-csm-promotion.json`记录两个文件前后SHA。root逐行审核bounded runner的8叶、独立SHA复核及流式附件4个正负例后启动两宿主两fresh完整工业GPU，日志`jc-i-20261001-j3-fullscene-csm-final.log`；结果未出前不记全绿。该生产源改变后，081816统一J5与D9为前一冻结批次结果，后续最终批次须重新核对。

## 完整工业实跑

`test-output/j3-d-fullscene-bounded-20261001/run-2026-10-01T08-41-10-043Z/evidence.json`保存真实32帧，currentRun=true、gpuExecuted=true、stable=true；所有原始完整域附件保持，生产/观察源前后守卫通过。原strict比较仍false；六处可观测阴影区间不交降为四处，不称全部修复。south162078的gap为0.00002052255；north143736/152970/165210为0.03792240058/0.00084739737/0.00097184982，两round两fresh一致。三个背光零控制点仍按原oracle报错保留，后继独立定义纯直射零输出合同。south细构件覆盖与跨端全图MSAA显示差异的原失败保留；不扩大边界或降低门限。
