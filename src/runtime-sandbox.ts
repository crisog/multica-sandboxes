import { Sandbox } from 'railway';

import type { RuntimeSandbox } from './lifecycle.ts';

import { multicaRuntimeTemplate } from './runtime-template.ts';

const REGION = 'us-east4-eqdc4a';
// Railway destroys a sandbox when no exec session keeps it alive, so a sandbox whose daemon exited does not outlive the timeout.
const SANDBOX_IDLE_TIMEOUT_MINUTES = 10;
// One page holds every sandbox an environment can run: https://docs.railway.com/sandboxes#sandboxes-per-environment
const SANDBOX_LIST_PAGE_SIZE = 100;

// Resolved by Railway when the sandbox is created, so secret values never pass through this process.
const SANDBOX_ENV = {
  MULTICA_SERVER_URL: '${{multica-sandboxes.MULTICA_SERVER_URL}}',
  MULTICA_TOKEN: '${{multica-sandboxes.MULTICA_TOKEN}}',
  CLAUDE_CODE_OAUTH_TOKEN: '${{multica-sandboxes.CLAUDE_CODE_OAUTH_TOKEN}}',
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

export async function bootRuntimeSandbox({ config, daemonId }: RuntimeSandboxParams): Promise<BootedSandbox> {
  const createStartedAt = performance.now();
  // Sandbox.create builds the template in the region it is given, so the build and the sandbox share it.
  const sandbox = await Sandbox.create(multicaRuntimeTemplate(), {
    ...config,
    region: REGION,
    idleTimeoutMinutes: SANDBOX_IDLE_TIMEOUT_MINUTES,
    env: SANDBOX_ENV
  });
  const createMs = Math.round(performance.now() - createStartedAt);

  try {
    const sessionName = await sandbox.exec(startDaemonCommand(daemonId)).detach();
    return { sandboxId: sandbox.id, region: sandbox.region, sessionName, createMs };
  } catch (error) {
    await sandbox.destroy();
    throw error;
  }
}

// A sandbox belongs to the dispatcher only when one of its sessions started the daemon with this daemon ID.
export async function listRuntimeSandboxes({ config, daemonId }: RuntimeSandboxParams): Promise<RuntimeSandbox[]> {
  const sandboxes = await Sandbox.list({ ...config, first: SANDBOX_LIST_PAGE_SIZE });
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
    const sandbox = await Sandbox.connect(info.id, config);
    if (await hasDaemonSession({ sandbox, daemonCommand })) {
      runtimeSandboxes.push({ id: info.id, createdAtMs: Date.parse(info.createdAt) });
    }
  }
  return runtimeSandboxes;
}

type HasDaemonSessionParams = {
  sandbox: Sandbox;
  daemonCommand: string;
};

async function hasDaemonSession({ sandbox, daemonCommand }: HasDaemonSessionParams): Promise<boolean> {
  const sessions = await sandbox.sessions();
  if (sessions === null) {
    throw new Error(`Sandbox ${sandbox.id} did not report its sessions, so its owner is unknown`);
  }
  for (const session of sessions) {
    if (session.kind === 'EXEC' && session.command.includes(daemonCommand)) {
      return true;
    }
  }
  return false;
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
    `exec ${daemonCommandFor(daemonId)} --foreground`
  ].join(' && ');
}

type DestroyRuntimeSandboxParams = {
  config: RailwayConfig;
  sandboxId: string;
};

export async function destroyRuntimeSandbox({ config, sandboxId }: DestroyRuntimeSandboxParams): Promise<void> {
  const sandbox = await Sandbox.connect(sandboxId, config);
  await sandbox.destroy();
}
