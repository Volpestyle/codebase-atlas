//! Scriptable command-line adapter for the Codebase Atlas library API.

use std::{
    ffi::OsString,
    io::{self, Write},
    path::PathBuf,
};

const HELP: &str = "Codebase Atlas repository graph API

Usage:
  atlas scan [--pretty] [-o PATH] REPOSITORY
  atlas serve [--port PORT] [--token CODE] [PATH ...]

Commands:
  scan     Write a repository graph as JSON
  serve    Expose shared repositories through the HTTP API

Run `atlas COMMAND --help` for command options.";

const SCAN_HELP: &str = "Write a repository graph as JSON

Usage: atlas scan [--pretty] [-o PATH] REPOSITORY

Options:
  -o, --output PATH  Write JSON to PATH instead of stdout; use - for stdout
      --pretty       Pretty-print JSON
  -h, --help         Show this help";

const SERVE_HELP: &str = "Expose shared repositories through the HTTP API

Usage: atlas serve [--port PORT] [--token CODE] [PATH ...]

Each PATH is made available through GET /v1/catalog and POST /v1/scan.
The current directory is shared when no PATH is provided.

Options:
      --port PORT    Listen on this port (default: 7420)
      --token CODE   Use this pairing code instead of generating one
  -h, --help         Show this help";

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Help(&'static str),
    Version,
    Scan {
        repository: PathBuf,
        output: Option<PathBuf>,
        pretty: bool,
    },
    Serve {
        port: u16,
        token: Option<String>,
        roots: Vec<PathBuf>,
    },
}

/// Runs the CLI and returns its process exit code.
pub fn run(args: impl IntoIterator<Item = OsString>) -> u8 {
    let args = args.into_iter().collect::<Vec<_>>();
    match parse(&args) {
        Ok(Action::Help(help)) => println!("{help}"),
        Ok(Action::Version) => println!("atlas {}", env!("CARGO_PKG_VERSION")),
        Ok(Action::Scan {
            repository,
            output,
            pretty,
        }) => {
            if let Err(error) = run_scan(&repository, output.as_deref(), pretty) {
                eprintln!("atlas scan: {error}");
                return 1;
            }
        }
        Ok(Action::Serve { port, token, roots }) => {
            let token = token.unwrap_or_else(crate::generate_token);
            if let Err(error) = crate::serve_blocking(port, &token, roots) {
                eprintln!("atlas serve: {error}");
                return 1;
            }
        }
        Err(error) => {
            eprintln!("atlas: {error}\n\nTry `atlas --help`.");
            return 2;
        }
    }
    0
}

fn run_scan(
    repository: &std::path::Path,
    output: Option<&std::path::Path>,
    pretty: bool,
) -> Result<(), String> {
    let json = crate::scan_json(repository, pretty)?;
    if output.is_none_or(|path| path == std::path::Path::new("-")) {
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "{json}").map_err(|error| format!("Could not write stdout: {error}"))
    } else if let Some(path) = output {
        std::fs::write(path, format!("{json}\n"))
            .map_err(|error| format!("Could not write {}: {error}", path.display()))
    } else {
        unreachable!()
    }
}

fn parse(args: &[OsString]) -> Result<Action, String> {
    let Some(command) = args.first() else {
        return Ok(Action::Help(HELP));
    };
    let command = command
        .to_str()
        .ok_or_else(|| "command is not valid Unicode".to_owned())?;
    match command {
        "-h" | "--help" => Ok(Action::Help(HELP)),
        "-V" | "--version" => Ok(Action::Version),
        "help" => parse_help(&args[1..]),
        "scan" => parse_scan(&args[1..]),
        "serve" => parse_serve(&args[1..]),
        _ => Err(format!("unknown command `{command}`")),
    }
}

fn parse_help(args: &[OsString]) -> Result<Action, String> {
    match args {
        [] => Ok(Action::Help(HELP)),
        [command] if command == "scan" => Ok(Action::Help(SCAN_HELP)),
        [command] if command == "serve" => Ok(Action::Help(SERVE_HELP)),
        [command] => Err(format!("unknown command `{}`", command.to_string_lossy())),
        _ => Err("help accepts at most one command".to_owned()),
    }
}

