import { z } from 'zod';
import { pino } from 'pino';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Sandbox } from 'railway';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

import { multicaRuntimeTemplate, RUNTIME_CHECKPOINT } from './runtime-template.ts';

const REGION = 'us-east4-eqdc4a';
const BUILD_IDLE_TIMEOUT_MINUTES = 10;
const COMMAND_TIMEOUT_SECONDS = 300;
const PROFILE_DIR = '/opt/agent-profile';
const BUNDLE_PATH = '/tmp/agent-profile.bundle';
const PLUGIN_ID = 'agent-workflows@agent-profile';
const DEFAULT_MODEL = 'claude-opus-5-5';

const environmentSchema = z.object({
  RAILWAY_API_TOKEN: z.string().min(1),
  RAILWAY_ENVIRONMENT_ID: z.uuid()
});

// The tag goes into a shell command, so it is limited to the characters git tags use here.
const argumentsSchema = z.tuple([z.string().min(1), z.string().regex(/^[\w./-]+$/)]);

const logger = pino();
const environment = environmentSchema.parse(process.env);
const [checkout, tag] = argumentsSchema.parse(process.argv.slice(2));
const config = {
  token: environment.RAILWAY_API_TOKEN,
  environmentId: environment.RAILWAY_ENVIRONMENT_ID
};

const commit = await git(['-C', checkout, 'rev-parse', '--verify', `${tag}^{commit}`]);
const bundleDir = await mkdtemp(join(tmpdir(), 'agent-profile-'));
try {
  // A bundle carries the tagged commit with its history, so the sandbox gets a clean checkout of the release, not the local worktree.
  const bundle = join(bundleDir, 'agent-profile.bundle');
  await git(['-C', checkout, 'bundle', 'create', bundle, tag]);
  await buildCheckpoint(await readFile(bundle));
} finally {
  await rm(bundleDir, { recursive: true, force: true });
}

// The build sandbox gets no env, so no credential reaches the checkpoint. Sandboxes receive theirs when they boot.
async function buildCheckpoint(bundle: Buffer): Promise<void> {
  const sandbox = await Sandbox.create(multicaRuntimeTemplate(), {
    ...config,
    region: REGION,
    idleTimeoutMinutes: BUILD_IDLE_TIMEOUT_MINUTES
  });
  try {
    await sandbox.files.write(BUNDLE_PATH, bundle);
    await run({ sandbox, command: installAgentProfile() });
    await run({ sandbox, command: requireAgentProfile() });
    const checkpoint = await sandbox.checkpoint(RUNTIME_CHECKPOINT);
    logger.info(
      { checkpointId: checkpoint.id, name: checkpoint.key, region: sandbox.region, tag, commit },
      'runtime checkpoint saved'
    );
  } finally {
    await sandbox.destroy();
  }
}

// The same setup as agent-profile's install.sh on a workstation: the guidelines become the user CLAUDE.md, and the plugin is installed from the checkout.
function installAgentProfile(): string {
  return [
    `git clone --quiet --branch ${tag} ${BUNDLE_PATH} ${PROFILE_DIR}`,
    `rm ${BUNDLE_PATH}`,
    `claude plugin marketplace add ${PROFILE_DIR}`,
    `claude plugin install ${PLUGIN_ID}`,
    `ln -sfn ${PROFILE_DIR}/AGENTS.md "$HOME/.claude/CLAUDE.md"`,
    // Multica passes --model only when an agent sets one, so this is the model of every other run.
    // Empty attribution drops Claude Code's PR footer and co-author trailer, as the profile's git rules require.
    `jq '.model = "${DEFAULT_MODEL}" | .attribution = {commit: "", pr: ""}' "$HOME/.claude/settings.json" > "$HOME/.claude/settings.json.next"`,
    `mv "$HOME/.claude/settings.json.next" "$HOME/.claude/settings.json"`
  ].join(' && ');
}

// The fingerprint hook stamps every session with the profile commit, and it prints a clean commit only when it can read the checkout.
function requireAgentProfile(): string {
  return [
    `test "$(git -C ${PROFILE_DIR} rev-parse HEAD)" = ${commit}`,
    `test "$(readlink "$HOME/.claude/CLAUDE.md")" = ${PROFILE_DIR}/AGENTS.md`,
    `claude plugin list --json | jq -e 'any(.[]; .id == "${PLUGIN_ID}" and .enabled)'`,
    `jq -e '.model == "${DEFAULT_MODEL}" and .attribution == {commit: "", pr: ""}' "$HOME/.claude/settings.json"`,
    `bash ${PROFILE_DIR}/plugins/agent-workflows/hooks/instruction-fingerprint.sh | grep -E 'instruction-fingerprint: agent-profile@[0-9a-f]+ agent-workflows@'`
  ].join(' && ');
}

type RunParams = {
  sandbox: Sandbox;
  command: string;
};

async function run({ sandbox, command }: RunParams): Promise<void> {
  const result = await sandbox.exec(command, { timeoutSec: COMMAND_TIMEOUT_SECONDS });
  if (result.exitCode !== 0) {
    throw new Error(`Build command exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  }
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)('git', args);
  return stdout.trim();
}
