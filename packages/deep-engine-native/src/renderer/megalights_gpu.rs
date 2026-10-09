//! Native RIS resources. Actual material GBuffer and winner TLAS visibility replace
//! opaque local lighting; unsupported profiles retain clustered lighting.

#[path = "megalights_gpu_bindings.rs"]
mod bindings;
#[path = "megalights_gpu_budget.rs"]
pub(crate) mod budget;
#[path = "megalights_gpu_create.rs"]
mod create;
#[path = "megalights_gpu_encode.rs"]
mod encode;
#[path = "megalights_gpu_math.rs"]
mod math;
#[path = "megalights_gpu_shaders.rs"]
mod shaders;
use bindings::{compute_entries, queue_zero, storage_layout};
#[cfg(test)]
pub(crate) use math::multiply4;
pub(crate) use math::{combined_clip_to_view, invert4, pack_ris_params, world_to_view};
use math::{pack_composite_params, pack_rebuild_params};
pub(crate) use shaders::compose_production_shader;
use shaders::{COMPOSITE_WGSL, REBUILD_WGSL};

use deep_engine_native::lighting_math_wgsl::DEEP_IES_SAMPLING_WGSL;
use deep_engine_native::megalights_abi::MEGA_LIGHT_WORDS;
use deep_engine_native::megalights_wgsl::DEEP_MEGA_LIGHTS_RIS_WGSL;
use deep_engine_native::mesh_abi::FORWARD_COLOR_FORMAT;
use deep_engine_native::player_view::PlayerView;

/// WGSL 重建参数块(TS `MEGA_LIGHTS_REBUILD_PARAMS_BYTES` 同 80B:mat4 64B +
/// viewport 8B + 保留 8B;struct 自然对齐 mat4 起点为 0)。
const REBUILD_PARAM_WORDS: usize = 20;
/// 加性合成参数块(TS 16B:viewport vec2u + 保留 vec2u)。
const COMPOSITE_PARAM_WORDS: usize = 4;
/// RIS 帧参数(TS DeepMegaParams 16 字 64B;u32/f32 位型混排,见 pack 契约)。
const RIS_PARAM_WORDS: usize = 16;
/// 表面行步长(3 vec4/像素;TS `MEGA_LIGHTS_SURFACES_STRIDE_VEC4` 同值)。
const SURFACE_STRIDE: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MegaLightsGpuReject {
    /// 视口为空(前向目标退化)。
    ViewportEmpty,
    /// 资源超设备存储上限(surfaces/蓄水池/颜色任一)。
    StorageLimit,
    /// 设备拒资源创建(error scope 非空;调用方判定)。
    DeviceRejected,
}

impl MegaLightsGpuReject {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::ViewportEmpty => "native_megalights_gpu_viewport_empty",
            Self::StorageLimit => "native_megalights_gpu_storage_limit",
            Self::DeviceRejected => "native_megalights_gpu_device_rejected",
        }
    }
}

/// 帧输入(调用方持有状态;链只持 GPU 驻留资源)。
pub(crate) struct MegaLightsGpuFrameInput<'a> {
    pub view: PlayerView,
    /// 帧 uniform 前 4 行(列主序 viewProjection = depth pass 相机)。
    pub frame_view_projection: &'a [[f32; 4]; 4],
    /// 灯池打包字(count ≥ 1 占位;16 f32/灯)。
    pub packed_words: &'a [f32],
    pub light_count: u32,
    pub shadow_mask: u32,
    /// IES 载荷(None = 最小 -1 行占位,因子恒 1)。
    pub ies: Option<&'a [f32]>,
    pub frame_seed: u32,
    pub alpha_blend: f32,
    pub exhaustive: bool,
    /// 加性合成目标(HDR 1x 附件;Rgba16Float)。
    pub hdr_view: &'a wgpu::TextureView,
    pub msaa_view: Option<&'a wgpu::TextureView>,
    pub exposure: f32,
}

/// 最小 IES 占位行(-1:RIS 核按行内容判缺省,因子恒 1;TS 缺省同款)。
const IES_PLACEHOLDER_ROW: [f32; 4] = [-1.0, -1.0, -1.0, -1.0];

