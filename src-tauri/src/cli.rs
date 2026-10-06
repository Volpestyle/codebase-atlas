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
  atlas story brief [REPOSITORY]
  atlas story check [REPOSITORY]

Commands:
  scan     Write a repository graph as JSON
  serve    Expose shared repositories through the HTTP API
  story    Brief a coding agent or validate its story

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

const STORY_HELP: &str = "Write and check a repository story with your own coding agent

Usage:
  atlas story brief [REPOSITORY]
  atlas story check [REPOSITORY]

The repository defaults to the current directory.
brief prints authoring rules, scan facts, the existing story, and warnings.
check prints coverage to stdout and warnings to stderr; exits 0 for a valid
story, 1 for warnings or no usable story, and 2 for usage errors.
Atlas never calls a model or writes the story file.

Options:
  -h, --help         Show this help";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StoryCommand {
    Brief,
    Check,
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Help(&'static str),
    Version,
    Scan {
        repository: PathBuf,
        output: Option<PathBuf>,
        pretty: bool,
    },
    Story {
        command: StoryCommand,
        repository: PathBuf,
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
        Ok(Action::Story {
            command,
            repository,
        }) => match run_story(command, &repository) {
            Ok(code) => return code,
            Err(error) => {
                eprintln!("atlas story: {error}");
                return 1;
            }
        },
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
        "story" => parse_story(&args[1..]),
        _ => Err(format!("unknown command `{command}`")),
    }
}

fn parse_help(args: &[OsString]) -> Result<Action, String> {
    match args {
        [] => Ok(Action::Help(HELP)),
        [command] if command == "scan" => Ok(Action::Help(SCAN_HELP)),
        [command] if command == "serve" => Ok(Action::Help(SERVE_HELP)),
        [command] if command == "story" => Ok(Action::Help(STORY_HELP)),
        [command, subcommand]
            if command == "story" && (subcommand == "brief" || subcommand == "check") =>
        {
            Ok(Action::Help(STORY_HELP))
        }
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

fn parse_story(args: &[OsString]) -> Result<Action, String> {
    let Some(subcommand) = args.first() else {
        return Err("story needs brief or check".to_owned());
    };
    let command = match subcommand.to_str() {
        Some("-h" | "--help") => return Ok(Action::Help(STORY_HELP)),
        Some("brief") => StoryCommand::Brief,
        Some("check") => StoryCommand::Check,
        _ => {
            return Err(format!(
                "unknown story command `{}`",
                subcommand.to_string_lossy()
            ));
        }
    };
    let mut repository = None;
    let mut positional = false;
    for arg in &args[1..] {
        let text = arg.to_str();
        if !positional && text == Some("--") {
            positional = true;
        } else if !positional && matches!(text, Some("-h" | "--help")) {
            return Ok(Action::Help(STORY_HELP));
        } else if !positional && text.is_some_and(|value| value.starts_with('-')) {
            return Err(format!("unknown story option `{}`", arg.to_string_lossy()));
        } else if repository.is_none() {
            repository = Some(PathBuf::from(arg));
        } else {
            return Err("story accepts at most one repository path".to_owned());
        }
    }
    Ok(Action::Story {
        command,
        repository: repository.unwrap_or_else(|| PathBuf::from(".")),
    })
}

fn run_story(command: StoryCommand, repository: &std::path::Path) -> Result<u8, String> {
    let (report, code) = match command {
        StoryCommand::Brief => (crate::story_brief(repository)?, 0),
        StoryCommand::Check => {
            let check = crate::story_check(repository)?;
            for warning in &check.warnings {
                eprintln!("atlas story: {warning}");
            }
            (check.report, u8::from(!check.valid))
        }
    };
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{report}").map_err(|error| format!("Could not write stdout: {error}"))?;
    Ok(code)
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
    #[test]
    fn parses_story_commands_defaults_help_and_usage_errors() {
        assert_eq!(
            parse(&args(&["story", "brief"])),
            Ok(Action::Story {
                command: StoryCommand::Brief,
                repository: PathBuf::from(".")
            })
        );
        assert_eq!(
            parse(&args(&["story", "check", "--", "-repo"])),
            Ok(Action::Story {
                command: StoryCommand::Check,
                repository: PathBuf::from("-repo")
            })
        );
        for values in [
            &["story", "--help"][..],
            &["story", "brief", "--help"],
            &["help", "story"],
            &["help", "story", "check"],
        ] {
            assert_eq!(parse(&args(values)), Ok(Action::Help(STORY_HELP)));
        }
        for values in [
            &["story"][..],
            &["story", "write"],
            &["story", "check", "--pretty"],
            &["story", "brief", ".", "other"],
        ] {
            assert!(parse(&args(values)).is_err());
            assert_eq!(run(args(values)), 2);
        }
    }

    #[test]
    fn story_check_exit_codes_follow_validation_not_coverage() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().as_os_str().to_owned();
        assert_eq!(
            run(vec![
                OsString::from("story"),
                OsString::from("check"),
                path.clone()
            ]),
            1
        );
        std::fs::write(
            root.path().join("product.ts"),
            "export const product = 1;\n",
        )
        .unwrap();
        std::fs::create_dir(root.path().join(".codebase-index")).unwrap();
        let story = root.path().join(".codebase-index/_story.json");
        std::fs::write(&story, r#"{"summary":"Product","actors":[{"id":"core","name":"Core","role":"core","blurb":"Works"}],"flows":[]}"#).unwrap();
        assert_eq!(
            run(vec![
                OsString::from("story"),
                OsString::from("check"),
                path.clone()
            ]),
            0
        );
        std::fs::write(&story, r#"{"summary":"Product","actors":[{"id":"core","name":"Core","role":"core","blurb":"Works","modules":["gone"]}],"flows":[]}"#).unwrap();
        assert_eq!(
            run(vec![
                OsString::from("story"),
                OsString::from("check"),
                path.clone()
            ]),
            1
        );
        std::fs::write(&story, "{ broken").unwrap();
        assert_eq!(
            run(vec![
                OsString::from("story"),
                OsString::from("check"),
                path.clone()
            ]),
            1
        );
        assert_eq!(
            run(vec![OsString::from("story"), OsString::from("brief"), path]),
            0
        );
        assert_eq!(
            run(args(&["story", "check", "/nonexistent-atlas-story-test"])),
            1
        );
    }
}
