#[cfg(feature = "app")]
mod app;
pub mod cli;
mod companion;
mod imports;
mod mermaid;
mod scanner;
mod source_scope;
mod story;
mod story_authoring;
mod symbols;

#[cfg(feature = "app")]
pub use app::run;
pub use companion::{DEFAULT_PORT, PROTOCOL, generate_token, serve_blocking};
pub use mermaid::story_mermaid;
pub use scanner::RepositoryGraph;
pub use story_authoring::{StoryCheck, story_brief, story_check};

use std::path::Path;

/// Scans a local repository into the canonical Codebase Atlas graph.
///
/// The CLI, HTTP server, and Tauri UI all call this API.
///
/// # Errors
///
/// Returns a user-facing message when the folder is missing, unreadable, or not a directory.
pub fn scan(path: &Path) -> Result<RepositoryGraph, String> {
    scanner::scan_repository_path(path)
}

/// Scans a local repository and serializes its canonical graph as JSON.
///
/// # Errors
///
/// Returns a user-facing scan or serialization error.
pub fn scan_json(path: &Path, pretty: bool) -> Result<String, String> {
    let graph = scan(path)?;
    if pretty {
        serde_json::to_string_pretty(&graph)
    } else {
        serde_json::to_string(&graph)
    }
    .map_err(|error| format!("Could not serialize repository graph: {error}"))
}
