//! Headless companion: share local repositories over the LAN or Tailscale so
//! an iPad (or browser) can map them without cloning.
//!
//! Usage: `serve [--port 7420] [--token CODE] [PATH ...]`

fn main() {
    let mut port = codebase_atlas_lib::DEFAULT_PORT;
    let mut token = String::new();
    let mut roots = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                let Some(value) = args.next() else {
                    eprintln!("serve: --port needs a number");
                    std::process::exit(2);
                };
                port = value.parse().unwrap_or_else(|_| {
                    eprintln!("serve: invalid port {value}");
                    std::process::exit(2);
                });
            }
            "--token" => {
                let Some(value) = args.next() else {
                    eprintln!("serve: --token needs a pairing code");
                    std::process::exit(2);
                };
                token = value;
            }
            "--help" | "-h" => {
                eprintln!(
                    "usage: serve [--port {default}] [--token CODE] [PATH ...]\n\nShares each PATH (or the current directory) so Codebase Atlas on iPhone or iPad can map it over Wi-Fi or Tailscale.",
                    default = codebase_atlas_lib::DEFAULT_PORT
                );
                std::process::exit(0);
            }
            _ => roots.push(std::path::PathBuf::from(arg)),
        }
    }
    if token.is_empty() {
        token = codebase_atlas_lib::generate_token();
    }
    if let Err(error) = codebase_atlas_lib::serve_blocking(port, &token, roots) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
