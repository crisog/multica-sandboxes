import { z } from 'zod';
import { pino } from 'pino';
import { createPrivateKey } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { readRuntimeWork } from './multica.ts';
import { createInstallationToken } from './github-app.ts';
import { bootRuntimeSandbox, destroyRuntimeSandbox, listRuntimeSandboxes } from './runtime-sandbox.ts';

// The daemon registered about 4 s after its sandbox started in tests.
const REGISTRATION_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;

const environmentSchema = z.object({
  RAILWAY_API_TOKEN: z.string().min(1),
  RAILWAY_ENVIRONMENT_ID: z.uuid(),
  MULTICA_SERVER_URL: z.url(),
  MULTICA_TOKEN: z.string().min(1),
  MULTICA_DAEMON_ID: z.uuid(),
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_UPLOAD_TOKEN: z.string().min(1)
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

// The dispatcher boots a sandbox only for runs on registered runtimes, so a new daemon ID needs one boot by hand.
// A second sandbox would fail the runs of the first, so the script refuses to boot next to a running one.
const [running] = await listRuntimeSandboxes(runtimeSandbox);
if (running !== undefined) {
  throw new Error(`Runtime sandbox ${running.id} is already running, and its daemon registers the runtimes`);
}

const githubToken = await createInstallationToken({
  appId: environment.GITHUB_APP_ID,
  privateKey: createPrivateKey(environment.GITHUB_APP_PRIVATE_KEY)
});
const booted = await bootRuntimeSandbox({
  ...runtimeSandbox,
  githubToken: githubToken.token,
  githubUploadToken: environment.GITHUB_UPLOAD_TOKEN
});
logger.info({ sandboxId: booted.sandboxId, createMs: booted.createMs }, 'sandbox booted');
try {
  await waitForRuntimeOnline();
  logger.info({ daemonId: environment.MULTICA_DAEMON_ID }, 'a runtime came online');
} finally {
  await destroyRuntimeSandbox({ config: runtimeSandbox.config, sandboxId: booted.sandboxId });
  logger.info({ sandboxId: booted.sandboxId }, 'sandbox destroyed');
}

async function waitForRuntimeOnline(): Promise<void> {
  const deadlineMs = Date.now() + REGISTRATION_TIMEOUT_MS;
  for (;;) {
    const work = await readRuntimeWork(multica);
    if (work.isRuntimeOnline) {
      return;
    }
    if (Date.now() > deadlineMs) {
      throw new Error(
        `No runtime with daemon ID ${environment.MULTICA_DAEMON_ID} came online within ${REGISTRATION_TIMEOUT_MS} ms`
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
