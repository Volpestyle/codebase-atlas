//! Compatibility alias for `atlas serve`.

fn main() -> std::process::ExitCode {
    let args = std::iter::once("serve".into()).chain(std::env::args_os().skip(1));
    std::process::ExitCode::from(codebase_atlas_lib::cli::run(args))
}
