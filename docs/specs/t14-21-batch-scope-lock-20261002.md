# T14/T15/T16/T19/T20/T21 尾项批量核查(2026-10-02,主线程)

> 六行各 1-2h"核查与范围锁定"的批量收口;每行结论均有源码级 grep 实证,此前批次实现不重验。

## T14(根运动/播放链)——已覆盖,关闭

`renderAnimationRootMotion`(gltf 域,src+dist 双证)+0927"事件/平移根运动已有"+0928 收官"T14 97.3ms 如实未达标(性能边界如实)";Native/WASM 统一播放链=Play 域(T30 已核)。无新增实现包。

## T15(IK)——已覆盖,关闭

`workcell-validation-plugin/kinematics.ts`+T15 IK 52 测数学层已验(0927,不可重做);T15 残差 9.06e-8m(0928)。大库姿态索引/过渡混合登记弱余项(随真实需求触发)。

## T16(角色)——已覆盖,关闭

viewerEngineContract/Runtime 角色消费+T16 角色四驱动位级相等(0928 收官确认)+镜头贴墙实测完成(用户拍板)。离线 morph/滑坡登记弱余项。

## T19(导航)——关闭,带一个登记余项

AGV/SimulationEngine/多机互锁/线平衡 RPW 已有(0927);**navmesh/动态障碍/坡度步高专项未见生产实现**(assetCompatibility 命中为资产兼容非导航)→登记余项 2-4h(工厂 AGV 需求出现时触发)。

## T20(粒子)——已覆盖,关闭

particles 域完整(flowFieldNoise/flowFieldParticleCpu/particleBudget/Curves/Events/Stats/smokeDiffusion)+I-C17 流场粒子行已关闭(生产 SDK 两 fresh);透明排序/曲线 LUT 已在域内。有边界烟体求解登记弱余项。

## T21(2D/UIA)——已覆盖,关闭

deep2d 域(deep2dDisplayList/ValidationPrimitives/DisplayListText)+10 万行/IME/文本矩阵已有(0925);2D 骨骼/移动触控/动作映射登记弱余项(移动端需求触发)。

## 结论

六行**全部关闭**:5 行确认为既有生产实现覆盖(此前批次);T19 navmesh 一项 2-4h 条件触发余项。**T 核查/范围锁定行累计 22 个**(T00/T08/T09/T12/T14/T15/T16/T17/T19/T20/T21/T23/T24/T27/T28/T29/T30/T31/T32/N5+软体/风场两蓝图)。
