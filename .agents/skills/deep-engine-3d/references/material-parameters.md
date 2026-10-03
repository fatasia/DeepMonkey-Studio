# PBR 材质参数速查（PbrMaterial）

颜色一律**线性空间** `[r,g,b]`(0..1);sRGB 设计稿色需先转线性。`emissiveFactor` 同为线性,实际发光 = emissiveFactor × emissiveStrength。

## 字段与范围

| 字段 | 类型/范围 | 说明 |
|---|---|---|
| baseColor | [r,g,b] 线性 | OPAQUE 主色;BLEND 时配合 baseColorAlpha |
| metallic / roughness | 0..1 | 金属度/粗糙度;roughness 低 + bloom 会泛光,标线类避免 <0.4 |
| emissiveFactor | [r,g,b] | 自发光颜色 |
| emissiveStrength | 0..256 | 自发光增益;告警呼吸常用 1..6,屏幕/灯带 2..4 |
| shadingModel | "unlit" | 缺省 PBR;unlit 直出 baseColor,做屏幕/HMI 面板 |
| alphaMode | OPAQUE/MASK/BLEND | BLEND 需 doubleSided 且走 weighted OIT;MASK 用 alphaCutoff(默认 0.5) |
| baseColorAlpha | 0..1 | BLEND 覆盖率;0 完全不可见(合法) |
| fog | boolean | 缺省受场景雾影响;false 关闭该材质雾 |

## 模板工业语义色板（线性，实测截图校准）

| 语义 | baseColor | emissiveFactor | emissiveStrength |
|---|---|---|---|
| 设备蓝(机体) | [0.22, 0.36, 0.58] | — | — |
| 深色机座/关节 | [0.14, 0.16, 0.19] | — | — |
| 钢结构(件) | [0.50, 0.53, 0.57] metallic .85 rough .32 | — | — |
| 安全黄(标线/围栏) | [0.85, 0.62, 0.05] | [0.7, 0.5, 0.03] | 0.7–1.1 |
| 状态-正常绿 | [0.08, 0.62, 0.28] | [0.06, 0.85, 0.3] | 2 |
| 状态-预警琥珀 | [0.85, 0.55, 0.06] | [0.9, 0.5, 0.03] | 2 |
| 状态-告警红 | [0.78, 0.10, 0.08] | [0.9, 0.07, 0.05] | 2–5(呼吸调制) |
| 选中高亮 | 主题色 | 同色 ×0.9 | 2–3 |
| 屏幕面板 | [0.05, 0.24, 0.46] unlit | — | — |
| 玻璃/观察窗 | [0.42, 0.62, 0.82] BLEND alpha .34 doubleSided | — | — |
| 混凝土地面 | [0.19, 0.21, 0.24] rough .85 | — | — |

## 氛围（RenderView,禁纯黑裸背景）

- `background`(远处):[0.011..0.014, 0.02..0.026, 0.038..0.048] 深藏青
- `floor`(近地渐变):[0.04..0.05, 0.05..0.06, 0.07..0.09]
- `exposure` 1.0–1.2;过大导致地面发灰白(已在 r1 视觉闭环校准)

## 呼吸/脉冲动画模式

`update(elapsedMs)` 返回替换 emissiveStrength 的新材质数组(静态材质复用原对象引用,动态件新建对象):

```ts
const pulse = 3 + Math.sin((elapsedMs % 1600) / 1600 * Math.PI * 2) * 1.8;
return { materials: materials.map(m => m.id === "status-alarm" ? { ...m, emissiveStrength: pulse } : m),
         instances };
```