fn parse_scan(args: &[OsString]) -> Result<Action, String> {
    let mut repository = None;
    let mut output = None;
    let mut pretty = false;
    let mut positional = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let text = arg.to_str();
        if !positional && text == Some("--") {
            positional = true;
        } else if !positional && matches!(text, Some("-h" | "--help")) {
            return Ok(Action::Help(SCAN_HELP));
        } else if !positional && text == Some("--pretty") {
            pretty = true;
        } else if !positional && matches!(text, Some("-o" | "--output")) {
            index += 1;
            output = Some(PathBuf::from(
                args.get(index)
                    .ok_or_else(|| "--output needs a path".to_owned())?,
            ));
        } else if !positional && text.is_some_and(|value| value.starts_with('-')) {
            return Err(format!("unknown scan option `{}`", arg.to_string_lossy()));
        } else if repository.is_none() {
            repository = Some(PathBuf::from(arg));
        } else if output.is_none() {
            // Keep the original `scan REPOSITORY OUTPUT` binary syntax working.
            output = Some(PathBuf::from(arg));
        } else {
            return Err("scan accepts one repository and one output path".to_owned());
        }
        index += 1;
    }
    Ok(Action::Scan {
        repository: repository.ok_or_else(|| "scan needs a repository path".to_owned())?,
        output,
        pretty,
    })
}

fn parse_serve(args: &[OsString]) -> Result<Action, String> {
    let mut port = crate::DEFAULT_PORT;
    let mut token = None;
    let mut roots = Vec::new();
    let mut positional = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let text = arg.to_str();
        if !positional && text == Some("--") {
            positional = true;
        } else if !positional && matches!(text, Some("-h" | "--help")) {
            return Ok(Action::Help(SERVE_HELP));
        } else if !positional && text == Some("--port") {
            index += 1;
            let value = args
                .get(index)
                .and_then(|value| value.to_str())
                .ok_or_else(|| "--port needs a number".to_owned())?;
            port = parse_port(value)?;
        } else if !positional && text == Some("--token") {
            index += 1;
            let value = args
                .get(index)
                .and_then(|value| value.to_str())
                .ok_or_else(|| "--token needs a pairing code".to_owned())?;
            let normalized = crate::companion::normalize_token(value);
            if normalized.is_empty() {
                return Err("--token needs at least one letter or number".to_owned());
            }
            token = Some(normalized);
        } else if !positional && text.is_some_and(|value| value.starts_with('-')) {
            return Err(format!("unknown serve option `{}`", arg.to_string_lossy()));
        } else {
            roots.push(PathBuf::from(arg));
        }
        index += 1;
    }
    Ok(Action::Serve { port, token, roots })
}

fn parse_port(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| format!("invalid port `{value}`"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_scriptable_scan_output() {
        assert_eq!(
            parse(&args(&["scan", "--pretty", "-o", "map.json", "."])),
            Ok(Action::Scan {
                repository: PathBuf::from("."),
                output: Some(PathBuf::from("map.json")),
                pretty: true,
            })
        );
        assert_eq!(
            parse(&args(&["scan", ".", "map.json"])),
            Ok(Action::Scan {
                repository: PathBuf::from("."),
                output: Some(PathBuf::from("map.json")),
                pretty: false,
            })
        );
    }

    #[test]
    fn parses_serve_configuration() {
        assert_eq!(
            parse(&args(&[
                "serve",
                "--port",
                "9000",
                "--token",
                "abcd-2345",
                "/repo"
            ])),
            Ok(Action::Serve {
                port: 9000,
                token: Some("ABCD2345".to_owned()),
                roots: vec![PathBuf::from("/repo")],
            })
        );
    }

    #[test]
    fn rejects_missing_values_and_unknown_options() {
        assert_eq!(
            parse(&args(&["scan"])),
            Err("scan needs a repository path".to_owned())
        );
        assert_eq!(
            parse(&args(&["serve", "--port", "0"])),
            Err("invalid port `0`".to_owned())
        );
        assert_eq!(
            parse(&args(&["scan", "--wat", "."])),
            Err("unknown scan option `--wat`".to_owned())
        );
    }
}
