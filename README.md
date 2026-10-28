# multica-sandboxes

Runs a [Multica](https://projects.lucrise.com) agent runtime in a Railway sandbox only while Multica has work for it.

The dispatcher checks Multica every 10 seconds. When the sandbox runtime has unfinished runs, it boots a sandbox that runs the Multica daemon, and the daemon executes the runs with Claude Code. When no runs are left for the idle grace, the dispatcher destroys the sandbox.

At most one sandbox runs at a time, and its daemon executes one run at a time. Runs that arrive together wait in the Multica queue and run in turn.

## Configuration

The dispatcher runs as the `multica-sandboxes` service in the Railway project and reads these variables:

| Variable                     | Value                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `MULTICA_SERVER_URL`         | Multica origin, e.g. `https://projects.lucrise.com`                           |
| `MULTICA_TOKEN`              | Personal access token of the dedicated Multica user (see Multica access)      |
| `MULTICA_DAEMON_ID`          | Fixed UUID, so every sandbox registers as the same Multica runtime            |
| `CLAUDE_CODE_OAUTH_TOKEN`    | Output of `claude setup-token` for the Claude subscription that pays for runs |
| `RAILWAY_API_TOKEN`          | Railway account or workspace token, not a project token                       |
| `GITHUB_APP_ID`              | ID of the agent GitHub App                                                    |
| `GITHUB_APP_PRIVATE_KEY`     | Private key of the agent GitHub App, in PEM format                            |
| `GITHUB_BOT_NAME`            | `<app-slug>[bot]`, the git name of agent commits                              |
| `GITHUB_BOT_EMAIL`           | `<bot-user-id>+<app-slug>[bot]@users.noreply.github.com`                      |
| `GITHUB_UPLOAD_TOKEN`        | Fine-grained personal access token that agents use for `gh --attach`          |
| `SANDBOX_IDLE_GRACE_SECONDS` | Optional. How long an idle sandbox stays up for follow-up runs. Default `300` |

Railway sets `RAILWAY_ENVIRONMENT_ID` for the service. Each sandbox receives `MULTICA_SERVER_URL`, `MULTICA_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_UPLOAD_TOKEN`, and the bot name and email as Railway references, which Railway resolves when the sandbox starts.

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

The template adds the Docker Compose plugin and a global Playwright install with Chromium, so agents can start a repository's local services and screenshot its UI. A script imports Playwright after `npm link playwright` in its directory.

The checkpoint holds no credentials. Each sandbox receives them when it boots.

Each sandbox also sets `AGENT_FOREGROUND_ONLY=1`. A Multica run ends when the agent's turn ends, so a call the agent sends to the background never returns to it. With the variable set, the profile's wait guard allows the agent to wait in the foreground, for example for a pull request's review.

Each sandbox has a ceiling of 16 vCPUs and 16 GB of memory. Railway bills the CPU and memory a sandbox uses, not its ceiling. A run that tests rapidotickets starts a PostgreSQL container for each test shard. Two such runs together exhausted the 8 GB default. The rapidotickets backend tests took 287 seconds on 8 vCPUs and 228 seconds on 16.

Rebuild the checkpoint after a new `agent-workflows` release or a change to `src/runtime-template.ts`. Run the build from a machine with an agent-profile checkout that has the release tag:

```bash
railway run --service multica-sandboxes -- npm run build:checkpoint -- ~/Code/Personal/agent-profile agent-workflows-v7.7.0
```

The build boots a sandbox from the template, installs the profile, and checks the result. It saves the checkpoint only when every check passes. The new checkpoint replaces the old one, and the next sandbox boots from it.

## Multica access

The agents in a sandbox run as the same user as the daemon, so they can read the daemon's Multica token. That token therefore belongs to a dedicated Multica user, never to a person:

- The user is a `member` of each workspace whose agents run here, and of no other workspace.
- The user owns the sandbox runtimes. They stay private and are shared with the owners of the agents that run on them.
- Each sandbox agent lets the user invoke it, so the dispatcher can see the agent's runs.

Multica refuses to register a daemon ID whose runtimes another user owns, so a new token owner also needs a new `MULTICA_DAEMON_ID`. A new daemon ID starts with no runtimes, and the dispatcher boots only for runs on existing runtimes. To move the runtime to a new token owner:

1. Wait until no runtime sandbox runs. The dispatcher finds its sandboxes by daemon ID, so it loses track of a sandbox that started under the old ID.
2. Invite the user to each workspace as a member. Sign in as the user, accept the invitations, and create a personal access token.
3. Set the token as `MULTICA_TOKEN` and a new UUID as `MULTICA_DAEMON_ID`. The variable change restarts the dispatcher.
4. Within the idle grace after that restart, run `railway run --service multica-sandboxes -- npm run register:runtimes`. It boots one sandbox, waits until a runtime with the new daemon ID comes online, and destroys the sandbox. Later than that, the dispatcher can destroy the sandbox as idle before its daemon registers. If the script stops early, the dispatcher destroys the sandbox when the idle grace ends.
5. As the user, open each workspace's runtimes, check that the new runtime is there, and share it with the owners of the agents that run on it.
6. As each agent's owner, move the agent to the new runtime, and allow the user to invoke it.

## GitHub access

Agents clone repositories, push branches, and open pull requests as the agent GitHub App. The App is private to `lucrise-llc`, has no webhook, and has these repository permissions:

| Permission      | Access       |
| --------------- | ------------ |
| Contents        | Read & write |
| Pull requests   | Read & write |
| Metadata        | Read         |
| Checks          | Read         |
| Commit statuses | Read & write |

Install the App once on the organization, and select only the repositories that agents may change. The dispatcher needs exactly one installation.

Select a repository only when a merge or push to its default branch runs no pipeline with credentials that agents must not reach. No branch rule keeps an agent from that branch. Agents post the `signoff` status after their checks pass, so an agent can post the status that a branch requires and then merge its own pull request with the App token. Only its instruction stops it. A required review does not stop it either, because an agent can read the upload token and approve as the token's owner. This repository never qualifies: Railway deploys every push to `main`, and the dispatcher holds the Railway token and the App key.

GitHub refuses image uploads from App tokens, so agents attach screenshots to pull requests with `GITHUB_UPLOAD_TOKEN`. It is a fine-grained personal access token for the repositories agents work on, with read and write access to contents and pull requests and no access to commit statuses, actions, or workflows. Every agent can read it and act as its owner within that access, so the agent instruction limits it to `gh --attach`. The same rule holds for its repositories as for the App's. It does not renew: replace it before it expires.

The App key stays in the dispatcher. At each boot the dispatcher mints an installation token, which expires after an hour, and writes it to `/run/multica-github/token` in the sandbox. It replaces the token while 30 minutes of its life remain. A git credential helper and a `gh` wrapper in the sandbox read the file on every call.

## Behavior

- A sandbox belongs to the dispatcher only when one of its sessions started `multica daemon start` with the configured daemon ID. The dispatcher leaves other sandboxes in the environment alone.
- When the runtime stays offline for 3 minutes, the dispatcher replaces the sandbox. Multica marks a runtime offline after 150 seconds without a heartbeat, so a crashed daemon is replaced about 5 minutes after it stops. The new daemon fails the runs that the old one left unfinished, and Multica retries each run once. Runs still waiting in the queue stay queued, and the new daemon runs them.
- Before it destroys an unhealthy sandbox, the dispatcher logs `unhealthy sandbox` with the daemon session's exit and the sandbox's memory report. An exit code of `-1` means a signal killed the daemon.
- When the daemon exits, Railway destroys its sandbox after 10 idle minutes, even if the dispatcher is down.
- A restart adopts the running sandbox, and the idle grace and the offline timeout start again.
- The dispatcher counts only runs of the agents that the token owner can see. Runs of Multica's agent builder do not count, so they neither start a sandbox nor keep one running. Do not select this runtime for the agent builder.
