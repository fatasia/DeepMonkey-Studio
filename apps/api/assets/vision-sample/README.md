# 本地视觉推理样例

随产品打包的 YOLOX-Nano 官方 ONNX 和官方演示图片。运行不下载资源，不访问其它项目、摄像头或业务服务。正式图片预处理、YOLOX 输出解析、NMS 与坐标还原均复用平台视觉内核。

- 权重：[YOLOX 0.1.1rc0 release](https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx)，3,659,407 bytes。
- 图片：[YOLOX assets/dog.jpg](https://github.com/Megvii-BaseDetection/YOLOX/blob/main/assets/dog.jpg)，163,759 bytes。
- 来源：[Megvii-BaseDetection/YOLOX](https://github.com/Megvii-BaseDetection/YOLOX)，Apache-2.0，完整许可见 `LICENSE-YOLOX`。
- SHA-256 权重：`c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d`。
- SHA-256 图片：`5a9522051c3cec2bbd2f6323fccba32e8fbf3ddcc2b3e2fd46b04c720bc6f866`。

这是通用检测链路样例，识别结果由 ONNX Runtime 每次实时计算。它不代表工业缺陷、PPE 或安全事件的现场准确率。部署包需要保留 `apps/api/assets/vision-sample`（与 `src`/`dist` 同级）。
