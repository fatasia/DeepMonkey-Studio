mod model;
mod physics;
mod pinn;
mod routes;
mod safety;
mod simulation;
mod transfer;
mod types;

use std::{env, path::PathBuf, sync::Arc};

use anyhow::Context;
use model::PinoRuntime;
use pinn::PinnRuntime;
use routes::{AppState, router};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let root =
        PathBuf::from(env::var("BATTERY_NATIVE_MODEL_ROOT").unwrap_or_else(|_| "models".into()));
    let model = root.join("spm-pino-v13-6-native-v10-guard.onnx");
    let pinn_model = root.join("batterymformer-spm-pinn.fp32.opset18.onnx");
    let state = Arc::new(AppState::new(
        PinoRuntime::load(&model)?,
        PinnRuntime::load(&pinn_model)?,
    ));
    let address = env::var("BATTERY_NATIVE_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8030".into());
    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .with_context(|| format!("无法监听 {address}"))?;
    println!(
        "battery-native-runtime {address} · {} · {}",
        model.display(),
        pinn_model.display()
    );
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
