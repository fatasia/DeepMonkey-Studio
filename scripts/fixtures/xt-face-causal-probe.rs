//! Diagnostic stage localization; this is not the independent geometry oracle.
use cad_ir::{brep::FaceId, math::Vec3, scene::GeometryId};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert!(args.len() > 1);
    let requested: Vec<usize> = args[1..].iter().map(|x| x.parse().unwrap()).collect();
    let (scene, report) = cad_xt::scene_from_file(&args[0], &Default::default()).unwrap();
    assert!(report.truncated.is_none());
    // Match the corpus runner's absolute millimetre contract, not its former
    // model-relative preset. This probe localizes a failure; it does not certify it.
    let options = cad_tess::Options {
        relative: false,
        linear_deflection: 0.005,
        ..Default::default()
    }
    .resolve(scene.vertex_bounds().diagonal());
    for (g, geometry) in scene.geometry.iter().enumerate() {
        let map = &scene.source_faces[&GeometryId(g as u32)];
        let solid = geometry.brep.as_ref().unwrap();
        let edges = cad_tess::edge::discretise_all(solid, &options);
        for (fid, source) in map
            .faces
            .iter()
            .enumerate()
            .filter(|(_, f)| requested.contains(f))
        {
            let face = &solid.faces[fid];
            let surface = solid.surface(face.surface);
            let patch =
                cad_tess::face::tessellate(solid, FaceId(fid as u32), &edges, &options).unwrap();
            let mut edge_points = Vec::new();
            let mut edge_types = Vec::new();
            let mut edge_samples = Vec::new();
            for bound in &face.bounds {
                for half in &bound.halves {
                    let e = solid.edge(half.edge);
                    edge_types.push(format!("{:?}", solid.curve(e.curve)));
                    edge_points
                        .extend(edges[half.edge.index()].points.iter().map(|p| p.to_array()));
                    edge_samples.push(serde_json::json!({"edgeId":half.edge.index(),
                    "curve":format!("{:?}",solid.curve(e.curve)),
                    "points":edges[half.edge.index()].points.iter().map(|p|p.to_array()).collect::<Vec<_>>()}));
                }
            }
            let points: Vec<_> = patch
                .positions
                .iter()
                .map(|p| p.map(|v| v as f64))
                .collect();
            let residuals: Vec<_> = points
                .iter()
                .map(|p| {
                    let point = Vec3::new(p[0], p[1], p[2]);
                    surface
                        .invert(point, None)
                        .map(|uv| (surface.point_at(uv) - point).length())
                })
                .collect();
            println!(
                "{}",
                serde_json::json!({"sourceFace":source,"faceId":fid,"body":map.body,
                "surface":format!("{surface:?}"),"resolvedSag":options.sag,"modelTolerance":solid.tolerance,
                "rebuilt":patch.rebuilt,"undrawn":patch.undrawn,"crossings":patch.crossings,
                "positions":points,"indices":patch.indices,"nativeResiduals":residuals,
                "edgePoints":edge_points,"edgeCurves":edge_types,"edgeSamples":edge_samples})
            );
        }
    }
}
