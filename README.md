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
| `RAILWAY_API_TOKEN`          | Railway token that can create and destroy sandboxes in the environment        |
| `SANDBOX_IDLE_GRACE_SECONDS` | Optional. How long an idle sandbox stays up for follow-up runs. Default `300` |

Railway sets `RAILWAY_ENVIRONMENT_ID` for the service. Each sandbox receives `MULTICA_SERVER_URL`, `MULTICA_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` as Railway references, which Railway resolves when the sandbox starts.

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

## Behavior

- A sandbox belongs to the dispatcher only when one of its sessions started `multica daemon start` with the configured daemon ID. The dispatcher leaves other sandboxes in the environment alone.
- When the runtime stays offline for 3 minutes, the dispatcher replaces the sandbox. Multica marks a runtime offline after 150 seconds without a heartbeat, so a crashed daemon is replaced about 5 minutes after it stops. The new daemon fails the runs that the old one left unfinished, and Multica retries them.
- When the daemon exits, Railway destroys its sandbox after 10 idle minutes, even if the dispatcher is down.
- A restart adopts the running sandbox, and the idle grace and the offline timeout start again.
- The dispatcher counts only runs of the agents that the token owner can see. Runs of Multica's agent builder do not count, so they neither start a sandbox nor keep one running. Do not select this runtime for the agent builder.
