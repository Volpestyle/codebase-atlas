//! Resolution of extracted import specifiers against the scanned node set.
//!
//! Specifiers arrive from [`crate::symbols`], which parses them out of source
//! files. Resolution is deliberately not a compiler: relative paths, workspace
//! `package.json` names, and workspace crate names are followed, and anything
//! that does not land on a scanned file or directory (external packages,
//! standard libraries) is dropped rather than guessed at.

use std::collections::{BTreeMap, BTreeSet};

use crate::symbols::ImportLanguage;

/// Resolves extracted specifiers against the scanned node set.
pub(crate) struct ImportResolver<'a> {
    /// Node id -> whether the node is a directory.
    nodes: &'a BTreeMap<String, bool>,
    /// npm workspace package name -> package directory id.
    npm_packages: &'a BTreeMap<String, String>,
    /// Cargo package name (underscore-normalized) -> crate directory id.
    cargo_crates: &'a BTreeMap<String, String>,
}

const TS_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs"];

impl<'a> ImportResolver<'a> {
    pub(crate) fn new(
        nodes: &'a BTreeMap<String, bool>,
        npm_packages: &'a BTreeMap<String, String>,
        cargo_crates: &'a BTreeMap<String, String>,
    ) -> Self {
        Self {
            nodes,
            npm_packages,
            cargo_crates,
        }
    }

    pub(crate) fn resolve(
        &self,
        language: ImportLanguage,
        file_id: &str,
        specifier: &str,
    ) -> Option<String> {
        let resolved = match language {
            ImportLanguage::TsJs => self.resolve_ts(file_id, specifier),
            ImportLanguage::Rust => self.resolve_rust(file_id, specifier),
        }?;
        (resolved != file_id).then_some(resolved)
    }

    fn is_file(&self, id: &str) -> bool {
        self.nodes.get(id).is_some_and(|directory| !directory)
    }

    fn is_directory(&self, id: &str) -> bool {
        self.nodes.get(id).is_some_and(|directory| *directory)
    }

    fn resolve_ts(&self, file_id: &str, specifier: &str) -> Option<String> {
        if specifier.starts_with('.') {
            let joined = join_relative(&parent_dir(file_id), specifier)?;
            return self.match_ts_module(&joined);
        }

        // Workspace package specifier: longest matching declared package name wins.
        let (name, directory) = self
            .npm_packages
            .iter()
            .filter(|(name, _)| {
                specifier == **name
                    || specifier
                        .strip_prefix(name.as_str())
                        .is_some_and(|rest| rest.starts_with('/'))
            })
            .max_by_key(|(name, _)| name.len())?;
        let subpath = specifier[name.len()..].trim_start_matches('/');
        if subpath.is_empty() {
            return self.match_ts_module(directory);
        }
        self.match_ts_module(&format!("{directory}/{subpath}"))
            .or_else(|| self.is_directory(directory).then(|| directory.clone()))
    }

    fn match_ts_module(&self, path: &str) -> Option<String> {
        if self.is_file(path) {
            return Some(path.to_owned());
        }
        // ESM-style "./x.js" refers to a compiled sibling of x.ts.
        if let Some(stem) = path
            .strip_suffix(".js")
            .or_else(|| path.strip_suffix(".jsx"))
        {
            for extension in ["ts", "tsx"] {
                let candidate = format!("{stem}.{extension}");
                if self.is_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
        for extension in TS_EXTENSIONS {
            let candidate = format!("{path}.{extension}");
            if self.is_file(&candidate) {
                return Some(candidate);
            }
        }
        for extension in TS_EXTENSIONS {
            let candidate = format!("{path}/index.{extension}");
            if self.is_file(&candidate) {
                return Some(candidate);
            }
        }
        self.is_directory(path).then(|| path.to_owned())
    }

    fn resolve_rust(&self, file_id: &str, specifier: &str) -> Option<String> {
        let mut segments: Vec<&str> = specifier.split("::").filter(|s| !s.is_empty()).collect();
        let base = match *segments.first()? {
            "std" | "core" | "alloc" => return None,
            "crate" => {
                segments.remove(0);
                self.crate_source_root(file_id)?
            }
            "self" => {
                segments.remove(0);
                module_dir(file_id)
            }
            "super" => {
                let mut directory = module_dir(file_id);
                while segments.first() == Some(&"super") {
                    segments.remove(0);
                    if directory.is_empty() {
                        return None;
                    }
                    directory = parent_dir(&directory);
                }
                directory
            }
            name => {
                let directory = self.cargo_crates.get(&name.replace('-', "_"))?;
                segments.remove(0);
                let source = format!("{directory}/src");
                if self.is_directory(&source) {
                    source
                } else {
                    directory.clone()
                }
            }
        };

        // Trailing segments are usually items, not modules: match the longest
        // leading run of segments that names a scanned module file.
        for take in (0..=segments.len()).rev() {
            let mut candidate = base.clone();
            for segment in &segments[..take] {
                if !candidate.is_empty() {
                    candidate.push('/');
                }
                candidate.push_str(segment);
            }
            if take > 0 {
                let as_file = format!("{candidate}.rs");
                if self.is_file(&as_file) {
                    return Some(as_file);
                }
                let as_module = format!("{candidate}/mod.rs");
                if self.is_file(&as_module) {
                    return Some(as_module);
                }
            } else {
                for root in ["lib.rs", "main.rs", "mod.rs"] {
                    let as_root = if candidate.is_empty() {
                        root.to_owned()
                    } else {
                        format!("{candidate}/{root}")
                    };
                    if self.is_file(&as_root) {
                        return Some(as_root);
                    }
                }
                if self.is_directory(&candidate) {
                    return Some(candidate);
                }
            }
        }
        None
    }

    /// Walks up from the file to the nearest registered crate and returns its
    /// source root.
    fn crate_source_root(&self, file_id: &str) -> Option<String> {
        let crate_dirs: BTreeSet<&String> = self.cargo_crates.values().collect();
        let mut directory = parent_dir(file_id);
        loop {
            if crate_dirs.contains(&directory) || (directory.is_empty() && crate_dirs.is_empty()) {
                let source = if directory.is_empty() {
                    "src".to_owned()
                } else {
                    format!("{directory}/src")
                };
                if self.is_directory(&source) {
                    return Some(source);
                }
                return Some(directory);
            }
            if directory.is_empty() {
                // No registered crate above the file; assume a plain src layout.
                return self.is_directory("src").then(|| "src".to_owned());
            }
            directory = parent_dir(&directory);
        }
    }
}

fn parent_dir(id: &str) -> String {
    id.rfind('/')
        .map_or_else(String::new, |i| id[..i].to_owned())
}

/// Directory whose children are the file's submodules.
fn module_dir(file_id: &str) -> String {
    let name = file_id.rsplit('/').next().unwrap_or(file_id);
    if matches!(name, "mod.rs" | "lib.rs" | "main.rs") {
        return parent_dir(file_id);
    }
    file_id.strip_suffix(".rs").unwrap_or(file_id).to_owned()
}

/// Joins a relative specifier onto a directory, staying inside the repository.
fn join_relative(directory: &str, specifier: &str) -> Option<String> {
    let mut segments: Vec<&str> = if directory.is_empty() {
        Vec::new()
    } else {
        directory.split('/').collect()
    };
    for segment in specifier.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            other => segments.push(other),
        }
    }
    Some(segments.join("/"))
}

