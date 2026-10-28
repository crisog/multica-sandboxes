# multica-sandboxes development guide

This file is for coding agents. `README.md` is for people operating the service.

## Project

multica-sandboxes runs a Multica agent runtime in a Railway sandbox only while Multica has work for it. The dispatcher in `src/dispatcher.ts` polls Multica, boots a sandbox from the `multica-runtime` checkpoint when runs are waiting, and destroys it after an idle grace. `npm run build:checkpoint` saves that checkpoint from the template in `src/runtime-template.ts` plus the agent profile. The sandbox runs `multica daemon start` under a fixed `MULTICA_DAEMON_ID`, so every sandbox registers as the same Multica runtime.

- Keep at most one runtime sandbox running. A starting daemon fails every in-flight run on its runtimes, so a second sandbox kills the runs of the first.
- A merged change to `src/runtime-template.ts` reaches sandboxes only after someone rebuilds the checkpoint. Say so in the PR description.
- Keep lifecycle policy in the pure `decide` function in `src/lifecycle.ts`, and add a failing case to its tests before you change it.
- Drive sandboxes with the `railway` SDK. Pass long-lived credentials into a sandbox as Railway variable references in its `env`, never as values, so they never pass through this process. The GitHub tokens are the exception, described below.
- Every agent in a sandbox can read every credential in it, so give a sandbox only credentials scoped to what agents may do. The Multica token belongs to a dedicated member user, as `README.md` describes under "Multica access".
- The dispatcher writes the two GitHub tokens into a sandbox through the sandbox file API. It mints the installation token from the GitHub App key it holds, so the key never enters the sandbox and the sandbox holds only a token that expires within the hour. It writes the upload token once at boot to a file, so the token stays out of the agents' environment and the `gh` wrapper uses it only to attach files and set a pull request's body. Agents run as root and can still read the file, so the token's own access bounds what an agent can do with it. Never put a secret in an exec command, because Railway records every exec command in the sandbox sessions.
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
