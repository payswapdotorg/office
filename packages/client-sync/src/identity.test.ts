import { describe, expect, it } from 'vitest';
import { parseOperationId } from '@office/sync';
import {
  offlineCommandFingerprint,
  offlineOperationIdOf,
  parseLocalSequence,
} from './identity';
import { createLocalQueue as createQueue } from './queue';
import type { OfflineCommandIdentity } from './identity';
import { CURRENT_SCHEMA_VERSION, parseCommandName } from '@office/contracts';
import {
  ACTOR_A,
  ACTOR_B,
  CLIENT_A,
  CLIENT_B,
  SCOPE_1,
  commandNameOf,
  progressMutation,
  unwrap,
} from './test-support';
import type { LocalSequence } from './identity';

// OFF-029 — deterministic offline operation identity: the A9 rule the whole
// exactly-once replay is built on. THE named acceptance here: the same
// client + the same local sequence + the same command ALWAYS derive the SAME
// operation id (a queue rebuild or an idempotent re-derivation never mints a
// second identity for one logical mutation), while a different payload (or
// command name, or client, or sequence) derives a DIFFERENT id (a genuinely
// new mutation).

const RECORD_PROGRESS = commandNameOf('work.recordProgress');

const commandIdentity = (payload: Record<string, unknown>): OfflineCommandIdentity => ({
  commandName: RECORD_PROGRESS,
  schemaVersion: CURRENT_SCHEMA_VERSION,
  scope: SCOPE_1,
  actor: ACTOR_A,
  payload,
});

const sequence = (n: number): LocalSequence => unwrap(parseLocalSequence(n));

describe('deterministic offline operation ids (THE named acceptance)', () => {
  it('derives the SAME id for the same client + local sequence + command, on every re-derivation', () => {
    const fingerprint = offlineCommandFingerprint(commandIdentity({ percent: 40 }));
    const first = offlineOperationIdOf({ clientId: CLIENT_A, localSequence: sequence(1), fingerprint });
    const second = offlineOperationIdOf({ clientId: CLIENT_A, localSequence: sequence(1), fingerprint });
    expect(second).toBe(first);

    // The derived id is a valid @office/sync OperationId (the shared grammar).
    expect(unwrap(parseOperationId(first))).toBe(first);
  });

  it('derives the SAME ids when the whole queue is rebuilt from the same captures (idempotent identity)', () => {
    const subscriptionId = 'office-sub-v1-0123456789abcdef0123456789abcdef' as never;
    const captures = [
      { ...progressMutation({ percent: 40 }), basePosition: 0 as never, subscriptionId },
      { ...progressMutation({ percent: 55 }), basePosition: 0 as never, subscriptionId },
    ];
    const firstQueue = createQueue({ clientId: CLIENT_A });
    const rebuild = createQueue({ clientId: CLIENT_A });
    const originalIds = captures.map((capture) => unwrap(firstQueue.capture(capture)).operationId);
    const rebuiltIds = captures.map((capture) => unwrap(rebuild.capture(capture)).operationId);
    expect(rebuiltIds).toEqual(originalIds);
    // Dense 1-based local sequences in queue order.
    expect(firstQueue.entries.map((entry) => entry.localSequence)).toEqual([1, 2]);
  });

  it('derives a DIFFERENT id for a different payload (a genuinely new mutation)', () => {
    const first = offlineOperationIdOf({
      clientId: CLIENT_A,
      localSequence: sequence(1),
      fingerprint: offlineCommandFingerprint(commandIdentity({ percent: 40 })),
    });
    const second = offlineOperationIdOf({
      clientId: CLIENT_A,
      localSequence: sequence(1),
      fingerprint: offlineCommandFingerprint(commandIdentity({ percent: 41 })),
    });
    expect(second).not.toBe(first);
  });

  it('derives a DIFFERENT id for a different command name, client, or local sequence', () => {
    const base = {
      localSequence: sequence(1),
      fingerprint: offlineCommandFingerprint(commandIdentity({ percent: 40 })),
    } as const;
    const otherCommand = offlineOperationIdOf({
      clientId: CLIENT_A,
      localSequence: base.localSequence,
      fingerprint: offlineCommandFingerprint({
        ...commandIdentity({ percent: 40 }),
        commandName: unwrap(parseCommandName('work.reviseProgress')),
      }),
    });
    const otherClient = offlineOperationIdOf({
      clientId: CLIENT_B,
      localSequence: base.localSequence,
      fingerprint: base.fingerprint,
    });
    const otherSequence = offlineOperationIdOf({
      clientId: CLIENT_A,
      localSequence: sequence(2),
      fingerprint: base.fingerprint,
    });
    const baseId = offlineOperationIdOf({ clientId: CLIENT_A, ...base });
    expect(new Set([baseId, otherCommand, otherClient, otherSequence]).size).toBe(4);
  });
});

describe('offline command fingerprints (the kernel rule, composed from parts)', () => {
  it('is deterministic and key-order-insensitive over the payload', () => {
    const left = offlineCommandFingerprint(commandIdentity({ percent: 40, note: 'a' }));
    const right = offlineCommandFingerprint(commandIdentity({ note: 'a', percent: 40 }));
    expect(right).toBe(left);
  });

  it('excludes nothing structural: a different actor or scope changes the fingerprint', () => {
    const base = offlineCommandFingerprint(commandIdentity({ percent: 40 }));
    const otherActor = offlineCommandFingerprint({
      ...commandIdentity({ percent: 40 }),
      actor: ACTOR_B,
    });
    expect(otherActor).not.toBe(base);
  });
});

describe('parseLocalSequence (fail-closed)', () => {
  it('accepts dense 1-based integers and rejects everything else', () => {
    for (const good of [1, 2, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      const parsed = parseLocalSequence(good);
      expect(parsed.ok, `local sequence ${String(good)} must parse`).toBe(true);
    }
    for (const bad of [0, -1, 1.5, Number.NaN, '3', null, undefined, {}]) {
      const parsed = parseLocalSequence(bad);
      expect(parsed.ok, `local sequence ${String(bad)} must fail`).toBe(false);
    }
  });
});