/// Extracts the `name` field from a `Cargo.toml` `[package]` section.
pub(crate) fn cargo_package_name(text: &str) -> Option<String> {
    let mut in_package = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if !in_package {
            continue;
        }
        if let Some(value) = line.strip_prefix("name") {
            let Some(value) = value.trim_start().strip_prefix('=') else {
                continue;
            };
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            if !value.is_empty() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

/// Extracts the `name` field from a `package.json`.
pub(crate) fn npm_package_name(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_specifiers_against_scanned_nodes() {
        let nodes = BTreeMap::from(
            [
                ("app", true),
                ("app/src", true),
                ("app/src/main.ts", false),
                ("app/src/util.ts", false),
                ("app/src/widgets", true),
                ("app/src/widgets/index.ts", false),
                ("app/worker", true),
                ("core", true),
                ("core/src", true),
                ("core/src/lib.rs", false),
                ("core/src/scanner.rs", false),
                ("core/src/scanner", true),
                ("core/src/scanner/walk.rs", false),
                ("pkg", true),
                ("pkg/index.ts", false),
            ]
            .map(|(id, directory)| (id.to_owned(), directory)),
        );
        let npm = BTreeMap::from([("@app/pkg".to_owned(), "pkg".to_owned())]);
        let cargo = BTreeMap::from([("core_lib".to_owned(), "core".to_owned())]);
        let resolver = ImportResolver::new(&nodes, &npm, &cargo);

        let ts = |file: &str, spec: &str| resolver.resolve(ImportLanguage::TsJs, file, spec);
        assert_eq!(
            ts("app/src/main.ts", "./util"),
            Some("app/src/util.ts".to_owned())
        );
        assert_eq!(
            ts("app/src/main.ts", "./util.js"),
            Some("app/src/util.ts".to_owned())
        );
        assert_eq!(
            ts("app/src/main.ts", "./widgets"),
            Some("app/src/widgets/index.ts".to_owned()),
        );
        assert_eq!(
            ts("app/src/main.ts", "@app/pkg"),
            Some("pkg/index.ts".to_owned())
        );
        assert_eq!(ts("app/src/main.ts", "react"), None);
        assert_eq!(
            ts("app/src/main.ts", "../worker"),
            Some("app/worker".to_owned())
        );
        assert_eq!(
            ts("app/src/util.ts", "./util"),
            None,
            "self-imports are dropped"
        );

        let rust = |file: &str, spec: &str| resolver.resolve(ImportLanguage::Rust, file, spec);
        assert_eq!(
            rust("core/src/lib.rs", "crate::scanner::walk::Walker"),
            Some("core/src/scanner/walk.rs".to_owned()),
        );
        assert_eq!(
            rust("core/src/scanner/walk.rs", "super::super::scanner"),
            Some("core/src/scanner.rs".to_owned()),
        );
        assert_eq!(rust("core/src/scanner.rs", "std::fs"), None);
        assert_eq!(
            rust("app/src/main.ts", "core_lib::scanner"),
            Some("core/src/scanner.rs".to_owned()),
        );
    }

    #[test]
    fn reads_manifest_names() {
        assert_eq!(
            cargo_package_name("[workspace]\nmembers = []\n[package]\nname = \"my-crate\"\n"),
            Some("my-crate".to_owned()),
        );
        assert_eq!(cargo_package_name("[workspace]\nmembers = [\"a\"]\n"), None);
        assert_eq!(
            npm_package_name("{\"name\": \"@app/core\", \"version\": \"1.0.0\"}"),
            Some("@app/core".to_owned()),
        );
        assert_eq!(npm_package_name("{\"private\": true}"), None);
    }
}
