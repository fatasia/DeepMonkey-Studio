//! Standalone Deep2D. Shared source is staged by export-deep2d-crate.py.
//! No dependency on the Native 3D runtime, Studio API, winit or Rapier.
extern crate self as deep_engine_native;

#[path = "shared/deep2d/mod.rs"]
pub mod deep2d;
#[path = "shared/benchmark_observer.rs"]
pub mod benchmark_observer;
pub use deep2d::*;

#[path = "shared/shader_package/mod.rs"]
mod shader_package;
#[path = "shared/runtime_package/mod.rs"]
mod runtime_package;

#[cfg(feature = "gpu")]
#[path = "shared/deep2d_gpu.rs"]
pub mod deep2d_gpu;
#[cfg(feature = "gpu")]
#[path = "shared/deep2d_gpu_cache.rs"]
pub mod deep2d_gpu_cache;
#[cfg(feature = "gpu")]
#[path = "shared/deep2d_frame_context.rs"]
pub mod deep2d_frame_context;
#[cfg(feature = "gpu")]
#[path = "shared/deep2d_atlas_gpu.rs"]
mod deep2d_atlas_gpu;
#[cfg(feature = "gpu")]
#[path = "shared/deep2d_dynamic_gpu.rs"]
mod deep2d_dynamic_gpu;
#[cfg(feature = "gpu")]
#[path = "shared/deep2d_backdrop_gpu.rs"]
mod deep2d_backdrop_gpu;
#[cfg(feature = "gpu")]
#[path = "shared/deep2d_scissor.rs"]
mod deep2d_scissor;

#[cfg(feature = "gpu")]
pub use deep2d_gpu::{Deep2dGpuPainter, Deep2dFrameContext, deep2d_frame_context};
#[cfg(feature = "gpu")]
pub use deep2d_gpu_cache::{Deep2dGpuAssetCache, Deep2dCacheStats};

#[cfg(all(test, feature = "gpu"))]
#[path = "shared/deep2d_paint_gpu_tests.rs"]
mod gpu_pixel_tests;
