//! rvt2026-record-reverse 单元测试(合成 2024 形态记录;真实文件对照由
//! 运行期 evidence.json 的 control-2024 承担)。
use super::*;
use rvt::partition_element_records as records;

#[cfg(test)]
fn synth_record(element_id: u32, category: i64, bbox: [f64; 6]) -> Vec<u8> {
    let mut buf = vec![0xffu8; records::RECORD_MIN_LEN];
    buf[0..8].copy_from_slice(&u64::from(element_id).to_le_bytes());
    buf[8..12].copy_from_slice(&0x0141u32.to_le_bytes());
    buf[12..16].copy_from_slice(&0x059fu32.to_le_bytes());
    buf[16..18].copy_from_slice(&0u16.to_le_bytes());
    buf[records::CATEGORY_OFFSET..records::CATEGORY_OFFSET + 8]
        .copy_from_slice(&(category as u64).to_le_bytes());
    buf[records::PLACEMENT_KIND_OFFSET..records::PLACEMENT_KIND_OFFSET + 4]
        .copy_from_slice(&records::PLACEMENT_KIND_INSTANCE.to_le_bytes());
    buf[records::BBOX_MARKER_OFFSET..records::BBOX_MARKER_OFFSET + 8]
        .copy_from_slice(&records::BBOX_MARKER);
    for (index, value) in bbox.iter().enumerate() {
        let at = records::BBOX_OFFSET + index * 8;
        buf[at..at + 8].copy_from_slice(&value.to_le_bytes());
    }
    buf
}

#[cfg(test)]
fn fresh_scan(ids: &[u32]) -> Scan {
    Scan::new(ids.iter().copied().collect())
}

#[cfg(test)]
fn tmp_outdir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rvt2026-rr-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn tally_tracks_alignment_and_first_offsets() {
    let mut t = Tally::default();
    t.hit(8);
    t.hit(9);
    t.hit(16);
    assert_eq!(t.total, 3);
    assert_eq!(t.align[0], 2);
    assert_eq!(t.align[1], 1);
    assert_eq!(t.first, vec![8, 9, 16]);
}

#[test]
fn ring_finds_nearest_preceding_within_bound() {
    let mut ring = Ring::default();
    ring.push(100);
    ring.push(200);
    assert_eq!(ring.nearest_within(212, MAX_DELTA), Some(12));
    assert_eq!(ring.nearest_within(212, 8), None);
    assert_eq!(ring.nearest_within(100, MAX_DELTA), None);
}

#[test]
fn deltas_count_pairs_and_misses() {
    let mut d = Deltas::default();
    d.observe(Some(0x12));
    d.observe(Some(0x12));
    d.observe(Some(9_999_999));
    d.observe(None);
    assert_eq!(d.pairs, 2);
    assert_eq!(d.misses, 2);
    assert_eq!(d.map.get(&0x12), Some(&2));
    assert_eq!(d.peak(), Some((0x12, 2)));
}

#[test]
fn window_detects_all_features_of_a_2024_shaped_record() {
    let outdir = tmp_outdir("features");
    let mut scan = fresh_scan(&[22805]);
    let mut buf = synth_record(22805, records::OST_COLUMNS, [1.0, 2.0, 0.0, 3.0, 4.0, 8.0]);
    buf.insert(0, 0x7f); // 前置噪声:记录起点非 0 时同样命中
    process_window(&mut scan, "Partitions/1", &buf, 100, 100 + buf.len() as u64, &outdir);
    assert_eq!(scan.id.total, 1);
    assert_eq!(scan.cat.total, 1);
    assert_eq!(scan.cat_values.get(&records::OST_COLUMNS), Some(&1));
    assert_eq!(scan.m59f.total, 1);
    assert_eq!(scan.marker.total, 1);
    assert_eq!(scan.place_inst.total, 1);
    assert!(scan.bbox6.total >= 1);
    assert_eq!(scan.decoded, 1);
    assert_eq!(scan.id_checks.all_five, 1);
    assert_eq!(scan.d_cat_from_id.map.get(&(R2024_CAT_AT as u32)), Some(&1));
    assert_eq!(scan.d_marker_from_id.map.get(&(R2024_MARKER_AT as u32)), Some(&1));
    assert_eq!(scan.d_m59f_from_id.map.get(&(R2024_M59F_AT as u32)), Some(&1));
    assert_eq!(scan.d_place_from_id.map.get(&(R2024_PLACE_AT as u32)), Some(&1));
    // 合成记录整条 0xff 填充 → 类别符号扩展(0x15)到 placement(0x42)
    // 是一个 45B run;锚点 A=0x15 应还原记录起点并完成解码。
    assert!(scan.ff.runs >= 1);
    let a15 = scan.ff.anchors.get(&0x15).expect("anchor 0x15 observed");
    assert_eq!(a15.id_join, 1);
    assert_eq!(a15.decoded, 1);
    assert_eq!(a15.run_from_id.map.get(&0x15), Some(&1));
    let a14 = scan.ff.anchors.get(&0x14).expect("anchor 0x14 observed");
    assert_eq!(a14.id_join, 0); // 错锚点不得 join
    std::fs::remove_dir_all(&outdir).ok();
}

