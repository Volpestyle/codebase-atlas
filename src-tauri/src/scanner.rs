use std::{
    collections::{BTreeMap, HashMap},
    fs, io,
    path::{Path, PathBuf},
};

use ignore::{DirEntry, WalkBuilder};
use serde::Serialize;

const MAX_NODES: usize = 4_000;
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const GENERATED_DIRECTORIES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    "coverage",
    "vendor",
    "Pods",
    "DerivedData",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryGraph {
    root: String,
    name: String,
    branch: Option<String>,
    source: RepositorySource,
    nodes: Vec<RepositoryNode>,
    edges: Vec<RepositoryEdge>,
    stats: RepositoryStats,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RepositorySource {
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryNode {
    id: String,
    name: String,
    path: String,
    kind: NodeKind,
    extension: Option<String>,
    language: Option<String>,
    size_bytes: u64,
    lines: u64,
    depth: usize,
    child_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NodeKind {
    Repository,
    Directory,
    Source,
    Config,
    Documentation,
    Asset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryEdge {
    source: String,
    target: String,
    kind: EdgeKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum EdgeKind {
    Contains,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryStats {
    files: usize,
    directories: usize,
    lines: u64,
    line_count_available: bool,
    bytes: u64,
    languages: Vec<LanguageStat>,
    truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanguageStat {
    name: String,
    files: usize,
    lines: u64,
}

struct ScanState {
    nodes: Vec<RepositoryNode>,
    edges: Vec<RepositoryEdge>,
    relationships: Vec<(usize, usize)>,
    node_indexes: HashMap<String, usize>,
    language_totals: BTreeMap<&'static str, (usize, u64)>,
    warnings: Vec<String>,
    files: usize,
    directories: usize,
    lines: u64,
    bytes: u64,
    truncated: bool,
}

#[tauri::command]
pub(crate) async fn scan_repository(path: String) -> Result<RepositoryGraph, String> {
    tauri::async_runtime::spawn_blocking(move || scan_repository_path(Path::new(&path)))
        .await
        .map_err(|_| "Repository scan stopped unexpectedly.".to_owned())?
}

fn scan_repository_path(path: &Path) -> Result<RepositoryGraph, String> {
    let root = canonical_root(path)?;
    let root_name = root.file_name().map_or_else(
        || root.to_string_lossy().into_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    let mut scan = ScanState::new(root_name);
    let mut walker = WalkBuilder::new(&root);
    walker
        .standard_filters(true)
        .hidden(false)
        .parents(true)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(should_visit)
        .sort_by_file_path(Path::cmp);

    for result in walker.build() {
        let entry = match result {
            Ok(entry) => entry,
            Err(error) => {
                scan.warnings.push(format!("Skipped entry: {error}"));
                continue;
            }
        };
        if !scan.add_entry(&root, &entry) {
            break;
        }
    }

    Ok(scan.finish(&root))
}

impl ScanState {
    fn new(root_name: String) -> Self {
        Self {
            nodes: vec![RepositoryNode {
                id: ".".to_owned(),
                name: root_name,
                path: ".".to_owned(),
                kind: NodeKind::Repository,
                extension: None,
                language: None,
                size_bytes: 0,
                lines: 0,
                depth: 0,
                child_count: 0,
            }],
            edges: Vec::new(),
            relationships: Vec::new(),
            node_indexes: HashMap::from([(".".to_owned(), 0)]),
            language_totals: BTreeMap::new(),
            warnings: Vec::new(),
            files: 0,
            directories: 0,
            lines: 0,
            bytes: 0,
            truncated: false,
        }
    }

    fn add_entry(&mut self, root: &Path, entry: &DirEntry) -> bool {
        if entry.depth() == 0 {
            return true;
        }
        let Some(file_type) = entry.file_type() else {
            self.warnings
                .push(format!("Could not inspect {}.", entry.path().display()));
            return true;
        };
        if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
            return true;
        }
        if self.nodes.len() >= MAX_NODES {
            self.truncated = true;
            return false;
        }

        let relative = entry
            .path()
            .strip_prefix(root)
            .expect("walker entries remain below their root");
        let id = relative_path(relative);
        let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
        let parent_id = if parent_relative.as_os_str().is_empty() {
            ".".to_owned()
        } else {
            relative_path(parent_relative)
        };
        let parent_index = *self
            .node_indexes
            .get(&parent_id)
            .expect("walker visits a directory before its children");
        let node_index = self.nodes.len();
        let (kind, language, count_text_lines) = if file_type.is_dir() {
            (NodeKind::Directory, None, false)
        } else {
            classify(entry.path())
        };
        let (size_bytes, lines) = if file_type.is_file() {
            file_metrics(entry.path(), &id, count_text_lines, &mut self.warnings)
        } else {
            (0, 0)
        };

        self.nodes[parent_index].child_count += 1;
        self.nodes.push(RepositoryNode {
            id: id.clone(),
            name: entry.file_name().to_string_lossy().into_owned(),
            path: id.clone(),
            kind,
            extension: entry
                .path()
                .extension()
                .map(|extension| extension.to_string_lossy().to_ascii_lowercase()),
            language: language.map(str::to_owned),
            size_bytes,
            lines,
            depth: entry.depth(),
            child_count: 0,
        });
        self.edges.push(RepositoryEdge {
            source: parent_id,
            target: id.clone(),
            kind: EdgeKind::Contains,
        });
        self.relationships.push((parent_index, node_index));
        self.node_indexes.insert(id, node_index);

        if file_type.is_dir() {
            self.directories += 1;
        } else {
            self.files += 1;
            self.bytes = self.bytes.saturating_add(size_bytes);
            self.lines = self.lines.saturating_add(lines);
            if let Some(language) = language {
                let totals = self.language_totals.entry(language).or_default();
                totals.0 += 1;
                totals.1 = totals.1.saturating_add(lines);
            }
        }
        true
    }

    fn finish(mut self, root: &Path) -> RepositoryGraph {
        for &(parent, child) in self.relationships.iter().rev() {
            let child_bytes = self.nodes[child].size_bytes;
            let child_lines = self.nodes[child].lines;
            self.nodes[parent].size_bytes =
                self.nodes[parent].size_bytes.saturating_add(child_bytes);
            self.nodes[parent].lines = self.nodes[parent].lines.saturating_add(child_lines);
        }

        self.nodes.sort_by(|left, right| left.id.cmp(&right.id));
        self.edges.sort_by(|left, right| {
            left.source
                .cmp(&right.source)
                .then_with(|| left.target.cmp(&right.target))
        });
        if self.truncated {
            self.warnings
                .push(format!("Scan limited to {MAX_NODES} nodes."));
        }

        let mut languages = self
            .language_totals
            .into_iter()
            .map(|(name, (files, lines))| LanguageStat {
                name: name.to_owned(),
                files,
                lines,
            })
            .collect::<Vec<_>>();
        languages.sort_by(|left, right| {
            right
                .lines
                .cmp(&left.lines)
                .then_with(|| right.files.cmp(&left.files))
                .then_with(|| left.name.cmp(&right.name))
        });

        RepositoryGraph {
            root: root.to_string_lossy().into_owned(),
            name: self.nodes[0].name.clone(),
            branch: git_branch(root),
            source: RepositorySource::Local,
            nodes: self.nodes,
            edges: self.edges,
            stats: RepositoryStats {
                files: self.files,
                directories: self.directories,
                lines: self.lines,
                line_count_available: true,
                bytes: self.bytes,
                languages,
                truncated: self.truncated,
            },
            warnings: self.warnings,
        }
    }
}

fn canonical_root(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("Select a repository folder.".to_owned());
    }

    let root = fs::canonicalize(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => "Selected folder does not exist.".to_owned(),
        io::ErrorKind::PermissionDenied => "Cannot access the selected folder.".to_owned(),
        _ => "Could not open the selected folder.".to_owned(),
    })?;
    let metadata =
        fs::metadata(&root).map_err(|_| "Could not inspect the selected folder.".to_owned())?;
    if !metadata.is_dir() {
        return Err("Selected path is not a folder.".to_owned());
    }
    Ok(root)
}

fn should_visit(entry: &DirEntry) -> bool {
    entry.depth() == 0
        || !GENERATED_DIRECTORIES
            .iter()
            .any(|directory| entry.file_name() == *directory)
}

fn relative_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn file_metrics(
    path: &Path,
    id: &str,
    count_text_lines: bool,
    warnings: &mut Vec<String>,
) -> (u64, u64) {
    let Ok(metadata) = fs::metadata(path) else {
        warnings.push(format!("Could not inspect {id}."));
        return (0, 0);
    };
    let size = metadata.len();
    if !count_text_lines || size > MAX_TEXT_BYTES {
        return (size, 0);
    }

    let Ok(lines) = count_lines(path) else {
        warnings.push(format!("Could not read {id}."));
        return (size, 0);
    };
    (size, lines)
}

fn count_lines(path: &Path) -> io::Result<u64> {
    let contents = fs::read(path)?;
    if contents.contains(&0) {
        return Ok(0);
    }
    let Ok(text) = std::str::from_utf8(&contents) else {
        return Ok(0);
    };
    Ok(text.lines().fold(0_u64, |lines, _| lines.saturating_add(1)))
}

fn classify(path: &Path) -> (NodeKind, Option<&'static str>, bool) {
    let name = path
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().to_lowercase());

    if name.starts_with("dockerfile") {
        return (NodeKind::Config, Some("Dockerfile"), true);
    }
    if name == "makefile" || name == "gnumakefile" {
        return (NodeKind::Config, Some("Makefile"), true);
    }
    if name == "cmakelists.txt" {
        return (NodeKind::Config, Some("CMake"), true);
    }
    if name == "cargo.lock" {
        return (NodeKind::Config, Some("TOML"), true);
    }
    if name.starts_with(".env")
        || matches!(
            name.as_str(),
            ".editorconfig" | ".gitattributes" | ".gitignore" | ".ignore"
        )
    {
        return (NodeKind::Config, None, true);
    }
    if matches!(
        name.as_str(),
        ".bash_profile" | ".bashrc" | ".profile" | ".zprofile" | ".zshrc"
    ) {
        return (NodeKind::Source, Some("Shell"), true);
    }
    if matches!(
        name.as_str(),
        "changelog" | "contributing" | "copying" | "license" | "readme"
    ) {
        return (NodeKind::Documentation, None, true);
    }

    match path
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .as_deref()
    {
        Some("rs") => (NodeKind::Source, Some("Rust"), true),
        Some("ts" | "tsx") => (NodeKind::Source, Some("TypeScript"), true),
        Some("js" | "jsx" | "mjs" | "cjs") => (NodeKind::Source, Some("JavaScript"), true),
        Some("py" | "pyi") => (NodeKind::Source, Some("Python"), true),
        Some("swift") => (NodeKind::Source, Some("Swift"), true),
        Some("kt" | "kts") => (NodeKind::Source, Some("Kotlin"), true),
        Some("java") => (NodeKind::Source, Some("Java"), true),
        Some("go") => (NodeKind::Source, Some("Go"), true),
        Some("c" | "h") => (NodeKind::Source, Some("C"), true),
        Some("cc" | "cpp" | "cxx" | "hh" | "hpp" | "hxx") => (NodeKind::Source, Some("C++"), true),
        Some("m") => (NodeKind::Source, Some("Objective-C"), true),
        Some("mm") => (NodeKind::Source, Some("Objective-C++"), true),
        Some("rb") => (NodeKind::Source, Some("Ruby"), true),
        Some("php") => (NodeKind::Source, Some("PHP"), true),
        Some("cs") => (NodeKind::Source, Some("C#"), true),
        Some("sh" | "bash" | "zsh" | "fish") => (NodeKind::Source, Some("Shell"), true),
        Some("html" | "htm") => (NodeKind::Source, Some("HTML"), true),
        Some("css" | "scss" | "sass" | "less") => (NodeKind::Source, Some("CSS"), true),
        Some("json" | "jsonc") => (NodeKind::Config, Some("JSON"), true),
        Some("yaml" | "yml") => (NodeKind::Config, Some("YAML"), true),
        Some("toml") => (NodeKind::Config, Some("TOML"), true),
        Some("xml" | "plist") => (NodeKind::Config, Some("XML"), true),
        Some("gradle") => (NodeKind::Config, Some("Gradle"), true),
        Some("cfg" | "conf" | "env" | "ini" | "properties") => (NodeKind::Config, None, true),
        Some("md" | "markdown" | "mdx") => (NodeKind::Documentation, Some("Markdown"), true),
        Some("adoc" | "asciidoc" | "rst" | "txt") => (NodeKind::Documentation, None, true),
        _ => (NodeKind::Asset, None, false),
    }
}

fn git_branch(root: &Path) -> Option<String> {
    let dot_git = root.join(".git");
    let git_directory = if dot_git.is_dir() {
        dot_git
    } else if dot_git.is_file() {
        let contents = fs::read_to_string(&dot_git).ok()?;
        let path = contents.lines().next()?.strip_prefix("gitdir:")?.trim();
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    } else {
        return None;
    };

    let head = fs::read_to_string(git_directory.join("HEAD")).ok()?;
    let reference = head.trim().strip_prefix("ref:")?.trim();
    let branch = reference.strip_prefix("refs/heads/")?;
    (!branch.is_empty()).then(|| branch.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_deterministically_and_rejects_invalid_roots() {
        let repository = tempfile::tempdir().expect("create test repository");
        fs::create_dir_all(repository.path().join(".git")).expect("create git directory");
        fs::create_dir_all(repository.path().join("node_modules"))
            .expect("create generated directory");
        fs::create_dir_all(repository.path().join("src")).expect("create source directory");
        fs::write(
            repository.path().join(".git/HEAD"),
            "ref: refs/heads/main\n",
        )
        .expect("write git head");
        fs::write(repository.path().join(".gitignore"), "ignored.py\n").expect("write ignore file");
        fs::write(repository.path().join("README.md"), "# Atlas\n").expect("write documentation");
        fs::write(repository.path().join("config.toml"), "name = \"atlas\"\n")
            .expect("write config");
        fs::write(repository.path().join("ignored.py"), "print('ignored')\n")
            .expect("write ignored source");
        fs::write(repository.path().join("logo.png"), [0, 1, 2, 3]).expect("write asset");
        fs::write(
            repository.path().join("node_modules/dependency.js"),
            "export default 1\n",
        )
        .expect("write generated source");
        fs::write(repository.path().join("src/lib.rs"), "fn main() {\n}\n")
            .expect("write Rust source");

        let first = scan_repository_path(repository.path()).expect("scan repository");
        let second = scan_repository_path(repository.path()).expect("rescan repository");

        assert_eq!(first, second);
        assert_eq!(first.branch.as_deref(), Some("main"));
        assert_eq!(
            first
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            [
                ".",
                ".gitignore",
                "README.md",
                "config.toml",
                "logo.png",
                "src",
                "src/lib.rs",
            ]
        );
        assert_eq!(first.nodes[0].child_count, 5);
        assert_eq!(first.nodes[0].size_bytes, 52);
        assert_eq!(first.nodes[0].lines, 5);
        assert_eq!(first.nodes[1].kind, NodeKind::Config);
        assert_eq!(first.nodes[2].kind, NodeKind::Documentation);
        assert_eq!(first.nodes[4].kind, NodeKind::Asset);
        assert_eq!(first.nodes[5].kind, NodeKind::Directory);
        assert_eq!(first.nodes[6].kind, NodeKind::Source);
        assert_eq!(
            first.stats,
            RepositoryStats {
                files: 5,
                directories: 1,
                lines: 5,
                line_count_available: true,
                bytes: 52,
                languages: vec![
                    LanguageStat {
                        name: "Rust".to_owned(),
                        files: 1,
                        lines: 2,
                    },
                    LanguageStat {
                        name: "Markdown".to_owned(),
                        files: 1,
                        lines: 1,
                    },
                    LanguageStat {
                        name: "TOML".to_owned(),
                        files: 1,
                        lines: 1,
                    },
                ],
                truncated: false,
            }
        );
        assert!(first.warnings.is_empty());

        assert_eq!(
            scan_repository_path(&repository.path().join("missing")),
            Err("Selected folder does not exist.".to_owned())
        );
    }
}
