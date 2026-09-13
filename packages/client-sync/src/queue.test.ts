import { describe, expect, it } from 'vitest';
import type { LedgerEventId } from '@office/events';
import { formatLedgerEventId } from '@office/events';
import {
  createLocalQueue,
  isProtectionClass,
  isQueueEntry,
  isQueueEntryState,
  parseProtectionClass,
  parseQueueEntry,
  parseQueueEntryState,
} from './queue';
import type { ConflictRecordId, SlicePosition, SubscriptionId } from '@office/sync';
import {
  CLIENT_A,
  NOW_2,
  SCOPE_TENANT_B,
  TARGET_NOTE,
  TARGET_PROGRESS,
  progressMutation,
  unwrap,
} from './test-support';
import type { QueueEntry } from './queue';

// OFF-029 — the LocalQueue model: the bounded disconnected mutation queue.
// These suites prove the capture discipline (dense local sequences, the
// deterministic operation ids, the local causal chain, the client-observed
// timestamp, the A8 idempotency-key rule), the bounded-capacity typed
// rejection (freeze A9), the TERMINAL entry lifecycle, and the fail-closed
// queue-entry parse (the boundary every untrusted queue entry — e.g. one read
// back from a durable store — passes through).

const eventId = (opaque: string): LedgerEventId => formatLedgerEventId({ version: 'v1', opaque });
const conflictId = (opaque: string): ConflictRecordId =>
  `office-scf-v1-${opaque}` as ConflictRecordId;
const subscriptionId = (): SubscriptionId =>
  'office-sub-v1-0123456789abcdef0123456789abcdef' as SubscriptionId;
const position = (n: number): SlicePosition => n as SlicePosition;
const fullMutation = (parts: Parameters<typeof progressMutation>[0] = {}) => ({
  ...progressMutation(parts),
  basePosition: position(0),
  subscriptionId: subscriptionId(),
});
const EVENT_1 = eventId('1'.padEnd(32, '0'));
const EVENT_2 = eventId('2'.padEnd(32, '0'));
const EVENT_3 = eventId('3'.padEnd(32, '0'));

describe('capture (the disconnected mutation discipline)', () => {
  it('assigns dense local sequences, deterministic ids, the local causal chain, and the client-observed timestamp', () => {
    const queue = createLocalQueue({ clientId: CLIENT_A });
    const first = unwrap(queue.capture(fullMutation({ percent: 40 })));
    const second = unwrap(queue.capture(fullMutation({ percent: 55 })));

    expect(first.localSequence).toBe(1);
    expect(second.localSequence).toBe(2);
    expect(first.operationId).not.toBe(second.operationId);
    // THE A8 offline rule: the envelope's idempotency key IS the entry's
    // deterministic operation id.
    expect(first.command.idempotencyKey).toBe(first.operationId);
    expect(second.command.idempotencyKey).toBe(second.operationId);
    // The local causal chain: the first capture is uncaused; each later
    // capture is caused by the previous entry's operation id (freeze A3).
    expect(first.command.causality.causationId).toBeNull();
    expect(second.command.causality.causationId).toBe(first.operationId);
    // The client-observed timestamp is payload data, preserved verbatim.
    expect(first.command.issuedAt).toBe(NOW_2);
    // Pending until the drain resolves it terminally.
    expect(first.state).toEqual({ status: 'pending' });
    expect(queue.pending).toHaveLength(2);
    expect(queue.size).toBe(2);
  });

  it('captures the causal/version token and the session subscription verbatim', () => {
    const queue = createLocalQueue({ clientId: CLIENT_A });
    const entry = unwrap(
      queue.capture({
        ...progressMutation({ percent: 40 }),
        basePosition: position(7),
        subscriptionId: subscriptionId(),
      }),
    );
    expect(entry.basePosition).toBe(7);
    expect(entry.subscriptionId).toBe(subscriptionId());
    expect(entry.target).toEqual(TARGET_PROGRESS);
    expect(entry.protection).toBe('protected');
    // The payload digest is the canonical digest of the command payload.
    expect(entry.payloadDigest).toHaveLength(64);
  });

  it('rejects non-project and malformed captures typed, leaving the queue untouched (A12 scoping is the engine + replay gate)', () => {
    const queue = createLocalQueue({ clientId: CLIENT_A });
    // The queue itself accepts any PROJECT-scoped capture (it is the client's
    // local store; a foreign-tenant project scope is still structurally valid
    // — the A12 typed rejection happens at the engine's session gate on
    // capture and at the replay's authorization, both proven in their suites).
    const foreignProject = queue.capture(fullMutation({ scope: SCOPE_TENANT_B, percent: 40 }));
    expect(foreignProject.ok).toBe(true);
    // Non-project (tenant-wide) scopes are structurally invalid for the slice
    // protocol — typed rejection at the queue boundary.
    const tenantScope = queue.capture({
      ...fullMutation({ percent: 40 }),
      scope: { kind: 'tenant', tenantId: SCOPE_TENANT_B.tenantId } as never,
    });
    expect(tenantScope.ok).toBe(false);
    if (!tenantScope.ok) {
      expect(tenantScope.error.code).toBe('invariant-violation');
      expect(tenantScope.error.details[0]?.code).toBe('capture-invalid');
    }
    const badCommand = queue.capture(
      fullMutation({ commandName: 'notACommandName' as never, percent: 40 }),
    );
    expect(badCommand.ok).toBe(false);
    const badActor = queue.capture(fullMutation({ actor: { kind: 'nobody' } as never }));
    expect(badActor.ok).toBe(false);
    // Only the structurally valid capture entered the queue.
    expect(queue.size).toBe(1);
  });
});

