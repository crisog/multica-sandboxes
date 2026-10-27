import type { SandboxTemplate } from 'railway';

import { Sandbox } from 'railway';

const MULTICA_VERSION = '0.7.0';
const MULTICA_ARCHIVE = 'multica_linux_amd64.tar.gz';
const MULTICA_RELEASE_URL = `https://github.com/multica-ai/multica/releases/download/v${MULTICA_VERSION}`;

// The release ships one archive per architecture; the sandbox image runs on x86_64.
const INSTALL_MULTICA_CLI = [
  'test "$(uname -m)" = x86_64',
  'cd "$(mktemp -d)"',
  `curl -fsSL -O ${MULTICA_RELEASE_URL}/${MULTICA_ARCHIVE} -O ${MULTICA_RELEASE_URL}/checksums.txt`,
  `grep " ${MULTICA_ARCHIVE}$" checksums.txt | sha256sum -c -`,
  `tar -xzf ${MULTICA_ARCHIVE} multica`,
  'install -m 0755 multica /usr/local/bin/multica'
].join(' && ');

export function multicaRuntimeTemplate(): SandboxTemplate {
  return Sandbox.template().run(INSTALL_MULTICA_CLI).run('multica version && claude --version');
}
