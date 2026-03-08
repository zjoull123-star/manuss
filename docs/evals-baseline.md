## Benchmark Baselines

The repository includes local benchmark cases under `packages/evals` and a CLI runner in `scripts/evals.ts`.

### Run benchmark suites

```bash
npm run evals:smoke
npm run evals
```

### Write baseline snapshots

```bash
npm run evals:baseline:smoke
npm run evals:baseline:full
```

Each run writes a detailed report to:

```text
.data/evals/<runId>/report.json
```

When `--write-baseline` is used, the latest suite baseline is also written to:

```text
.data/evals/baselines/smoke.json
.data/evals/baselines/full.json
```

### What the reports contain

- overall completion count and completion rate
- per-case latency
- per-case quality score
- whether fallback was used
- whether the final artifact was validated
- failure category for unsuccessful cases

### Current benchmark intent

- `smoke`
  - keep file-analysis and markdown/pdf export paths stable
- `full`
  - keep long `research/browser` and `timeline/pdf` tasks from regressing

Baseline snapshots are local runtime artifacts and are intentionally not committed.
