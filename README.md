# multica-sandboxes

Runs [Multica](https://projects.lucrise.com) agent runtimes in Railway sandboxes. Each sandbox runs the Multica daemon, which picks up queued agent runs and executes them with Claude Code.

## Configuration

The sandbox reads its credentials from variables on the `multica-sandboxes` service in the Railway project, resolved when the sandbox is created:

| Variable                  | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| `MULTICA_SERVER_URL`      | Multica origin, e.g. `https://projects.lucrise.com`                           |
| `MULTICA_TOKEN`           | Multica personal access token of the runtime owner                            |
| `MULTICA_DAEMON_ID`       | Fixed UUID, so every sandbox registers as the same runtime                    |
| `CLAUDE_CODE_OAUTH_TOKEN` | Output of `claude setup-token` for the Claude subscription that pays for runs |

Set the two tokens from your own terminal so their values never reach a chat transcript or shell history:

```bash
railway variable set MULTICA_TOKEN --stdin --service multica-sandboxes
railway variable set CLAUDE_CODE_OAUTH_TOKEN --stdin --service multica-sandboxes
```

## Boot a sandbox

```bash
nvm use
npm ci
RAILWAY_API_TOKEN=... RAILWAY_ENVIRONMENT_ID=... npm run boot
```

`boot` builds the runtime template (cached after the first build), creates a sandbox from it, and starts the daemon in a detached session. Destroy the sandbox with `railway sandbox destroy <id>` when it is no longer needed.
