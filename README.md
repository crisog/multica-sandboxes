# multica-sandboxes

Runs a [Multica](https://projects.lucrise.com) agent runtime in a Railway sandbox only while Multica has work for it.

The dispatcher checks Multica every 10 seconds. When the sandbox runtime has unfinished runs, it boots a sandbox that runs the Multica daemon, and the daemon executes the runs with Claude Code. When no runs are left for the idle grace, the dispatcher destroys the sandbox.

At most one sandbox runs at a time. Runs that arrive together share it, each in its own working directory.

## Configuration

The dispatcher runs as the `multica-sandboxes` service in the Railway project and reads these variables:

| Variable                     | Value                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `MULTICA_SERVER_URL`         | Multica origin, e.g. `https://projects.lucrise.com`                           |
| `MULTICA_TOKEN`              | Multica personal access token of the runtime owner                            |
| `MULTICA_DAEMON_ID`          | Fixed UUID, so every sandbox registers as the same Multica runtime            |
| `CLAUDE_CODE_OAUTH_TOKEN`    | Output of `claude setup-token` for the Claude subscription that pays for runs |
| `RAILWAY_API_TOKEN`          | Railway account or workspace token, not a project token                       |
| `GITHUB_APP_ID`              | ID of the agent GitHub App                                                    |
| `GITHUB_APP_PRIVATE_KEY`     | Private key of the agent GitHub App, in PEM format                            |
| `GITHUB_BOT_NAME`            | `<app-slug>[bot]`, the git name of agent commits                              |
| `GITHUB_BOT_EMAIL`           | `<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`                      |
| `SANDBOX_IDLE_GRACE_SECONDS` | Optional. How long an idle sandbox stays up for follow-up runs. Default `300` |

Railway sets `RAILWAY_ENVIRONMENT_ID` for the service. Each sandbox receives `MULTICA_SERVER_URL`, `MULTICA_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, and the bot name and email as Railway references, which Railway resolves when the sandbox starts.

Set each token from your own terminal so its value never reaches a chat transcript or shell history:

```bash
railway variable set MULTICA_TOKEN --stdin --service multica-sandboxes
```

## Run locally

```bash
nvm use
npm ci
railway run --service multica-sandboxes -- npm start
```

`railway run` gives the process the service's variables. Stop the deployed dispatcher first. Two dispatchers can each boot a sandbox, and a second daemon fails the runs of the first.

## Sandbox image

Every sandbox boots from the `multica-runtime` checkpoint in the Railway environment. The checkpoint holds the template from `src/runtime-template.ts` and the [agent profile](https://github.com/crisog/agent-profile) at one release tag:

- The profile's `AGENTS.md` as `~/.claude/CLAUDE.md`, so every run loads the agent guidelines
- The `agent-workflows` plugin with its skills, guard hooks, and subagents
- `claude-opus-5-5` as the default model. A model set on a Multica agent takes precedence.
- Empty Claude Code attribution, so agent commits and pull requests carry no Claude footer or co-author trailer

The checkpoint holds no credentials. Each sandbox receives them when it boots.

Rebuild the checkpoint after a new `agent-workflows` release or a change to `src/runtime-template.ts`. Run the build from a machine with an agent-profile checkout that has the release tag:

```bash
railway run --service multica-sandboxes -- npm run build:checkpoint -- ~/Code/Personal/agent-profile agent-workflows-v7.7.0
```

The build boots a sandbox from the template, installs the profile, and checks the result. It saves the checkpoint only when every check passes. The new checkpoint replaces the old one, and the next sandbox boots from it.

## GitHub access

Agents clone repositories, push branches, and open pull requests as the agent GitHub App. The App is private to `lucrise-llc`, has no webhook, and has these repository permissions:

| Permission    | Access       |
| ------------- | ------------ |
| Contents      | Read & write |
| Pull requests | Read & write |
| Metadata      | Read         |

Install the App once on the organization, and select only the repositories that agents may change. The dispatcher needs exactly one installation.

Never select a repository whose default branch the App can update and a pipeline deploys with credentials that agents must not reach. This repository is one: Railway deploys every push to `main`, and the dispatcher holds the Railway token and the App key. Select such a repository only after its default branch requires a review or a status check that the App cannot give.

The App key stays in the dispatcher. At each boot the dispatcher mints an installation token, which expires after an hour, and writes it to `/run/multica-github/token` in the sandbox. It replaces the token while 30 minutes of its life remain. A git credential helper and a `gh` wrapper in the sandbox read the file on every call.

## Behavior

- A sandbox belongs to the dispatcher only when one of its sessions started `multica daemon start` with the configured daemon ID. The dispatcher leaves other sandboxes in the environment alone.
- When the runtime stays offline for 3 minutes, the dispatcher replaces the sandbox. Multica marks a runtime offline after 150 seconds without a heartbeat, so a crashed daemon is replaced about 5 minutes after it stops. The new daemon fails the runs that the old one left unfinished, and Multica retries them.
- When the daemon exits, Railway destroys its sandbox after 10 idle minutes, even if the dispatcher is down.
- A restart adopts the running sandbox, and the idle grace and the offline timeout start again.
- The dispatcher counts only runs of the agents that the token owner can see. Runs of Multica's agent builder do not count, so they neither start a sandbox nor keep one running. Do not select this runtime for the agent builder.
