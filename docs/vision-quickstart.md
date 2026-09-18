# 视觉 AI 上手

从安装内置模型到跑通图片质检、实时视频识别和三维联动的最短路径。

1. 从场景管理页进入“视觉中心”。首次验证目标检测可安装 YOLOX-Nano 或 SSD MobileNet；图片分类链路可安装 MobileNet V2；烟雾告警链路可安装 Pyronear，但室内工厂场景仍须使用现场数据验证。
2. 自有 YOLO 模型在训练环境导出 ONNX，例如 Ultralytics CLI 使用 `yolo export model=best.pt format=onnx imgsz=640 dynamic=False`。从“YOLOv5–v11 通用检测模板”下载清单并把 `labels` 改成训练时的准确类别顺序。
3. 上传 `model.onnx` 与 `manifest.json`。服务端会真实加载模型并检查输入节点，不通过的模型不会进入可选任务列表。
4. 创建任务时选择推理设备：“自动（GPU 优先）”会先尝试 Windows DirectML，初始化或运行失败时自动回退 CPU；也可以强制选择“GPU · DirectML”或“CPU”。单显卡设备编号保持 `0`，多显卡按系统枚举顺序填写。任务卡会显示实际运行设备、单次推理耗时和实际 FPS。
5. 图片质检：创建“图片识别”任务，在任务页上传 JPG/PNG/WebP/BMP/TIFF，查看框选、类别、置信度与耗时。
6. 实时识别：先添加视频源，再创建“实时视频”任务，设置推理 FPS、置信度、告警类别和冷却时间。RTSP/RTMP/SRT 可由实时视频服务转为浏览器可播放地址，推理 Worker 直接抽帧。
7. 三维联动：任务中选择场景并填写模型 ID；内部图层使用 `模型ID/图层ID`。新告警会在已打开的 Studio/浏览页中高亮并定位目标。

## 模型与运行环境约定

平台运行 ONNX，不直接运行训练检查点 `.pt`。模型清单中的输入尺寸、RGB/BGR、归一化、类别顺序和输出格式必须与导出模型一致。Windows GPU 推理使用 ONNX Runtime DirectML，可兼容主流 DirectX 12 显卡；DirectML 会话按任务串行执行，防止同一会话并发造成不稳定。
