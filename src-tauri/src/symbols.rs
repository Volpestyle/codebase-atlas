//! Symbol and import extraction with tree-sitter.
//!
//! One parse per source file yields both halves of the fact layer: the
//! declarations a file defines, and the specifiers it imports together with the
//! named bindings that cross each import. Bindings are what make an arc on the
//! map say something — `App.tsx` does not merely import `model.ts`, it takes
//! `RepositoryGraph` and `layerForNode` from it.
//!
//! This is a parser, not a compiler. It reads what a file says at its top level
//! and does not follow re-exports, resolve types, or track which imported names
//! a body actually uses.

use serde::Serialize;
use tree_sitter::{Node, Parser};

/// Declarations kept per file. Generated sources can declare thousands; the
/// inspector and search only need the shape of a file, not every entry.
const MAX_SYMBOLS_PER_FILE: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImportLanguage {
    TsJs,
    Rust,
}

pub(crate) fn import_language(extension: Option<&str>) -> Option<ImportLanguage> {
    match extension {
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs") => Some(ImportLanguage::TsJs),
        Some("rs") => Some(ImportLanguage::Rust),
        _ => None,
    }
}

/// A declaration a file makes at its top level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Symbol {
    pub(crate) name: String,
    pub(crate) kind: SymbolKind,
    /// 1-based line of the declaration.
    pub(crate) line: u32,
    pub(crate) exported: bool,
}

/// Normalized across languages: every declaration is a behavior, a shape, or a
/// value. Finer language-specific distinctions do not survive a map legend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SymbolKind {
    Function,
    Type,
    Constant,
}

/// One import site: the specifier as written, and the names taken from it.
/// `names` is empty for side-effect imports and dynamic forms whose bindings
/// are not statically known, and holds `*` for namespace and glob imports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ImportRef {
    pub(crate) specifier: String,
    pub(crate) names: Vec<String>,
}

impl ImportRef {
    fn bare(specifier: impl Into<String>) -> Self {
        Self {
            specifier: specifier.into(),
            names: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct FileFacts {
    pub(crate) imports: Vec<ImportRef>,
    pub(crate) symbols: Vec<Symbol>,
}

/// Parses one source file. Returns empty facts when the grammar cannot load or
/// the file does not parse into a usable tree.
pub(crate) fn extract(language: ImportLanguage, extension: Option<&str>, text: &str) -> FileFacts {
    let grammar = match language {
        ImportLanguage::Rust => tree_sitter_rust::LANGUAGE.into(),
        ImportLanguage::TsJs => match extension {
            Some("ts") => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            // JSX is valid in .js/.jsx across the ecosystem, and the TSX
            // grammar is the superset that reads both.
            _ => tree_sitter_typescript::LANGUAGE_TSX.into(),
        },
    };
    let mut parser = Parser::new();
    if parser.set_language(&grammar).is_err() {
        return FileFacts::default();
    }
    let Some(tree) = parser.parse(text, None) else {
        return FileFacts::default();
    };

    let root = tree.root_node();
    let mut facts = FileFacts::default();
    match language {
        ImportLanguage::TsJs => {
            ts_imports(root, text, &mut facts.imports);
            ts_symbols(root, text, &mut facts.symbols);
        }
        ImportLanguage::Rust => {
            rust_imports(root, text, &mut facts.imports, 0);
            rust_symbols(root, text, &mut facts.symbols, false);
        }
    }
    facts.symbols.truncate(MAX_SYMBOLS_PER_FILE);
    facts
}

fn text_of<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    node.utf8_text(source.as_bytes()).unwrap_or_default()
}

fn line_of(node: Node<'_>) -> u32 {
    u32::try_from(node.start_position().row + 1).unwrap_or(u32::MAX)
}

/// Strips the surrounding quotes from a string literal node.
fn string_value(node: Node<'_>, source: &str) -> Option<String> {
    let raw = text_of(node, source);
    let value = raw
        .strip_prefix(['"', '\'', '`'])
        .and_then(|rest| rest.strip_suffix(['"', '\'', '`']))?;
    (!value.is_empty()).then(|| value.to_owned())
}

fn children<'a>(node: Node<'a>) -> impl Iterator<Item = Node<'a>> {
    let mut cursor = node.walk();
    let nodes: Vec<Node<'a>> = node.children(&mut cursor).collect();
    nodes.into_iter()
}

