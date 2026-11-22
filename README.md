# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/aris99i/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/aris99i/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit an AI model wrote to a tree of text files — one patch
tool for every AI edit format. Either every edit lands, or nothing is written.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is read from standard input when it is absent or `-`. Node 22, standard
library only.

## Formats

- **Unified diffs** — `diff --git` sections and `---`/`+++` headers, hunks with
  `@@ -A[,B] +C[,D] @@`, context/`-`/`+`/`\` body lines, creates, deletes and
  renames.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines,
  `=======`, new lines, `>>>>>>> REPLACE`.
- **V4A patches** — `*** Begin Patch` / `*** End Patch`, `*** Add File:` /
  `*** Delete File:` / `*** Update File:` sections, `*** Move to:`,
  `@@` anchors and `*** End of File`.
- **JSON edits** — one JSON array of edit objects, or one object per line
  (JSON Lines): `create` (`file_text`), `str_replace` (`old_str`, `new_str`),
  `insert` (`insert_line`, `new_str`).

With `--format=auto` (the default) the format is detected from the patch's
markers; when none match, the answer is `error: format`.

## Matching

Old lines are found at the first of three tiers where they occur: exact,
trailing whitespace ignored, leading and trailing whitespace ignored.
`--strict` tries the exact tier only. A context line is written as the file's
own matched line, and at tier 2 the other new lines are re-indented to the
file's indentation. A unified hunk takes the occurrence nearest its old start
line; a SEARCH/REPLACE block needs exactly one occurrence; a V4A chunk takes
the first occurrence at or after its cursor.

## Exit codes and output

- `0` — changed paths, one per line in byte order (`A`, `D`, `M`,
  `R <old> -> <new>`), then `ok: <n> files` (or `ok: 1 file`).
- `1` — one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`; nothing is written.
- `2` — exactly one line: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

`--check` reports exactly what a real run would, and writes nothing.

## Testing

The kit's practice set (100 checks across all four formats) passes in full:

```sh
node check.ts program/generator/practice.json
# 100 of 100 passed: practice score 1000
```

`check.ts` is a local test helper and is not part of the submission. The
submission is `main.ts` plus the kit's `runner.ts`, which the trial harness
uses to run `main.ts` against each check in a fresh directory.

## Limits

- One file is at most 1 MiB; the source tree is at most 4 MiB.
- Files and patches are UTF-8 text. A changed file keeps its own line break
  (CRLF or LF) and its final break, unless a unified hunk says otherwise; a
  created file uses LF and ends with a line break, unless its format says
  otherwise. A JSON `create` writes its `file_text` byte for byte.

## License

MIT. See [LICENSE](LICENSE).