describe('the bounded queue (freeze A9)', () => {
  it('typed-rejects captures beyond the capacity', () => {
    const queue = createLocalQueue({ clientId: CLIENT_A, capacity: 2 });
    unwrap(queue.capture(fullMutation({ percent: 40 })));
    unwrap(queue.capture(fullMutation({ percent: 55 })));
    const overflow = queue.capture(fullMutation({ percent: 60 }));
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.code).toBe('invariant-violation');
      expect(overflow.error.details[0]?.code).toBe('queue-full');
    }
    expect(queue.size).toBe(2);
  });

  it('throws loudly on an invalid capacity (a wiring error, never a runtime behavior)', () => {
    expect(() => createLocalQueue({ clientId: CLIENT_A, capacity: 0 })).toThrow(TypeError);
  });
});

describe('the terminal entry lifecycle', () => {
  it('pending → applied / conflicted / superseded, and terminal means terminal', () => {
    const queue = createLocalQueue({ clientId: CLIENT_A });
    const applied = unwrap(queue.capture(fullMutation({ percent: 40, target: TARGET_PROGRESS })));
    const conflicted = unwrap(queue.capture(fullMutation({ percent: 55, target: TARGET_NOTE })));

    const marked = unwrap(
      queue.markApplied(applied.operationId, { eventId: EVENT_1, replayed: false }),
    );
    expect(marked.state).toEqual({ status: 'applied', eventId: EVENT_1, replayed: false });

    const parked = unwrap(
      queue.markConflicted(conflicted.operationId, conflictId('0123456789abcdef0123456789abcdef')),
    );
    expect(parked.state).toEqual({
      status: 'conflicted',
      conflictId: conflictId('0123456789abcdef0123456789abcdef'),
    });

    // Terminal states never transition again (typed rejections).
    const reApplied = queue.markApplied(applied.operationId, { eventId: EVENT_2, replayed: true });
    expect(reApplied.ok).toBe(false);
    if (!reApplied.ok) {
      expect(reApplied.error.details[0]?.code).toBe('queue-entry-terminal');
    }
    const reConflicted = queue.markSuperseded(conflicted.operationId, conflictId('0123456789abcdef0123456789abcdef'));
    expect(reConflicted.ok).toBe(false);
    // Only pending entries remain.
    expect(queue.pending).toHaveLength(0);
    expect(queue.size).toBe(2);
  });

  it('typed-rejects transitions of unknown operations and invalid outcomes', () => {
    const queue = createLocalQueue({ clientId: CLIENT_A });
    const unknown = queue.markApplied('office-op-v1-0123456789abcdef0123456789abcdef' as never, {
      eventId: EVENT_3,
      replayed: false,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('not-found');
    }
    const entry = unwrap(queue.capture(fullMutation({ percent: 40 })));
    const badEvent = queue.markApplied(entry.operationId, {
      eventId: 'not-a-ledger-event-id' as never,
      replayed: false,
    });
    expect(badEvent.ok).toBe(false);
  });
});

describe('parseQueueEntry (fail-closed, strict keys)', () => {
  const validEntry = (): QueueEntry => {
    const queue = createLocalQueue({ clientId: CLIENT_A });
    return unwrap(queue.capture(fullMutation({ percent: 40 })));
  };

  it('round-trips a captured entry through serialization', () => {
    const entry = validEntry();
    const parsed = parseQueueEntry(JSON.parse(JSON.stringify(entry)) as unknown);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(entry);
      expect(isQueueEntry(JSON.parse(JSON.stringify(entry)) as unknown)).toBe(true);
    }
  });

  it('rejects unknown keys, missing fields, and wrong types', () => {
    const entry = validEntry() as unknown as Record<string, unknown>;
    const withUnknown = parseQueueEntry({ ...entry, extra: 'no' });
    expect(withUnknown.ok).toBe(false);
    const missing = parseQueueEntry({ ...entry, target: undefined });
    expect(missing.ok).toBe(false);
    const wrongType = parseQueueEntry({ ...entry, localSequence: 'one' });
    expect(wrongType.ok).toBe(false);
  });

  it('enforces THE A8 offline rule: the envelope idempotency key IS the entry operation id', () => {
    const entry = validEntry() as unknown as Record<string, unknown>;
    const command = { ...(entry['command'] as Record<string, unknown>) };
    command['idempotencyKey'] = 'office-op-v1-ffffffffffffffffffffffffffffffff';
    const mismatched = parseQueueEntry({ ...entry, command });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.error.code).toBe('invalid-value');
      expect(mismatched.error.path).toBe('command.idempotencyKey');
    }
  });

  it('requires a PROJECT scope (the slice protocol is project-scoped, freeze A12)', () => {
    const entry = validEntry() as unknown as Record<string, unknown>;
    const command = { ...(entry['command'] as Record<string, unknown>) };
    command['scope'] = { kind: 'tenant', tenantId: 'tenant-v1-0b1c2d3e4f5061728394a5b6c7d8e9f0' };
    const tenantScoped = parseQueueEntry({ ...entry, command });
    expect(tenantScoped.ok).toBe(false);
  });
});

