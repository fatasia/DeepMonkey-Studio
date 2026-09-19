//! R2 Native wgpu harness 机器层(测试 2 的共用底座,由
//! `tests/r2_shader_compute_harness.rs` 以 `#[path]` 引入):
//! WGSL 工件常量 + wgpu 装配(纹理/均匀缓冲/dispatch/256 对齐回读)+ 时间工具。
//! 合同:WGSL 文本逐字节来自 R4 证据 kernels/(哈希断言防复制漂移);装配方式
//! 不改变 shader 文本(同文本入 wgpu);上传/回读均按行 256 对齐后本地去填充。

use wgpu::util::DeviceExt;

// ---------------------------------------------------------------------------
// WGSL 工件(逐字节复制自 R4 证据 kernels/,哈希来自 R2/R4 evidence.json)
// ---------------------------------------------------------------------------

pub const WGSL_ANCHORED_MIN: &str = include_str!("../../assets/shaders/dcir_hi_z_first_stage_min_v1.wgsl");
pub const WGSL_ANCHORED_MAX: &str = include_str!("../../assets/shaders/dcir_hi_z_first_stage_max_v1.wgsl");
pub const WGSL_VARIABLE_MIN: &str =
    include_str!("../../assets/shaders/dcir_hi_z_variable_reduce_min_v1.wgsl");
pub const WGSL_VARIABLE_MAX: &str =
    include_str!("../../assets/shaders/dcir_hi_z_variable_reduce_max_v1.wgsl");

pub const WGSL_SHA_ANCHORED_MIN: &str =
    "c586a61f7a5500220a5616232447fb07a1443a1428dbac5ffc8b72f10005765f";
pub const WGSL_SHA_ANCHORED_MAX: &str =
    "7b28b38a8261a33d9c18939c82de292b0048528d2d7e5f798c144f99914c7a55";
pub const WGSL_SHA_VARIABLE_MIN: &str =
    "755d89edd90678b61b1891c7d4440515e38e5973e8dacc23736b97d71c78fc20";
pub const WGSL_SHA_VARIABLE_MAX: &str =
    "892252c38cb012914fa8795ed5de562e39c7dbc0123fea4efb814e27948ceba7";

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Mode {
    Min,
    Max,
}

impl Mode {
    pub fn wgsl(self, kind: Kind) -> &'static str {
        match (kind, self) {
            (Kind::Anchored, Mode::Min) => WGSL_ANCHORED_MIN,
            (Kind::Anchored, Mode::Max) => WGSL_ANCHORED_MAX,
            (Kind::Variable, Mode::Min) => WGSL_VARIABLE_MIN,
            (Kind::Variable, Mode::Max) => WGSL_VARIABLE_MAX,
        }
    }
    pub fn sha(self, kind: Kind) -> &'static str {
        match (kind, self) {
            (Kind::Anchored, Mode::Min) => WGSL_SHA_ANCHORED_MIN,
            (Kind::Anchored, Mode::Max) => WGSL_SHA_ANCHORED_MAX,
            (Kind::Variable, Mode::Min) => WGSL_SHA_VARIABLE_MIN,
            (Kind::Variable, Mode::Max) => WGSL_SHA_VARIABLE_MAX,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Mode::Min => "min",
            Mode::Max => "max",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 2×2 锚定块(`hi_z_first_stage`,R2 认证内核)。
    Anchored,
    /// 变窗 ≤3 masked 定序展开(`hi_z_variable_reduce`,R4 新增)。
    Variable,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Anchored => "anchored",
            Kind::Variable => "variable",
        }
    }
}

/// 单级 reduce 的源/目标尺寸与内核分派(黄金表行)。
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ReduceLevel {
    pub src: [u32; 2],
    pub dst: [u32; 2],
    pub kind: Kind,
}

// ---------------------------------------------------------------------------
// 证据路径与读回工具
// ---------------------------------------------------------------------------

pub const WORKGROUP: u32 = 8;
pub const ROW_ALIGNMENT: usize = 256;
/// 单 encoder 内 timestamp resolve + map 走 16 字节(2 × u64)。
pub const TIMESTAMP_BYTES: u64 = 16;

pub fn align256(bytes: usize) -> usize {
    bytes.div_ceil(ROW_ALIGNMENT) * ROW_ALIGNMENT
}

pub fn evidence_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-output")
}

pub fn read_evidence_input(root: &std::path::Path, evidence_set: &str, name: &str) -> Vec<u8> {
    let path = root
        .join(evidence_set)
        .join("inputs")
        .join(format!("{name}.f32.bin"));
    std::fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "证据输入缺失: {} ({error})。请先重跑 Web 端脚本重建证据 \
             (pnpm --filter @bim-studio/deep-engine test:r4-hiz-wiring-gpu / test:r2-shader-ir-gpu)。",
            path.display()
        )
    })
}

