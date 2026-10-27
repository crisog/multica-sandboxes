import { z } from 'zod';
import { pino } from 'pino';
import { Sandbox } from 'railway';

import { multicaRuntimeTemplate } from './runtime-template.ts';

const REGION = 'us-east4-eqdc4a';
const SANDBOX_IDLE_TIMEOUT_MINUTES = 30;

// The daemon reads its token only from the CLI config, so the boot command logs in before it starts.
const START_DAEMON = [
  'multica config set server_url "$MULTICA_SERVER_URL"',
  'multica login --token "$MULTICA_TOKEN"',
  'exec multica daemon start --foreground'
].join(' && ');

// Resolved by Railway when the sandbox is created, so secret values never pass through this process.
const SANDBOX_ENV = {
  MULTICA_SERVER_URL: '${{multica-sandboxes.MULTICA_SERVER_URL}}',
  MULTICA_TOKEN: '${{multica-sandboxes.MULTICA_TOKEN}}',
  MULTICA_DAEMON_ID: '${{multica-sandboxes.MULTICA_DAEMON_ID}}',
  CLAUDE_CODE_OAUTH_TOKEN: '${{multica-sandboxes.CLAUDE_CODE_OAUTH_TOKEN}}'
};

const environmentSchema = z.object({
  RAILWAY_API_TOKEN: z.string().min(1),
  RAILWAY_ENVIRONMENT_ID: z.uuid()
});

const logger = pino();
const environment = environmentSchema.parse(process.env);
const client = {
  token: environment.RAILWAY_API_TOKEN,
  environmentId: environment.RAILWAY_ENVIRONMENT_ID
};

const buildStartedAt = performance.now();
const template = await multicaRuntimeTemplate().build({
  ...client,
  region: REGION
});
logger.info({ durationMs: Math.round(performance.now() - buildStartedAt) }, 'template ready');

const createStartedAt = performance.now();
const sandbox = await Sandbox.create(template, {
  ...client,
  idleTimeoutMinutes: SANDBOX_IDLE_TIMEOUT_MINUTES,
  env: SANDBOX_ENV
});
logger.info(
  {
    sandboxId: sandbox.id,
    region: sandbox.region,
    durationMs: Math.round(performance.now() - createStartedAt)
  },
  'sandbox running'
);

const daemon = sandbox.exec(START_DAEMON);
const sessionName = await daemon.detach();
logger.info({ sandboxId: sandbox.id, sessionName }, 'daemon started');
