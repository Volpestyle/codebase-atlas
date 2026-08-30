fn main() -> std::process::ExitCode {
    std::process::ExitCode::from(codebase_atlas_lib::cli::run(std::env::args_os().skip(1)))
}
