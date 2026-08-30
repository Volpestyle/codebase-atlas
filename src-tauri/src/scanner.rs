use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs, io,
    path::{Path, PathBuf},
};

use ignore::{DirEntry, WalkBuilder};
use serde::Serialize;

use crate::imports::{self, ImportResolver};
use crate::symbols::{self, ImportLanguage, ImportRef, Symbol};

const MAX_NODES: usize = 4_000;
const MAX_IMPORT_EDGES: usize = 20_000;
const MAX_SYMBOLS: usize = 60_000;
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const GENERATED_DIRECTORIES: &[&str] = &[
    ".git",
    ".codebase-index",
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
pub struct RepositoryGraph {
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
    description: Option<String>,
    /// Declarations this file makes. Empty for directories and for languages
    /// the extractor does not read.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    symbols: Vec<Symbol>,
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
    /// For an import edge, the named bindings that cross it — what the source
    /// actually takes from the target. Empty for containment, for side-effect
    /// and dynamic imports, and `*` for namespace and glob imports.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    symbols: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum EdgeKind {
    Contains,
    Imports,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryStats {
    files: usize,
    directories: usize,
    lines: u64,
    line_count_available: bool,
    imports_available: bool,
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
    pending_imports: Vec<(String, ImportLanguage, Vec<ImportRef>)>,
    npm_packages: BTreeMap<String, String>,
    cargo_crates: BTreeMap<String, String>,
    warnings: Vec<String>,
    files: usize,
    directories: usize,
    lines: u64,
    bytes: u64,
    truncated: bool,
}

/// Walks `path` into a serializable repository graph.
///
/// # Errors
///
/// Returns a user-facing message when the folder is missing, unreadable, or not a directory.
pub fn scan_repository_path(path: &Path) -> Result<RepositoryGraph, String> {
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
                description: None,
                symbols: Vec::new(),
            }],
            edges: Vec::new(),
            relationships: Vec::new(),
            node_indexes: HashMap::from([(".".to_owned(), 0)]),
            language_totals: BTreeMap::new(),
            pending_imports: Vec::new(),
            npm_packages: BTreeMap::new(),
            cargo_crates: BTreeMap::new(),
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
        let (size_bytes, lines, text) = if file_type.is_file() {
            file_metrics(entry.path(), &id, count_text_lines, &mut self.warnings)
        } else {
            (0, 0, None)
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let extension = entry
            .path()
            .extension()
            .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
        let symbols = text.as_deref().map_or_else(Vec::new, |text| {
            self.register_file_text(&id, &parent_id, &name, extension.as_deref(), text)
        });

        self.nodes[parent_index].child_count += 1;
        self.nodes.push(RepositoryNode {
            id: id.clone(),
            name,
            path: id.clone(),
            kind,
            extension,
            language: language.map(str::to_owned),
            size_bytes,
            lines,
            depth: entry.depth(),
            child_count: 0,
            description: None,
            symbols,
        });
        self.edges.push(RepositoryEdge {
            source: parent_id,
            target: id.clone(),
            kind: EdgeKind::Contains,
            symbols: Vec::new(),
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

    /// Parses a source file into the fact layer, returning the declarations to
    /// attach to its node. Manifests instead register the workspace names that
    /// import resolution needs.
    fn register_file_text(
        &mut self,
        id: &str,
        parent_id: &str,
        name: &str,
        extension: Option<&str>,
        text: &str,
    ) -> Vec<Symbol> {
        if let Some(language) = symbols::import_language(extension) {
            let facts = symbols::extract(language, extension, text);
            if !facts.imports.is_empty() {
                self.pending_imports
                    .push((id.to_owned(), language, facts.imports));
            }
            return facts.symbols;
        }
        let directory = if parent_id == "." {
            String::new()
        } else {
            parent_id.to_owned()
        };
        if name == "package.json" {
            if let Some(package) = imports::npm_package_name(text) {
                self.npm_packages.insert(package, directory);
            }
        } else if name == "Cargo.toml" {
            if let Some(package) = imports::cargo_package_name(text) {
                self.cargo_crates
                    .insert(package.replace('-', "_"), directory);
            }
        }
        Vec::new()
    }

    fn resolve_imports(&mut self) -> Vec<RepositoryEdge> {
        let node_kinds: BTreeMap<String, bool> = self
            .nodes
            .iter()
            .map(|node| {
                (
                    node.id.clone(),
                    matches!(node.kind, NodeKind::Directory | NodeKind::Repository),
                )
            })
            .collect();
        let resolver = ImportResolver::new(&node_kinds, &self.npm_packages, &self.cargo_crates);
        // Several import sites can reach the same file; their bindings merge so
        // one edge carries everything that crosses it.
        let mut pairs: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
        for (source, language, references) in &self.pending_imports {
            for reference in references {
                if let Some(target) = resolver.resolve(*language, source, &reference.specifier) {
                    // A binding named after the module it comes from (`use
                    // crate::scanner;`) repeats the edge's own target.
                    let module_name = module_name(&target);
                    let names: Vec<String> = reference
                        .names
                        .iter()
                        .filter(|name| name.as_str() != module_name)
                        .cloned()
                        .collect();
                    pairs
                        .entry((source.clone(), target))
                        .or_default()
                        .extend(names);
                }
            }
        }
        if pairs.len() > MAX_IMPORT_EDGES {
            self.warnings
                .push(format!("Import edges limited to {MAX_IMPORT_EDGES}."));
        }
        pairs
            .into_iter()
            .take(MAX_IMPORT_EDGES)
            .map(|((source, target), names)| RepositoryEdge {
                source,
                target,
                kind: EdgeKind::Imports,
                symbols: names.into_iter().collect(),
            })
            .collect()
    }

    /// Keeps the exported graph — which also travels to paired devices — from
    /// growing without bound on repositories that declare enormous surfaces.
    fn cap_symbols(&mut self) {
        let mut budget = MAX_SYMBOLS;
        let mut dropped = false;
        for node in &mut self.nodes {
            if node.symbols.len() > budget {
                node.symbols.truncate(budget);
                dropped = true;
            }
            budget -= node.symbols.len();
        }
        if dropped {
            self.warnings
                .push(format!("Symbols limited to {MAX_SYMBOLS}."));
        }
    }

    fn finish(mut self, root: &Path) -> RepositoryGraph {
        for &(parent, child) in self.relationships.iter().rev() {
            let child_bytes = self.nodes[child].size_bytes;
            let child_lines = self.nodes[child].lines;
            self.nodes[parent].size_bytes =
                self.nodes[parent].size_bytes.saturating_add(child_bytes);
            self.nodes[parent].lines = self.nodes[parent].lines.saturating_add(child_lines);
        }

        let import_edges = self.resolve_imports();
        self.edges.extend(import_edges);
        self.cap_symbols();
        attach_index_summaries(root, &mut self.nodes, &mut self.warnings);
        self.nodes.sort_by(|left, right| left.id.cmp(&right.id));
        self.edges.sort_by(|left, right| {
            left.source
                .cmp(&right.source)
                .then_with(|| left.target.cmp(&right.target))
                .then_with(|| left.kind.cmp(&right.kind))
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
                imports_available: true,
                bytes: self.bytes,
                languages,
                truncated: self.truncated,
            },
            warnings: self.warnings,
        }
    }
}

pub(crate) fn canonical_root(path: &Path) -> Result<PathBuf, String> {
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

/// File stem of a node id, which is the name an importer would use for the
/// module itself.
fn module_name(id: &str) -> &str {
    let name = id.rsplit('/').next().unwrap_or(id);
    name.rsplit_once('.').map_or(name, |(stem, _)| stem)
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
) -> (u64, u64, Option<String>) {
    let Ok(metadata) = fs::metadata(path) else {
        warnings.push(format!("Could not inspect {id}."));
        return (0, 0, None);
    };
    let size = metadata.len();
    if !count_text_lines || size > MAX_TEXT_BYTES {
        return (size, 0, None);
    }

    let Ok(text) = read_text(path) else {
        warnings.push(format!("Could not read {id}."));
        return (size, 0, None);
    };
    let lines = text.as_deref().map_or(0, |text| {
        text.lines().fold(0_u64, |lines, _| lines.saturating_add(1))
    });
    (size, lines, text)
}

/// Reads a file's contents, returning `None` for binary or non-UTF-8 data.
fn read_text(path: &Path) -> io::Result<Option<String>> {
    let contents = fs::read(path)?;
    if contents.contains(&0) {
        return Ok(None);
    }
    Ok(String::from_utf8(contents).ok())
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

const MAX_SUMMARY_CHARS: usize = 480;

/// Attaches summaries from a `.codebase-index/` markdown mirror (see the
/// codebase-index convention: one `<path>.md` per scanned path, `_root.md`
/// for the repository root) to the nodes they describe.
fn attach_index_summaries(root: &Path, nodes: &mut [RepositoryNode], warnings: &mut Vec<String>) {
    let index_root = root.join(".codebase-index");
    if !index_root.is_dir() {
        return;
    }
    for node in nodes.iter_mut() {
        let entry = if node.id == "." {
            index_root.join("_root.md")
        } else {
            index_root.join(format!("{}.md", node.id))
        };
        if let Ok(text) = fs::read_to_string(entry) {
            node.description = index_summary(&text);
        }
    }

    let last_indexed = fs::read_to_string(index_root.join(".last-commit"))
        .map(|hash| hash.trim().to_owned())
        .ok();
    if let (Some(last_indexed), Some(head)) = (last_indexed, git_head_commit(root)) {
        if last_indexed != head {
            warnings.push(
                "The codebase index is behind HEAD; module summaries may be stale.".to_owned(),
            );
        }
    }
}

/// First paragraph after the title heading, bounded for the inspector.
fn index_summary(text: &str) -> Option<String> {
    let mut lines = text.lines().skip_while(|line| {
        let line = line.trim();
        line.is_empty() || line.starts_with('#')
    });
    let mut summary = lines.next()?.trim().to_owned();
    for line in lines {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            break;
        }
        summary.push(' ');
        summary.push_str(line);
    }
    if summary.chars().count() > MAX_SUMMARY_CHARS {
        summary = summary.chars().take(MAX_SUMMARY_CHARS).collect::<String>() + "…";
    }
    (!summary.is_empty()).then_some(summary)
}

fn git_head_commit(root: &Path) -> Option<String> {
    let git_directory = git_directory(root)?;
    let head = fs::read_to_string(git_directory.join("HEAD")).ok()?;
    let head = head.trim();
    let Some(reference) = head.strip_prefix("ref:") else {
        return (!head.is_empty()).then(|| head.to_owned());
    };
    let reference = reference.trim();
    if let Ok(hash) = fs::read_to_string(git_directory.join(reference)) {
        return Some(hash.trim().to_owned());
    }
    // Ref may be packed instead of loose.
    let packed = fs::read_to_string(git_directory.join("packed-refs")).ok()?;
    packed.lines().find_map(|line| {
        line.strip_suffix(reference)
            .map(|hash| hash.trim().to_owned())
            .filter(|hash| !hash.is_empty())
    })
}

fn git_directory(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    if !dot_git.is_file() {
        return None;
    }
    let contents = fs::read_to_string(&dot_git).ok()?;
    let path = contents.lines().next()?.strip_prefix("gitdir:")?.trim();
    let path = PathBuf::from(path);
    Some(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

fn git_branch(root: &Path) -> Option<String> {
    let head = fs::read_to_string(git_directory(root)?.join("HEAD")).ok()?;
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
                imports_available: true,
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

    #[test]
    fn resolves_import_edges_across_workspace_packages() {
        let repository = tempfile::tempdir().expect("create test repository");
        let root = repository.path();
        fs::create_dir_all(root.join("web")).expect("create web package");
        fs::create_dir_all(root.join("lib")).expect("create lib package");
        fs::create_dir_all(root.join("engine/src")).expect("create engine crate");
        fs::write(
            root.join("web/package.json"),
            "{\"name\": \"@atlas/web\"}\n",
        )
        .expect("write web manifest");
        fs::write(
            root.join("web/index.ts"),
            "import { u } from \"./util\";\nimport lib from \"@atlas/lib\";\nimport external from \"react\";\n",
        )
        .expect("write web entry");
        fs::write(root.join("web/util.ts"), "export const u = 1;\n").expect("write web util");
        fs::write(
            root.join("lib/package.json"),
            "{\"name\": \"@atlas/lib\"}\n",
        )
        .expect("write lib manifest");
        fs::write(root.join("lib/index.ts"), "export default 1;\n").expect("write lib entry");
        fs::write(
            root.join("engine/Cargo.toml"),
            "[package]\nname = \"engine\"\n",
        )
        .expect("write engine manifest");
        fs::write(
            root.join("engine/src/lib.rs"),
            "use crate::scan::Scanner;\nuse std::fs;\nmod scan;\nmod util;\n",
        )
        .expect("write engine root");
        fs::write(
            root.join("engine/src/scan.rs"),
            "use super::util::helper;\n",
        )
        .expect("write engine scan");
        fs::write(root.join("engine/src/util.rs"), "pub fn helper() {}\n")
            .expect("write engine util");
        fs::create_dir_all(root.join(".codebase-index/web")).expect("create index directory");
        fs::write(
            root.join(".codebase-index/_root.md"),
            "# .\n\nA test workspace with web and engine halves.\nIt exists for the scanner tests.\n\nDeeper detail nobody should see in the summary.\n",
        )
        .expect("write root index entry");
        fs::write(
            root.join(".codebase-index/web/index.ts.md"),
            "# web/index.ts\n\nEntry point wiring util and the lib package.\n",
        )
        .expect("write file index entry");

        let graph = scan_repository_path(root).expect("scan repository");
        let imports: Vec<(&str, &str)> = graph
            .edges
            .iter()
            .filter(|edge| edge.kind == EdgeKind::Imports)
            .map(|edge| (edge.source.as_str(), edge.target.as_str()))
            .collect();

        assert_eq!(
            imports,
            [
                ("engine/src/lib.rs", "engine/src/scan.rs"),
                ("engine/src/scan.rs", "engine/src/util.rs"),
                ("web/index.ts", "lib/index.ts"),
                ("web/index.ts", "web/util.ts"),
            ]
        );
        assert!(graph.stats.imports_available);

        let by_id = |id: &str| {
            graph
                .nodes
                .iter()
                .find(|node| node.id == id)
                .unwrap_or_else(|| panic!("node {id}"))
        };
        assert!(
            !graph
                .nodes
                .iter()
                .any(|node| node.id.starts_with(".codebase-index"))
        );
        assert_eq!(
            by_id(".").description.as_deref(),
            Some("A test workspace with web and engine halves. It exists for the scanner tests."),
        );
        assert_eq!(
            by_id("web/index.ts").description.as_deref(),
            Some("Entry point wiring util and the lib package."),
        );
        assert_eq!(by_id("web/util.ts").description, None);
    }
}
