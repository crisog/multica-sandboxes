import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countActiveRuns } from './multica.ts';

const runtimeIds = new Set(['rt-tickets', 'rt-pagos']);

describe('countActiveRuns', () => {
  it('counts every unfinished status on the served runtimes', () => {
    const runs = [
      { runtime_id: 'rt-tickets', status: 'queued' },
      { runtime_id: 'rt-tickets', status: 'dispatched' },
      { runtime_id: 'rt-pagos', status: 'running' },
      { runtime_id: 'rt-pagos', status: 'waiting_local_directory' }
    ];

    assert.equal(countActiveRuns({ runs, runtimeIds }), 4);
  });

  it('ignores runs on runtimes it does not serve', () => {
    const runs = [
      { runtime_id: 'rt-laptop', status: 'running' },
      { runtime_id: 'rt-laptop', status: 'queued' },
      { runtime_id: 'rt-tickets', status: 'queued' }
    ];

    assert.equal(countActiveRuns({ runs, runtimeIds }), 1);
  });

  it('ignores deferred and finished runs', () => {
    const runs = [
      { runtime_id: 'rt-tickets', status: 'deferred' },
      { runtime_id: 'rt-tickets', status: 'completed' },
      { runtime_id: 'rt-pagos', status: 'failed' },
      { runtime_id: 'rt-pagos', status: 'cancelled' }
    ];

    assert.equal(countActiveRuns({ runs, runtimeIds }), 0);
  });
});