// -- TypeScript / JavaScript -------------------------------------------------

fn ts_imports(node: Node<'_>, source: &str, out: &mut Vec<ImportRef>) {
    match node.kind() {
        // `import ... from "x"` and `export ... from "x"`.
        "import_statement" | "export_statement" => {
            if let Some(specifier) = node
                .child_by_field_name("source")
                .and_then(|source_node| string_value(source_node, source))
            {
                let mut names = Vec::new();
                for child in children(node) {
                    ts_binding_names(child, source, &mut names);
                }
                names.sort_unstable();
                names.dedup();
                out.push(ImportRef { specifier, names });
            }
        }
        // `require("x")` and `import("x")`: bindings are not statically known.
        "call_expression" => {
            let callee = node.child_by_field_name("function");
            let is_module_call = callee.is_some_and(|callee| {
                callee.kind() == "import" || text_of(callee, source) == "require"
            });
            if is_module_call {
                if let Some(specifier) = node
                    .child_by_field_name("arguments")
                    .and_then(|arguments| children(arguments).find(|node| node.kind() == "string"))
                    .and_then(|argument| string_value(argument, source))
                {
                    out.push(ImportRef::bare(specifier));
                }
            }
        }
        // `new URL("./worker", import.meta.url)` names a module-relative file.
        // A `URL` built against any other base is an ordinary runtime value.
        "new_expression"
            if node
                .child_by_field_name("constructor")
                .is_some_and(|callee| text_of(callee, source) == "URL") =>
        {
            let literals: Vec<Node<'_>> = node
                .child_by_field_name("arguments")
                .map(|arguments| children(arguments).collect())
                .unwrap_or_default();
            let relative_to_module = literals
                .iter()
                .any(|node| text_of(*node, source) == "import.meta.url");
            let specifier = literals
                .iter()
                .find(|node| node.kind() == "string")
                .and_then(|node| string_value(*node, source));
            if let (true, Some(specifier)) = (relative_to_module, specifier) {
                out.push(ImportRef::bare(specifier));
            }
        }
        _ => {}
    }
    for child in children(node) {
        ts_imports(child, source, out);
    }
}

/// Collects the names an import or re-export clause takes from its module. An
/// aliased binding contributes the *source* name, since that is the symbol the
/// target file exports.
fn ts_binding_names(node: Node<'_>, source: &str, out: &mut Vec<String>) {
    match node.kind() {
        "import_clause" | "named_imports" | "export_clause" => {
            for child in children(node) {
                ts_binding_names(child, source, out);
            }
        }
        "import_specifier" | "export_specifier" => {
            if let Some(name) = node.child_by_field_name("name") {
                out.push(text_of(name, source).to_owned());
            }
        }
        // `import Default from "x"` binds the module's default export.
        "identifier" => out.push(text_of(node, source).to_owned()),
        // `import * as ns from "x"` / `export * from "x"` take the whole module.
        "namespace_import" | "namespace_export" | "*" => out.push("*".to_owned()),
        _ => {}
    }
}

fn ts_symbols(root: Node<'_>, source: &str, out: &mut Vec<Symbol>) {
    for child in children(root) {
        // `export function f() {}` wraps the declaration one level down.
        let (declaration, exported) = if child.kind() == "export_statement" {
            match child.child_by_field_name("declaration") {
                Some(declaration) => (declaration, true),
                None => continue,
            }
        } else {
            (child, false)
        };
        ts_declaration(declaration, source, exported, out);
    }
}

