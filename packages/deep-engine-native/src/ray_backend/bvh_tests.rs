use super::*;

pub(super) fn grid_mesh(cells: u32) -> (Vec<f32>, Vec<u32>) {
    let stride = (cells + 1) as usize;
    let mut vertices = vec![0.0f32; stride * stride * 3];
    for y in 0..stride {
        for x in 0..stride {
            let base = (y * stride + x) * 3;
            vertices[base] = x as f32;
            vertices[base + 1] = y as f32;
            vertices[base + 2] = ((x as f32) * 13.7 + (y as f32) * 7.3).sin();
        }
    }
    let mut indices = Vec::new();
    for y in 0..cells as usize {
        for x in 0..cells as usize {
            let a = y * stride + x;
            let b = a + 1;
            let c = a + stride;
            let d = c + 1;
            indices
                .extend_from_slice(&[a as u32, c as u32, b as u32, b as u32, c as u32, d as u32]);
        }
    }
    (vertices, indices)
}

#[test]
fn builds_a_hierarchy_with_explicit_right_children() {
    let (vertices, indices) = grid_mesh(8);
    let built = build_bvh(&vertices, &indices).expect("build succeeds");
    assert!(built.nodes.len() > 1);
    let leaf_triangles: u32 = built.nodes.iter().map(|n| n.count).sum();
    assert_eq!(leaf_triangles as usize, indices.len() / 3);
    for node in &built.nodes {
        if node.count == 0 {
            assert!(node.right_child != 0 || built.nodes.len() == 1);
            assert!(node.right_child < built.nodes.len() as u32);
            assert!(node.left_first < built.nodes.len() as u32);
        }
    }
}

#[test]
fn rejects_out_of_range_indices_fail_closed() {
    let err = build_bvh(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], &[0, 1, 7]);
    assert!(matches!(err, Err(BvhBuildError::IndexOutOfRange { .. })));
    // 与 TS 合同一致：空几何合法返回空结果；非整三角流才是错误。
    assert_eq!(
        build_bvh(&[], &[]),
        Ok(BvhBuildResult {
            nodes: Vec::new(),
            order: Vec::new()
        })
    );
    // 顶点流存在但索引越界：先报 IndexOutOfRange（与 TS validateRayBlas 同序）。
    let err = build_bvh(&[0.0, 0.0, 0.0], &[0, 1, 2]);
    assert!(matches!(err, Err(BvhBuildError::IndexOutOfRange { .. })));
}

#[test]
fn matches_ts_golden_fixture() {
    // identityGolden：读取 TS buildBvh 生成的 fixture（generateBvhGolden.mts），
    // 节点布局与 order 逐值比对——任一侧构建语义漂移都会失败。
    let path = "../deep-engine/fixtures/rayTracing/bvh-golden.json";
    let raw = std::fs::read_to_string(path).expect("golden fixture readable");
    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("fixture parses");
    assert_eq!(parsed["schema"], "deep-monkey.bvh-golden.v1");
    // 输入顶点/索引直接取 fixture（两侧 sin/浮点实现不同，输入必须共享）。
    let vertices: Vec<f32> = parsed["vertices"]
        .as_array()
        .expect("vertices")
        .iter()
        .map(|value| value.as_f64().expect("vertex f64") as f32)
        .collect();
    let indices: Vec<u32> = parsed["indices"]
        .as_array()
        .expect("indices")
        .iter()
        .map(|value| value.as_u64().expect("index") as u32)
        .collect();
    let built = build_bvh(&vertices, &indices).expect("build succeeds");
    let nodes = parsed["nodes"].as_array().expect("nodes array");
    assert_eq!(
        built.nodes.len(),
        nodes.len(),
        "node count must match TS buildBvh"
    );
    for (node, expected) in built.nodes.iter().zip(nodes) {
        assert_eq!(
            node.left_first,
            expected["leftFirst"].as_u64().expect("leftFirst") as u32
        );
        assert_eq!(
            node.count,
            expected["count"].as_u64().expect("count") as u32
        );
        let right = expected.get("rightChild").and_then(|v| v.as_u64());
        if node.count == 0 {
            assert_eq!(
                Some(node.right_child as u64),
                right,
                "rightChild must match"
            );
        } else {
            assert_eq!(right, None, "leaves carry no rightChild");
        }
        for (actual, key) in [
            (node.min_x, "minX"),
            (node.min_y, "minY"),
            (node.min_z, "minZ"),
            (node.max_x, "maxX"),
            (node.max_y, "maxY"),
            (node.max_z, "maxZ"),
        ] {
            let expected_value = expected[key].as_f64().expect(key) as f32;
            assert_eq!(
                actual.to_bits(),
                expected_value.to_bits(),
                "bounds {key} must be bit-identical"
            );
        }
    }
    let order = parsed["order"].as_array().expect("order array");
    assert_eq!(built.order.len(), order.len());
    for (actual, expected) in built.order.iter().zip(order) {
        assert_eq!(*actual, expected.as_u64().expect("order entry") as u32);
    }
}
