import { describe, expect, it } from 'vitest';
import { formatEntityId, isActor, parseActor, parseEntityId } from './index';
import type { Actor, ParseResult } from './index';

// OFF-002 contracts — actor tests. Deterministic: fixed ids, no clock.

const OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const roundTrip = (value: unknown, parse: (raw: unknown) => ParseResult<unknown>): void => {
  const parsed = parse(JSON.parse(JSON.stringify(value)) as unknown);
  if (!parsed.ok) {
    throw new Error(`round-trip parse failed: ${JSON.stringify(parsed.error)}`);
  }
  expect(parsed.value).toStrictEqual(value);
};

const actorId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: OPAQUE })));

const actors: Actor[] = [
  { kind: 'user', actorId },
  { kind: 'agent', actorId },
  { kind: 'app', actorId },
  { kind: 'adapter', actorId },
  { kind: 'system' },
];

describe('actor provenance (freeze A3)', () => {
  it('round-trips every actor kind through JSON', () => {
    for (const actor of actors) {
      roundTrip(actor, parseActor);
    }
  });

  it('parses and narrows identified vs system actors', () => {
    const user = unwrap(parseActor({ kind: 'user', actorId }));
    if (user.kind === 'user') {
      expect(user.actorId).toBe(actorId);
    } else {
      throw new Error('expected identified actor');
    }
    const system = unwrap(parseActor({ kind: 'system' }));
    expect(system.kind).toBe('system');
  });

  it('accepts any canonical entity id as the actor id', () => {
    const adapter = unwrap(parseActor({ kind: 'adapter', actorId: `office-prj-v1-${OPAQUE}` }));
    if (adapter.kind === 'adapter') {
      expect(adapter.actorId).toBe(`office-prj-v1-${OPAQUE}`);
    } else {
      throw new Error('expected adapter actor');
    }
  });

  it('type-guards actor values', () => {
    expect(isActor({ kind: 'system' })).toBe(true);
    expect(isActor({ kind: 'user', actorId })).toBe(true);
    expect(isActor(42)).toBe(false);
    expect(isActor({ kind: 'user' })).toBe(false);
  });

  it('rejects malformed shapes', () => {
    const malformed = [42, null, [], 'user', {}];
    for (const candidate of malformed) {
      expect(parseActor(candidate).ok, `candidate: ${JSON.stringify(candidate)}`).toBe(false);
    }
  });

  it('rejects unknown actor kinds', () => {
    const result = parseActor({ kind: 'human', actorId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('kind');
    }
  });

  it('requires actorId on identified actors', () => {
    const result = parseActor({ kind: 'user' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('missing-field');
      expect(result.error.path).toBe('actorId');
    }
  });

  it('rejects system actors that carry an actorId (strict shapes)', () => {
    const result = parseActor({ kind: 'system', actorId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-field');
      expect(result.error.path).toBe('actorId');
    }
  });

  it('rejects invalid actor ids with nested paths', () => {
    const result = parseActor({ kind: 'user', actorId: '12345' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe('actorId');
    }
  });
});
