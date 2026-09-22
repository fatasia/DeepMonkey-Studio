use super::*;

    fn record(id: u32, container: u64, placement: u32, bbox: [f64; 6]) -> records::PartitionElementRecord {
        records::PartitionElementRecord {
            stream: "Partitions/1".into(),
            offset: 0,
            element_id: id,
            flags: 0,
            builtin_category: records::OST_WALLS,
            container,
            placement_kind: placement,
            bbox_feet: bbox,
            references: Vec::new(),
            preceding_reference: None,
            owner_reference: None,
        }
    }

    #[test]
    fn instance_rule_and_counts_follow_the_record_test() {
        let mut agg = CategoryAgg::default();
        let placement_instance = records::PLACEMENT_KIND_INSTANCE;
        let placement_symbol = records::PLACEMENT_KIND_SYMBOL;
        let none = records::CONTAINER_NONE;
        agg.observe(&record(1, none, placement_instance, [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]));
        // 同 id 同 bbox 的重复记录不冲突。
        agg.observe(&record(1, none, placement_instance, [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]));
        // 类型符号与容器成员都不进导出实例。
        agg.observe(&record(2, none, placement_symbol, [-1.0, -1.0, 0.0, 1.0, 1.0, 1.0]));
        agg.observe(&record(3, 42, placement_instance, [0.0, 0.0, 0.0, 2.0, 2.0, 2.0]));
        assert_eq!(agg.record_count, 4);
        assert_eq!(agg.exported_ids, BTreeSet::from([1]));
        assert_eq!(agg.exported_record_count, 2);
        assert_eq!(agg.symbol_record_count, 1);
        assert_eq!(agg.container_member_record_count, 1);
        assert_eq!(agg.unambiguous_bbox_union(), Some([0.0, 0.0, 0.0, 1.0, 1.0, 1.0]));
    }

    #[test]
    fn conflicting_duplicate_bbox_is_marked_ambiguous() {
        let mut agg = CategoryAgg::default();
        let none = records::CONTAINER_NONE;
        agg.observe(&record(7, none, records::PLACEMENT_KIND_INSTANCE, [0.0; 6]));
        agg.observe(&record(7, none, records::PLACEMENT_KIND_INSTANCE, [1.0; 6]));
        assert!(agg.ambiguous_ids.contains(&7));
        assert_eq!(agg.unambiguous_bbox_union(), None);
    }

    #[test]
    fn union_boxes_takes_componentwise_min_max() {
        let merged = union_boxes(Some([0.0, -1.0, 2.0, 4.0, 5.0, 6.0]), [1.0, 0.0, 3.0, 3.0, 4.0, 9.0]);
        assert_eq!(merged, [0.0, -1.0, 2.0, 4.0, 5.0, 9.0]);
        assert_eq!(union_boxes(None, [1.0; 6]), [1.0; 6]);
    }

    #[test]
    fn verify_record_bytes_rejects_bad_marker() {
        let mut b = vec![255u8; 144];
        b[0..8].copy_from_slice(&42u64.to_le_bytes());
        b[16..18].fill(0);
        b[18..26].copy_from_slice(&records::OST_WALLS.to_le_bytes());
        b[50..58].copy_from_slice(&records::CONTAINER_NONE.to_le_bytes());
        b[66..70].copy_from_slice(&records::PLACEMENT_KIND_INSTANCE.to_le_bytes());
        b[80..88].copy_from_slice(&records::BBOX_MARKER);
        for (i, v) in [0f64, 0., 0., 1., 1., 1.].iter().enumerate() {
            b[88 + i * 8..96 + i * 8].copy_from_slice(&v.to_le_bytes());
        }
        b[136..140].fill(0);
        let decoded = records::decode_at("Partitions/1", &b, 0, &BTreeSet::from([42])).unwrap();
        assert!(verify_record_bytes(&decoded, &b, &BTreeSet::from([42])).is_ok());
        b[80] = 0;
        assert!(verify_record_bytes(&decoded, &b, &BTreeSet::from([42])).is_err());
    }

    #[test]
    fn malformed_input_is_rejected() {
        assert!(inspect(vec![0; 512]).is_err());
    }
