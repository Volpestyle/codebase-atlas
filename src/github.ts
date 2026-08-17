import { parseGitHubRepositoryUrl } from "./github-url.ts";
import type {
  RepositoryEdge,
  RepositoryGraph,
  RepositoryNode,
  RepositoryNodeKind,
} from "./model.ts";

const API_VERSION = "2026-03-10";
const MAX_NODES = 4_000;
const generatedDirectories = new Set([
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
]);

interface GitHubRepositoryResponse {
  name: string;
  full_name: string;
  default_branch: string;
  html_url: string;
}

interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

interface GitHubTreeResponse {
  tree: GitHubTreeEntry[];
  truncated: boolean;
}

interface Classification {
  kind: RepositoryNodeKind;
  language: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function githubJson(url: string, notFoundMessage: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
  } catch {
    throw new Error("Could not reach GitHub. Check your connection and try again.");
  }

  if (!response.ok) {
    if (response.status === 404) throw new Error(notFoundMessage);
    if (response.status === 409) throw new Error("This GitHub repository has no commits to map.");
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const retry = Number.isFinite(reset)
        ? ` Try again after ${new Date(reset * 1000).toLocaleTimeString()}.`
        : " Try again later.";
      throw new Error(`GitHub's public API rate limit has been reached.${retry}`);
    }
    throw new Error(`GitHub could not load this repository (HTTP ${response.status}).`);
  }

  return response.json();
}

function repositoryResponse(value: unknown): GitHubRepositoryResponse {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.full_name !== "string" ||
    typeof value.default_branch !== "string" ||
    typeof value.html_url !== "string"
  ) {
    throw new Error("GitHub returned an unexpected repository response.");
  }
  return {
    name: value.name,
    full_name: value.full_name,
    default_branch: value.default_branch,
    html_url: value.html_url,
  };
}

function treeResponse(value: unknown): GitHubTreeResponse {
  if (!isRecord(value) || !Array.isArray(value.tree) || typeof value.truncated !== "boolean") {
    throw new Error("GitHub returned an unexpected repository tree.");
  }

  const tree = value.tree.flatMap((entry): GitHubTreeEntry[] => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      (entry.type !== "blob" && entry.type !== "tree" && entry.type !== "commit") ||
      (entry.size !== undefined && typeof entry.size !== "number")
    ) {
      return [];
    }
    return [{ path: entry.path, type: entry.type, size: entry.size }];
  });
  return { tree, truncated: value.truncated };
}

function classify(path: string): Classification {
  const pathParts = path.split("/");
  const name = (pathParts[pathParts.length - 1] ?? path).toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";

  if (name.startsWith("dockerfile")) return { kind: "config", language: "Dockerfile" };
  if (name === "makefile" || name === "gnumakefile") return { kind: "config", language: "Makefile" };
  if (name === "cmakelists.txt") return { kind: "config", language: "CMake" };
  if (name === "cargo.lock") return { kind: "config", language: "TOML" };
  if (name.startsWith(".env") || [".editorconfig", ".gitattributes", ".gitignore", ".ignore"].includes(name)) {
    return { kind: "config", language: null };
  }
  if (["changelog", "contributing", "copying", "license", "readme"].includes(name)) {
    return { kind: "documentation", language: null };
  }

  const languages: Record<string, string> = {
    rs: "Rust",
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    mjs: "JavaScript",
    cjs: "JavaScript",
    py: "Python",
    pyi: "Python",
    swift: "Swift",
    kt: "Kotlin",
    kts: "Kotlin",
    java: "Java",
    go: "Go",
    c: "C",
    h: "C",
    cc: "C++",
    cpp: "C++",
    cxx: "C++",
    hh: "C++",
    hpp: "C++",
    hxx: "C++",
    rb: "Ruby",
    php: "PHP",
    cs: "C#",
    sh: "Shell",
    bash: "Shell",
    zsh: "Shell",
    fish: "Shell",
    html: "HTML",
    htm: "HTML",
    css: "CSS",
    scss: "CSS",
    sass: "CSS",
    less: "CSS",
  };
  if (languages[extension]) return { kind: "source", language: languages[extension] };

  const configs: Record<string, string | null> = {
    json: "JSON",
    jsonc: "JSON",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    xml: "XML",
    plist: "XML",
    gradle: "Gradle",
    cfg: null,
    conf: null,
    env: null,
    ini: null,
    properties: null,
  };
  if (extension in configs) return { kind: "config", language: configs[extension] };

  if (["md", "markdown", "mdx"].includes(extension)) {
    return { kind: "documentation", language: "Markdown" };
  }
  if (["adoc", "asciidoc", "rst", "txt"].includes(extension)) {
    return { kind: "documentation", language: null };
  }
  return { kind: "asset", language: null };
}

