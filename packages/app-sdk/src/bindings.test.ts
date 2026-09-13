import { describe, expect, it } from 'vitest';
import {
  BINDABLE_ACTION_CLASSES,
  isAppHandler,
  isCommandBinding,
  parseAppHandler,
  parseCommandBinding,
} from './bindings';
import { unwrap } from './test-support';

// OFF-025 — command bindings: the typed command + the SYMBOLIC handler
// contract + the required action class. 'prohibited' is unbindable; code
// references of any kind are unrepresentable in the handler contract.

const VALID_HANDLER = {
  kind: 'app-handler',
  handlerId: 'record-progress-handler',
  title: 'Record progress',
  description: 'Records one field progress observation.',
} as const;

const VALID_BINDING = {
  kind: 'command-binding',
  commandName: 'field.recordProgress',
  handler: VALID_HANDLER,
  actionClass: 'reversible',
} as const;

describe('the bindable action classes', () => {
  it('is the executable subset of the freeze-A8 vocabulary', () => {
    expect(BINDABLE_ACTION_CLASSES).toStrictEqual(['read', 'reversible', 'approval-required']);
  });
});

describe('the handler contract (AppHandler)', () => {
  it('parses a symbolic handler and defaults description to null', () => {
    expect(unwrap(parseAppHandler(VALID_HANDLER))).toStrictEqual({
      kind: 'app-handler',
      handlerId: 'record-progress-handler',
      title: 'Record progress',
      description: 'Records one field progress observation.',
    });
    expect(
      unwrap(parseAppHandler({ kind: 'app-handler', handlerId: 'record-progress-handler', title: 'Record' })),
    ).toStrictEqual({
      kind: 'app-handler',
      handlerId: 'record-progress-handler',
      title: 'Record',
      description: null,
    });
    expect(isAppHandler(VALID_HANDLER)).toBe(true);
  });

  it('rejects malformed handlers fail-closed (strict keys, grammars, types)', () => {
    for (const bad of [
      null,
      [],
      'handler',
      { ...VALID_HANDLER, kind: 'handler' },
      { ...VALID_HANDLER, handlerId: 'Handler Id' },
      { ...VALID_HANDLER, handlerId: '' },
      { ...VALID_HANDLER, title: '' },
      { ...VALID_HANDLER, title: 'x'.repeat(201) },
      { ...VALID_HANDLER, description: 5 },
      { ...VALID_HANDLER, extra: 'code.js' },
      { kind: 'app-handler', handlerId: 'record-progress-handler' },
    ]) {
      expect(parseAppHandler(bad).ok, `handler ${JSON.stringify(bad)}`).toBe(false);
      expect(isAppHandler(bad)).toBe(false);
    }
  });
});

describe('command bindings (CommandBinding)', () => {
  it('parses a valid binding unchanged', () => {
    expect(unwrap(parseCommandBinding(VALID_BINDING))).toStrictEqual(VALID_BINDING);
    expect(isCommandBinding(VALID_BINDING)).toBe(true);
  });

  it('rejects prohibited-class bindings (never executable for anyone)', () => {
    const result = parseCommandBinding({ ...VALID_BINDING, actionClass: 'prohibited' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('actionClass');
    }
  });

  it('rejects malformed bindings fail-closed (command grammar, class, keys)', () => {
    for (const bad of [
      null,
      'binding',
      { ...VALID_BINDING, kind: 'binding' },
      { ...VALID_BINDING, commandName: 'notACommandName' },
      { ...VALID_BINDING, commandName: 'field..record' },
      { ...VALID_BINDING, commandName: '' },
      { ...VALID_BINDING, commandName: 42 },
      { ...VALID_BINDING, actionClass: 'destructive' },
      { ...VALID_BINDING, actionClass: null },
      { ...VALID_BINDING, actionClass: undefined },
      { ...VALID_BINDING, handler: null },
      { ...VALID_BINDING, handler: 'record-progress-handler' },
      { ...VALID_BINDING, handler: { ...VALID_HANDLER, handlerId: 'Bad Id' } },
      { ...VALID_BINDING, extra: 'payload' },
      { kind: 'command-binding', commandName: 'field.recordProgress', actionClass: 'read' },
    ]) {
      expect(parseCommandBinding(bad).ok, `binding ${JSON.stringify(bad)}`).toBe(false);
      expect(isCommandBinding(bad)).toBe(false);
    }
  });
});
