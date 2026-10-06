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
