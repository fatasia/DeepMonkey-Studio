# 浏览器图片解码边界

`@bim-studio/deep-engine/browser-image-decoder` 导出 `createBrowserImageDecoder(host)`，由浏览器宿主提供 `decode` 与 `readPixels`。引擎核心负责取消检查、字节所有权和 bitmap 释放，核心不调用 OffscreenCanvas 或 createImageBitmap。

Lab 沿用本地 `browserImageDecoder` 入口，模型加载调用方无需改动。Web 的发布适配器复用同一工厂，其完整发布链按独立切片管理。

已完成验证：接手 HEAD 独立导出仅叠加工厂、Lab 适配器、两份测试与包子路径导出，9 项测试及核心/Lab 类型检查通过。用例覆盖取消、失败释放、像素复制及浏览器解码选项。当前工作树完整 Deep Engine 测试 2827 通过/41 跳过，Node 26 通过，纯净性门禁通过。

真实浏览器像素与资源清理尚未验证；本批不代表跨端视觉验收完成。独立导出证据在本机 `test-output/decoder-head-audit/`，不提交日志。
