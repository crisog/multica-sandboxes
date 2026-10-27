import { z } from 'zod';

const REQUEST_TIMEOUT_MS = 10_000;

// ceiling: a deferred retry also needs a running daemon to promote it, but the snapshot lists only wakeup retries, so no deferred run counts. A retry armed while the daemon runs is due within seconds, inside the idle grace. Debt — count deferred retries once Multica lists every one.
const ACTIVE_RUN_STATUSES = new Set(['queued', 'dispatched', 'running', 'waiting_local_directory']);

const workspacesSchema = z.array(z.object({ id: z.string() }));

const runtimesSchema = z.array(
  z.object({
    id: z.string(),
    daemon_id: z.string().nullable(),
    status: z.string()
  })
);

const agentTasksSchema = z.array(
  z.object({
    runtime_id: z.string(),
    status: z.string()
  })
);

type AgentTask = z.infer<typeof agentTasksSchema>[number];

export type MulticaConfig = {
  serverUrl: string;
  token: string;
  daemonId: string;
};

export type RuntimeWork = {
  activeRunCount: number;
  isRuntimeOnline: boolean;
};

// Reads the unfinished runs on the runtimes that the sandbox daemon registers, across every workspace of the token owner.
export async function readRuntimeWork(config: MulticaConfig): Promise<RuntimeWork> {
  const workspaces = workspacesSchema.parse(await getJson({ config, path: '/api/workspaces' }));

  let activeRunCount = 0;
  let isRuntimeOnline = false;
  for (const workspace of workspaces) {
    const runtimes = runtimesSchema.parse(await getJson({ config, path: '/api/runtimes', workspaceId: workspace.id }));
    const runtimeIds = new Set<string>();
    for (const runtime of runtimes) {
      if (runtime.daemon_id === config.daemonId) {
        runtimeIds.add(runtime.id);
        if (runtime.status === 'online') {
          isRuntimeOnline = true;
        }
      }
    }
    const runs = agentTasksSchema.parse(
      await getJson({ config, path: '/api/agent-task-snapshot', workspaceId: workspace.id })
    );
    activeRunCount += countActiveRuns({ runs, runtimeIds });
  }
  return { activeRunCount, isRuntimeOnline };
}

type CountActiveRunsParams = {
  runs: AgentTask[];
  runtimeIds: ReadonlySet<string>;
};

export function countActiveRuns({ runs, runtimeIds }: CountActiveRunsParams): number {
  let count = 0;
  for (const run of runs) {
    if (runtimeIds.has(run.runtime_id) && ACTIVE_RUN_STATUSES.has(run.status)) {
      count += 1;
    }
  }
  return count;
}

type GetJsonParams = {
  config: MulticaConfig;
  path: string;
  workspaceId?: string;
};

async function getJson({ config, path, workspaceId }: GetJsonParams): Promise<unknown> {
  const headers = new Headers({ Authorization: `Bearer ${config.token}` });
  if (workspaceId !== undefined) {
    headers.set('X-Workspace-ID', workspaceId);
  }
  const response = await fetch(new URL(path, config.serverUrl), {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Multica GET ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}
