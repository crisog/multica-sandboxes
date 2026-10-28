import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { ghWrapper } from './runtime-template.ts';

const APP_TOKEN = 'app-token-value';
const UPLOAD_TOKEN = 'upload-token-value';
const REFUSAL =
  'gh: --attach works only as gh pr edit <number> --attach <file>... [--body-file <file>] [--repo <owner>/<repo>]';

// Stands in for /usr/bin/gh and prints the token and the arguments it received, one per line.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$GH_TOKEN" "$@"
`;

const dir = await mkdtemp(join(tmpdir(), 'gh-wrapper-'));
after(() => rm(dir, { recursive: true, force: true }));

const fakeGh = join(dir, 'fake-gh');
await writeFile(fakeGh, FAKE_GH, { mode: 0o755 });
await writeFile(join(dir, 'token'), APP_TOKEN);
await writeFile(join(dir, 'upload-token'), UPLOAD_TOKEN);

const gh = join(dir, 'gh');
await writeFile(
  gh,
  ghWrapper({ ghPath: fakeGh, tokenPath: join(dir, 'token'), uploadTokenPath: join(dir, 'upload-token') }),
  { mode: 0o755 }
);

// The checkpoint build runs the wrapper before the dispatcher has written any token.
const ghWithoutTokens = join(dir, 'gh-without-tokens');
await writeFile(
  ghWithoutTokens,
  ghWrapper({ ghPath: fakeGh, tokenPath: join(dir, 'missing'), uploadTokenPath: join(dir, 'missing-upload') }),
  { mode: 0o755 }
);

describe('gh wrapper', () => {
  const uploadForms = [
    ['pr', 'edit', '12', '--attach', 'shot.png'],
    ['pr', 'edit', '12', '--attach=shot.png'],
    ['pr', 'edit', '12', '--attach', 'before.png', '--attach', 'after.png'],
    ['pr', 'edit', '12', '--attach', './login.png#The login error state'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '--body-file', 'body.md'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '--body-file=body.md'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '-F', '-'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '-Fbody.md'],
    ['pr', 'edit', '--attach', 'shot.png', '-R', 'lucrise-llc/rapidotickets', '12'],
    ['pr', 'edit', '12', '--repo=lucrise-llc/rapidotickets', '--attach', 'shot.png']
  ];
  for (const args of uploadForms) {
    it(`runs gh ${args.join(' ')} with the upload token and the arguments unchanged`, () => {
      const result = spawnSync(gh, args, { encoding: 'utf8' });

      assert.equal(result.status, 0);
      assert.equal(result.stdout, `${[UPLOAD_TOKEN, ...args].join('\n')}\n`);
    });
  }

  const refusedForms = [
    ['pr', 'edit', '12', '--attach', 'shot.png', '--title', 'Fix login'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '-t', 'Fix login'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '--body', 'Fixes login'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '--add-reviewer', 'crisog'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '--remove-milestone'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '--help'],
    ['pr', 'edit', '--attach', 'shot.png'],
    ['pr', 'edit', 'feat/login', '--attach', 'shot.png'],
    ['pr', 'edit', 'https://github.com/lucrise-llc/rapidotickets/pull/12', '--attach', 'shot.png'],
    ['pr', 'edit', '12', '13', '--attach', 'shot.png'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '--', '--title', 'Fix login'],
    ['pr', 'edit', '12', '--attach', 'shot.png', '-tF', 'body.md'],
    ['pr', 'edit', '12', '--attach'],
    ['pr', 'edit', '12', '--body-file', '--attach']
  ];
  for (const args of refusedForms) {
    it(`refuses gh ${args.join(' ')} without running gh or reading a token`, () => {
      const result = spawnSync(ghWithoutTokens, args, { encoding: 'utf8' });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${REFUSAL}\n`);
    });
  }

  const appCalls = [
    ['pr', 'merge', '12', '--squash'],
    ['pr', 'review', '12', '--approve'],
    ['pr', 'comment', '12', '--attach', 'shot.png'],
    ['pr', 'create', '--title', 'Fix login', '--attach', 'shot.png'],
    ['pr', 'edit', '12', '--title', 'Fix login'],
    ['pr', 'edit', '12', '--body-file', 'body.md'],
    ['api', 'repos/lucrise-llc/rapidotickets/statuses/0a1b2c3', '-f', 'state=success', '-f', 'context=signoff'],
    ['api', 'graphql', '-f', 'query=--attach'],
    ['pr', 'view', '12', '--json', 'body', '--jq', '.body | test("login error")']
  ];
  for (const args of appCalls) {
    it(`runs gh ${args.join(' ')} with the App token and the arguments unchanged`, () => {
      const result = spawnSync(gh, args, { encoding: 'utf8' });

      assert.equal(result.status, 0);
      assert.equal(result.stdout, `${[APP_TOKEN, ...args].join('\n')}\n`);
    });
  }
});
