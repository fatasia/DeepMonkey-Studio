use bytemuck::cast_slice;
use deep_engine_native::lod_contract::{GPU_LOD_RECORD_BYTES, GPU_LOD_VIEW_BYTES, PreparedGpuLod};
use wgpu::util::DeviceExt;

pub struct LodView {
    pub uniform: wgpu::Buffer,
    pub visible: wgpu::Buffer,
    pub indirect: wgpu::Buffer,
    pub group: wgpu::BindGroup,
    pub _history: wgpu::Buffer,
}

pub fn validate_device(device: &wgpu::Device, prepared: &PreparedGpuLod) -> Result<(), String> {
    let limits = device.limits();
    if limits.max_storage_buffers_per_shader_stage < 6 {
        return Err("native GPU LOD requires six compute storage bindings".into());
    }
    if (prepared.objects.len() as u32).div_ceil(64) > limits.max_compute_workgroups_per_dimension {
        return Err("native GPU LOD dispatch exceeds device workgroup limit".into());
    }
    for (label, bytes) in [
        (
            "objects",
            prepared.objects.len() as u64 * GPU_LOD_RECORD_BYTES,
        ),
        (
            "levels",
            prepared.levels.len() as u64 * GPU_LOD_RECORD_BYTES,
        ),
        (
            "visible instances",
            u64::from(prepared.visible_capacity) * 144,
        ),
        (
            "indirect commands",
            prepared.indirect_template.len() as u64 * 20,
        ),
    ] {
        if bytes > limits.max_storage_buffer_binding_size || bytes > limits.max_buffer_size {
            return Err(format!(
                "native GPU LOD {label} exceeds device storage buffer limit ({bytes} bytes)"
            ));
        }
    }
    Ok(())
}

pub fn init(
    device: &wgpu::Device,
    label: &str,
    bytes: &[u8],
    usage: wgpu::BufferUsages,
) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: bytes,
        usage,
    })
}

pub fn create_view(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    inputs: [&wgpu::Buffer; 3],
    prepared: &PreparedGpuLod,
    bytes: &[u8; GPU_LOD_VIEW_BYTES as usize],
) -> LodView {
    let storage = wgpu::BufferUsages::STORAGE;
    let uniform = init(
        device,
        "native LOD view",
        bytes,
        wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    );
    let history = init(
        device,
        "native LOD per-view desired history",
        cast_slice(&vec![u32::MAX; prepared.objects.len()]),
        storage,
    );
    let visible = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("native LOD compact visible instances"),
        size: u64::from(prepared.visible_capacity) * 144,
        usage: storage | wgpu::BufferUsages::VERTEX,
        mapped_at_creation: false,
    });
    let indirect = init(
        device,
        "native LOD indexed indirect",
        cast_slice(&prepared.indirect_template),
        storage
            | wgpu::BufferUsages::INDIRECT
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC,
    );
    let buffers = [
        inputs[0], inputs[1], inputs[2], &uniform, &history, &visible, &indirect,
    ];
    let entries: Vec<_> = buffers
        .iter()
        .enumerate()
        .map(|(index, buffer)| wgpu::BindGroupEntry {
            binding: index as u32,
            resource: buffer.as_entire_binding(),
        })
        .collect();
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("native LOD view bindings"),
        layout,
        entries: &entries,
    });
    LodView {
        uniform,
        visible,
        indirect,
        group,
        _history: history,
    }
}
