// OFF-017 acceptance — the ActionDescriptor registry: known-action
// resolution, fail-closed construction (a duplicate command name is a loud
// TypeError, never a silent policy override).
import { describe, expect, it } from 'vitest';
import { parseCommandName } from '@office/contracts';
import { CANONICAL_DESCRIPTORS, unwrap } from './test-support';
import { createInMemoryActionRegistry } from './registry';

describe('createInMemoryActionRegistry', () => {
  it('resolves every registered descriptor by command name', () => {
    const registry = createInMemoryActionRegistry(CANONICAL_DESCRIPTORS);
    for (const descriptor of CANONICAL_DESCRIPTORS) {
      expect(registry.find(descriptor.commandName)).toEqual(descriptor);
    }
  });

  it('resolves unknown command names to null', () => {
    const registry = createInMemoryActionRegistry(CANONICAL_DESCRIPTORS);
    expect(
      registry.find(unwrap(parseCommandName('cost.teleportLedger'))),
    ).toBeNull();
  });

  it('lists descriptors in registration order', () => {
    const registry = createInMemoryActionRegistry(CANONICAL_DESCRIPTORS);
    expect(registry.descriptors()).toEqual(CANONICAL_DESCRIPTORS);
  });

  it('returns a defensive copy from descriptors()', () => {
    const registry = createInMemoryActionRegistry(CANONICAL_DESCRIPTORS);
    const listed = registry.descriptors();
    expect(listed).not.toBe(registry.descriptors());
  });

  it('throws a loud TypeError on a duplicate command name', () => {
    const [first] = CANONICAL_DESCRIPTORS;
    if (first === undefined) throw new Error('fixture invariant broken');
    expect(() =>
      createInMemoryActionRegistry([first, first]),
    ).toThrowError(/duplicate action descriptor/);
  });

  it('accepts an empty registry (everything becomes prohibited-by-default)', () => {
    const registry = createInMemoryActionRegistry([]);
    expect(registry.descriptors()).toEqual([]);
    expect(registry.find(unwrap(parseCommandName('cost.listCostItems')))).toBeNull();
  });
});
