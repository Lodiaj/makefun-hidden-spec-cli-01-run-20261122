# makefun-hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Lodiaj/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Lodiaj/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. A command-line tool that applies AI-written edits in four formats (unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of files, to the specification that ships in the kit. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts --format=auto patch.diff
cat patch.diff | node main.ts -
node main.ts --check patch.diff
```

Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`), `--check` (do everything but write), `--strict` (match lines exactly, tier 0 only).

---

<sub>Entered on [make.fun](https://make.fun/?ref=v7bcp4ry&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
