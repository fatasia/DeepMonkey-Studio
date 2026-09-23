use super::*;

    // ---- v2 多层级联合同 ----

    const FINE_VALUE: [f32; 3] = [1.0, 2.0, 4.0];
    const COARSE_VALUE: [f32; 3] = [0.5, 1.0, 2.0];

    /// 细层 [4,4,4] sp1 origin0（范围 [0,4]³），粗层 [2,2,2] sp4 origin0
    /// （范围 [0,8]³ 完全包含细层，spacing 严格递增）。
    fn fine_header() -> ProbeGiGridHeader {
        ProbeGiGridHeader { origin: [0.0; 3], spacing: 1.0, grid_size: [4, 4, 4], probe_count: 64 }
    }
    fn coarse_header() -> ProbeGiGridHeader {
        ProbeGiGridHeader { origin: [0.0; 3], spacing: 4.0, grid_size: [2, 2, 2], probe_count: 8 }
    }

    /// 双层记录流：细层网格头(base=2) + 64 探针 + 粗层网格头(base=67) + 8 探针。
    fn two_level_records(fine_value: [f32; 3], fine_validity: f32,
        coarse_value: [f32; 3], coarse_validity: f32) -> Vec<IrradianceProbeRecord> {
        let layout = ProbeGiGridLayoutHeader { level_count: 2, levels_start_record: 1 };
        let mut records = vec![layout.encode().unwrap()];
        let fine = fine_header();
        records.push(fine.encode_with_base(2).unwrap());
        for _ in 0..fine.probe_count {
            let mut record = IrradianceProbeRecord::zero();
            record.irradiance = fine_value;
            record.validity = fine_validity;
            record.mean_distance = 1_000_000.0;
            records.push(record);
        }
        let coarse = coarse_header();
        records.push(coarse.encode_with_base(2 + fine.probe_count as usize + 1).unwrap());
        for _ in 0..coarse.probe_count {
            let mut record = IrradianceProbeRecord::zero();
            record.irradiance = coarse_value;
            record.validity = coarse_validity;
            record.mean_distance = 1_000_000.0;
            records.push(record);
        }
        records
    }

    #[test]
    fn layout_header_round_trips_and_rejects_invalid() {
        let layout = ProbeGiGridLayoutHeader { level_count: 2, levels_start_record: 1 };
        let record = layout.encode().unwrap();
        assert_eq!(ProbeGiGridLayoutHeader::decode(&record).unwrap(), layout);
        // 保留区字位置固定：[version, levelCount, levelsStart, 0...]，主 12 字全零。
        assert_eq!(record.reserved[0], PROBE_GI_GRID_LAYOUT_VERSION);
        assert_eq!(record.reserved[1], 2.0);
        assert_eq!(record.reserved[2], 1.0);
        assert!(record.reserved[3..].iter().all(|value| *value == 0.0));
        assert_eq!(record.irradiance, [0.0; 3]);
        assert_eq!(record.validity, 0.0);
        // 未知版本拒绝
        let mut bad = record;
        bad.reserved[0] = 3.0;
        assert_eq!(ProbeGiGridLayoutHeader::decode(&bad).unwrap_err(), ProbeGiGridError::InvalidHeader);
        // 层数越界（0 与 5）与非整数
        for bad_count in [0.0, 5.0, 2.5] {
            let mut bad = record;
            bad.reserved[1] = bad_count;
            assert_eq!(
                ProbeGiGridLayoutHeader::decode(&bad).unwrap_err(),
                ProbeGiGridError::InvalidHeader,
                "levelCount {bad_count}"
            );
        }
        // levels 起始非 1 / 非整数
        for bad_start in [0.0, 2.0, 1.5] {
            let mut bad = record;
            bad.reserved[2] = bad_start;
            assert_eq!(
                ProbeGiGridLayoutHeader::decode(&bad).unwrap_err(),
                ProbeGiGridError::InvalidHeader,
                "levelsStart {bad_start}"
            );
        }
        // 保留区尾部非零 / 主字非零
        let mut bad = record;
        bad.reserved[7] = 1.0;
        assert_eq!(ProbeGiGridLayoutHeader::decode(&bad).unwrap_err(), ProbeGiGridError::InvalidHeader);
        let mut bad = record;
        bad.irradiance = [0.0, 0.0, 1.0];
        assert_eq!(ProbeGiGridLayoutHeader::decode(&bad).unwrap_err(), ProbeGiGridError::InvalidHeader);
    }

    #[test]
    fn versioned_single_level_decodes_like_legacy() {
        // levelCount=1 的 v2 记录流：层级解码与采样结果必须与旧单层完全一致。
        let legacy = uniform_records([3, 2, 2], 0.5, [0.25, 0.5, 0.75]);
        let head = ProbeGiGridHeader::decode(&legacy[0]).unwrap();
        let layout = ProbeGiGridLayoutHeader { level_count: 1, levels_start_record: 1 };
        let mut versioned = vec![layout.encode().unwrap()];
        versioned.push(head.encode_with_base(2).unwrap());
        versioned.extend_from_slice(&legacy[1..]);
        let cascade = decode_probe_grid_cascade(&versioned).unwrap();
        assert_eq!(cascade.layout.as_ref().unwrap().level_count, 1);
        assert_eq!(cascade.levels[0], head);
        assert_eq!(cascade.header_records, vec![1]);
        for world in [[1.25, 2.5, 3.5], [1.5, 2.75, 3.25]] {
            assert_eq!(
                sample_probe_grid_irradiance(&versioned, world, [0.0, 1.0, 0.0]),
                sample_probe_grid_irradiance(&legacy, world, [0.0, 1.0, 0.0]),
                "v2 单层与旧合同采样必须逐位一致 at {world:?}"
            );
        }
    }

    #[test]
    fn two_level_cascade_decodes_with_extended_base_records() {
        let records = two_level_records(FINE_VALUE, 1.0, COARSE_VALUE, 1.0);
        let cascade = decode_probe_grid_cascade(&records).unwrap();
        assert_eq!(cascade.levels, vec![fine_header(), coarse_header()]);
        // baseProbeRecords = 布局头(1) + 前面所有层记录 + 本层网格头。
        assert_eq!(cascade.header_records, vec![1, 66]);
        assert_eq!(records[1].padding, 2.0);
        assert_eq!(records[66].padding, 67.0);
        // 打包:v2 放行保留区布局头;网格头(padding=baseProbeRecords、v2 保留区)
        // 本就不在 ABI 逐记录校验范围内,网格流必须走级联打包路径。
        let packed = pack_cascade_records(&records).unwrap();
        assert_eq!(packed.len(), records.len() * 96);
        // 旧单层经级联打包 = 记录流原样字节(确定性、与 GPU 测试的字节布局一致)。
        let legacy = uniform_records([2, 2, 2], 1.0, [1.0, 1.0, 1.0]);
        let via_cascade = pack_cascade_records(&legacy).unwrap();
        let raw: Vec<u8> = legacy
            .iter()
            .flat_map(|record| bytemuck::bytes_of(record).to_vec())
            .collect();
        assert_eq!(via_cascade, raw, "旧单层级联打包必须与记录流原样字节逐字节一致");
    }

    #[test]
    fn two_level_cascade_blends_by_web_smoothstep() {
        let records = two_level_records(FINE_VALUE, 1.0, COARSE_VALUE, 1.0);
        // 细层深内部（边界距离 1.5 格 → smoothstep=1 → blend=0）→ 纯细层值。
        let deep = sample_probe_grid_irradiance(&records, [1.5, 1.5, 1.5], [0.0, 1.0, 0.0]);
        for axis in 0..3 {
            assert!((deep[axis] - FINE_VALUE[axis]).abs() < 1e-6, "deep[{axis}]={}", deep[axis]);
        }
        // 细层边界（边界距离 0 → blend=1）→ 纯粗层值。
        let edge = sample_probe_grid_irradiance(&records, [0.0, 1.5, 1.5], [0.0, 1.0, 0.0]);
        for axis in 0..3 {
            assert!((edge[axis] - COARSE_VALUE[axis]).abs() < 1e-6, "edge[{axis}]={}", edge[axis]);
        }
        // 中间带（边界距离 0.75 → blend=0.5）→ 逐式对齐 Web 公式的中点值。
        let world = [0.75, 1.5, 1.5];
        let blended = sample_probe_grid_irradiance(&records, world, [0.0, 1.0, 0.0]);
        let boundary = fine_header().boundary_cells(world);
        assert!((boundary - 0.75).abs() < 1e-6);
        let blend = 1.0 - cascade_smoothstep(0.0, PROBE_GI_CASCADE_BLEND_CELLS, boundary);
        assert!((blend - 0.5).abs() < 1e-6);
        for axis in 0..3 {
            let expected = FINE_VALUE[axis] + (COARSE_VALUE[axis] - FINE_VALUE[axis]) * blend;
            assert!((blended[axis] - expected).abs() < 1e-6, "blended[{axis}]={}", blended[axis]);
        }
    }

    #[test]
    fn coarse_fallback_when_fine_weight_is_insufficient() {
        // 细层 validity 全零 → 权重不足 → 单独落粗层（Web fallback 语义）。
        let records = two_level_records(FINE_VALUE, 0.0, COARSE_VALUE, 1.0);
        let value = sample_probe_grid_irradiance(&records, [1.5, 1.5, 1.5], [0.0, 1.0, 0.0]);
        for axis in 0..3 {
            assert!((value[axis] - COARSE_VALUE[axis]).abs() < 1e-6, "value[{axis}]={}", value[axis]);
        }
        // 反向：粗层权重不足而细层足够 → 纯细层值（不走混合分支）。
        let records = two_level_records(FINE_VALUE, 1.0, COARSE_VALUE, 0.0);
        let value = sample_probe_grid_irradiance(&records, [0.0, 1.5, 1.5], [0.0, 1.0, 0.0]);
        for axis in 0..3 {
            assert!((value[axis] - FINE_VALUE[axis]).abs() < 1e-6, "value[{axis}]={}", value[axis]);
        }
        // 两层都权重不足 → fail-closed 返零。
        let records = two_level_records(FINE_VALUE, 0.0, COARSE_VALUE, 0.0);
        assert_eq!(
            sample_probe_grid_irradiance(&records, [1.5, 1.5, 1.5], [0.0, 1.0, 0.0]),
            [0.0; 3]
        );
    }

    #[test]
    fn invalid_multi_level_layouts_fail_closed() {
        let valid = two_level_records(FINE_VALUE, 1.0, COARSE_VALUE, 1.0);
        // 粗层 spacing 未严格递增（= 细层）。
        let mut bad = valid.clone();
        bad[66].validity = bad[1].validity;
        assert!(decode_probe_grid_cascade(&bad).is_err());
        assert_eq!(
            sample_probe_grid_irradiance(&bad, [1.5, 1.5, 1.5], [0.0, 1.0, 0.0]),
            [0.0; 3]
        );
        // 粗层范围不包含细层（origin 平移出界）。
        let mut bad = valid.clone();
        bad[66].irradiance = [10.0, 0.0, 0.0];
        assert!(decode_probe_grid_cascade(&bad).is_err());
        // 层头 baseProbeRecords 被篡改。
        let mut bad = valid.clone();
        bad[66].padding = 3.0;
        assert!(decode_probe_grid_cascade(&bad).is_err());
        // 层头占用保留区。
        let mut bad = valid.clone();
        bad[1].reserved[0] = 1.0;
        assert!(decode_probe_grid_cascade(&bad).is_err());
        // 尾随多余记录 / 缺失记录。
        let mut bad = valid.clone();
        bad.push(IrradianceProbeRecord::zero());
        assert!(decode_probe_grid_cascade(&bad).is_err());
        let bad = valid[..valid.len() - 1].to_vec();
        assert!(decode_probe_grid_cascade(&bad).is_err());
        // 声明层数 4 但只排布 2 层。
        let mut bad = valid;
        bad[0].reserved[1] = 4.0;
        assert!(decode_probe_grid_cascade(&bad).is_err());
        assert_eq!(
            sample_probe_grid_irradiance(&bad, [1.5, 1.5, 1.5], [0.0, 1.0, 0.0]),
            [0.0; 3]
        );
    }

    #[test]
    fn cascade_record_budget_is_fail_closed() {
        // 40³ + 12³ 双层总计 1+1+64000+1+1728 = 65731 > 65536 → 预算拒绝。
        let layout = ProbeGiGridLayoutHeader { level_count: 2, levels_start_record: 1 };
        let mut records = vec![layout.encode().unwrap()];
        let big = ProbeGiGridHeader { origin: [0.0; 3], spacing: 1.0, grid_size: [40, 40, 40], probe_count: 64_000 };
        let small = ProbeGiGridHeader { origin: [0.0; 3], spacing: 2.0, grid_size: [12, 12, 12], probe_count: 1_728 };
        records.push(big.encode_with_base(2).unwrap());
        for _ in 0..big.probe_count {
            records.push(IrradianceProbeRecord::zero());
        }
        records.push(small.encode_with_base(records.len() + 1).unwrap());
        for _ in 0..small.probe_count {
            records.push(IrradianceProbeRecord::zero());
        }
        assert_eq!(
            decode_probe_grid_cascade(&records).unwrap_err(),
            ProbeGiGridError::RecordBudgetExceeded(ProbeGiAbiError::RecordBudgetExceeded)
        );
    }

