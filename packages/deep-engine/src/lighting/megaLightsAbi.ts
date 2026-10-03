/**
 * B2 MegaLights M1 GPU ABI:compute 通路绑定槽位与 uniform 参数字级布局。
 * 与 wgsl/megaLightsRis.wgsl 的宿主模板(megaLightsRuntime.ts)逐字互钉;
 * 纯常量模块(无运行时导入),checksum 门与 self-check 均可安全引用。
 */

/** ABI 版本:布局/绑定变化时递增(runtime pipeline key 一并递增)。 */
export const MEGA_LIGHTS_ABI_VERSION = 1;

/** 两个 compute pass 共享 group 0;各 pass 只消费自己声明的槽位(布局按全集声明)。 */
export const MEGA_LIGHTS_BIND_GROUP = 0;
/** uniform 帧参数(DeepMegaParams,32B,见 MEGA_LIGHTS_PARAM_WORDS)。 */
export const MEGA_LIGHTS_PARAMS_BINDING = 0;
/** 灯池 storage(megaLights.ts 打包,64B/灯)。 */
export const MEGA_LIGHTS_POOL_BINDING = 1;
/** 表面 storage,3 vec4/像素(48B):[0]=(positionView.xyz, metallic)
 * [1]=(normalView.xyz, roughness)[2]=(baseColor.xyz, 预留)。 */
export const MEGA_LIGHTS_SURFACES_BINDING = 2;
/** 逐像素 UV 运动 storage,1 vec4/像素 = (motionUv.xy, 0, 0)(T07 口径;未启用时全零)。 */
export const MEGA_LIGHTS_MOTION_BINDING = 3;
/** 趟一输出蓄水池(read_write;趟二读它做 5×5 合并),1 vec4/像素。 */
export const MEGA_LIGHTS_RESERVOIRS_A_BINDING = 4;
/** 趟二输出蓄水池(read_write = 下一帧的历史源;趟一读 B 取上一帧状态,pass 边界
 * 内存序为 WebGPU 规范强保证,固定双缓冲角色、无 ping-pong 重绑)。 */
export const MEGA_LIGHTS_RESERVOIRS_B_BINDING = 5;
/** 趟二颜色输出(read_write),1 vec4/像素 = (rgb EMA 后, 0)。 */
export const MEGA_LIGHTS_COLOR_BINDING = 6;
/** 颜色时域历史(read_write;EMA 收敛 = M1 噪声下限控制,生产与 TSR/TAA 组合同职责),
 * 1 vec4/像素。 */
export const MEGA_LIGHTS_COLOR_HISTORY_BINDING = 7;
/** E02 IES 展开表 storage(iesShading.packIesShading 原样复用;无 IES 时为最小 -1 行)。 */
export const MEGA_LIGHTS_IES_BINDING = 8;

/** DeepMegaParams uniform:16 f32 字 = 64B(与 WGSL struct DeepMegaParams 的自然对齐
 * 尺寸一致:vec2u(8B)+7×u32/f32(28B)+vec3u(align16 → 48..60)→ 64B;绑定必须≥结构
 * 尺寸,否则越界读零——真机探针抓出过的真实故障,勿回退)。
 * [0]=(viewport.x, viewport.y) [1]=(lightCount, frameSeed)
 * [2]=(spatialEnabled, temporalEnabled, exhaustive)
 * [3]=(visibilitySlot(恒 1.0,M2 接 BVH), alphaBlend(颜色 EMA;首帧传 1), 保留×6)。 */
export const MEGA_LIGHTS_PARAM_WORDS = 16;
export const MEGA_LIGHTS_PARAMS_BYTES = MEGA_LIGHTS_PARAM_WORDS * 4;

/** 蓄水池/颜色/运动的每像素 vec4 步长(vec4 个数)。 */
export const MEGA_LIGHTS_PIXEL_STRIDE_VEC4 = 1;
export const MEGA_LIGHTS_SURFACES_STRIDE_VEC4 = 3;
