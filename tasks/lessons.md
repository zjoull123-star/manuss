# Lessons Learned

Patterns and rules captured after corrections. Review at session start.

---

## General

- **Plan before implementing**: For any task with 3+ steps or architectural decisions, write a plan to `tasks/todo.md` first.
- **Mock mode is always the test environment**: All `OPENCLAW_*_MODE` vars must be `mock` when running `npm test`. Never add live dependencies to tests.
- **`npm run db:generate` after schema changes**: The Prisma client is generated code — forgetting this causes cryptic type errors at build time.
- **`noUncheckedIndexedAccess` means array access returns `T | undefined`**: Always guard `arr[0]` before use. TypeScript will catch this but it's easy to miss in complex expressions.
- **One barrel per package**: Exports live in `packages/*/src/index.ts`. Don't reach into package internals from other packages.
- **`tsx` for dev, `node dist/` for production**: Never use `ts-node`. The project uses `tsx` for development and compiles to `dist/` for production runs.

---

_Update this file whenever a correction is received. Include the pattern and the rule that prevents recurrence._
