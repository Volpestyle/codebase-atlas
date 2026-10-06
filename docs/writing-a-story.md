# Writing a story

The story view reads `.codebase-index/_story.json` from a local scan or, on the web, from the public GitHub repository’s default branch. Commit the file to make the story available on the web; no model call is needed. It is written by hand (or by an agent that maintains the index), not derived, because the parts that matter most to a reader — the person typing, the chat service, the model being called — are not files in the repository.

```json
{
  "summary": "One paragraph a non-programmer can read.",
  "actors": [
    { "id": "person", "name": "Someone in Discord", "role": "person",
      "blurb": "Anyone chatting with Clankie in a server or a DM." },
    { "id": "front-door", "name": "The front door", "role": "door",
      "blurb": "Every request lands here first. It checks who is calling.",
      "modules": ["apps/clankie/src/app.ts", "packages/api-client"] }
  ],
  "flows": [
    { "from": "person", "to": "front-door",
      "carries": "a message someone typed",
      "returns": "his reply, posted back in the same place" }
  ],
  "journeys": [
    { "name": "Someone asks a question",
      "blurb": "The ordinary path.",
      "steps": ["person", "front-door", "person"] }
  ]
}
```

- `role` is also the column, in the order `person`, `surface`, `door`, `core`, `store`, `external`. There are no coordinates: name the role honestly and the layout follows.
- `modules` are paths as the scan sees them. An actor is a role, not a directory — several modules can serve one, and people and outside services have none.
- `carries` and `returns` are sentences, not type names. One arrow carries both directions.
- `steps` are actor ids. Consecutive pairs need a flow in one direction or the other; a step taken against a flow reads as its `returns`.
- Everything is checked against the scanned tree. Unknown ids and stale paths are dropped and reported as scan warnings rather than failing the scan, so the story keeps rendering the part that is still true.
- Missing stories produce no warning. Files over 256 KiB, malformed JSON, invalid field types, or unknown roles are rejected with a warning; the rest of the map still loads.
- `.codebase-index/` itself is not scanned, so a story cannot list itself as one of an actor's modules.

This repository carries its own story at `.codebase-index/_story.json`. Scanning Atlas with Atlas is the shortest way to see what a finished one looks like.

Author with `atlas story brief [REPOSITORY]`; validate and inspect product-source coverage with `atlas story check [REPOSITORY]`. Both default to the current directory. Atlas calls no model and writes no story: your coding agent reads the brief, checks the actual code where needed, and writes the file.

## Product-source scope and checks

Coverage and the brief’s code-module digest use the same rule, implemented in `src-tauri/src/source_scope.rs` for straightforward mirroring in the web story view:

- Count only source files. Exclude configuration nodes, `*.config.*` files, lockfiles, documentation, and assets.
- Exclude files inside any dot-directory (`.claude/`, `.github/`, `.vscode/`, and other directory segments starting with `.`). A dot-prefixed filename alone is not a directory exclusion.
- Exclude generated directory segments from the scanner’s shared list: `.git`, `.codebase-index`, `node_modules`, `target`, `dist`, `build`, `.next`, `.turbo`, `coverage`, `vendor`, `Pods`, `DerivedData`. Also exclude any `gen/` directory below `src-tauri/`.
- Exclude the existing test layer: `*.test.*`, `*.spec.*`, `*_test.*`, and files beneath `test`, `tests`, `__tests__`, `spec`, `specs`, `e2e`, `fixtures`, or `__mocks__` (support-directory matching ignores case).

Actor modules cover their source files and descendants; overlapping actor modules count each file once. Coverage uses counted lines from the fresh scan and is informational. `atlas story check` exits 1 only for story validation warnings or no usable story. Other scan warnings, including truncation, skipped entries, and stale summaries, are printed as information and do not invalidate a story. A partial scan or unavailable line counts still limit what coverage can say.

The brief partitions code files into at most 150 modules at the deepest level that fits, collapses single-child directory chains, and lists each module once without ancestor totals. Docs/config contribute one short line count, with the same hidden/generated exclusions. Import edges to directory targets are included when that directory resolves to one listed module; ambiguous or excluded targets are counted as omissions.

## Part figures

An actor may set `figure` to a Hairline name: `riffle`, `terrain`, `exploded`, `phosphor`, `slow`, `elevator`, `turntable`, `lockers`, `cabinet`, `vault`, `terminal`, `laptop`, `phone`, `keyboard`, `branches`, `loupe`, `padlock`, `patch`, `dish`, `router`, `sieve`, `rail`, `plug`, `query`, `drawer`, `basket`, or `plot`. Unknown names warn and fall back to the role default. Defaults: surface → terminal, door → padlock, core → riffle, store → cabinet, external → branches. People always render as text, with no figure. Figures are presentation, not inferred code behavior.
