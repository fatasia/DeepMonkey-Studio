# C8-S6 正式片元观测

在S5同作者场景读取两端正式片元的NV/NL/有效roughness与原single响应，定位剩余HDR差异。产品shader与LUT配置保持冻结。

## 现状核查

1. 全仓源码与未跟踪文件：无同名片元观测能力；S4 fixture/probe/readback、S5两轮原Three/common-half数值与截图已有，不复制renderer或投影。
2. 契约：正式RenderView、RenderPacket、GPU注入/DeviceSession与FrameCaptureSession均已有；本刀只用lab隔离注入，不加产品合同。
3. 依赖：现有Three r185、esbuild、Vitest、Chrome；不新增依赖或IR。
4. 消费：pipelines.ts实际createShaderModule(code=sceneShader)，Three实际RE_Direct_Physical读取directLight与PhysicalMaterial。shade和RE均已有正式完整材质链。
5. 测试/证据：S5 display max1、轮廓0、真实白炉全绿，HDR绝对.002仍未过；CPU LUT分析不足以解释最差像素，不能直接改grid/F0/曝光。
6. 规格：读取S4/S5及remaining C8；J5/生产shader冻结，I占GPU。本刀只新增隔离leaf，S4 lab-only gpu注入待根harvest后实施。

**已有（不重建）**：正式同root投影、完整前置材质/灯输入、真实FP16附件、GPU资源生命周期与源码哈希。**真实缺口**：没有实际fragment中间量，CPU raycast不能代替正式shader观察。

## 冻结范围与失败门

geometry输出NV、NL、effective rough；single输出实际GGX+Lambert直射、在emissive/多散射前。两端保留正式所有前置和同作者场景；debug只替换最终颜色，不能用CPU重算作为观察值。

原Three RE与opaque、Deep shade块精确SHA守卫，未知mode、重复装配、源漂移拒绝。记录原/仪表化shader SHA、正式模块实际命中计数；零命中或来源不等于正式sceneShader拒绝，避免空跑。Three ShaderChunk finally恢复；GPU/adapter请求只用隔离注入，实际GPUDevice保持原对象，createShaderModule临时实例拦截在finally恢复。无常驻全局、第二renderer或新LUT。

此阶段只预注册观察身份/完整性，不把中间量数值差当最终质量通过；S5原HDR/display门保持。近scale.6/远scale1、曝光.5、原Three r185、320×192数值附件不变。视觉仅dark1920×1080两必要轮，GPU按根调度。

## CPU准备

六个聚焦装配/资源负例通过：源漂移、重复/未知mode、空收据、旧模式GL源码、模块身份不符、late device交付和无法安装临时方法均拒绝；后两条实际销毁新device一次并恢复Three chunks。比较器11测试通过，额外拒空draw、非有限附件、旧packet/source、相机复用、常量几何和无single响应。观察passed只表示完整性，qualityCertified固定false。

新runner沿既有Chrome/esbuild/localhost工具栈，两fresh轮取近/远×geometry/single×front/oblique；实际GL fragment源通过renderer.info.programs.fragmentShader读回，仪表RE逐字匹配，receipt保存原/改chunk SHA和实际编译源SHA；不把重复读取次数写成独立编译次数。输出均是实际RGBA16F读回，NV/NL/rough观测分辨率受half精度限制。

根完成S5/C15原子提交3aaeec5e后，仅新增S4 lab的gpu注入与实际draw后的GL program回调；默认行为保持。J3他路只读数组断言已修复，S6新增所有leaf的lab类型检查通过。

## 实测结果

2026-09-30，`node scripts/c8-fragment-observables.mjs` 两fresh轮通过且附件逐值稳定；GPU已释放。证据在 `test-output/interrupted-0930/c8-fragment-observables/`：evidence.json、rounds.json、两张dark1920×1080截图、analysis.json与可复跑CPU分析脚本。每个实际观察run命中一个Deep正式module、四个唯一Three实际编译fragment源，十二次源码读取；八个fresh run均有完整收据。通过仅认证观察完整性，qualityCertified=false。

| 实际视角 | 共同稳定内部像素 | NV最大差 | NL最大差 | rough最大差 / p99 | single最大差 / p99 |
|---|---:|---:|---:|---:|---:|
| near front | 15987 | .00048828125 | .00048828125 | .00732421875 / .00146484375 | .0010986328125 / .0001220703125 |
| near oblique | 13981 | .00048828125 | .000030517578125 | .00830078125 / .00146484375 | .00390625 / .0001220703125 |
| far front | 5027 | 0 | .000003814697265625 | .00732421875 / .002685546875 | .00146484375 / .000244140625 |
| far oblique | 4328 | .00048828125 | .00006103515625 | .01220703125 / .00341796875 | .0025634765625 / .000244140625 |

所有NV/NL的p99均为零。当前正式Deep module SHA为 `6cc13053306df85a4a4a17bf0ed7bb689b6d6adba1d6eab0e80f33ce135b7b7b`；pbrShader文件SHA为 `fcbb5b519eb1d5494fcb210eb95d4f91bd41e657f8084e158175f34d2617f48c`，environmentShader为 `46b4d8b606fb3e98a76e04684c4d7f925c357695ef6c51a99946e1d46fcf2dc9`。receipt保存仪表化module与实际GL源码身份，bundle SHA固定；其他生产文件不据此声明全局冻结。

与既存S5最差像素交叉读取（实际GPU half附件，CPU只索引）：

- far oblique (198,64)：NV/NL相同，rough为Three .98046875 / Deep .98828125；single红 .146728515625 / .1441650390625，差 .0025634765625；最终红差 .0029296875。该点87.5%的最终差已出现在单散射，LUT不是唯一成因。
- near oblique (76,46)：rough .1904296875 / .1903076171875，single红6.58984375 / 6.59375，差一个half ULP；最终红差两个ULP。rough和single存在真实差异。
- near front (62,40)：NV/NL/rough与single实际half都相同，最终红差一个ULP。half观察不能排除量化前的差异，不能据此归因LUT或rough。

下一步只做隔离lab的默认/fine/coarse导数因果验证与几何normal观察，优先far oblique和front控制；不先改LUT、曝光或质量阈值。S5 HDR绝对.002门仍未通过。

## 视觉范围与同族检查

两张实际dark1080截图已查看：近/远、front/oblique的两端观察均完整，无裁切/重叠；原single高光实际可见，geometry观察色明确标注。对标原Three r185正式材质链；本页是诊断附件，不认证完整Studio场景画质。十维范围评分：布局9、令牌9、排版9、交互状态不适用（静态证据）、动效不适用、3D最终画质未认证（仅正式片元观察）、信息设计9、即时反馈不适用（CLI证据）、主题/尺寸9（按用户仅dark1080）、术语9。未新增产品UI，不扩浅色/窄屏测试。

同族核查覆盖近远/两相机、两观察模式：rough残差四视角均存在，NV/NL多数逐half相同；模式源码、共同packet/材质、编译命中与非空真实灯贡献均被门检查。未改产品语义、没有复跑白炉或旧J5矩阵。
