use std::{sync::mpsc, time::Duration};

use bytemuck::cast_slice;
use deep_engine_native::{lod_contract::PreparedGpuLod, scene::PackedInstance};
use wgpu::util::DeviceExt;

pub struct Harness {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    source: wgpu::Buffer,
    objects: wgpu::Buffer,
    levels: wgpu::Buffer,
    pub template: Vec<[u32; 5]>,
    capacity: u32,
    count: usize,
}

pub struct View {
    uniform: wgpu::Buffer,
    history: wgpu::Buffer,
    visible: wgpu::Buffer,
    indirect: wgpu::Buffer,
    group: wgpu::BindGroup,
}

pub struct Output {
    pub commands: Vec<[u32; 5]>,
    pub history: Vec<u32>,
    pub visible: Vec<PackedInstance>,
}

impl Harness {
    pub async fn new(instances: &[PackedInstance], prepared: &PreparedGpuLod) -> Self {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .expect("GPU device");
        println!("Native GPU LOD real adapter: {:?}", adapter.get_info());
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("production native LOD shader"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../assets/shaders/native_gpu_lod_v1.wgsl").into(),
            ),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None,
            layout: None,
            module: &shader,
            entry_point: Some("select_lod"),
            compilation_options: Default::default(),
            cache: None,
        });
        let source = make(&device, cast_slice(instances), wgpu::BufferUsages::STORAGE);
        let objects = make(
            &device,
            cast_slice(&prepared.objects),
            wgpu::BufferUsages::STORAGE,
        );
        let levels = make(
            &device,
            cast_slice(&prepared.levels),
            wgpu::BufferUsages::STORAGE,
        );
        assert!(scope.pop().await.is_none());
        Self {
            device,
            queue,
            pipeline,
            source,
            objects,
            levels,
            template: prepared.indirect_template.clone(),
            capacity: prepared.visible_capacity,
            count: prepared.objects.len(),
        }
    }

    pub fn view(&self) -> View {
        let storage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC;
        let uniform = make(
            &self.device,
            &[0; 160],
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        );
        let history = make(
            &self.device,
            cast_slice(&vec![u32::MAX; self.count]),
            storage,
        );
        let visible = make(
            &self.device,
            &vec![0; self.capacity as usize * 144],
            storage,
        );
        let indirect = make(
            &self.device,
            cast_slice(&self.template),
            storage | wgpu::BufferUsages::COPY_DST,
        );
        let buffers = [
            &self.source,
            &self.objects,
            &self.levels,
            &uniform,
            &history,
            &visible,
            &indirect,
        ];
        let entries: Vec<_> = buffers
            .iter()
            .enumerate()
            .map(|(index, buffer)| wgpu::BindGroupEntry {
                binding: index as u32,
                resource: buffer.as_entire_binding(),
            })
            .collect();
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.pipeline.get_bind_group_layout(0),
            entries: &entries,
        });
        View {
            uniform,
            history,
            visible,
            indirect,
            group,
        }
    }

    pub fn run(&self, view: &View, params: &[u8; 160]) -> Output {
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        self.queue.write_buffer(&view.uniform, 0, params);
        self.queue
            .write_buffer(&view.indirect, 0, cast_slice(&self.template));
        let commands_bytes = self.template.len() as u64 * 20;
        let history_bytes = self.count as u64 * 4;
        let visible_bytes = u64::from(self.capacity) * 144;
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: commands_bytes + history_bytes + visible_bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &view.group, &[]);
            pass.dispatch_workgroups((self.count as u32).div_ceil(64), 1, 1);
        }
        encoder.copy_buffer_to_buffer(&view.indirect, 0, &readback, 0, commands_bytes);
        encoder.copy_buffer_to_buffer(&view.history, 0, &readback, commands_bytes, history_bytes);
        encoder.copy_buffer_to_buffer(
            &view.visible,
            0,
            &readback,
            commands_bytes + history_bytes,
            visible_bytes,
        );
        self.queue.submit([encoder.finish()]);
        let (sender, receiver) = mpsc::sync_channel(1);
        readback.map_async(wgpu::MapMode::Read, .., move |result| {
            let _ = sender.send(result);
        });
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_secs(5)),
            })
            .unwrap();
        receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("GPU mapping callback timed out")
            .unwrap();
        let bytes = readback.get_mapped_range(..).unwrap();
        let split = commands_bytes as usize;
        let end = split + history_bytes as usize;
        let output = Output {
            commands: cast_slice(&bytes[..split]).to_vec(),
            history: cast_slice(&bytes[split..end]).to_vec(),
            visible: cast_slice(&bytes[end..]).to_vec(),
        };
        drop(bytes);
        readback.unmap();
        assert!(pollster::block_on(scope.pop()).is_none());
        output
    }
}

fn make(device: &wgpu::Device, bytes: &[u8], usage: wgpu::BufferUsages) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: bytes,
        usage,
    })
}

pub fn params(
    count: u32,
    scale: f32,
    mask: u32,
    orthographic: bool,
    planes: [[f32; 4]; 6],
) -> [u8; 160] {
    let mut bytes = [0; 160];
    bytes[..96].copy_from_slice(cast_slice(&planes));
    bytes[112..128].copy_from_slice(cast_slice(&[0.0_f32, 0.0, -1.0, 0.0]));
    bytes[128..144].copy_from_slice(cast_slice(&[count, mask, u32::from(orthographic), 0]));
    bytes[144..].copy_from_slice(cast_slice(&[scale, 0.1_f32, 0.0, 0.0]));
    bytes
}
