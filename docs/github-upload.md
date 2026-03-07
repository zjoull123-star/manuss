# GitHub Upload Guide

This project should be published as a standalone Git repository rooted at the
repository directory itself.

## Included in version control

- `apps/`
- `packages/`
- `plugins/`
- `prisma/`
- `scripts/`
- `docs/`
- `infra/`
- `README.md`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `.gitignore`
- `.env.example`

## Excluded from version control

- `.env`
- `.data/`
- `dist/`
- `node_modules/`
- `prisma/dev.db`
- logs, screenshots, uploads, temporary smoke-test files

## Preflight checklist

Run these commands from the repository root:

```bash
npm test
npm run build
git status --short
git ls-files
```

Review the output and confirm:

- no secrets are staged
- no runtime databases are tracked
- no local artifacts or caches are tracked
- the repository contains only source code and documentation

## Create a standalone local repository

```bash
git init -b main
git config user.name "<your name>"
git config user.email "<your email>"
git add .
git commit -m "Initial commit: local-first Manus runtime"
```

## Create and push a private GitHub repository

After `gh auth login`:

```bash
gh repo create openclaw-manus --private --source=. --remote=origin --push
```

Or create the repository on GitHub first and then:

```bash
git remote add origin <your GitHub repository URL>
git push -u origin main
```