fn ts_declaration(node: Node<'_>, source: &str, exported: bool, out: &mut Vec<Symbol>) {
    let kind = match node.kind() {
        "function_declaration" | "generator_function_declaration" | "function_signature" => {
            SymbolKind::Function
        }
        "class_declaration"
        | "abstract_class_declaration"
        | "interface_declaration"
        | "type_alias_declaration"
        | "enum_declaration" => SymbolKind::Type,
        // `const x = ...`: a value unless it is bound to a function.
        "lexical_declaration" | "variable_declaration" => {
            for declarator in children(node).filter(|node| node.kind() == "variable_declarator") {
                let Some(name) = declarator.child_by_field_name("name") else {
                    continue;
                };
                // Destructuring binds several names at once and reads as noise
                // in a symbol list; only plain identifiers become symbols.
                if name.kind() != "identifier" {
                    continue;
                }
                let bound_to_function = declarator.child_by_field_name("value").is_some_and(|value| {
                    matches!(
                        value.kind(),
                        "arrow_function" | "function_expression" | "function" | "generator_function"
                    )
                });
                out.push(Symbol {
                    name: text_of(name, source).to_owned(),
                    kind: if bound_to_function {
                        SymbolKind::Function
                    } else {
                        SymbolKind::Constant
                    },
                    line: line_of(declarator),
                    exported,
                });
            }
            return;
        }
        _ => return,
    };
    if let Some(name) = node.child_by_field_name("name") {
        out.push(Symbol {
            name: text_of(name, source).to_owned(),
            kind,
            line: line_of(node),
            exported,
        });
    }
}

// -- Rust --------------------------------------------------------------------

fn rust_imports(node: Node<'_>, source: &str, out: &mut Vec<ImportRef>, mod_depth: usize) {
    for child in children(node) {
        match child.kind() {
            "use_declaration" => {
                let Some(argument) = child.child_by_field_name("argument") else {
                    continue;
                };
                let mut leaves = Vec::new();
                use_tree(argument, source, "", &mut leaves);
                out.extend(
                    leaves
                        .into_iter()
                        .filter_map(|leaf| rebase_super(leaf, mod_depth)),
                );
            }
            // An inline module nests the file's own module one level deeper.
            "mod_item" => {
                if let Some(body) = child.child_by_field_name("body") {
                    rust_imports(body, source, out, mod_depth + 1);
                }
            }
            _ => rust_imports(child, source, out, mod_depth),
        }
    }
}

/// Rewrites a `super`-relative path written inside an inline module so it is
/// relative to the file instead. Each enclosing `mod` block consumes one
/// `super`, because the first one only climbs back out to the file's own
/// module — the reason `use super::*;` in a `mod tests` block imports the file
/// around it rather than the directory above. A path that lands on the file
/// itself crosses no boundary and yields no edge.
fn rebase_super(reference: ImportRef, mod_depth: usize) -> Option<ImportRef> {
    let mut path = reference.specifier.as_str();
    let mut consumed = 0;
    while consumed < mod_depth {
        let Some(rest) = path.strip_prefix("super") else {
            break;
        };
        path = rest.strip_prefix("::").unwrap_or("");
        consumed += 1;
    }
    if consumed == 0 {
        return Some(reference);
    }
    if path.is_empty() {
        return None;
    }
    let specifier = if path.starts_with("super") {
        path.to_owned()
    } else {
        format!("self::{path}")
    };
    Some(ImportRef {
        specifier,
        names: reference.names,
    })
}

/// Expands a `use` tree into one fully-qualified path per leaf, so grouped and
/// multi-line forms (`use crate::{a::B, c}`) resolve as precisely as the
/// single-path form they are shorthand for.
fn use_tree(node: Node<'_>, source: &str, prefix: &str, out: &mut Vec<ImportRef>) {
    let join = |segment: &str| {
        if prefix.is_empty() {
            segment.to_owned()
        } else {
            format!("{prefix}::{segment}")
        }
    };
    match node.kind() {
        "scoped_use_list" => {
            let path = node
                .child_by_field_name("path")
                .map_or_else(|| prefix.to_owned(), |path| join(text_of(path, source)));
            if let Some(list) = node.child_by_field_name("list") {
                for child in children(list) {
                    use_tree(child, source, &path, out);
                }
            }
        }
        "use_list" => {
            for child in children(node) {
                use_tree(child, source, prefix, out);
            }
        }
        "use_as_clause" => {
            // The alias is local; the crossing symbol keeps its source name.
            if let Some(path) = node.child_by_field_name("path") {
                use_tree(path, source, prefix, out);
            }
        }
        "use_wildcard" => {
            let path = children(node)
                .find(|child| child.kind() != "*" && !child.is_extra())
                .map_or_else(|| prefix.to_owned(), |path| join(text_of(path, source)));
            out.push(ImportRef {
                specifier: path,
                names: vec!["*".to_owned()],
            });
        }
        // `use crate::imports::{self, Thing}`: `self` names the module itself.
        "self" if !prefix.is_empty() => out.push(ImportRef::bare(prefix.to_owned())),
        "scoped_identifier" | "identifier" | "crate" | "super" | "self" | "type_identifier" => {
            let path = join(text_of(node, source));
            let name = path.rsplit("::").next().unwrap_or(&path).to_owned();
            out.push(ImportRef {
                specifier: path,
                names: vec![name],
            });
        }
        _ => {}
    }
}

