//! Product-source scope for story coverage and the authoring digest.
//! Mirror this small rule in the web story's Where-it-lives percentages.
//! The canonical human-readable contract is docs/writing-a-story.md.

use crate::scanner::{GENERATED_DIRECTORIES, NodeKind, RepositoryNode};

const SUPPORT_DIRS: &[&str] = &[
    "test",
    "tests",
    "__tests__",
    "spec",
    "specs",
    "e2e",
    "fixtures",
    "__mocks__",
];

/// Exclude directory segments, not files whose names happen to start with a dot.
/// `gen` below any `src-tauri` directory is generated platform scaffolding.
pub(crate) fn excluded_path(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    let mut in_tauri = false;
    for part in parts.iter().take(parts.len().saturating_sub(1)) {
        if part.starts_with('.')
            || GENERATED_DIRECTORIES.contains(part)
            || (in_tauri && *part == "gen")
        {
            return true;
        }
        in_tauri |= *part == "src-tauri";
    }
    false
}

pub(crate) fn is_config_source(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.')
        .is_some_and(|(stem, _)| stem.ends_with(".config"))
}

pub(crate) fn is_product_source(node: &RepositoryNode) -> bool {
    if node.kind != NodeKind::Source || excluded_path(&node.id) || is_config_source(&node.id) {
        return false;
    }
    if node
        .id
        .split('/')
        .any(|part| SUPPORT_DIRS.contains(&part.to_lowercase().as_str()))
    {
        return false;
    }
    let name = node.id.rsplit('/').next().unwrap_or(&node.id);
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    ![".test", ".spec", "_test"]
        .iter()
        .any(|suffix| stem.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_excludes_directory_segments_without_excluding_similar_file_names() {
        for path in [
            ".claude/skills/tool.ts",
            ".github/ci.ts",
            ".vscode/tool.ts",
            "src/.tools/run.ts",
            "src-tauri/gen/apple/main.swift",
            "apps/src-tauri/platform/gen/main.rs",
            "src/node_modules/lib.ts",
            "src/vendor/lib.ts",
            "src/DerivedData/generated.swift",
        ] {
            assert!(excluded_path(path), "{path}");
        }
        for path in [
            ".entry.ts",
            "src/generation/main.ts",
            "src/general.ts",
            "src/gen/main.ts",
            "src-tauri/src/generated.rs",
            "src/vendor.ts",
        ] {
            assert!(!excluded_path(path), "{path}");
        }
        assert!(is_config_source("vite.config.ts"));
        assert!(!is_config_source("src/config.ts"));
    }

    /// tests/source-scope-table.json is shared with tests/source-scope.test.ts:
    /// each row is [path, is product source] for a source file, so the web
    /// mirror in src/sourceScope.ts cannot drift from this rule unnoticed.
    #[test]
    fn product_scope_matches_the_shared_path_table() {
        let table: Vec<(String, bool)> =
            serde_json::from_str(include_str!("../../tests/source-scope-table.json")).unwrap();
        assert!(!table.is_empty());
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.ts"), "export const a = 1;\n").unwrap();
        let graph = crate::scanner::scan_repository_path(root.path()).unwrap();
        let template = graph
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Source)
            .expect("a scanned source file")
            .clone();
        for (path, product) in table {
            let mut node = template.clone();
            node.id.clone_from(&path);
            assert_eq!(is_product_source(&node), product, "{path}");
        }
    }
}
