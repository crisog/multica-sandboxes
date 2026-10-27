# multica-sandboxes development guide

This file is for coding agents. `README.md` is for people operating the service.

## Project

multica-sandboxes runs Multica agent runtimes in Railway sandboxes. A sandbox boots from the template in `src/runtime-template.ts`, logs the Multica CLI in, and runs `multica daemon start` under a fixed `MULTICA_DAEMON_ID`, so every sandbox registers as the same Multica runtime.

- Drive sandboxes with the `railway` SDK. Pass credentials into a sandbox as Railway variable references in its `env`, never as values, so secrets never pass through this process.
- Node runs the TypeScript in `src` directly through its built-in type stripping, so there is no build step and no `dist`.

## Environment

Node and npm are pinned, and `.npmrc` sets `engine-strict`, so run `nvm use` before `npm ci` or any script.

## Checks

`npm run verify` is the complete gate: formatting, lint, typecheck, unused code, and the production dependency audit. CI runs the same command. The pre-commit hook runs lint-staged on the staged files.

Fix a failing check at its cause. Change a rule in `oxlint.config.ts` only when the rule itself is wrong for this project.

## Code

- Keep TypeScript strict. Type untrusted data as `unknown` and parse it with a `zod` schema at the boundary, including environment variables.
- Keep module imports free of side effects. Create sandboxes and open connections from the entry script.
- Never commit `.env` files or tokens. Never log credentials.

Use Conventional Commits for commit subjects.