fn rust_symbols(node: Node<'_>, source: &str, out: &mut Vec<Symbol>, nested: bool) {
    for child in children(node) {
        let exported = children(child).any(|node| node.kind() == "visibility_modifier");
        let kind = match child.kind() {
            "function_item" | "macro_definition" => SymbolKind::Function,
            "struct_item" | "enum_item" | "union_item" | "trait_item" | "type_item" => {
                SymbolKind::Type
            }
            "const_item" | "static_item" => SymbolKind::Constant,
            // An impl block's methods are the type's real surface, so they are
            // listed as `Type::method` rather than dropped with the block.
            "impl_item" => {
                rust_impl_methods(child, source, out);
                continue;
            }
            // Inline modules hold declarations that belong to this file.
            "mod_item" => {
                if let Some(body) = child.child_by_field_name("body") {
                    rust_symbols(body, source, out, true);
                }
                continue;
            }
            _ => continue,
        };
        if let Some(name) = child.child_by_field_name("name") {
            out.push(Symbol {
                name: text_of(name, source).to_owned(),
                kind,
                line: line_of(child),
                // A `pub` item inside a private inline module is not reachable
                // from outside the file.
                exported: exported && !nested,
            });
        }
    }
}

fn rust_impl_methods(node: Node<'_>, source: &str, out: &mut Vec<Symbol>) {
    let Some(type_name) = node.child_by_field_name("type") else {
        return;
    };
    let type_name = text_of(type_name, source);
    let Some(body) = node.child_by_field_name("body") else {
        return;
    };
    for item in children(body).filter(|item| item.kind() == "function_item") {
        let Some(name) = item.child_by_field_name("name") else {
            continue;
        };
        out.push(Symbol {
            name: format!("{type_name}::{}", text_of(name, source)),
            kind: SymbolKind::Function,
            line: line_of(item),
            exported: children(item).any(|node| node.kind() == "visibility_modifier"),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn specifiers(facts: &FileFacts) -> Vec<&str> {
        let mut list: Vec<&str> = facts
            .imports
            .iter()
            .map(|entry| entry.specifier.as_str())
            .collect();
        list.sort_unstable();
        list.dedup();
        list
    }

    fn names_for<'a>(facts: &'a FileFacts, specifier: &str) -> Vec<&'a str> {
        facts
            .imports
            .iter()
            .filter(|entry| entry.specifier == specifier)
            .flat_map(|entry| entry.names.iter().map(String::as_str))
            .collect()
    }

    #[test]
    fn reads_ts_imports_with_their_bindings() {
        let source = r#"
import a from "./a";
import { b, c as renamed } from '../lib/b.js';
import * as everything from "./ns";
import "./effects";
import {
  multi,
  line,
} from "./wrapped";
export * from "@app/core";
export { picked } from "./picked";
const c = require('./c');
await import("./d");
const worker = new URL("../worker", import.meta.url);
const external = new URL("./ignored", baseUrl);
// import x from "./ignored";
"#;
        let facts = extract(ImportLanguage::TsJs, Some("ts"), source);
        assert_eq!(
            specifiers(&facts),
            [
                "../lib/b.js",
                "../worker",
                "./a",
                "./c",
                "./d",
                "./effects",
                "./ns",
                "./picked",
                "./wrapped",
                "@app/core",
            ]
        );
        assert_eq!(names_for(&facts, "./a"), ["a"]);
        assert_eq!(names_for(&facts, "../lib/b.js"), ["b", "c"]);
        assert_eq!(names_for(&facts, "./ns"), ["*"]);
        assert!(names_for(&facts, "./effects").is_empty());
        assert_eq!(names_for(&facts, "./wrapped"), ["line", "multi"]);
        assert_eq!(names_for(&facts, "./picked"), ["picked"]);
        assert_eq!(names_for(&facts, "@app/core"), ["*"]);
    }

    #[test]
    fn reads_ts_declarations() {
        let source = r"
export function visible() {}
function hidden() {}
export const arrow = () => 1;
export const VALUE = 4;
const { destructured } = thing;
export interface Shape { a: number }
export type Alias = Shape;
export class Widget {}
export enum Mode { On }
";
        let facts = extract(ImportLanguage::TsJs, Some("tsx"), source);
        let found: Vec<(&str, SymbolKind, bool)> = facts
            .symbols
            .iter()
            .map(|symbol| (symbol.name.as_str(), symbol.kind, symbol.exported))
            .collect();
        assert_eq!(
            found,
            [
                ("visible", SymbolKind::Function, true),
                ("hidden", SymbolKind::Function, false),
                ("arrow", SymbolKind::Function, true),
                ("VALUE", SymbolKind::Constant, true),
                ("Shape", SymbolKind::Type, true),
                ("Alias", SymbolKind::Type, true),
                ("Widget", SymbolKind::Type, true),
                ("Mode", SymbolKind::Type, true),
            ]
        );
        assert_eq!(facts.symbols[0].line, 2);
    }

    #[test]
    fn expands_rust_use_trees() {
        let source = r"
use std::{
    collections::{BTreeMap, HashMap},
    fs,
};
use crate::imports::{self, ImportLanguage, ImportResolver};
pub use super::scanner::ScanState;
use other_crate::Thing as Renamed;
use prelude::*;
";
        let facts = extract(ImportLanguage::Rust, Some("rs"), source);
        assert_eq!(
            specifiers(&facts),
            [
                "crate::imports",
                "crate::imports::ImportLanguage",
                "crate::imports::ImportResolver",
                "other_crate::Thing",
                "prelude",
                "std::collections::BTreeMap",
                "std::collections::HashMap",
                "std::fs",
                "super::scanner::ScanState",
            ]
        );
        assert_eq!(names_for(&facts, "super::scanner::ScanState"), ["ScanState"]);
        assert_eq!(names_for(&facts, "other_crate::Thing"), ["Thing"]);
        assert_eq!(names_for(&facts, "prelude"), ["*"]);
        assert!(names_for(&facts, "crate::imports").is_empty());
    }

    #[test]
    fn rebases_super_paths_written_inside_inline_modules() {
        let source = r"
use super::sibling::Thing;
mod tests {
    use super::*;
    use super::super::sibling::Other;
    use crate::root::Absolute;
}
";
        let facts = extract(ImportLanguage::Rust, Some("rs"), source);
        assert_eq!(
            specifiers(&facts),
            [
                "crate::root::Absolute",
                "super::sibling::Other",
                "super::sibling::Thing",
            ],
            "`use super::*` in a test module names the file itself, not its parent",
        );
    }

    #[test]
    fn reads_rust_declarations_including_impl_methods() {
        let source = r"
pub fn exported() {}
fn private() {}
pub struct State { field: u8 }
pub(crate) enum Mode { On }
pub trait Walk {}
const LIMIT: usize = 4;
impl State {
    pub fn new() -> Self { Self { field: 0 } }
    fn helper(&self) {}
}
";
        let facts = extract(ImportLanguage::Rust, Some("rs"), source);
        let found: Vec<(&str, SymbolKind, bool)> = facts
            .symbols
            .iter()
            .map(|symbol| (symbol.name.as_str(), symbol.kind, symbol.exported))
            .collect();
        assert_eq!(
            found,
            [
                ("exported", SymbolKind::Function, true),
                ("private", SymbolKind::Function, false),
                ("State", SymbolKind::Type, true),
                ("Mode", SymbolKind::Type, true),
                ("Walk", SymbolKind::Type, true),
                ("LIMIT", SymbolKind::Constant, false),
                ("State::new", SymbolKind::Function, true),
                ("State::helper", SymbolKind::Function, false),
            ]
        );
    }
}
