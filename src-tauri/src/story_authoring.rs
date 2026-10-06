//! Facts for the user's coding agent, and validation/coverage for its story.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write,
    fs,
    path::Path,
};

use crate::scanner::{EdgeKind, NodeKind, RepositoryGraph, RepositoryNode};

const RULES: &str = include_str!("../../docs/writing-a-story.md");
const MAX_MODULES: usize = 150;
const MAX_ROUTES: usize = 150;
const MAX_DECLARATIONS: usize = 6;
const MAX_CROSSINGS: usize = 8;
const MAX_LABEL_CHARS: usize = 240;
const MAX_UNCOVERED: usize = 150;
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

/// A fresh scan's story validation and informational product-source coverage.
#[derive(Debug)]
pub struct StoryCheck {
    pub report: String,
    pub warnings: Vec<String>,
    pub valid: bool,
}

/// Produces the rules, bounded scan digest, existing story, and warnings.
///
/// # Errors
/// Returns the same folder/access errors as `scan`.
pub fn story_brief(path: &Path) -> Result<String, String> {
    let graph = crate::scan(path)?;
    let mut output = format!("{RULES}\n{}", digest(&graph));
    output.push_str("\n## Existing story\n\n");
    let story_path = path.join(".codebase-index/_story.json");
    // The scanner has already checked size, parsing, and validity. Preserve
    // the original here so an agent can fix pieces validation dropped.
    if fs::metadata(&story_path).is_ok_and(|metadata| metadata.len() <= crate::story::MAX_BYTES) {
        if let Ok(text) = fs::read_to_string(&story_path) {
            output.push_str(&text);
            output.push('\n');
        } else {
            output.push_str("The existing story could not be read.\n");
        }
    } else {
        output.push_str("No readable story within the 256 KiB limit.\n");
    }
    output.push_str("\n## Scan and validation warnings\n\n");
    if graph.warnings.is_empty() {
        output.push_str("None.\n");
    }
    for warning in &graph.warnings {
        writeln!(output, "- {warning}").expect("write string");
    }
    Ok(output)
}

/// Checks the story through the fresh scan's `attach_story` / `validate` path.
/// Coverage is informational and never determines validity.
///
/// # Errors
/// Returns the same folder/access errors as `scan`.
pub fn story_check(path: &Path) -> Result<StoryCheck, String> {
    let graph = crate::scan(path)?;
    let mut warnings = graph.warnings.clone();
    if graph.story.is_none() {
        warnings.push("No usable story exists at .codebase-index/_story.json.".to_owned());
    }
    let modules: BTreeSet<&str> = graph
        .story
        .iter()
        .flat_map(|story| &story.actors)
        .flat_map(|actor| &actor.modules)
        .map(String::as_str)
        .collect();
    let product: Vec<_> = graph
        .nodes
        .iter()
        .filter(|node| is_product_source(node))
        .collect();
    let total: u64 = product.iter().map(|node| node.lines).sum();
    let mut uncovered: Vec<_> = product
        .into_iter()
        .filter(|node| {
            !modules.iter().any(|module| {
                *module == "." || node.id == *module || node.id.starts_with(&format!("{module}/"))
            })
        })
        .collect();
    let uncovered_lines: u64 = uncovered.iter().map(|node| node.lines).sum();
    let covered = total - uncovered_lines;
    let percent = if total == 0 {
        0
    } else {
        (u128::from(covered) * 1000 + u128::from(total) / 2) / u128::from(total)
    };
    let mut report = format!(
        "Product-source coverage: {covered}/{total} scanned lines ({}.{}%).\n",
        percent / 10,
        percent % 10
    );
    if total == 0 {
        report.push_str("No counted product-source lines; coverage is unavailable.\n");
    }
    if graph.stats.truncated {
        report.push_str("Partial scan: coverage describes only the scanned files.\n");
    }
    report.push_str("Uncovered files (largest first):\n");
    uncovered.sort_by(|left, right| {
        right
            .lines
            .cmp(&left.lines)
            .then_with(|| left.id.cmp(&right.id))
    });
    for node in uncovered.iter().take(MAX_UNCOVERED) {
        writeln!(report, "- {}: {} lines", node.id, node.lines).expect("write string");
    }
    if uncovered.is_empty() {
        report.push_str("None.\n");
    } else if uncovered.len() > MAX_UNCOVERED {
        writeln!(
            report,
            "{} more uncovered files omitted.",
            uncovered.len() - MAX_UNCOVERED
        )
        .expect("write string");
    }
    Ok(StoryCheck {
        valid: warnings.is_empty(),
        report,
        warnings,
    })
}

