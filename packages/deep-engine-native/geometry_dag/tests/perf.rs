//! 性能基线(非门禁):1M 三角形全管线编译计时。
//!
//! 运行:`cargo test --release --test perf -- --ignored --nocapture`
//! M2 预算:编译 100 万三角形 ≤ 数秒量级(量级合理即可,实测数字写入交付报告)。

use geometry_dag::{DagOptions, DgcWriteOptions, IndexedGeometry, build_meshlet_dag, write_dgc};
use std::time::Instant;

/// 确定性经纬球(细分到 ~1M 三角形):segments×rings×2 - 极点修正。
fn big_sphere(segments: usize, rings: usize) -> IndexedGeometry {
    let mut positions = Vec::with_capacity((segments + 1) * (rings + 1) * 3);
    let mut indices = Vec::new();
    let jitter = 0.05;
    for r in 0..=rings {
        let phi = (r as f64 / rings as f64) * std::f64::consts::PI;
        for s in 0..=segments {
            let theta = (s as f64 / segments as f64) * std::f64::consts::PI * 2.0;
            // 与 gen_fixture 同款波形扰动,保证非均匀分布(压测包围体/法向锥路径)。
            let radius = 1.0 + jitter * (6.0 * phi).sin() * (4.0 * theta).cos();
            positions.push((radius * phi.sin() * theta.cos()) as f32);
            positions.push(radius.cos() as f32);
            positions.push((radius * phi.sin() * theta.sin()) as f32);
        }
    }
    let row = segments + 1;
    for r in 0..rings {
        for s in 0..segments {
            let a = (r * row + s) as u32;
            let b = a + 1;
            let c = a + row as u32;
            let d = c + 1;
            if r > 0 {
                indices.extend_from_slice(&[a, c, b]);
            }
            if r < rings - 1 {
                indices.extend_from_slice(&[b, c, d]);
            }
        }
    }
    IndexedGeometry { positions, indices }
}

#[test]
#[ignore = "perf baseline: run with --release -- --ignored --nocapture"]
fn compile_1m_triangles_under_seconds() {
    // 1000 x 500 网格:2*1000*499 = 998_000 三角形(≈1M)。
    let geometry = big_sphere(1000, 500);
    let triangles = geometry.triangle_count();
    println!(
        "input: {triangles} triangles, {} vertices",
        geometry.vertex_count()
    );

    let t0 = Instant::now();
    let dag = build_meshlet_dag(&geometry, &DagOptions::default()).expect("dag build");
    let build_elapsed = t0.elapsed();

    let t1 = Instant::now();
    let bytes = write_dgc(&dag, &DgcWriteOptions::default()).expect("dgc write");
    let serialize_elapsed = t1.elapsed();

    let total_clusters: usize = dag.levels.iter().map(|l| l.meshlet_count).sum();
    println!("levels: {}", dag.levels.len());
    for level in &dag.levels {
        println!(
            "  level {}: {} tris -> {} clusters, error {:.4}",
            level.level,
            level.indices.len() / 3,
            level.meshlet_count,
            level.error
        );
    }
    println!("total clusters: {total_clusters}");
    println!(
        "dgc size: {} bytes ({} MiB)",
        bytes.len(),
        bytes.len() / 1024 / 1024
    );
    println!(
        "build:      {build_elapsed:8.1?} ({} tri/s)",
        (triangles as f64 / build_elapsed.as_secs_f64()) as usize
    );
    println!("serialize:  {serialize_elapsed:8.1?}");

    // 量级断言(软门,防回归到分钟级):3 秒内完成 1M 三角形编译。
    assert!(
        build_elapsed.as_secs_f64() < 3.0,
        "1M-triangle DAG build took {build_elapsed:?}, expected < 3s"
    );

    // 结构自洽:层级单调下降。
    for w in dag.levels.windows(2) {
        assert!(w[1].indices.len() < w[0].indices.len());
    }
}

#[test]
#[ignore = "perf baseline: run with --release -- --ignored --nocapture"]
fn build_meshlets_only_1m_triangles() {
    let geometry = big_sphere(1000, 500);
    let t = Instant::now();
    let built = geometry_dag::build_meshlets(&geometry, None, None).expect("build");
    let elapsed = t.elapsed();
    println!(
        "cluster-only: {} triangles -> {} meshlets in {elapsed:8.1?} ({} tri/s)",
        geometry.triangle_count(),
        built.meshlet_count,
        (geometry.triangle_count() as f64 / elapsed.as_secs_f64()) as usize
    );
    assert!(elapsed.as_secs_f64() < 1.0, "cluster pass took {elapsed:?}");
}
