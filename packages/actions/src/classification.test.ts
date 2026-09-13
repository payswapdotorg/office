// OFF-017 acceptance — action classification: the closed four-class
// vocabulary and the fail-closed rule that UNKNOWN commands are prohibited
// by default (nothing about an unregistered action is ever trusted).
import { describe, expect, it } from 'vitest';
import { parseCommandName } from '@office/contracts';
import {
  COMMIT_BUDGET_REVISION,
  LIST_COST_ITEMS,
  PURGE_COST_LEDGER,
  RECORD_PROGRESS,
  unwrap,
} from './test-support';
import { classifyAction, authorizationActionOf } from './classification';
import { ACTION_CLASSES, isActionClass, parseActionClass } from './descriptor';
import { createInMemoryActionRegistry } from './registry';

describe('the four-class vocabulary (freeze A8)', () => {
  it('declares the classes in vocabulary order', () => {
    expect(ACTION_CLASSES).toEqual([
      'read',
      'reversible',
      'approval-required',
      'prohibited',
    ]);
  });

  it('parses every declared class and rejects everything else', () => {
    for (const actionClass of ACTION_CLASSES) {
      expect(parseActionClass(actionClass).ok).toBe(true);
    }
    for (const bad of ['undoable', 'Read', '', 'write', 3, null]) {
      expect(parseActionClass(bad).ok).toBe(false);
    }
  });

  it('type-guards declared classes', () => {
    expect(isActionClass('read')).toBe(true);
    expect(isActionClass('prohibited')).toBe(true);
    expect(isActionClass('sometimes')).toBe(false);
  });
});

describe('classifyAction (fail-closed)', () => {
  const registry = createInMemoryActionRegistry([
    LIST_COST_ITEMS,
    RECORD_PROGRESS,
    COMMIT_BUDGET_REVISION,
    PURGE_COST_LEDGER,
  ]);

  it('classifies a known action by its declared class', () => {
    const read = classifyAction(
      registry,
      unwrap(parseCommandName('cost.listCostItems')),
    );
    expect(read.actionClass).toBe('read');
    expect(read.known).toBe(true);
    expect(read.descriptor?.commandName).toBe('cost.listCostItems');

    const reversible = classifyAction(
      registry,
      unwrap(parseCommandName('field.recordProgress')),
    );
    expect(reversible.actionClass).toBe('reversible');
    expect(reversible.known).toBe(true);

    const approval = classifyAction(
      registry,
      unwrap(parseCommandName('cost.commitBudgetRevision')),
    );
    expect(approval.actionClass).toBe('approval-required');

    const prohibited = classifyAction(
      registry,
      unwrap(parseCommandName('cost.purgeCostLedger')),
    );
    expect(prohibited.actionClass).toBe('prohibited');
    expect(prohibited.known).toBe(true);
  });

  it('classifies an UNKNOWN command as prohibited by default', () => {
    const unknown = classifyAction(
      registry,
      unwrap(parseCommandName('cost.teleportLedger')),
    );
    expect(unknown.actionClass).toBe('prohibited');
    expect(unknown.known).toBe(false);
    expect(unknown.descriptor).toBeNull();
  });

  it('resolves an empty registry to prohibited for everything', () => {
    const empty = createInMemoryActionRegistry([]);
    const classification = classifyAction(
      empty,
      unwrap(parseCommandName('cost.listCostItems')),
    );
    expect(classification.actionClass).toBe('prohibited');
    expect(classification.known).toBe(false);
  });
});

describe('authorizationActionOf (the authz action of a class)', () => {
  it("maps 'read' to the read action and every write class to write", () => {
    expect(authorizationActionOf('read')).toBe('read');
    expect(authorizationActionOf('reversible')).toBe('write');
    expect(authorizationActionOf('approval-required')).toBe('write');
    expect(authorizationActionOf('prohibited')).toBe('write');
  });
});
