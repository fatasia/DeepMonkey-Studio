use super::*;

fn header(grid: [u32; 3], spacing: f32) -> ProbeGiGridHeader {
    ProbeGiGridHeader {
        origin: [1.0, 2.0, 3.0],
        spacing,
        grid_size: grid,
        probe_count: grid[0] * grid[1] * grid[2],
    }
}

fn uniform_records(
    grid: [u32; 3],
    spacing: f32,
    irradiance: [f32; 3],
) -> Vec<IrradianceProbeRecord> {
    let head = header(grid, spacing);
    let mut records = vec![head.encode().unwrap()];
    for index in 0..head.probe_count {
        let mut record = IrradianceProbeRecord::zero();
        record.irradiance = irradiance;
        record.validity = 1.0;
        record.mean_distance = 1_000_000.0; // Chebyshev 恒通过
        let linear = index;
        let x = linear % grid[0];
        let y = (linear / grid[0]) % grid[1];
        let z = linear / (grid[0] * grid[1]);
        // 重定位增量置于零：探针世界位置 = origin + cell*spacing。
        let cell = [x as f32, y as f32, z as f32];
        record.position_offset = [
            head.origin[0] + cell[0] * spacing - (head.origin[0] + cell[0] * spacing),
            0.0,
            0.0,
        ];
        let _ = cell;
        records.push(record);
    }
    records
}

#[test]
fn header_round_trips_and_rejects_invalid() {
    let head = header([4, 3, 2], 0.5);
    let record = head.encode().unwrap();
    assert_eq!(ProbeGiGridHeader::decode(&record).unwrap(), head);
    // spacing 非法
    let bad = ProbeGiGridHeader {
        spacing: 0.0,
        ..head
    };
    assert_eq!(bad.encode().unwrap_err(), ProbeGiGridError::InvalidHeader);
    // grid 越界（<2 或 >64）
    let bad = header([1, 3, 2], 0.5);
    assert_eq!(bad.encode().unwrap_err(), ProbeGiGridError::InvalidHeader);
    let bad = header([65, 3, 2], 0.5);
    assert_eq!(bad.encode().unwrap_err(), ProbeGiGridError::InvalidHeader);
    // probeCount 与 grid 体积不符
    let mut bad = header([2, 2, 2], 0.5);
    bad.probe_count = 7;
    assert_eq!(
        bad.encode().unwrap_err(),
        ProbeGiGridError::ProbeCountMismatch
    );
    // maxPosition 被篡改
    let mut record = head.encode().unwrap();
    record.position_offset = [0.0; 3];
    assert_eq!(
        ProbeGiGridHeader::decode(&record).unwrap_err(),
        ProbeGiGridError::InvalidHeader
    );
}

#[test]
fn uniform_grid_returns_the_shared_irradiance() {
    let records = uniform_records([2, 2, 2], 1.0, [0.25, 0.5, 0.75]);
    // 网格内部任意点：8 角等值，权重归一后等于共享值。
    let value = sample_probe_grid_irradiance(&records, [1.75, 2.5, 3.5], [0.0, 1.0, 0.0]);
    for (axis, expected) in [0.25, 0.5, 0.75].iter().enumerate() {
        assert!((value[axis] - expected).abs() < 1e-6);
    }
    // 网格外返回零。
    assert_eq!(
        sample_probe_grid_irradiance(&records, [0.5, 2.5, 3.5], [0.0, 1.0, 0.0]),
        [0.0; 3]
    );
}

#[test]
fn cell_center_uses_only_positive_hemisphere_probes() {
    // 2x1x2 网格（grid 每轴 >=2），把 -x 侧两角置为背面（法线 +x 时权重 0），
    // +x 侧两角携带高亮 irradiance：采样 interior 中点只应受 +x 侧影响。
    let grid = [2, 2, 2];
    let spacing = 1.0f32;
    let head = header(grid, spacing).encode().unwrap();
    let mut records = vec![head];
    for index in 0..8u32 {
        let mut record = IrradianceProbeRecord::zero();
        record.validity = 1.0;
        record.mean_distance = 1_000_000.0;
        let x = index % 2;
        record.irradiance = if x == 1 {
            [4.0, 0.0, 0.0]
        } else {
            [1.0, 0.0, 0.0]
        };
        records.push(record);
    }
    // 着色点位于 x=cell0/cell1 中间，法线 +x：-x 角被法线权重剔除。
    let value = sample_probe_grid_irradiance(&records, [1.5, 2.5, 3.5], [1.0, 0.0, 0.0]);
    assert!(
        (value[0] - 4.0).abs() < 1e-5,
        "背面探针不应漏光, got {}",
        value[0]
    );
}

#[test]
fn invalid_or_missing_records_fail_closed_to_zero() {
    // 记录数不足（缺探针）。
    let head = header([2, 2, 2], 1.0).encode().unwrap();
    assert_eq!(
        sample_probe_grid_irradiance(&[head], [1.5, 2.5, 3.5], [0.0, 1.0, 0.0]),
        [0.0; 3]
    );
    // 全部探针 validity=0。
    let records = uniform_records([2, 2, 2], 1.0, [1.0, 1.0, 1.0])
        .into_iter()
        .enumerate()
        .map(|(index, mut record)| {
            if index > 0 {
                record.validity = 0.0;
            }
            record
        })
        .collect::<Vec<_>>();
    assert_eq!(
        sample_probe_grid_irradiance(&records, [1.5, 2.5, 3.5], [0.0, 1.0, 0.0]),
        [0.0; 3]
    );
    // 头非法（spacing 被清零）。
    let records = uniform_records([2, 2, 2], 1.0, [1.0, 1.0, 1.0]);
    let mut corrupted = records.clone();
    corrupted[0].validity = 0.0;
    assert_eq!(
        sample_probe_grid_irradiance(&corrupted, [1.5, 2.5, 3.5], [0.0, 1.0, 0.0]),
        [0.0; 3]
    );
}

#[path = "probe_gi_grid_cascade_tests.rs"]
mod probe_gi_grid_cascade_tests;
