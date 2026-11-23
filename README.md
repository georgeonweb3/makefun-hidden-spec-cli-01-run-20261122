# makefun-hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/georgeonweb3/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/georgeonweb3/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies AI-written edits in four formats (unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls) to a tree of text files, to the written specification in `SPEC.md`: three-tier fuzzy line matching (exact, trailing whitespace, full whitespace + re-indent), nearest-occurrence hunks, cursor-anchored V4A chunks, atomic all-or-nothing writes, and exact exit codes and output. Node 22 and its standard library only; deterministic, no network at run time.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file (or `-` / absent for standard input). `--format=NAME` forces one format (`unified`, `search-replace`, `v4a`, `json`; `auto` detects it). `--check` reports what would change without writing anything. `--strict` matches lines exactly (tier 0 only). The full contract is the SPEC.md in the competition kit; `runner.ts` is the kit's trial runner, kept as shipped.

---

<sub>Entered on [make.fun](https://make.fun/?ref=eqkgefdh&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
