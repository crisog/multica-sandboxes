export type RuntimeSandbox = {
  id: string;
  createdAtMs: number;
};

export type Observation = {
  sandboxes: RuntimeSandbox[];
  activeRunCount: number;
  isRuntimeOnline: boolean;
  lastActiveAtMs: number;
  lastOnlineAtMs: number;
  nowMs: number;
};

export type LifecyclePolicy = {
  idleGraceMs: number;
  offlineTimeoutMs: number;
};

export type Decision =
  | { kind: 'boot' }
  | { kind: 'destroy'; sandboxIds: string[]; reason: 'duplicate' | 'unhealthy' | 'idle' }
  | { kind: 'wait' };

type DecideParams = {
  observation: Observation;
  policy: LifecyclePolicy;
};

// A starting daemon fails every in-flight run on its runtimes, so at most one runtime sandbox may run.
export function decide({ observation, policy }: DecideParams): Decision {
  const newest = findNewest(observation.sandboxes);
  if (newest === null) {
    if (observation.activeRunCount > 0) {
      return { kind: 'boot' };
    }
    return { kind: 'wait' };
  }

  const duplicateIds: string[] = [];
  for (const sandbox of observation.sandboxes) {
    if (sandbox.id !== newest.id) {
      duplicateIds.push(sandbox.id);
    }
  }
  if (duplicateIds.length > 0) {
    return { kind: 'destroy', sandboxIds: duplicateIds, reason: 'duplicate' };
  }

  // Multica keeps runs alive while their runtime is briefly offline, so only a long outage replaces the sandbox.
  const offlineSinceMs = Math.max(newest.createdAtMs, observation.lastOnlineAtMs);
  const offlineMs = observation.nowMs - offlineSinceMs;
  if (!observation.isRuntimeOnline && offlineMs >= policy.offlineTimeoutMs) {
    return { kind: 'destroy', sandboxIds: [newest.id], reason: 'unhealthy' };
  }

  const idleMs = observation.nowMs - observation.lastActiveAtMs;
  if (observation.activeRunCount === 0 && idleMs >= policy.idleGraceMs) {
    return { kind: 'destroy', sandboxIds: [newest.id], reason: 'idle' };
  }
  return { kind: 'wait' };
}

function findNewest(sandboxes: RuntimeSandbox[]): RuntimeSandbox | null {
  let newest: RuntimeSandbox | null = null;
  for (const sandbox of sandboxes) {
    if (newest === null || sandbox.createdAtMs > newest.createdAtMs) {
      newest = sandbox;
    }
  }
  return newest;
}
