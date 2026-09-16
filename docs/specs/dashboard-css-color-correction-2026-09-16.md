# Dashboard 作者颜色修正

修复 CSS sRGB 颜色被直接当作线性 RGB 送入 Native 路径着色器的问题。真实 sRGB GPU 目标上，作者蓝色 `[54,139,214]` 原先输出 `[127,195,236]`，画面明显变亮。

CSS 解析继续返回原 sRGB 通道，供文字像素 producer 使用；形状、边框、容器和测量背景在路径入口显式转为线性 RGB，straight alpha 不变。没有更改 GPU 着色器或旧文字系统字体接口。同步内容编译 pass 更新为 4，两份 golden 通过正式 producer 脚本重生，作者源文档未变。

新增 GPU 回归读取真实 producer golden，以独立写定的三个作者 CSS 颜色核对最终 sRGB 像素，允许每通道 1 级量化误差；修复前失败、修复后通过。Native 内容 golden 两项、相关 TS 69 项、严格 Clippy 通过。producer 包截图探针现在使用 sRGB 目标，读回元数据也明确标注 `rgba8unorm-srgb`；历史线性目标的字节读回不作为最终显示颜色证据。

本项验证不透明形状色值及生产者转换，不替代半透明混合、浏览器字体亚像素和整页视觉验收。