#[test]
fn carry_limit_excludes_trailing_hits() {
    let outdir = tmp_outdir("carry");
    let mut scan = fresh_scan(&[22805]);
    let buf = synth_record(22805, records::OST_WALLS, [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
    process_window(&mut scan, "Partitions/1", &buf, 0, 0, &outdir);
    assert_eq!(scan.id.total, 0);
    assert_eq!(scan.cat.total, 0);
    assert_eq!(scan.ff.runs, 0);
    std::fs::remove_dir_all(&outdir).ok();
}

#[test]
fn verdict_picks_dominant_peak_or_zero_features() {
    let scan = fresh_scan(&[1]);
    let (tier, _, proposed) = derive_verdict(&scan);
    assert_eq!(tier, "C-not-derivable-from-2024-features");
    assert!(proposed.is_null());
    let outdir = tmp_outdir("verdict");
    let mut scan = fresh_scan(&[22805, 22806]);
    let mut buf = synth_record(22805, records::OST_WALLS, [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
    buf.extend(synth_record(22806, records::OST_WALLS, [0.0, 0.0, 0.0, 2.0, 2.0, 2.0]));
    process_window(&mut scan, "Partitions/1", &buf, 0, buf.len() as u64, &outdir);
    let (tier, _, proposed) = derive_verdict(&scan);
    assert_eq!(tier, "A-same-skeleton-2024-offsets");
    assert_eq!(proposed["recordStartToCategory"], R2024_CAT_AT);
    std::fs::remove_dir_all(&outdir).ok();
}

#[test]
fn hexdump_renders_annotated_lines() {
    let buf = vec![0xabu8; 32];
    let text = render_hexdump(&buf, 7);
    assert!(text.contains("center offset: 7"));
    assert!(text.contains("ab ab"));
    assert!(text.contains("u64 abababababababab"));
}

#[test]
fn id_set_joins_and_degrades() {
    let ids: BTreeSet<u32> = [0, 1, 63, 64, 70].iter().copied().collect();
    let mut set = IdSet::build(&ids);
    assert!(!set.degraded);
    assert!(set.contains(63));
    assert!(set.contains(64));
    assert!(!set.contains(2));
    set.set(70);
    assert_eq!(set.count_ones(), 5); // 0,1,63,64,70 各占一位(含 id 0)
    let huge: BTreeSet<u32> = [1, 200_000_000].iter().copied().collect();
    assert!(IdSet::build(&huge).degraded);
}

#[test]
fn record_profile_maps_every_field_of_a_synth_record() {
    // 以 placement(0x42)为锚画像一条合成 2024 记录:每个已证字段都应
    // 在对应相对偏移上显形。
    let ids: BTreeSet<u32> = [22805].into();
    let idset = IdSet::build(&ids);
    let buf = synth_record(22805, records::OST_COLUMNS, [1.0, 2.0, 0.0, 3.0, 4.0, 8.0]);
    let mut p = RecordProfile::new(R2024_PLACE_AT);
    p.observe(&idset, &buf, 0);
    assert_eq!(p.candidates, 0); // observe 不计候选,由 profile_window 计
    let off = |o: usize| &p.offsets[o];
    assert_eq!(off(0x00).declared_id, 1);
    // 0x0c 是 u32 常量,画像按 u64 读 → 常量含相邻字节,组合值同样稳定。
    let expect_0c = u64::from_le_bytes(buf[0x0c..0x14].try_into().unwrap());
    assert_eq!(off(0x0c).consts.get(&expect_0c), Some(&1));
    assert_eq!(off(0x12).cat_band, 1);
    assert_eq!(off(0x42).place_inst, 1);
    assert_eq!(off(0x4c).u32_ffffffff, 1); // 2024 形态 +0x4c 的 0xffffffff
    assert_eq!(off(0x4c).byte_ff, 1);
    assert_eq!(off(0x50).consts.get(&u64::from_le_bytes(records::BBOX_MARKER)), Some(&1));
    assert_eq!(off(0x58).f64_finite, 1);
    let v = p.value();
    assert_eq!(v["anchorBytesBeforePlacement"], 0x42);
}

#[test]
fn profile_window_only_accepts_declared_heads() {
    let outdir = tmp_outdir("profile");
    let mut scan = fresh_scan(&[22805]);
    let mut buf = synth_record(22805, records::OST_COLUMNS, [1.0, 2.0, 0.0, 3.0, 4.0, 8.0]);
    buf.insert(0, 0x7f);
    buf.extend(std::iter::repeat(0u8).take(0x60)); // 保证 r+PROF_LEN 不越界
    let anchor = R2024_PLACE_AT as usize;
    let mut p = RecordProfile::new(R2024_PLACE_AT);
    profile::profile_window_for_test(&mut scan, &buf, anchor, &mut p, &outdir, "Partitions/1");
    assert_eq!(p.candidates, 1);
    assert_eq!(p.offsets[0].declared_id, 1);
    assert_eq!(p.offsets[0x42].place_inst, 1);
    // 头部 id 不在声明集 → 候选被拒。
    let mut scan2 = fresh_scan(&[999999]);
    let mut p2 = RecordProfile::new(R2024_PLACE_AT);
    profile::profile_window_for_test(&mut scan2, &buf, anchor, &mut p2, &outdir, "Partitions/1");
    assert_eq!(p2.candidates, 0);
    std::fs::remove_dir_all(&outdir).ok();
}
