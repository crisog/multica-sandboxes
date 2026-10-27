import { z } from 'zod';
import { pino } from 'pino';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Decision, Observation } from './lifecycle.ts';

import { decide } from './lifecycle.ts';
import { readRuntimeWork } from './multica.ts';
import { bootRuntimeSandbox, destroyRuntimeSandbox, listRuntimeSandboxes } from './runtime-sandbox.ts';

const POLL_INTERVAL_MS = 10_000;
// The daemon registered about 4 s after its sandbox started in tests; the timeout also rides out a brief Multica outage.
const RUNTIME_OFFLINE_TIMEOUT_MS = 180_000;

const environmentSchema = z.object({
  RAILWAY_API_TOKEN: z.string().min(1),
  RAILWAY_ENVIRONMENT_ID: z.uuid(),
  MULTICA_SERVER_URL: z.url(),
  MULTICA_TOKEN: z.string().min(1),
  MULTICA_DAEMON_ID: z.uuid(),
  SANDBOX_IDLE_GRACE_SECONDS: z.coerce.number().int().positive().default(300)
});

const logger = pino();
const environment = environmentSchema.parse(process.env);
const runtimeSandbox = {
  config: {
    token: environment.RAILWAY_API_TOKEN,
    environmentId: environment.RAILWAY_ENVIRONMENT_ID
  },
  daemonId: environment.MULTICA_DAEMON_ID
};
const multica = {
  serverUrl: environment.MULTICA_SERVER_URL,
  token: environment.MULTICA_TOKEN,
  daemonId: environment.MULTICA_DAEMON_ID
};
const policy = {
  idleGraceMs: environment.SANDBOX_IDLE_GRACE_SECONDS * 1_000,
  offlineTimeoutMs: RUNTIME_OFFLINE_TIMEOUT_MS
};

// A restart cannot know when the runtimes last had work or were online, so both clocks start again.
let lastActiveAtMs = Date.now();
let lastOnlineAtMs = Date.now();
let lastObservationKey = '';

logger.info({ idleGraceSeconds: environment.SANDBOX_IDLE_GRACE_SECONDS }, 'dispatcher started');
for (;;) {
  try {
    await reconcile();
  } catch (error) {
    logger.error({ err: error }, 'reconcile failed');
  }
  await sleep(POLL_INTERVAL_MS);
}

async function reconcile(): Promise<void> {
  const [work, sandboxes] = await Promise.all([readRuntimeWork(multica), listRuntimeSandboxes(runtimeSandbox)]);
  const nowMs = Date.now();
  if (work.activeRunCount > 0) {
    lastActiveAtMs = nowMs;
  }
  if (work.isRuntimeOnline) {
    lastOnlineAtMs = nowMs;
  }
  const observation: Observation = { sandboxes, ...work, lastActiveAtMs, lastOnlineAtMs, nowMs };
  logObservationChange(observation);
  await act(decide({ observation, policy }));
}

async function act(decision: Decision): Promise<void> {
  switch (decision.kind) {
    case 'wait': {
      return;
    }
    case 'boot': {
      const booted = await bootRuntimeSandbox(runtimeSandbox);
      logger.info(booted, 'sandbox booted');
      return;
    }
    case 'destroy': {
      for (const sandboxId of decision.sandboxIds) {
        await destroyRuntimeSandbox({ config: runtimeSandbox.config, sandboxId });
        logger.info({ sandboxId, reason: decision.reason }, 'sandbox destroyed');
      }
      return;
    }
    default: {
      const unhandled: never = decision;
      throw new Error(`Unhandled decision ${JSON.stringify(unhandled)}`);
    }
  }
}

function logObservationChange(observation: Observation): void {
  const sandboxIds = observation.sandboxes.map((sandbox) => sandbox.id);
  const key = JSON.stringify([observation.activeRunCount, observation.isRuntimeOnline, sandboxIds]);
  if (key === lastObservationKey) {
    return;
  }
  lastObservationKey = key;
  logger.info(
    {
      activeRunCount: observation.activeRunCount,
      isRuntimeOnline: observation.isRuntimeOnline,
      sandboxIds
    },
    'observed'
  );
}
