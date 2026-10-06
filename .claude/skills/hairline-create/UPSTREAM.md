# Upstream

This folder is a vendored copy of `skills/hairline-create` from
[lucasmarkes/hairline](https://github.com/lucasmarkes/hairline), MIT licensed
(`LICENSE` here is upstream's). Every other file is unchanged.

- Commit: `bc782244216620434b14736df1d74daed2d05046` (2026-10-05)
- Why it is here: Atlas illustrates each story part with a Hairline figure.
  The 27 stock figures in `@lucasmarkes/hairline` cover most parts; this skill
  draws the ones they do not, on the same engine, so they match.

## Using it in this repo

Run `/hairline-create` from `.local/figures/` (ignored by `*.local`), not the
repo root: the skill writes `<name>.js`, `hairline-<name>.html` and a look
sheet into the working directory.

`look.mjs` installs `playwright-core@1` once into `~/Library/Caches/hairline-look`
(set `HAIRLINE_LOOK_CACHE` to move it). Nothing is installed into the repo.

## Updating

Replace every file except this one with upstream's `skills/hairline-create/`
and `LICENSE` at a newer commit, read the diff, and update the commit above.
Do not edit the vendored files here; changes belong upstream.
