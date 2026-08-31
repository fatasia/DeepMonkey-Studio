/** 工业内置视觉模型目录；仅登记可解释的预设，不把外部模型伪装成生产模型。 */
import type { VisionModelPreset } from "@bim-studio/contracts";

const COCO_LABELS = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
  "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
  "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
  "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
  "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed",
  "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven",
  "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"
];

export const PRESETS: VisionModelPreset[] = [
  {
    id: "ssd-mobilenet-v1-coco",
    name: "SSD MobileNet V1 · 人员车辆检测",
    description: "轻量通用目标检测，可作为人员、车辆和现场目标识别基线。",
    category: "general",
    downloadUrl: "https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12/resolve/main/ssd_mobilenet_v1_12.onnx?download=true",
    readyToDownload: true,
    manifest: {
      schemaVersion: 1, name: "SSD MobileNet V1 · COCO", version: "12", task: "detection",
      input: { width: 1200, height: 1200, channels: 3, layout: "NHWC", color: "RGB", resize: "stretch", dataType: "uint8", scale: 1 },
      output: { format: "ssd", coordinates: "normalized", nmsIncluded: true }, labels: COCO_LABELS,
      threshold: 0.55, iouThreshold: 0.45, license: "Apache-2.0", sourceUrl: "https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12"
    }
  },
  {
    id: "mobilenet-v2-imagenet",
    name: "MobileNet V2 · 图片分类验证",
    description: "轻量图片分类预设，用于验证图片上传、ONNX推理和结果回传链路。",
    category: "quality",
    downloadUrl: "https://huggingface.co/onnxmodelzoo/mobilenetv2-12/resolve/main/mobilenetv2-12.onnx?download=true",
    readyToDownload: true,
    manifest: {
      schemaVersion: 1, name: "MobileNet V2 · ImageNet", version: "12", task: "classification",
      input: { width: 224, height: 224, channels: 3, layout: "NCHW", color: "RGB", resize: "center-crop", scale: 1 / 255, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
      output: { format: "classification-logits" }, labels: Array.from({ length: 1000 }, (_, index) => `class-${index}`),
      threshold: 0, license: "Apache-2.0", sourceUrl: "https://huggingface.co/onnxmodelzoo/mobilenetv2-12"
    }
  },
  {
    id: "yolox-nano-coco",
    name: "YOLOX-Nano · COCO 实时检测",
    description: "约 3.5 MB 的官方轻量 YOLO ONNX，适合验证人员、车辆和实时视频检测链路。",
    category: "general",
    downloadUrl: "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx",
    readyToDownload: true,
    manifest: {
      schemaVersion: 1, name: "YOLOX-Nano · COCO", version: "0.1.1rc0", task: "detection",
      input: { width: 416, height: 416, channels: 3, layout: "NCHW", color: "BGR", resize: "letterbox", letterboxPosition: "top-left", padding: [114, 114, 114], scale: 1 },
      output: { format: "yolox", coordinates: "input-pixels", nmsIncluded: false }, labels: COCO_LABELS,
      threshold: 0.4, iouThreshold: 0.45, license: "Apache-2.0", sourceUrl: "https://github.com/Megvii-BaseDetection/YOLOX"
    }
  },
  {
    id: "pyronear-smoke-yolo11s",
    name: "Pyronear · 早期烟雾检测",
    description: "Apache-2.0 的早期野外烟雾 ONNX；适合打通烟雾告警链路，室内工厂必须用现场样本复核或再训练。",
    category: "safety",
    downloadUrl: "https://huggingface.co/pyronear/yolo11s_sensitive-detector/resolve/main/onnx_cpu.tar.gz?download=true",
    readyToDownload: true,
    manifest: {
      schemaVersion: 1, name: "Pyronear Early Smoke", version: "1.0.0", task: "detection",
      input: { width: 1024, height: 1024, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: ["smoke"],
      threshold: 0.2, iouThreshold: 0.1, license: "Apache-2.0", sourceUrl: "https://huggingface.co/pyronear/yolo11s_sensitive-detector"
    }
  },
  {
    id: "yolo-coco-template",
    name: "YOLOv5–v11 · 通用检测模板",
    description: "兼容 YOLOv5/v7 的 5+C、YOLOv8/v10/v11 的 4+C，以及已执行 NMS 的 Nx6 输出。",
    category: "general",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "YOLO Detection", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: COCO_LABELS,
      threshold: 0.5, iouThreshold: 0.45
    }
  },
  {
    id: "ppe-detection-template",
    name: "安全帽与反光衣检测 · 接入模板",
    description: "给算法供应商的PPE模型包模板；上传已训练ONNX后即可创建视频任务。",
    category: "safety",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "PPE Detection", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: ["person", "helmet", "no_helmet", "vest", "no_vest"],
      threshold: 0.6, iouThreshold: 0.45
    }
  },
  {
    id: "quality-ng-template",
    name: "产线OK/NG分类 · 接入模板",
    description: "适用于外部训练的产品合格/不合格分类模型。",
    category: "quality",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Quality OK NG", version: "1.0.0", task: "classification",
      input: { width: 224, height: 224, channels: 3, layout: "NCHW", color: "RGB", resize: "center-crop", scale: 1 / 255 },
      output: { format: "classification-logits" }, labels: ["ok", "ng"], threshold: 0.5
    }
  },
  {
    id: "industrial-defect-template",
    name: "工业表面缺陷检测 · 接入模板",
    description: "适配划伤、凹坑、裂纹、毛刺、脏污、缺件和错件等现场 YOLO ONNX；标签应按真实产线数据修改。",
    category: "quality",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Industrial Surface Defect", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false },
      labels: ["scratch", "dent", "crack", "burr", "contamination", "missing_part", "wrong_part"],
      threshold: 0.45, iouThreshold: 0.4
    }
  },
  {
    id: "industrial-anomaly-template",
    name: "工业异常 OK/NG · 接入模板",
    description: "适配 Anomalib、PaddleX 等导出的二分类 ONNX；用于产品整体异常初筛，定位型热力图需后续专用适配器。",
    category: "quality",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Industrial Anomaly OK NG", version: "1.0.0", task: "classification",
      input: { width: 256, height: 256, channels: 3, layout: "NCHW", color: "RGB", resize: "center-crop", scale: 1 / 255 },
      output: { format: "classification-logits" }, labels: ["normal", "anomaly"], threshold: 0.5
    }
  },
  {
    id: "fire-smoke-template",
    name: "火焰与烟雾检测 · 接入模板",
    description: "适配现场训练的火焰/烟雾 YOLO ONNX；建议结合连续帧、温感或烟感信号降低误报。",
    category: "safety",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Fire Smoke Detection", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: ["fire", "smoke"],
      threshold: 0.5, iouThreshold: 0.4
    }
  },
  {
    id: "smoking-template",
    name: "吸烟行为检测 · 接入模板",
    description: "适配人员、香烟和吸烟状态检测 ONNX；生产使用应增加人员跟踪与连续帧确认。",
    category: "safety",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Smoking Detection", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: ["person", "cigarette", "smoking"],
      threshold: 0.55, iouThreshold: 0.4
    }
  },
  {
    id: "unsafe-behavior-template",
    name: "打架、睡岗与跌倒 · 接入模板",
    description: "行为识别模板；单帧只做候选筛查，可靠告警需要连续帧、人员跟踪或姿态/视频时序模型确认。",
    category: "safety",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Unsafe Human Behavior", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: ["person", "fighting", "sleeping", "falling", "phone_call"],
      threshold: 0.6, iouThreshold: 0.4
    }
  },
  {
    id: "sop-operation-template",
    name: "SOP 工序与操作规范 · 接入模板",
    description: "识别人、手、工具、工件、工装、缺件和错件；平台按检测结果与顺序规则组合成步骤完成、漏步和逆序告警。",
    category: "quality",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "SOP Operation Detection", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false },
      labels: ["operator", "hand", "tool", "workpiece", "fixture", "missing_part", "wrong_part", "unsafe_action"],
      threshold: 0.55, iouThreshold: 0.4
    }
  }
];

