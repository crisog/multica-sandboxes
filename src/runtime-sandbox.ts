import type { SandboxSessionInfo } from 'railway';

import { Sandbox } from 'railway';

import type { RuntimeSandbox } from './lifecycle.ts';

import { GITHUB_TOKEN_PATH, RUNTIME_CHECKPOINT } from './runtime-template.ts';

// Railway destroys a sandbox when no exec session keeps it alive, so a sandbox whose daemon exited does not outlive the timeout.
const SANDBOX_IDLE_TIMEOUT_MINUTES = 10;
// One page holds every sandbox an environment can run: https://docs.railway.com/sandboxes#sandboxes-per-environment
const SANDBOX_LIST_PAGE_SIZE = 100;
const RAILWAY_REQUEST_TIMEOUT_MS = 30_000;
const DAEMON_START_TIMEOUT_MS = 30_000;
// The size is a ceiling, and Railway bills the memory in use: https://docs.railway.com/sandboxes#sandbox-size
// Two concurrent rapidotickets runs exhausted the 8 GB default.
const SANDBOX_MEMORY_GB = 16;
// Runs share the sandbox's memory, so the daemon runs one at a time and later runs wait in the Multica queue.
const MAX_CONCURRENT_RUNS = 1;
// Pressure stall lines carry cumulative totals, so they still show memory starvation after the sandbox recovers.
const MEMORY_REPORT_COMMAND = 'free -m; cat /proc/pressure/memory';
const MEMORY_REPORT_TIMEOUT_SECONDS = 10;

// Resolved by Railway when the sandbox is created, so secret values never pass through this process.
const SANDBOX_ENV = {
  MULTICA_SERVER_URL: '${{multica-sandboxes.MULTICA_SERVER_URL}}',
  MULTICA_TOKEN: '${{multica-sandboxes.MULTICA_TOKEN}}',
  CLAUDE_CODE_OAUTH_TOKEN: '${{multica-sandboxes.CLAUDE_CODE_OAUTH_TOKEN}}',
  // Commits carry the GitHub App's bot identity, so GitHub attributes them to the app.
  GIT_AUTHOR_NAME: '${{multica-sandboxes.GITHUB_BOT_NAME}}',
  GIT_AUTHOR_EMAIL: '${{multica-sandboxes.GITHUB_BOT_EMAIL}}',
  GIT_COMMITTER_NAME: '${{multica-sandboxes.GITHUB_BOT_NAME}}',
  GIT_COMMITTER_EMAIL: '${{multica-sandboxes.GITHUB_BOT_EMAIL}}',
  // The sandbox runs as root, and Claude Code allows bypassPermissions under root only inside a declared sandbox.
  IS_SANDBOX: '1'
};

type RailwayConfig = {
  token: string;
  environmentId: string;
};

type RuntimeSandboxParams = {
  config: RailwayConfig;
  daemonId: string;
};

export type BootedSandbox = {
  sandboxId: string;
  region: string;
  sessionName: string;
  createMs: number;
};

type BootRuntimeSandboxParams = RuntimeSandboxParams & {
  githubToken: string;
};

export async function bootRuntimeSandbox({
  config,
  daemonId,
  githubToken
}: BootRuntimeSandboxParams): Promise<BootedSandbox> {
  const createStartedAt = performance.now();
  // A checkpoint boots in the region where it was saved, and Railway rejects any other region.
  const sandbox = await Sandbox.create(RUNTIME_CHECKPOINT, {
    ...config,
    fetch: fetchWithDeadline,
    idleTimeoutMinutes: SANDBOX_IDLE_TIMEOUT_MINUTES,
    resources: { memoryGB: SANDBOX_MEMORY_GB },
    env: SANDBOX_ENV
  });
  const createMs = Math.round(performance.now() - createStartedAt);

  try {
    // The daemon clones the workspace repositories when it starts, so the token has to be in place first.
    await putGithubToken({ sandbox, token: githubToken });
    const sessionName = await startDaemon({ sandbox, daemonId });
    return { sandboxId: sandbox.id, region: sandbox.region, sessionName, createMs };
  } catch (error) {
    await sandbox.destroy();
    throw error;
  }
}

type StartDaemonParams = {
  sandbox: Sandbox;
  daemonId: string;
};

// The SDK terminates a command when its signal aborts, so the timer stops at detach and the deadline bounds only the start.
async function startDaemon({ sandbox, daemonId }: StartDaemonParams): Promise<string> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error(`The daemon exec did not start within ${DAEMON_START_TIMEOUT_MS} ms`));
  }, DAEMON_START_TIMEOUT_MS);
  try {
    return await sandbox.exec(startDaemonCommand(daemonId), { signal: deadline.signal }).detach();
  } finally {
    clearTimeout(timer);
  }
}

