#[path = "support/lod_gpu.rs"]
mod gpu;

use deep_engine_native::{lod_contract::PreparedGpuLod, scene::PackedInstance};
use gpu::{Harness, params};

const OPEN: [[f32; 4]; 6] = [[0.0, 1.0, 0.0, 100.0]; 6];

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn production_lod_selects_compacts_and_keeps_independent_view_history() {
    pollster::block_on(async {
        let mut sources: Vec<_> = [10.0, 20.0, 40.0, 10.0, 40.0]
            .into_iter()
            .enumerate()
            .map(|(index, depth)| instance(index, depth))
            .collect();
        sources[3][0] = -1.0;
        let prepared = inputs(sources.len(), &[3, 3, 3, 3, 1]);
        let gpu = Harness::new(&sources, &prepared).await;
        let main = gpu.view();
        let near_shadow = gpu.view();
        let far_shadow = gpu.view();
        let output = gpu.run(&main, &params(5, 1000.0, 1, false, OPEN));
        assert_eq!(output.history, [0, 1, 2, 0, 2]);
        assert_eq!(counts(&output.commands), [2, 0, 3]);
        let ids = |start: usize, count: usize| {
            let mut ids: Vec<_> = output.visible[start..start + count]
                .iter()
                .map(|row| row[24] as usize)
                .collect();
            ids.sort_unstable();
            ids
        };
        assert_eq!(ids(0, 2), [0, 3]);
        assert_eq!(ids(10, 3), [1, 2, 4]);
        assert!(
            output
                .commands
                .iter()
                .all(|command| command[2..] == [0, 0, 0])
        );
        let a = gpu.run(&near_shadow, &params(5, 100.0, 2, true, OPEN));
        let b = gpu.run(&far_shadow, &params(5, 45.0, 2, true, OPEN));
        assert_eq!(a.history, [0, 0, 0, 0, u32::MAX]);
        assert_eq!(counts(&a.commands), [4, 0, 0]);
        assert_eq!(b.history, [1, 1, 1, 1, u32::MAX]);
        assert_eq!(counts(&b.commands), [0, 0, 4]);
        // Downward and upward thresholds use desired history, never the resident fallback.
        for (scale, expected) in [(850.0, 0), (750.0, 1), (1000.0, 1), (1100.0, 0)] {
            let output = gpu.run(&main, &params(5, scale, 1, false, OPEN));
            assert_eq!(output.history[0], expected, "scale={scale}");
        }
        println!(
            "native GPU LOD readback passed: perspective, per-CSM orthographic history, residency fallback, hysteresis, mirrored and BLEND flags, visible bytes, firstInstance=0"
        );
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn production_lod_culling_handles_affine_support_and_rotation_projection() {
    pollster::block_on(async {
        let n = std::f32::consts::FRAC_1_SQRT_2;
        let mut sources = vec![instance(0, 10.0), instance(1, 10.0)];
        for (row, offset) in sources.iter_mut().zip([1.5, 1.7]) {
            row[1] = 1.0;
            row[3] = -offset * n;
            row[7] = -offset * n;
        }
        let prepared = inputs(2, &[3, 3]);
        let gpu = Harness::new(&sources, &prepared).await;
        let output = gpu.run(
            &gpu.view(),
            &params(2, 2000.0, 1, false, [[n, n, 0.0, 0.0]; 6]),
        );
        assert_eq!(counts(&output.commands), [1, 0, 0]);
        assert_eq!(output.visible[0], sources[0]);
        let mut rotated = instance(0, 10.0);
        rotated[0] = n;
        rotated[1] = -n;
        rotated[4] = n;
        rotated[5] = n;
        let gpu = Harness::new(&[rotated], &inputs(1, &[3])).await;
        let output = gpu.run(&gpu.view(), &params(1, 750.0, 1, false, OPEN));
        assert_eq!(
            output.history,
            [1],
            "rotation alone must not promote geometry"
        );
        assert_eq!(counts(&output.commands), [0, 0, 1]);
    });
}

fn counts(commands: &[[u32; 5]]) -> Vec<u32> {
    commands.iter().map(|command| command[1]).collect()
}

fn instance(id: usize, depth: f32) -> PackedInstance {
    let mut row = [0.0; 36];
    row[0] = 1.0;
    row[5] = 1.0;
    row[10] = 1.0;
    row[11] = -depth;
    row[24] = id as f32;
    row
}

fn inputs(count: usize, flags: &[u32]) -> PreparedGpuLod {
    let bound = [0.0_f32, 0.0, 0.0, 1.0].map(f32::to_bits);
    PreparedGpuLod {
        objects: (0..count)
            .map(|index| {
                [
                    [index as u32, 0, 3, flags[index]],
                    bound,
                    [0.12_f32.to_bits(), 0, 0, 0],
                ]
            })
            .collect(),
        levels: [180.0_f32, 80.0, 0.0]
            .into_iter()
            .enumerate()
            .map(|(index, threshold)| {
                [
                    [
                        index as u32,
                        (index * count) as u32,
                        u32::from(index != 1),
                        0,
                    ],
                    bound,
                    [threshold.to_bits(), 0, 0, 0],
                ]
            })
            .collect(),
        batches: Vec::new(),
        indirect_template: vec![[12, 0, 0, 0, 0], [6, 0, 0, 0, 0], [3, 0, 0, 0, 0]],
        visible_capacity: count as u32 * 3,
    }
}
