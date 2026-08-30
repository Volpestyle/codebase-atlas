//! Compatibility alias for `atlas scan`.

fn main() -> std::process::ExitCode {
    let args = std::iter::once("scan".into()).chain(std::env::args_os().skip(1));
    std::process::ExitCode::from(codebase_atlas_lib::cli::run(args))
}
