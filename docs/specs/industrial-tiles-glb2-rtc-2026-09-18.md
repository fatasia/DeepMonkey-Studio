# Tiles 旧 GLB 转换与地理定位验证

本片用于补旧瓦片无法由当前 GLB 读取器加载的问题；尚未接入正式格式导入。

## 已完成

- 固定隔离候选 `gltf-pipeline@4.3.1`，Apache-2.0；npm gitHead `f6c8d94022c8c21f3b837d990421122b4c27f3bb`。54 个依赖安装后完成 `npm ci --offline --ignore-scripts`，产品依赖未变。
- 既有来源/哈希清单中的 5 个真实 b3dm 先经过严格容器预检，再转换 GLB 1→2。每个产物两次转换 SHA 一致。
- 每瓦片 240 顶点、120 三角；所有顶点属性及索引逐项一致。没有用计数相等代替数据一致。
- 发现 `CESIUM_RTC` 必需扩展被当前 NodeIO 拒绝。转为标准父节点平移后 5 个产物均可读取；不把大坐标写入 Float32 顶点。逐顶点应用原节点变换、Y/Z 轴转换和 RTC 后，与转换输出比较，5 个样本最大位置差均为 0。
- 保留原 Batch Table 为既有 `properties.json` 结构：每瓦片 10 个 feature，源哈希与 batch 索引组成身份，业务 `id` 原值保留，不混为元素身份。5 份输出共 50 条记录均能由 `_BATCHID` 引用回查；经纬度和高度不丢失。二进制属性/扩展未解码时明确拒绝，不静默舍弃。证据 `test-output/industrial-tiles-glb2-features-20260918/evidence.json`；另有 2 项属性/引用负例测试通过。

## 复跑与证据

```powershell
node --test scripts/lib/industrialB3dmPreflight.test.mjs scripts/lib/industrialTilesRtc.test.mjs
node scripts/fixtures/qualify-industrial-tiles-glb2.mjs test-output/industrial-tiles-glb2-rtc-offline-20260918
```

产物及 SHA：`test-output/industrial-tiles-glb2-rtc-offline-20260918/evidence.json`。容器预检 15 项，RTC 轴向/共享根/失败不修改输入 4 项通过。

轴向语义对照 [Cesium 固定提交的 GltfUtilities](https://github.com/CesiumGS/3d-tiles-tools/blob/4ca692eb16a9c7db21ec99e2aacc32645ce92f28/src/tools/contentProcessing/GltfUtilities.ts)；RTC 原理见 [Khronos CESIUM_RTC](https://github.com/KhronosGroup/glTF/tree/main/extensions/1.0/Vendor/CESIUM_RTC)。没有新增渲染内核。

## 本轮待办

Tileset transform/CRS、feature 元数据、材质外观、层级加载/驻留及 Web/Native 正式交付仍待验收。当前输出不能直接宣称完整 Tiles 支持。

候选依赖逐文件清单已生成到 `test-output/industrial-gltf-pipeline-licenses-20260918/evidence.json`；初审发现 wasm-splats、bitmap-sdf、draco3d、lerc、mersenne-twister 分发包缺独立 notice 文件，需核对上游授权文本及包内头注释后补齐。此状态不代表这些包无授权，也不计许可闭包完成。
