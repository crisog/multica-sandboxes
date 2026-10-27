import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LifecyclePolicy, Observation } from './lifecycle.ts';

import { decide } from './lifecycle.ts';

const NOW_MS = Date.parse('2026-10-27T06:00:00Z');

const policy: LifecyclePolicy = {
  idleGraceMs: 300_000,
  offlineTimeoutMs: 180_000
};

describe('decide', () => {
  it('boots a sandbox when runs are waiting and no sandbox exists', () => {
    const observation: Observation = {
      sandboxes: [],
      activeRunCount: 1,
      isRuntimeOnline: false,
      lastActiveAtMs: NOW_MS,
      lastOnlineAtMs: NOW_MS - 3_600_000,
      nowMs: NOW_MS
    };

    assert.deepEqual(decide({ observation, policy }), { kind: 'boot' });
  });

  it('waits when there is no work and no sandbox', () => {
    const observation: Observation = {
      sandboxes: [],
      activeRunCount: 0,
      isRuntimeOnline: false,
      lastActiveAtMs: NOW_MS - 3_600_000,
      lastOnlineAtMs: NOW_MS - 3_600_000,
      nowMs: NOW_MS
    };

    assert.deepEqual(decide({ observation, policy }), { kind: 'wait' });
  });

  it('does not boot a second sandbox while one is serving runs', () => {
    const observation: Observation = {
      sandboxes: [{ id: 'sb-1', createdAtMs: NOW_MS - 600_000 }],
      activeRunCount: 3,
      isRuntimeOnline: true,
      lastActiveAtMs: NOW_MS,
      lastOnlineAtMs: NOW_MS,
      nowMs: NOW_MS
    };

    assert.deepEqual(decide({ observation, policy }), { kind: 'wait' });
  });

  it('keeps the sandbox while runs are unfinished, even when the idle clock is old', () => {
    const observation: Observation = {
      sandboxes: [{ id: 'sb-1', createdAtMs: NOW_MS - 7_200_000 }],
      activeRunCount: 2,
      isRuntimeOnline: true,
      lastActiveAtMs: NOW_MS - 3_600_000,
      lastOnlineAtMs: NOW_MS,
      nowMs: NOW_MS
    };

    assert.deepEqual(decide({ observation, policy }), { kind: 'wait' });
  });

  it('keeps an idle sandbox until the grace ends', () => {
    const observation: Observation = {
      sandboxes: [{ id: 'sb-1', createdAtMs: NOW_MS - 600_000 }],
      activeRunCount: 0,
      isRuntimeOnline: true,
      lastActiveAtMs: NOW_MS - 299_999,
      lastOnlineAtMs: NOW_MS,
      nowMs: NOW_MS
    };

    assert.deepEqual(decide({ observation, policy }), { kind: 'wait' });
  });

  it('destroys an idle sandbox once the grace ends', () => {
    const observation: Observation = {
      sandboxes: [{ id: 'sb-1', createdAtMs: NOW_MS - 600_000 }],
      activeRunCount: 0,
      isRuntimeOnline: true,
      lastActiveAtMs: NOW_MS - 300_000,
      lastOnlineAtMs: NOW_MS,
      nowMs: NOW_MS
    };

    assert.deepEqual(decide({ observation, policy }), {
      kind: 'destroy',
      sandboxIds: ['sb-1'],
      reason: 'idle'
    });
  });

  it('keeps a starting sandbox whose runtime is not online yet', () => {
    const observation: Observation = {
      sandboxes: [{ id: 'sb-1', createdAtMs: NOW_MS - 179_999 }],
      activeRunCount: 1,
      isRuntimeOnline: false,
      lastActiveAtMs: NOW_MS,
      lastOnlineAtMs: NOW_MS - 3_600_000,
      nowMs: NOW_MS
    };

    assert.deepEqual(decide({ observation, policy }), { kind: 'wait' });
  });

  it('destroys a new sandbox whose runtime does not come online within the timeout', () => {
    const observation: Observation = {
      sandboxes: [{ id: 'sb-1', createdAtMs: NOW_MS - 180_000 }],
      activeRunCount: 1,
      isRuntimeOnline: false,
      lastActiveAtMs: NOW_MS,
      lastOnlineAtMs: NOW_MS - 3_600_000,
      nowMs: NOW_MS
    };

    assert.deepEqual(decide({ observation, policy }), {
      kind: 'destroy',
      sandboxIds: ['sb-1'],
      reason: 'unhealthy'
    });
  });

  it('keeps an old sandbox whose runtime went offline less than the timeout ago', () => {
    const observation: Observation = {
      sandboxes: [{ id: 'sb-1', createdAtMs: NOW_MS - 3_600_000 }],
      activeRunCount: 1,
      isRuntimeOnline: false,
      lastActiveAtMs: NOW_MS,
      lastOnlineAtMs: NOW_MS - 179_999,
      nowMs: NOW_MS
    };

    assert.deepEqual(decide({ observation, policy }), { kind: 'wait' });
  });

  it('destroys an old sandbox whose runtime stayed offline for the timeout', () => {
    const observation: Observation = {
      sandboxes: [{ id: 'sb-1', createdAtMs: NOW_MS - 3_600_000 }],
      activeRunCount: 1,
      isRuntimeOnline: false,
      lastActiveAtMs: NOW_MS,
      lastOnlineAtMs: NOW_MS - 180_000,
      nowMs: NOW_MS
    };

    assert.deepEqual(decide({ observation, policy }), {
      kind: 'destroy',
      sandboxIds: ['sb-1'],
      reason: 'unhealthy'
    });
  });

  it('destroys every sandbox except the newest when more than one is running', () => {
    const observation: Observation = {
      sandboxes: [
        { id: 'sb-old', createdAtMs: NOW_MS - 900_000 },
        { id: 'sb-new', createdAtMs: NOW_MS - 60_000 },
        { id: 'sb-mid', createdAtMs: NOW_MS - 300_000 }
      ],
      activeRunCount: 1,
      isRuntimeOnline: true,
      lastActiveAtMs: NOW_MS,
      lastOnlineAtMs: NOW_MS,
      nowMs: NOW_MS
    };

    const decision = decide({ observation, policy });

    assert.ok(decision.kind === 'destroy');
    assert.equal(decision.reason, 'duplicate');
    assert.deepEqual(decision.sandboxIds.toSorted(), ['sb-mid', 'sb-old']);
  });
});