pub fn map_read_buffer(device: &wgpu::Device, buffer: &wgpu::Buffer, len: usize) -> Vec<u8> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("readback mapping completes");
    receiver.recv().unwrap().expect("readback map succeeds");
    let view = buffer.get_mapped_range(..).expect("mapped range view");
    view[..len].to_vec()
}

// ---------------------------------------------------------------------------
// Native wgpu harness
// ---------------------------------------------------------------------------

pub struct NativeHarness {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
    pub timestamp_period_ns: f32,
    gpu_errors: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    pipelines: std::collections::HashMap<(&'static str, Mode), wgpu::ComputePipeline>,
}

impl NativeHarness {
    pub fn new() -> Self {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        }))
        .expect("Native wgpu harness requires a real GPU adapter; run on the RTX evidence machine");
        let info = adapter.get_info();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("R2 DCIR native wgpu harness"),
            // TIMESTAMP_QUERY:query set/timestamp 基础;INSIDE_ENCODERS:encoder 级
            // write_timestamp(wgpu 30 的 wgpu 特性,缺它整个 encoder 会被校验作废)。
            required_features: wgpu::Features::TIMESTAMP_QUERY
                | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS,
            ..Default::default()
        }))
        .expect("real GPU device with timestamp query support");
        let gpu_errors: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let recorded = gpu_errors.clone();
        device.on_uncaptured_error(std::sync::Arc::new(move |error: wgpu::Error| {
            recorded.lock().unwrap().push(error.to_string());
        }));
        let pipelines: std::collections::HashMap<(&'static str, Mode), wgpu::ComputePipeline> = [
            (Kind::Anchored, Mode::Min),
            (Kind::Anchored, Mode::Max),
            (Kind::Variable, Mode::Min),
            (Kind::Variable, Mode::Max),
        ]
        .into_iter()
        .map(|(kind, mode)| {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("DCIR HiZ reduce (emitted WGSL artifact)"),
                source: wgpu::ShaderSource::Wgsl(mode.wgsl(kind).into()),
            });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("DCIR HiZ reduce pipeline"),
                layout: None,
                module: &module,
                entry_point: Some(if kind == Kind::Anchored {
                    "hi_z_first_stage"
                } else {
                    "hi_z_variable_reduce"
                }),
                compilation_options: Default::default(),
                cache: None,
            });
            ((kind.label(), mode), pipeline)
        })
        .collect();
        let timestamp_period_ns = queue.get_timestamp_period();
        Self {
            device,
            queue,
            info,
            timestamp_period_ns,
            gpu_errors,
            pipelines,
        }
    }

    pub fn pipeline(&self, kind: Kind, mode: Mode) -> &wgpu::ComputePipeline {
        self.pipelines
            .get(&(kind.label(), mode))
            .expect("all four DCIR pipelines are prebuilt")
    }

    /// 单级 reduce:同 WGSL 文本 + 同输入 → 去除行填充后的 r32f 字节(tw*th*4)。
    pub fn run_reduce(&self, level: &ReduceLevel, mode: Mode, source: &[u8]) -> Vec<u8> {
        let (sw, sh) = (level.src[0] as usize, level.src[1] as usize);
        let (tw, th) = (level.dst[0] as usize, level.dst[1] as usize);
        assert_eq!(source.len(), sw * sh * 4, "source bytes must match r32f extent");
        // 上传/回读都按行 256 对齐(与 Web 端 readback 口径一致),本地去填充。
        let upload_row = align256(sw * 4);
        let mut upload = vec![0_u8; upload_row * sh];
        for y in 0..sh {
            upload[y * upload_row..y * upload_row + sw * 4]
                .copy_from_slice(&source[y * sw * 4..(y + 1) * sw * 4]);
        }
        let upload_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("DCIR HiZ source upload"),
                contents: &upload,
                usage: wgpu::BufferUsages::COPY_SRC,
            });
        let source_texture = self.create_reduce_texture(sw, sh, "DCIR HiZ source r32f");
        let target_texture = self.create_reduce_texture(tw, th, "DCIR HiZ target r32f");
        // uniform 实际 16 字节:uvec2 sourceSize @0 + uvec2 targetSize @8
        // (reduceMax 已在 IR 层特化为 min/max 双工件,见 R2 真机结论)。
        let uniform = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("DCIR HiZ uniforms (uvec2 sourceSize, uvec2 targetSize)"),
                contents: bytemuck::cast_slice(&[sw as u32, sh as u32, tw as u32, th as u32]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group =
            self.bind_reduce(self.pipeline(level.kind, mode), &source_texture, &target_texture, &uniform);
        let readback_row = align256(tw * 4);
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("DCIR HiZ readback"),
            size: (readback_row * th) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("DCIR HiZ reduce pass"),
            });
        encoder.copy_buffer_to_texture(
            wgpu::TexelCopyBufferInfo {
                buffer: &upload_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(upload_row as u32),
                    rows_per_image: Some(sh as u32),
                },
            },
            source_texture.as_image_copy(),
            wgpu::Extent3d { width: sw as u32, height: sh as u32, depth_or_array_layers: 1 },
        );
        self.encode_dispatch(&mut encoder, level, mode, &bind_group);
        encoder.copy_texture_to_buffer(
            target_texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(readback_row as u32),
                    rows_per_image: Some(th as u32),
                },
            },
            wgpu::Extent3d { width: tw as u32, height: th as u32, depth_or_array_layers: 1 },
        );
        let submission = self.queue.submit([encoder.finish()]);
        let _ = submission; // 单队列顺序提交:等待"最近一次提交"即本次提交(见 submit_and_wait 注释)
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("reduce submission completes within timeout");
        // 回读缓冲按行 256 对齐:先整段 map,再按行去填充(Web 端 readback 同口径)。
        let raw = map_read_buffer(&self.device, &readback, readback_row * th);
        readback.unmap();
        let mut bytes = Vec::with_capacity(tw * th * 4);
        for y in 0..th {
            bytes.extend_from_slice(&raw[y * readback_row..y * readback_row + tw * 4]);
        }
        bytes
    }

    /// 全链执行:level N 源 = 本端 level N-1 输出(与 Web 端真实执行同口径)。
    pub fn run_chain(&self, mode: Mode, levels: &[ReduceLevel], source: &[u8]) -> Vec<Vec<u8>> {
        let mut current = source.to_vec();
        let mut outputs = Vec::with_capacity(levels.len());
        for level in levels {
            let reduced = self.run_reduce(level, mode, &current);
            outputs.push(reduced.clone());
            current = reduced;
        }
        outputs
    }

    pub fn create_reduce_texture(&self, width: usize, height: usize, label: &str) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: width as u32,
                height: height as u32,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    }

    pub fn bind_reduce(
        &self,
        pipeline: &wgpu::ComputePipeline,
        source: &wgpu::Texture,
        target: &wgpu::Texture,
        uniform: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("DCIR HiZ bind group"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        &source.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &target.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        })
    }

    pub fn encode_dispatch(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        level: &ReduceLevel,
        mode: Mode,
        bind_group: &wgpu::BindGroup,
    ) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("DCIR HiZ reduce"),
            ..Default::default()
        });
        pass.set_pipeline(self.pipeline(level.kind, mode));
        pass.set_bind_group(0, bind_group, &[]);
        pass.dispatch_workgroups(
            level.dst[0].div_ceil(WORKGROUP),
            level.dst[1].div_ceil(WORKGROUP),
            1,
        );
    }

    pub fn submit_and_wait(&self, encoder: wgpu::CommandEncoder, label: &'static str) {
        self.queue.submit([encoder.finish()]);
        // 说明:wgpu 30 上按显式 submission_index 等待在含 timestamp query 的 encoder
        // 上会命中 WrongSubmissionIndex(内部索引分配与显式等待校准不同步);
        // 单队列顺序提交下"等待最近一次提交"与"等待本次提交"语义等价,故统一用
        // wait_indefinitely,避免对内部索引分配的隐式依赖。
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap_or_else(|error| panic!("{label} submission completes: {error:?}"));
    }

    pub fn assert_no_gpu_errors(&self, context: &str) {
        let errors = self.gpu_errors.lock().unwrap();
        assert!(errors.is_empty(), "uncaptured GPU errors during {context}: {errors:?}");
    }
}

// ---------------------------------------------------------------------------
// 时间工具(证据时间戳;纯整型 civil 算法,无外部依赖)
// ---------------------------------------------------------------------------

pub fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before epoch")
        .as_millis()
}

/// epoch 毫秒 → RFC3339 UTC(格里高利历)。
pub fn iso8601_utc(unix_ms: u128) -> String {
    let days = (unix_ms / 86_400_000) as i64;
    let ms_of_day = (unix_ms % 86_400_000) as u32;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    let (second, ms) = ((ms_of_day / 1000) % 60, ms_of_day % 1000);
    let (minute, hour) = ((ms_of_day / 60_000) % 60, ms_of_day / 3_600_000);
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z")
}
