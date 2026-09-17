fn main() {
    if deep_engine_native::compat_x::process::serve_worker(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
    )
    .is_err()
    {
        std::process::exit(2);
    }
}
