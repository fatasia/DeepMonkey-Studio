use super::environment::Env;
use super::{HEIGHT, ROWS, WIDTH};
use deep_engine_native::chart::{
    ChartAction, ChartDataUpdate, ChartIR, ChartRuntime, DatasetRowsUpdate,
};
use serde_json::Value;
use std::time::Instant;

fn runtime_for(env: &mut Env, pool: &[ChartIR]) {
    env.runtime = Some(ChartRuntime::new(pool[0].clone(), WIDTH as f64, HEIGHT as f64).unwrap());
}
pub(super) type Scene = fn(&mut Env, usize, &[ChartIR], &[Vec<Vec<Value>>]);

pub(super) fn scenarios() -> [(&'static str, Scene); 7] {
    [
        ("initial_build", |env, _, pool, _| {
            runtime_for(env, pool);
            env.painter = None;
            env.frame(true);
        }),
        ("static_repeat", |env, _, pool, _| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            env.frame(env.painter.is_none());
        }),
        ("local_update_one_series", |env, _, pool, local| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            let revision = env.runtime.as_ref().unwrap().data_revision();
            let update = ChartDataUpdate {
                expected_data_revision: revision,
                data_revision: revision + 1,
                datasets: vec![DatasetRowsUpdate::Replace {
                    dataset_id: "dataset-1".into(),
                    rows: local[revision as usize % 2].clone(),
                }],
            };
            env.stage_cpu(|runtime| {
                runtime.update_data(update).unwrap();
            });
            env.frame(true);
        }),
        ("full_replace", |env, _, pool, _| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            let revision = env.runtime.as_ref().unwrap().data_revision();
            let next = pool[1 + revision as usize % 3].clone();
            env.stage_cpu(|runtime| runtime.replace(next).unwrap());
            env.frame(true);
        }),
        ("resize_1280_960", |env, _, pool, _| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            let width = if env.config.width == WIDTH {
                960
            } else {
                WIDTH
            };
            let start = Instant::now();
            env.runtime
                .as_mut()
                .unwrap()
                .resize(width as f64, HEIGHT as f64)
                .unwrap();
            env.config.width = width;
            env.surface.configure(&env.device, &env.config);
            env.extra_cpu += start.elapsed();
            env.frame(true);
        }),
        ("legend_toggle", |env, _, pool, _| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            env.stage_cpu(|runtime| {
                runtime
                    .dispatch(ChartAction::ToggleLegend {
                        series_id: "series-0".into(),
                    })
                    .map(|_| ())
                    .unwrap()
            });
            env.frame(true);
        }),
        ("tooltip_text_update", |env, i, pool, _| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            let index = i % ROWS;
            env.anchor = [100.0 + (i % 200) as f64, 100.0 + (i % 120) as f64];
            env.stage_cpu(|runtime| {
                runtime
                    .dispatch(ChartAction::Hover {
                        series_id: "series-0".into(),
                        data_index: index,
                        x_label: format!("设备-{index}"),
                        value: format!("{index}.0"),
                    })
                    .map(|_| ())
                    .unwrap()
            });
            env.frame(true);
        }),
    ]
}
