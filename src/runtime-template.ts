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

// The daemon registers a runtime for each agent CLI it finds on PATH or through `$SHELL -ilc`.
// The base image ships these CLIs besides Claude, and only Claude has credentials in the sandbox.
const UNUSED_AGENT_CLIS = 'codex cursor-agent grok opencode pi';

const REMOVE_UNUSED_AGENT_CLIS = `for cli in ${UNUSED_AGENT_CLIS}; do for path in "$(command -v "$cli")" "$(bash -ilc "command -v $cli" 2>/dev/null)"; do if [ -n "$path" ]; then rm -f "$path"; fi; done; done`;

const REQUIRE_NO_UNUSED_AGENT_CLIS = `for cli in ${UNUSED_AGENT_CLIS}; do if command -v "$cli" || bash -ilc "command -v $cli" 2>/dev/null; then exit 1; fi; done`;

export function multicaRuntimeTemplate(): SandboxTemplate {
  return Sandbox.template()
    .run(INSTALL_MULTICA_CLI)
    .run(REMOVE_UNUSED_AGENT_CLIS)
    .run(REQUIRE_NO_UNUSED_AGENT_CLIS)
    .run('multica version && claude --version');
}
