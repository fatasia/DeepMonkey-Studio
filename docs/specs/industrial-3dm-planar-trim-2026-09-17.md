# 3DM 无缓存平面裁剪离散

日期：2026-09-17。已完成受限几何切片；状态仍为研究 `geometry-preview`。

既有 CAD IR 现在可以离散具有直线 outer/inner trim 的仿射平面，并进入原 3DM GLB 预览路径。
离散器读取原 trim 的 proxy subdomain 与反向标志、面反向标志，按原曲面求值得到顶点；
复用已安装 Three.js r185 的 `ShapeUtils.triangulateShape`，没有增加依赖。
保存网格优先，每个缺失面单独尝试；复杂曲面、曲线 trim、开环、相交/嵌套孔洞、
非仿射双线性面和超预算输入保持明确面级诊断。

当前合同只接受非有理、参数一致、2×2 控制点的一次仿射面，以及两控制点一次 trim。
参数化 2 的映射虽已实现，曲面离散仍未接入。最多 128 环/2048 顶点；
执行环相交、孔洞包含、三角形中心和边穿越、UV 面积守恒验证后才输出。
GLB primitive 标记 `cad-ir-affine-plane-trim`、源对象 UUID、源 face index 和离散审计。
法线由真实曲面方向和 face reversed 得到；曲面参数没有冒充纹理 UV。

## 真实文件结果

固定 rhino3dm v8.32 `file3dm_stuff.3dm`，源 SHA-256：
`e78ca005c86130953a5b4c0c44d068ae1d00665f4c0f6028edd3911a01d4ff88`。
来源与使用边界沿用[CAD IR 记录](industrial-3dm-cad-ir-2026-09-17.md)。

- 12 个无缓存面生成 48 顶点、24 三角；加上原保存网格后为 5 meshes / 13 primitives / 52 vertices / 26 triangles。
- 三维三角面积与源平面 Jacobian × trim 面积独立核验；支撑面最大残差 `1.7763568394002505e-15` 源单位。
- 生成 GLB 25,940 bytes，SHA-256 `625052139bbc743a030186c9217ce7918ae43ea5f0acd71b4b07756745d888b5`；13 面均有真实几何，但不代表文件内其它未知对象得到支持。
- blocks 球面仍为 `inspect-no-geometry`；sphereDecals 继续使用文件保存网格。

`test-output/3dm-source-audit/planar-trim-evidence.json` SHA-256：
`d877183dd4d2a4dc10001d422e1e004b51b75fa53cf9c02586ed9e5d29d35995`。
真实样本没有 inner loop；孔洞实现只由合成边界证明（100−16=84），尚需独立真实带孔语料。

## 验证

```powershell
pnpm exec tsx --test scripts/fixtures/3dm-planar-trim.test.mts scripts/fixtures/3dm-glb-export.test.mts
pnpm exec tsx scripts/fixtures/audit-3dm-glb.mts
pnpm exec tsc --noEmit --allowImportingTsExtensions --allowJs --skipLibCheck --esModuleInterop --target es2022 --module nodenext --moduleResolution nodenext --typeRoots apps/api/node_modules/@types scripts/fixtures/3dm-planar-trim.mts scripts/fixtures/3dm-planar-trim.test.mts scripts/fixtures/audit-3dm-glb.mts
pnpm gate:repository
```

11/11 聚焦测试、五件真实 GLB 审计、专项类型检查、repository gate 和本片 diff-check 通过。
测试验证源面身份、法线/绕序、孔洞内部采样、面积、支撑面残差和拒绝路径；
真实 GLB 的位置、索引、法线和源 UV 逐元素核验。

本片没有产品 UI/渲染器变更，未执行浏览器两轮视觉验收，也不计入视觉完成。
后续按 design-taste-digitaltwin，以西门子式源几何严谨性和中性材质对拍，补真实带孔/凹边界、
复杂曲面弦差/法线/接缝、闭合性及 Deep Engine 两端产品接线。
