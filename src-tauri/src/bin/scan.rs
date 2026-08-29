//! Headless scanner: writes a repository's map JSON (the same graph the
//! desktop app exports) so maps can be generated in scripts and bundled into
//! app builds. Usage: `scan <repository-path> [output.json]`.
#![allow(dead_code)]

#[path = "../imports.rs"]
mod imports;
#[path = "../scanner.rs"]
mod scanner;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(repository) = args.next() else {
        eprintln!("usage: scan <repository-path> [output.json]");
        std::process::exit(2);
    };
    let graph = match scanner::scan_repository_path(std::path::Path::new(&repository)) {
        Ok(graph) => graph,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let json = serde_json::to_string(&graph).expect("scanned graphs serialize");
    match args.next() {
        Some(path) => {
            if let Err(error) = std::fs::write(&path, json) {
                eprintln!("could not write {path}: {error}");
                std::process::exit(1);
            }
        }
        None => println!("{json}"),
    }
}
