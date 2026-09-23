# 测试样本档案

工作区约束要求入库样本记录来源、哈希、授权/使用边界、格式版本与预期内容。

## audio-track-sample.mp4

- **来源**:本地 ffmpeg 8.0(essentials_build-www.gyan.dev)lavfi 合成,非第三方素材:
  `color=c=black:s=64x64:r=10:d=1` + `sine=frequency=440:duration=1:sample_rate=44100`,
  `-c:v libx264 -pix_fmt yuv420p -profile:v baseline -c:a aac -b:a 32k -shortest -movflags +faststart`。
- **SHA-256**: `81afc6e84e23536c6b1056f84051a8fa3fb4eafbb4280c0c89ef7eea1e43dc9f`
- **字节数**: 6,668
- **授权/使用边界**:自产合成样本,无第三方版权;仅用于仓库内自动化测试,不代表真实业务媒体。
- **格式版本**:ISO BMFF(ftyp isom,faststart);视频 H.264 Baseline 64x64@10fps;
  音频 AAC-LC 44,100 Hz 单声道。
- **预期内容**:1 秒黑色 64x64 视频流 + 1 秒 440 Hz 正弦音轨。
  用途:Dashboard 视频解码器的音频轨道探测管道验证(音轨存在性与采样率读取);
  对照样本 `apps/web/public/showcase/line-loop.mp4` 为无音轨 H.264。