// A sandbox belongs to the dispatcher only when one of its sessions started the daemon with this daemon ID.
export async function listRuntimeSandboxes({ config, daemonId }: RuntimeSandboxParams): Promise<RuntimeSandbox[]> {
  const sandboxes = await Sandbox.list({ ...config, fetch: fetchWithDeadline, first: SANDBOX_LIST_PAGE_SIZE });
  // ceiling: the SDK returns one page and drops its cursor, and destroyed sandboxes stay in the list. Railway lists newest first, so a running sandbox is on the page unless 100 newer sandboxes exist. Debt — page with the cursor once the SDK returns it.
  let previousCreatedAtMs = Number.POSITIVE_INFINITY;
  for (const info of sandboxes) {
    const createdAtMs = Date.parse(info.createdAt);
    if (createdAtMs > previousCreatedAtMs) {
      throw new Error('Railway no longer lists sandboxes newest first, so a running sandbox can fall off the page');
    }
    previousCreatedAtMs = createdAtMs;
  }

  const daemonCommand = daemonCommandFor(daemonId);
  const runtimeSandboxes: RuntimeSandbox[] = [];
  for (const info of sandboxes) {
    if (info.status !== 'RUNNING') {
      continue;
    }
    const sandbox = await Sandbox.connect(info.id, { ...config, fetch: fetchWithDeadline });
    if ((await findDaemonSession({ sandbox, daemonCommand })) !== null) {
      runtimeSandboxes.push({ id: info.id, createdAtMs: Date.parse(info.createdAt) });
    }
  }
  return runtimeSandboxes;
}

type FindDaemonSessionParams = {
  sandbox: Sandbox;
  daemonCommand: string;
};

async function findDaemonSession({
  sandbox,
  daemonCommand
}: FindDaemonSessionParams): Promise<SandboxSessionInfo | null> {
  const sessions = await sandbox.sessions();
  if (sessions === null) {
    throw new Error(`Sandbox ${sandbox.id} did not report its sessions, so its owner is unknown`);
  }
  for (const session of sessions) {
    if (session.kind === 'EXEC' && session.command.includes(daemonCommand)) {
      return session;
    }
  }
  return null;
}

export type SandboxHealth = {
  daemonSession: Pick<SandboxSessionInfo, 'running' | 'exitCode' | 'exitedAt'> | null;
  memoryReport: string;
};

type DescribeRuntimeSandboxParams = RuntimeSandboxParams & {
  sandboxId: string;
};

// The daemon session's exit tells a killed daemon from a stalled one, and the memory report tells whether memory ran out.
export async function describeRuntimeSandbox({
  config,
  daemonId,
  sandboxId
}: DescribeRuntimeSandboxParams): Promise<SandboxHealth> {
  const sandbox = await Sandbox.connect(sandboxId, { ...config, fetch: fetchWithDeadline });
  const session = await findDaemonSession({ sandbox, daemonCommand: daemonCommandFor(daemonId) });
  const report = await sandbox.exec(MEMORY_REPORT_COMMAND, {
    timeoutSec: MEMORY_REPORT_TIMEOUT_SECONDS,
    ephemeral: true
  });

  let daemonSession: SandboxHealth['daemonSession'] = null;
  if (session !== null) {
    daemonSession = { running: session.running, exitCode: session.exitCode, exitedAt: session.exitedAt };
  }
  return { daemonSession, memoryReport: report.stdout };
}

// The daemon ID in the command marks the session, so the dispatcher can recognize its own sandboxes.
function daemonCommandFor(daemonId: string): string {
  return `env MULTICA_DAEMON_ID=${daemonId} multica daemon start`;
}

// The daemon reads its token only from the CLI config, so the command logs in first. The token goes through stdin, not arguments.
function startDaemonCommand(daemonId: string): string {
  return [
    'multica config set server_url "$MULTICA_SERVER_URL"',
    'printf "%s\\n" "$MULTICA_TOKEN" | multica login --token',
    `exec ${daemonCommandFor(daemonId)} --foreground --max-concurrent-tasks ${MAX_CONCURRENT_RUNS}`
  ].join(' && ');
}

type DestroyRuntimeSandboxParams = {
  config: RailwayConfig;
  sandboxId: string;
};

export async function destroyRuntimeSandbox({ config, sandboxId }: DestroyRuntimeSandboxParams): Promise<void> {
  const sandbox = await Sandbox.connect(sandboxId, { ...config, fetch: fetchWithDeadline });
  await sandbox.destroy();
}

type WriteGithubTokenParams = {
  config: RailwayConfig;
  sandboxId: string;
  token: string;
};

export async function writeGithubToken({ config, sandboxId, token }: WriteGithubTokenParams): Promise<void> {
  const sandbox = await Sandbox.connect(sandboxId, { ...config, fetch: fetchWithDeadline });
  await putGithubToken({ sandbox, token });
}

type PutGithubTokenParams = {
  sandbox: Sandbox;
  token: string;
};

// The token goes through the file API, never a command line, because Railway records every exec command in the sandbox sessions.
// The rename replaces the file in one step, so git and gh never read a partial token.
async function putGithubToken({ sandbox, token }: PutGithubTokenParams): Promise<void> {
  const nextPath = `${GITHUB_TOKEN_PATH}.next`;
  await sandbox.files.write(nextPath, token);
  await sandbox.files.rename(nextPath, GITHUB_TOKEN_PATH);
}

// The SDK bounds its readiness polls but no single request. A sandbox keeps this fetch for its sessions, exec, and destroy calls.
function fetchWithDeadline(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const signals = [AbortSignal.timeout(RAILWAY_REQUEST_TIMEOUT_MS)];
  if (init?.signal) {
    signals.push(init.signal);
  }
  return fetch(input, { ...init, signal: AbortSignal.any(signals) });
}
