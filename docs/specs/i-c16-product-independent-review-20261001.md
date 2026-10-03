# I-C16 产品独立验收

## 现状核查

1. 读取正式dialog/CSS、sourceKey接线、未跟踪微片与真实3qmg9O截图；已有物理预览/取消/失效/下载，不重复实现。
2. 读取Props、Worker消息与正式snapshot/RenderPacket/camera合同，CSS修复不变更类型或图像输出。
3. 读取既有Web/SDK依赖与实际build/typecheck回执，局部样式无新增依赖。
4. 真菜单从MoreMenu/ExportMenu进入正式dialog，实际Worker消费已加载bundle；窄屏全局platform-components.css:229把ghost压到34px，与新footer冲突。
5. 独立看实际1920预览/失效、480待机截图；真实9测/5effects、SDK122及实际Worker/取消/preview/材质makeSnapshot均已有，首轮最终fixture写入409保留。
6. 读取锁定I-C16静帧产品行、作者规格与digitaltwin闭环；T10全包另计，不把发光对照推为默认studio最终画质。

已有（不重建）：真实物理输出、菜单/积累/取消/失效和预览门。真实缺口：窄屏footer按钮竖排，以及两fresh最终HDR/视觉收口。最小CSS限定本dialog footer按钮宽度、padding、nowrap和flex-shrink，窄屏分组换行；沿既有令牌，不修改全局ghost规则。单源before/after SHA由root核对后提升，重建Web再从头两fresh。3qmg9O实际材质失效/preview结果保留为先前批次。

产品正式camera为[0,0,3]→[0,0,0]、50°。实际preview主体上移根因为applyModelState遗漏authorModelTransforms同步，已单行正式修复；读取/输入/快照克隆、primitive及普通model、重复恢复/missing-id七测通过。两fresh保存均精确恢复作者位置/旋转/非均匀尺度，未移动fixture或camera掩盖问题。

## 独立验收（18:07）

真实隔离生产浏览器`test-output/runs/2026-09-05/i16-author-physical-jwDRdw/report.json`两轮均通过，每轮4个真实Worker全部关闭，283个实际HTTP资源body验SHA，无页面/资源错误。root逐一重新核对3085个源与构建文件、两轮sourceBefore/After同值及canonical摘要；独立收据`test-output/jc-i-20261001-i16-product-source-verified.json`，报告SHA为`243a65f1cecc4987a97e9bb02dc6e84cd2de8c890aaaafe055acdce6e7b2bdfb`。

root另写不调用生产decoder的RGBE读回，重新读取全部实际preview/final下载。两轮studio160×90/256spp噪声`.5588000545805288`只允许preview；真实非空独立发光作者场景64spp噪声`2.9989271991673465e-6`通过原2%门，final HDR两轮SHA全等，独立sRGB解码×2全像素最大误差`.0020335002277985237`在原RGBE量化门内。较小默认studio2×2真实CPU在30901spp通过相同2%门；产品长预算32768/65536已接线。未将发光面最终出口测试当成全分辨率studio收敛。

人工查看两轮1920待机、积累、取消、preview、失效和final及480按钮；布局主次明确，真实椭球完整入镜，取消/编辑清空和禁用导出符合状态。1280/480 client=scroll，底部无覆盖/竖排。按既有Unity/Siemens设计读、令牌与同族核查，十维两轮9.0–9.2，详见`test-output/i-c16-author-product-20261001/visual-review-20261001.md`。分数覆盖本次支持域和产品呈现，噪声preview没有获最终照片画质认证。

锁定行“累积/材质变更失效/取消/导出及收敛对照”已在正式菜单、实际Worker和作者snapshot消费验证，SDK122测、Apps9测、真实React effect5测及恢复7测、类型检查/构建通过，批准关闭I-C16产品行。纹理/单面/alpha/扩展层/HDR环境/局部IES明确拒绝，T10硬件RT/refit/降噪/MIS另计；最新J5统一集成门仍需本批重跑。
