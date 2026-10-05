/**
 * B2 MegaLights M1 GPU ABI:compute 通路绑定槽位与 uniform 参数字级布局。
 * 与 wgsl/megaLightsRis.wgsl 的宿主模板(megaLightsRuntime.ts)逐字互钉;
 * 纯常量模块(无运行时导入),checksum 门与 self-check 均可安全引用。
 */

/** ABI 版本:布局/绑定变化时递增(runtime pipeline key 一并递增)。
 * v2(2026-10-05):M2 胜者可见性射线档新增绑定 9-16(见下);legacy(可见性档关)
 * 的绑定 0-8 与 DeepMegaParams 字级布局逐字不变(visibilityEnabled 字由 reserved
 * 首槽转正,字偏移 12 与 struct 尺寸不变),关闭时帧输出与 v1 逐位一致。 */
export const MEGA_LIGHTS_ABI_VERSION = 2;

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

// ---- v2 胜者可见性射线档绑定(仅可见性档的管线布局声明;legacy 布局不含) ----

/** 胜者遮挡射线流(32B/像素 = 2 vec4,rayTraceLayout 同构:front=(origin.xyz,tMax)、
 * back=(dir.xyz,0);趟一 build 写,可见性 trace pass 读)。 */
export const MEGA_LIGHTS_RAY_STREAM_BINDING = 9;
/** 栈溢出哨兵(atomic<u32>;bvhTraverse 片段族同名合同,溢出 fail-closed 写遮挡;
 * COPY_SRC 供诊断读回,同 shadow 家族纪律)。 */
export const MEGA_LIGHTS_OVERFLOW_BINDING = 10;
/** TLAS/BLAS 场景五缓冲(bvhTraverse 片段族的 storage 变量名合同逐字对应)。 */
export const MEGA_LIGHTS_NODES_BINDING = 11;
export const MEGA_LIGHTS_INSTANCES_BINDING = 12;
export const MEGA_LIGHTS_VERTICES_BINDING = 13;
export const MEGA_LIGHTS_INDICES_BINDING = 14;
export const MEGA_LIGHTS_ORDER_BINDING = 15;
/** 可见性档帧参数(80B:viewToWorld mat4x4f + rayMask u32 + pad×3)。 */
export const MEGA_LIGHTS_VIS_PARAMS_BINDING = 16;
/** 胜者可见性 mask(1 u32/像素,1=可见/0=遮挡/溢出 fail-closed 0)。独立 buffer——
 * color.w 同位读写会在 shade pass 内自竞态(trace 写/shade 读/ shade 末尾覆写 0),
 * pass 边界内存序只保 pass 间不保 pass 内。 */
export const MEGA_LIGHTS_VIS_MASK_BINDING = 17;

/** DeepMegaVisParams uniform:20 f32 字 = 80B(仅可见性档;viewToWorld 为**列主序**
 * view→world,与 rtShadowFrame.invertColumnMajor4x4 输出同族)。
 * [0..15]=viewToWorld [16]=(rayMask, 保留×3)。 */
export const MEGA_LIGHTS_VIS_PARAM_WORDS = 20;
export const MEGA_LIGHTS_VIS_PARAMS_BYTES = MEGA_LIGHTS_VIS_PARAM_WORDS * 4;
/** 胜者射线自相交偏移(相对射线长度;origin 外推 + tMax 双侧收缩)。
 * 与 rayTraceClosestFrame 家族的 extent 派生 bias 同角色,这里取相对式——
 * 万灯距离跨度大,绝对偏移会在远灯上失真。 */
export const MEGA_LIGHTS_VISIBILITY_RAY_BIAS_RELATIVE = 1e-3;

/** DeepMegaParams uniform:绑定 16 f32 字 = 64B(v2 起 WGSL struct 自然尺寸缩为
 * 48B——reserved 由 vec3u 改 vec2u 后 max align = 8;绑定保持 64B ≥ minBindingSize,
 * 字 12-15 为结构外保留,宿主零写入)。绑定必须≥结构尺寸,否则越界读零——真机探针
 * 抓出过的真实故障,勿回退。
 * [0]=(viewport.x, viewport.y) [1]=(lightCount, frameSeed)
 * [2]=(spatialEnabled, temporalEnabled, exhaustive)
 * [3]=(visibilitySlot(恒 1.0,可见性档的 per-pixel 因子走 color.w mask), alphaBlend
 * (颜色 EMA;首帧传 1))
 * [9]=visibilityEnabled(M2 胜者可见性射线开关;v1 reserved 首字转正——WGSL 自然
 * packing 位于 alphaBlend 后一字。0=关闭:模板注入的 deepMegaVisibilityAt 恒 1.0,
 * 帧输出与 M1 逐位一致;trace pass 同字早退零 dispatch)[10..11]=vec2u 保留。 */
export const MEGA_LIGHTS_PARAM_WORDS = 16;
export const MEGA_LIGHTS_PARAMS_BYTES = MEGA_LIGHTS_PARAM_WORDS * 4;

/** 蓄水池/颜色/运动的每像素 vec4 步长(vec4 个数)。 */
export const MEGA_LIGHTS_PIXEL_STRIDE_VEC4 = 1;
export const MEGA_LIGHTS_SURFACES_STRIDE_VEC4 = 3;