/// megaLights GPU 执行腿链(renderer 独占;所有 GPU 资源随链释放)。
/// 蓄水池 A/B 与颜色/历史跨帧驻留(时域 EMA + 蓄水池历史源),表面/灯池/IES
/// 每帧覆写。
pub(crate) struct MegaLightsGpuChain {
    width: u32,
    height: u32,
    full: (u32, u32),
    epoch: u64,
    rebuild_pipeline: wgpu::ComputePipeline,
    build_pipeline: wgpu::ComputePipeline,
    shade_pipeline: wgpu::ComputePipeline,
    composite_pipeline: wgpu::RenderPipeline,
    composite_msaa_pipeline: wgpu::RenderPipeline,
    rebuild_params: wgpu::Buffer,
    composite_params: wgpu::Buffer,
    ris_params: wgpu::Buffer,
    surfaces: wgpu::Buffer,
    motion: wgpu::Buffer,
    reservoirs_a: wgpu::Buffer,
    reservoirs_b: wgpu::Buffer,
    color: wgpu::Buffer,
    color_history: wgpu::Buffer,
    lights: wgpu::Buffer,
    lights_capacity_words: usize,
    ies: wgpu::Buffer,
    ies_capacity: usize,
    rebuild_bind: wgpu::BindGroup,
    build_bind: wgpu::BindGroup,
    shade_bind: wgpu::BindGroup,
    composite_bind: wgpu::BindGroup,
    visibility: wgpu::Buffer,
    pub(super) inputs: Option<super::megalights_inputs::MegaLightsInputs>,
    local_count_switch: wgpu::Buffer,
}

impl MegaLightsGpuChain {
    /// 视口(链驻留尺寸;调用方换代判定用)。
    #[allow(dead_code)]
    pub(crate) fn viewport(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// 视口/深度视图代/IES 载荷长度是否与链一致(不一致调用方整体重建)。
    pub(crate) fn matches(&self, width: u32, height: u32, epoch: u64, ies_words: usize) -> bool {
        self.full == (width, height) && self.epoch == epoch && self.ies_capacity == ies_words
    }

    /// 灯池缓冲容量是否覆盖本帧字数(不足调用方先扩容)。
    pub(crate) fn lights_fit(&self, words: usize) -> bool {
        words <= self.lights_capacity_words
    }

    /// 灯池缓冲扩容(灯数变化;重建 lights 缓冲与 build/shade 绑定组,尾域清零
    /// 保确定性——RIS 核只读 params.lightCount 以内的灯,尾域不参与求值)。
    pub(crate) fn grow_lights(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, words: usize) {
        if words <= self.lights_capacity_words {
            return;
        }
        let capacity = words.max(self.lights_capacity_words * 2);
        self.lights = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("megalights lights"),
            size: (capacity * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        queue_zero(device, queue, &self.lights);
        let ris_params = &self.ris_params;
        let surfaces = &self.surfaces;
        let motion = &self.motion;
        let reservoirs_a = &self.reservoirs_a;
        let reservoirs_b = &self.reservoirs_b;
        let color = &self.color;
        let color_history = &self.color_history;
        let ies = &self.ies;
        let lights = &self.lights;
        let build_layout = self.build_pipeline.get_bind_group_layout(0);
        let shade_layout = self.shade_pipeline.get_bind_group_layout(0);
        self.build_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("megalights build bindings"),
            layout: &build_layout,
            entries: &compute_entries(
                ris_params,
                lights,
                surfaces,
                motion,
                reservoirs_a,
                reservoirs_b,
                color,
                color_history,
                ies,
                &self.visibility,
                true,
            ),
        });
        self.shade_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("megalights shade bindings"),
            layout: &shade_layout,
            entries: &compute_entries(
                ris_params,
                lights,
                surfaces,
                motion,
                reservoirs_a,
                reservoirs_b,
                color,
                color_history,
                ies,
                &self.visibility,
                false,
            ),
        });
        self.lights_capacity_words = capacity;
    }
}