function extensionFor(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}

function parentId(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "." : path.slice(0, separator);
}

function includeEntry(path: string): boolean {
  return !path.split("/").some((part) => generatedDirectories.has(part));
}

export function githubTreeToGraph(
  repository: GitHubRepositoryResponse,
  tree: GitHubTreeResponse,
): RepositoryGraph {
  const root: RepositoryNode = {
    id: ".",
    name: repository.name,
    path: ".",
    kind: "repository",
    extension: null,
    language: null,
    sizeBytes: 0,
    lines: 0,
    depth: 0,
    childCount: 0,
  };
  const nodes = [root];
  const nodeById = new Map<string, RepositoryNode>([[root.id, root]]);
  const edges: RepositoryEdge[] = [];
  const languages = new Map<string, number>();
  let files = 0;
  let directories = 0;
  let bytes = 0;

  const candidates = tree.tree
    .filter((entry) => includeEntry(entry.path))
    .sort(
      (left, right) =>
        left.path.split("/").length - right.path.split("/").length ||
        left.path.localeCompare(right.path),
    );
  const entries = candidates.slice(0, MAX_NODES - 1);

  for (const entry of entries) {
    const parent = nodeById.get(parentId(entry.path));
    if (!parent) continue;

    const pathParts = entry.path.split("/");
    const name = pathParts[pathParts.length - 1] ?? entry.path;
    const isDirectory = entry.type === "tree";
    const classification = isDirectory
      ? { kind: "directory" as const, language: null }
      : classify(entry.path);
    const sizeBytes = isDirectory ? 0 : Math.max(0, entry.size ?? 0);
    const node: RepositoryNode = {
      id: entry.path,
      name,
      path: entry.path,
      kind: classification.kind,
      extension: isDirectory ? null : extensionFor(name),
      language: classification.language,
      sizeBytes,
      lines: 0,
      depth: entry.path.split("/").length,
      childCount: 0,
    };

    nodes.push(node);
    nodeById.set(node.id, node);
    parent.childCount += 1;
    edges.push({ source: parent.id, target: node.id, kind: "contains" });

    if (isDirectory) {
      directories += 1;
      continue;
    }

    files += 1;
    bytes += sizeBytes;
    if (node.language) languages.set(node.language, (languages.get(node.language) ?? 0) + 1);
    let ancestor: RepositoryNode | undefined = parent;
    while (ancestor) {
      ancestor.sizeBytes += sizeBytes;
      ancestor = ancestor.id === "." ? undefined : nodeById.get(parentId(ancestor.id));
    }
  }

  nodes.sort((left, right) => left.id.localeCompare(right.id));
  edges.sort(
    (left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target),
  );
  const truncated = tree.truncated || candidates.length > entries.length;

  return {
    root: repository.html_url,
    name: repository.name,
    branch: repository.default_branch,
    source: "github",
    nodes,
    edges,
    stats: {
      files,
      directories,
      lines: 0,
      lineCountAvailable: false,
      bytes,
      languages: [...languages]
        .map(([name, languageFiles]) => ({ name, files: languageFiles, lines: 0 }))
        .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name)),
      truncated,
    },
    warnings: truncated ? ["GitHub returned a partial tree; the map shows the available entries."] : [],
  };
}

export async function scanGitHubRepository(input: string): Promise<RepositoryGraph> {
  const location = parseGitHubRepositoryUrl(input);
  const base = `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}`;
  const repository = repositoryResponse(
    await githubJson(base, "Repository not found. Confirm the URL points to a public GitHub repository."),
  );
  const tree = treeResponse(
    await githubJson(
      `${base}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`,
      "GitHub could not find the repository's default branch.",
    ),
  );
  return githubTreeToGraph(repository, tree);
}