// Match model.ts's test layer, including support directories and filename
// suffixes. Only source nodes enter the denominator, so docs/config stay out.
fn is_product_source(node: &RepositoryNode) -> bool {
    if node.kind != NodeKind::Source {
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
    ![".test", ".spec", "_test", ".config"]
        .iter()
        .any(|suffix| stem.ends_with(suffix))
}

fn module_id(id: &str, depth: usize) -> String {
    if depth == 0 {
        return ".".to_owned();
    }
    id.split('/').take(depth).collect::<Vec<_>>().join("/")
}

fn label(value: &str) -> String {
    let mut text: String = value
        .chars()
        .take(MAX_LABEL_CHARS)
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    if value.chars().count() > MAX_LABEL_CHARS {
        text.push('…');
    }
    text
}

#[derive(Default)]
struct Module {
    lines: u64,
    declarations: BTreeSet<String>,
}

fn digest(graph: &RepositoryGraph) -> String {
    let max_depth = graph.nodes.iter().map(|node| node.depth).max().unwrap_or(0);
    let depth = (0..=max_depth)
        .take_while(|depth| {
            graph
                .nodes
                .iter()
                .filter(|node| node.depth > 0 || *depth == 0)
                .map(|node| module_id(&node.id, *depth))
                .collect::<BTreeSet<_>>()
                .len()
                <= MAX_MODULES
        })
        .last()
        .unwrap_or(0);
    let mut modules: BTreeMap<String, Module> = BTreeMap::new();
    let mut node_modules = BTreeMap::new();
    for node in &graph.nodes {
        node_modules.insert(node.id.as_str(), module_id(&node.id, depth));
        if node.depth <= depth && (node.depth > 0 || depth == 0) {
            modules.insert(
                node.id.clone(),
                Module {
                    lines: node.lines,
                    declarations: BTreeSet::new(),
                },
            );
        }
    }
    for node in &graph.nodes {
        if matches!(node.kind, NodeKind::Repository | NodeKind::Directory) {
            continue;
        }
        for level in 0..=node.depth.min(depth) {
            if let Some(module) = modules.get_mut(&module_id(&node.id, level)) {
                module.declarations.extend(
                    node.symbols
                        .iter()
                        .filter(|symbol| symbol.exported)
                        .map(|symbol| symbol.name.clone()),
                );
            }
        }
    }
    let mut output = format!(
        "\n## Scan digest: {}\n\nDirectory level {depth}; {} modules. Directory lines include descendants; do not sum overlapping rows. Labels are limited to {MAX_LABEL_CHARS} characters.\n\n### Modules\n\n",
        label(&graph.name),
        modules.len()
    );
    for (id, module) in &modules {
        let names = module
            .declarations
            .iter()
            .take(MAX_DECLARATIONS)
            .map(|name| label(name))
            .collect::<Vec<_>>()
            .join(", ");
        write!(
            output,
            "- {}: {} lines; exports: {}",
            label(id),
            module.lines,
            if names.is_empty() { "none" } else { &names }
        )
        .expect("write string");
        if module.declarations.len() > MAX_DECLARATIONS {
            write!(
                output,
                " (+{} omitted)",
                module.declarations.len() - MAX_DECLARATIONS
            )
            .expect("write string");
        }
        output.push('\n');
    }
    append_routes(graph, &node_modules, &mut output);
    output
}

fn append_routes(
    graph: &RepositoryGraph,
    node_modules: &BTreeMap<&str, String>,
    output: &mut String,
) {
    let mut routes: BTreeMap<(&str, &str), (usize, BTreeSet<&str>)> = BTreeMap::new();
    for edge in graph
        .edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::Imports)
    {
        let (Some(from), Some(to)) = (
            node_modules.get(edge.source.as_str()),
            node_modules.get(edge.target.as_str()),
        ) else {
            continue;
        };
        if from == to {
            continue;
        }
        let route = routes.entry((from, to)).or_default();
        route.0 += 1;
        route.1.extend(edge.symbols.iter().map(String::as_str));
    }
    let mut ranked: Vec<_> = routes.iter().collect();
    ranked.sort_by(|left, right| right.1.0.cmp(&left.1.0).then_with(|| left.0.cmp(right.0)));
    output.push_str("\n### Imports between modules (heaviest first)\n\n");
    for ((from, to), (count, names)) in ranked.iter().take(MAX_ROUTES) {
        let crossing = names
            .iter()
            .take(MAX_CROSSINGS)
            .map(|name| label(name))
            .collect::<Vec<_>>()
            .join(", ");
        write!(
            output,
            "- {} -> {}: {count} imports; takes: {}",
            label(from),
            label(to),
            if crossing.is_empty() {
                "no named bindings"
            } else {
                &crossing
            }
        )
        .expect("write string");
        if names.len() > MAX_CROSSINGS {
            write!(output, " (+{} names omitted)", names.len() - MAX_CROSSINGS)
                .expect("write string");
        }
        output.push('\n');
    }
    if routes.len() > MAX_ROUTES {
        writeln!(output, "{} more routes omitted.", routes.len() - MAX_ROUTES)
            .expect("write string");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, path: &str, body: &str) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, body).unwrap();
    }

    fn story(root: &Path, modules: &[&str]) {
        write(root, ".codebase-index/_story.json", &serde_json::json!({
            "summary": "A tiny product.",
            "actors": [{ "id": "core", "name": "The core", "role": "core", "blurb": "Works.", "modules": modules }],
            "flows": []
        }).to_string());
    }

    #[test]
    fn coverage_uses_the_union_and_excludes_support_config_and_docs() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "src/main.ts",
            "export const one = 1;\nexport const two = 2;\n",
        );
        write(root.path(), "src/small.ts", "export const small = 1;\n");
        write(
            root.path(),
            "other.ts",
            "const a = 1;\nconst b = 2;\nconst c = 3;\n",
        );
        for path in [
            "src/a.test.ts",
            "src/a.spec.ts",
            "src/a_test.ts",
            "Fixtures/a.ts",
            "tests/a.ts",
            "spec/b.ts",
            "e2e/c.ts",
            "__mocks__/d.ts",
        ] {
            write(root.path(), path, "const test = 1;\n");
        }
        write(root.path(), "README.md", "Docs\n");
        write(root.path(), "package.json", "{}\n");
        write(root.path(), "Cargo.lock", "version = 4\n");
        write(root.path(), "vite.config.ts", "export default {};\n");
        story(root.path(), &["src/main.ts", "src/main.ts"]);
        let check = story_check(root.path()).unwrap();
        assert!(check.valid, "{:?}", check.warnings);
        assert!(
            check.report.contains("2/6 scanned lines (33.3%)"),
            "{}",
            check.report
        );
        assert!(
            check.report.find("other.ts: 3").unwrap()
                < check.report.find("src/small.ts: 1").unwrap()
        );
        story(root.path(), &["src", "src/main.ts"]);
        assert!(
            story_check(root.path())
                .unwrap()
                .report
                .contains("3/6 scanned lines (50.0%)")
        );
        story(root.path(), &["."]);
        assert!(
            story_check(root.path())
                .unwrap()
                .report
                .contains("6/6 scanned lines (100.0%)")
        );
        story(root.path(), &[]);
        assert!(
            story_check(root.path()).unwrap().valid,
            "zero coverage is informational"
        );
    }

    #[test]
    fn check_reuses_story_validation_and_brief_preserves_the_original() {
        let root = tempfile::tempdir().unwrap();
        assert!(!story_check(root.path()).unwrap().valid);
        write(root.path(), "src/main.ts", "export const main = 1;\n");
        story(root.path(), &["gone"]);
        let check = story_check(root.path()).unwrap();
        assert!(!check.valid);
        assert!(
            check
                .warnings
                .iter()
                .any(|warning| warning.contains("gone"))
        );
        assert!(story_brief(root.path()).unwrap().contains("\"gone\""));
        write(root.path(), ".codebase-index/_story.json", "{ broken");
        assert!(!story_check(root.path()).unwrap().valid);
        let brief = story_brief(root.path()).unwrap();
        assert!(brief.contains("{ broken"));
        assert!(brief.contains("The story file could not be read:"));
        assert!(brief.starts_with(RULES));
        assert!(story_check(&root.path().join("missing")).is_err());
    }

    #[test]
    fn digest_bounds_modules_exports_routes_and_crossings() {
        let root = tempfile::tempdir().unwrap();
        for module in 0..12 {
            for file in 0..20 {
                let mut body = String::new();
                for i in 0..20 {
                    writeln!(body, "export const value{i} = {i};").unwrap();
                }
                for target in 0..12 {
                    if target != module {
                        writeln!(
                            body,
                            "import {{ {} }} from '../m{target}/f0';",
                            (0..20)
                                .map(|i| format!("value{i}"))
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                        .unwrap();
                    }
                }
                write(root.path(), &format!("m{module}/f{file}.ts"), &body);
            }
        }
        let graph = crate::scan(root.path()).unwrap();
        let text = digest(&graph);
        assert!(text.contains("Directory level 1; 12 modules"), "{text}");
        assert!(text.contains("+14 omitted"));
        assert!(text.contains("+12 names omitted"));
        let rows = text
            .split("### Modules\n\n")
            .nth(1)
            .unwrap()
            .split("\n### Imports")
            .next()
            .unwrap();
        assert_eq!(
            rows.lines().filter(|line| line.starts_with("- ")).count(),
            12
        );
        assert!(text.len() < 70_000);

        // Flat repositories collapse to the root rather than silently hiding files.
        for i in 0..160 {
            write(
                root.path(),
                &format!("flat{i}.ts"),
                "export const flat = 1;\n",
            );
        }
        assert!(
            digest(&crate::scan(root.path()).unwrap()).contains("Directory level 0; 1 modules")
        );
    }

    #[test]
    fn digest_keeps_directory_import_targets_and_caps_route_count() {
        let root = tempfile::tempdir().unwrap();
        for module in 0..20 {
            let mut body = "export const value = 1;\n".to_owned();
            for target in 0..20 {
                if target != module {
                    writeln!(body, "import {{ value }} from '../m{target}';").unwrap();
                }
            }
            write(root.path(), &format!("m{module}/index.ts"), &body);
        }
        let graph = crate::scan(root.path()).unwrap();
        let text = digest(&graph);
        assert!(text.contains("230 more routes omitted."), "{text}");
        let routes = text
            .split("### Imports between modules (heaviest first)\n\n")
            .nth(1)
            .unwrap();
        assert_eq!(
            routes.lines().filter(|line| line.starts_with("- ")).count(),
            MAX_ROUTES
        );
        assert!(routes.contains("takes: value"));
        assert_eq!(
            label(&"a".repeat(1000)).chars().count(),
            MAX_LABEL_CHARS + 1
        );
    }
}
