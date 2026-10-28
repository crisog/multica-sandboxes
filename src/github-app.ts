import type { KeyObject } from 'node:crypto';

import { z } from 'zod';
import { sign } from 'node:crypto';

const GITHUB_API_URL = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
// GitHub rejects an app JWT that lives longer than 10 minutes. Backdating iat absorbs clock drift.
const JWT_LIFETIME_SECONDS = 540;
const JWT_BACKDATE_SECONDS = 60;
// Tokens get exactly these permissions, so a permission later added to the App does not reach agents.
// Agents read checks and statuses to wait for a pull request's review, and post the signoff status after their checks pass.
const TOKEN_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
  checks: 'read',
  statuses: 'write'
};

const installationsSchema = z.array(z.object({ id: z.number() }));

const installationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime()
});

export type GithubAppConfig = {
  appId: number;
  privateKey: KeyObject;
};

export type InstallationToken = {
  token: string;
  expiresAtMs: number;
};

// The app is private to one organization, so its only installation covers every repository agents may use.
export async function createInstallationToken(config: GithubAppConfig): Promise<InstallationToken> {
  const jwt = appJwt(config);
  const installations = installationsSchema.parse(
    await githubRequest({ jwt, method: 'GET', path: '/app/installations' })
  );
  const installation = installations[0];
  if (installation === undefined || installations.length > 1) {
    throw new Error(
      `GitHub App ${config.appId} has ${installations.length} installations, and the dispatcher needs exactly one`
    );
  }
  const created = installationTokenSchema.parse(
    await githubRequest({
      jwt,
      method: 'POST',
      path: `/app/installations/${installation.id}/access_tokens`,
      body: { permissions: TOKEN_PERMISSIONS }
    })
  );
  return { token: created.token, expiresAtMs: Date.parse(created.expires_at) };
}

function appJwt({ appId, privateKey }: GithubAppConfig): string {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const header = base64url({ alg: 'RS256', typ: 'JWT' });
  const payload = base64url({
    iat: nowSeconds - JWT_BACKDATE_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: appId
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

type GithubRequestParams = {
  jwt: string;
  method: 'GET' | 'POST';
  path: string;
  body?: object;
};

async function githubRequest({ jwt, method, path, body }: GithubRequestParams): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'multica-sandboxes',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(new URL(path, GITHUB_API_URL), init);
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}