describe('parseQueueEntryState + parseProtectionClass (fail-closed)', () => {
  it('parses every lifecycle state shape and rejects the rest', () => {
    expect(unwrap(parseQueueEntryState({ status: 'pending' }))).toEqual({ status: 'pending' });
    const applied = parseQueueEntryState({
      status: 'applied',
      eventId: EVENT_1,
      replayed: true,
    });
    expect(applied.ok).toBe(true);
    const conflicted = parseQueueEntryState({
      status: 'conflicted',
      conflictId: conflictId('0123456789abcdef0123456789abcdef'),
    });
    expect(conflicted.ok).toBe(true);
    const superseded = parseQueueEntryState({
      status: 'superseded',
      conflictId: conflictId('0123456789abcdef0123456789abcdef'),
    });
    expect(superseded.ok).toBe(true);

    for (const bad of [
      {},
      { status: 'unknown' },
      { status: 'applied' },
      { status: 'applied', eventId: EVENT_1, replayed: 'yes' },
      { status: 'conflicted', conflictId: conflictId('0123456789abcdef0123456789abcdef'), extra: 1 },
      null,
      'pending',
    ]) {
      expect(parseQueueEntryState(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(isQueueEntryState({ status: 'pending' })).toBe(true);
  });

  it('parses the closed protection vocabulary and rejects everything else', () => {
    expect(unwrap(parseProtectionClass('protected'))).toBe('protected');
    expect(unwrap(parseProtectionClass('open'))).toBe('open');
    for (const bad of ['Protected', 'shielded', '', null, 1]) {
      expect(parseProtectionClass(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(isProtectionClass('open')).toBe(true);
    expect(isProtectionClass('closed')).toBe(false);
  });
});
