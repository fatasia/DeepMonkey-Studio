# Deep2D P2-02：ZRender 批次→X 显示包

状态：作者端显示桥切片已完成；隔离动态适配器与 P2-02 整卡仍为本轮待办。

`ZRenderXDisplayBridge` 消费已有 ECharts/ZRender 6.1.0 实验的真实 rect delta，重建完整快照后校验 `outputHash`，再经既有 Deep2D 验证器和 X v6 构建器冻结显示包。未引入第二个图表布局器，未把 ECharts 放入 N0。

## 合同

- 同一 chartId 的连续 epoch；拒绝跳帧、重复帧、依赖版本漂移、重复命令、未知删除、超预算和错误完整快照 hash。
- 最多 256 bars / 512 commands；批次携带作者布局宽高。真实 ECharts 的负柱高直接保留端点，不取绝对值或反转基线。
- 相同 bar 保留稳定 path/paint identity，删除后无幽灵图元。全部包校验成功才推进已接收 delta 状态；失败可用原正确批次重试。
- 接收时复制 rect/颜色，调用者随后修改对象不影响已接收快照。更新无须重新建立 ECharts 实例。

## 验证

- Web 聚焦：既有 Painter 10 项 + 显示桥 11 项，21/21；Web typecheck 通过。
- `bun scripts/verify-zrender-x-native.mts`：真实同一 ECharts 实例生成初帧、单柱变化、三柱缩为两柱；命令数依次 3/1/3。
- 三包经 Native v6 校验→LPAC→回执，完整显示列表与作者输出逐项相等，原生三角数分别 6/6/4。各包独立窗口 GPU 呈现成功、error scopes/callbacks clean，均接收后续 3 ticks。
- 完整快照 hash：初帧 `bd879f1bb9133d78390306ed560df653b7af6dc4a7b7b46ed46d2ead76111011`；单柱更新 `4f4f9314b9a0b24e8cf0ae64e452ef609c09f4c2c01041dbab28d974d64f0eeb`；删柱 `bd1537df0d31e8afde087fc2a7c6d096eae8fdae84576201f077dfeb9d104787`。
- 运行产物在 gitignored `test-output/zrender-x-native/`；不提交生成包、可执行文件与日志。先构建 native debug player 和静态 CRT `x_compat_worker` 再运行审计脚本。

## 未覆盖

ECharts 仍在作者端计算，不在 LPAC 内执行；三个包是独立窗口启动，不是同一窗口实时替换或隔离 JS 动画。formatter、图片、tooltip、非 rect Painter 与动画仍保持原认证限制。

本片没有产品 UI/颜色改动，画布映射沿用 Deep2D/FVS 等比语义。真实窗口截图双轮、像素级逐帧差异和 Kimi-95 完整验收尚未完成；GPU 提交成功不代替这些证据。
