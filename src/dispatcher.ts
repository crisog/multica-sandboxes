import { z } from 'zod';
import { pino } from 'pino';
import { createPrivateKey } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Decision, Observation, RuntimeSandbox } from './lifecycle.ts';

import { decide } from './lifecycle.ts';
import { readRuntimeWork } from './multica.ts';
import { createInstallationToken } from './github-app.ts';
import {
  bootRuntimeSandbox,
  describeRuntimeSandbox,
  destroyRuntimeSandbox,
  listRuntimeSandboxes,
  writeGithubToken
} from './runtime-sandbox.ts';

const POLL_INTERVAL_MS = 10_000;
// The daemon registered about 4 s after its sandbox started in tests; the timeout also rides out a brief Multica outage.
const RUNTIME_OFFLINE_TIMEOUT_MS = 180_000;
// GitHub installation tokens live one hour, so a token is replaced with half its life left.
const GITHUB_TOKEN_REFRESH_MARGIN_MS = 30 * 60_000;

const environmentSchema = z.object({
  RAILWAY_API_TOKEN: z.string().min(1),
  RAILWAY_ENVIRONMENT_ID: z.uuid(),
  MULTICA_SERVER_URL: z.url(),
  MULTICA_TOKEN: z.string().min(1),
  MULTICA_DAEMON_ID: z.uuid(),
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
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
const githubApp = {
  appId: environment.GITHUB_APP_ID,
  privateKey: createPrivateKey(environment.GITHUB_APP_PRIVATE_KEY)
};
const policy = {
  idleGraceMs: environment.SANDBOX_IDLE_GRACE_SECONDS * 1_000,
  offlineTimeoutMs: RUNTIME_OFFLINE_TIMEOUT_MS
};

// A restart cannot know when the runtimes last had work or were online, so both clocks start again.
let lastActiveAtMs = Date.now();
let lastOnlineAtMs = Date.now();
let lastObservationKey = '';
// A restart cannot know when the adopted sandbox got its token, so the first reconcile replaces it.
let githubTokenRefresh: { sandboxId: string; dueAtMs: number } | null = null;

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
  const decision = decide({ observation, policy });
  await act(decision);
  if (decision.kind === 'wait') {
    await refreshGithubTokens(sandboxes);
  }
}

async function act(decision: Decision): Promise<void> {
  switch (decision.kind) {
    case 'wait': {
      return;
    }
    case 'boot': {
      const githubToken = await createInstallationToken(githubApp);
      const booted = await bootRuntimeSandbox({ ...runtimeSandbox, githubToken: githubToken.token });
      githubTokenRefresh = {
        sandboxId: booted.sandboxId,
        dueAtMs: githubToken.expiresAtMs - GITHUB_TOKEN_REFRESH_MARGIN_MS
      };
      logger.info(booted, 'sandbox booted');
      return;
    }
    case 'destroy': {
      for (const sandboxId of decision.sandboxIds) {
        if (decision.reason === 'unhealthy') {
          await logUnhealthySandbox(sandboxId);
        }
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

// An unhealthy sandbox may not answer, and the description must not keep it alive, so a failed read is logged and the replacement goes ahead.
async function logUnhealthySandbox(sandboxId: string): Promise<void> {
  try {
    const health = await describeRuntimeSandbox({ ...runtimeSandbox, sandboxId });
    logger.warn({ sandboxId, ...health }, 'unhealthy sandbox');
  } catch (error) {
    logger.warn({ sandboxId, err: error }, 'unhealthy sandbox not described');
  }
}

// A wait keeps at most one sandbox, because decide destroys every duplicate first.
async function refreshGithubTokens(sandboxes: RuntimeSandbox[]): Promise<void> {
  for (const sandbox of sandboxes) {
    if (githubTokenRefresh?.sandboxId === sandbox.id && Date.now() < githubTokenRefresh.dueAtMs) {
      continue;
    }
    const githubToken = await createInstallationToken(githubApp);
    await writeGithubToken({ config: runtimeSandbox.config, sandboxId: sandbox.id, token: githubToken.token });
    githubTokenRefresh = {
      sandboxId: sandbox.id,
      dueAtMs: githubToken.expiresAtMs - GITHUB_TOKEN_REFRESH_MARGIN_MS
    };
    logger.info(
      { sandboxId: sandbox.id, expiresAt: new Date(githubToken.expiresAtMs).toISOString() },
      'github token written'
    );
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
