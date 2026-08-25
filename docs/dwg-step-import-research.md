# DWG 与 STEP 导入实现说明

更新时间：2026-08-04。当前项目已经接入开源 STEP 和 DWG 基础导入链路；这里区分“已经实现”和“格式自身的兼容边界”。

## 已实现流水线

```text
STEP / STP
  -> API 转换队列
  -> occt-import-js / Open CASCADE WASM（三角化，统一为米）
  -> geometry.glb + hierarchy.json + properties.json + manifest.json
  -> Three.js Viewer

DWG
  -> API 转换队列
  -> GNU LibreDWG dwg2dxf
  -> model.dxf + manifest.json
  -> 现有 dxf-parser / Three.js 二维查看器
```

前端上传框和后端格式白名单均已加入 `.step`、`.stp`、`.dwg`。STEP 不依赖本地 CAD 软件；DWG 在 Windows 首次使用前执行 `pnpm dwg:install`，API 随后自动识别 `tools/libredwg/dwg2dxf.exe`。

## STEP 能力与边界

- 已保存装配树、零件节点、名称、主体颜色、顶点数、三角面数和统一单位；内部节点可在现有目录树中选择、显隐、锁定、移动、旋转、缩放和删除。
- 输出是用于浏览与场景编辑的三角网格，不是可继续修改孔径、圆角、拉伸参数的 STEP B-Rep 编辑器。
- 当前使用 `occt-import-js` 公开的层级与网格结果。后续若需要 GD&T、PMI、Saved Views、精细材料或更多 XDE 属性，应增加原生 OCCT/XDE Worker。
- 三角化参数固定写入转换器：单位为米、线性偏差为包围盒比例 `0.001`、角度偏差 `0.5`，保证同一版本下结果可复现。

## DWG 能力与边界

- 当前定位是基础 CAD 浏览：LibreDWG 保留并转换常见 DWG 图层和实体，现有查看器主要显示 LINE、LWPOLYLINE、ARC、CIRCLE 等可转为线段的实体。
- 本地 `商业 BIM 平台示例图纸.dwg` 已验证能转换为约 10.9 MB DXF；`dxf-parser` 读到 6,889 个实体、44 个图层，包含 LINE、LWPOLYLINE、ARC、CIRCLE、TEXT、MTEXT、INSERT、DIMENSION 等类型。当前基础渲染器在模型空间中生成 5,951 个可管理对象和 32 个非空图层。
- 加载器读取 `$INSUNITS` 并换算为米，使用 `$EXTMIN/$EXTMAX` 选择模型空间，自动保存原始中心并将显示几何归中；这避免绝对测绘坐标和纸空间图框把相机推到数千万坐标。
- 当前查看器不会完整还原 INSERT 块、DIMENSION 标注、HATCH 填充、复杂文字字体、动态块、布局视口以及 AEC/Civil 代理对象。LibreDWG 对部分高级 R2010+ 对象也会输出警告或跳过。
- 因此页面应表述为“DWG 基础导入”，不能宣传与 AutoCAD/商业 BIM 平台 相同的高保真 DWG 能力。高保真需求仍应切换到 Autodesk RealDWG、ODA Drawings SDK 或 Autodesk APS。

## 许可证

| 组件 | 许可证 | 当前隔离方式 |
| --- | --- | --- |
| `occt-import-js` / Open CASCADE WASM | LGPL-2.1 | npm 依赖，作为可替换 STEP 导入边界 |
| GNU LibreDWG `dwg2dxf` | GPL-3.0-or-later | 独立外部进程，不链接进 Web/API bundle |
| `dxf-parser` | MIT | Web 端解析转换后的 DXF |

公司内部运行不构成对外分发。若以后把包含 LibreDWG 的安装包交付给客户，需要随包保留 GPL 许可证、提供对应源码并复核整体分发义务；也可以让客户单独安装转换器，或换成商业 DWG SDK。

## 参考

- [occt-import-js](https://github.com/kovacsv/occt-import-js)
- [Open CASCADE STEP translator](https://dev.opencascade.org/doc/overview/html/occt_user_guides__step.html)
- [GNU LibreDWG](https://www.gnu.org/software/libredwg/)
- [GNU LibreDWG Programs](https://www.gnu.org/software/libredwg/manual/html_node/Programs.html)
- [Autodesk RealDWG](https://forge.autodesk.com/developer/overview/realdwg-api)
- [ODA Drawings SDK](https://www.opendesign.com/products/drawings)
