use std::time::Instant;

use deep_engine_native::deep2d::{
    Deep2dRuntimeContent, decode_runtime_content, prepare_runtime_content,
};

#[test]
fn deep2d_prepare_baseline_and_reuse_are_measurable() {
    let content =
        decode_runtime_content(include_bytes!("../fixtures/deep2d_runtime_atlas_v1.json"))
            .expect("fixture must parse");
    let Deep2dRuntimeContent::Package(package) = content else {
        panic!("fixture must be a package");
    };
    let mut samples = Vec::new();
    for _ in 0..6 {
        let started = Instant::now();
        let prepared = prepare_runtime_content(&Deep2dRuntimeContent::Package(package.clone()))
            .expect("prepare must pass");
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        samples.push((
            elapsed_ms,
            prepared.chunks.len(),
            prepared.summary.atlas_bytes,
        ));
    }
    assert!(samples.iter().all(|sample| sample.1 > 0));
    assert!(samples.iter().all(|sample| sample.2 > 0));
    println!("deep2d prepare baseline samples={samples:?}");
}
