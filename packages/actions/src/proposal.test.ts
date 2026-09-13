// OFF-017 acceptance — the action proposal: total fail-closed parsing of
// everything a consequential proposal carries (typed command envelope, A4
// evidence references + confidence, subject, resource scope, approval
// reference) and the trusted-path builder.
import { describe, expect, it } from 'vitest';
import { parseCommandName } from '@office/contracts';
import {
  AGENT,
  CORRELATION_ID,
  PROJECT_1,
  SUBJECT_ID,
  envelope,
  proposal,
  subjectRef,
  unwrap,
} from './test-support';
import { parseActionProposal, actionProposal, isActionProposal } from './proposal';
import type { ActionProposal } from './proposal';

const baseProposal = () => ({
  command: envelope({ note: 'R-1' }, unwrap(parseCommandName('field.recordProgress'))),
  evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
  confidence: 'high',
});

describe('parseActionProposal (fail-closed, strict keys)', () => {
  it('parses a full proposal with every optional part present', () => {
    const parsed = parseActionProposal({
      command: envelope({ note: 'R-1' }, unwrap(parseCommandName('field.recordProgress'))),
      subject: subjectRef(),
      evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
      confidence: 'high',
      resourceScope: { kind: 'project', tenantId: 'office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9', projectId: 'office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9' },
      approval: {
        instanceId: 'office-ent-v1-0000000000000001',
        approvalKey: 'action',
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.command.commandName).toBe('field.recordProgress');
      expect(parsed.value.subject?.entityId).toBe(SUBJECT_ID);
      expect(parsed.value.evidence).toEqual([{ slot: 'observation', ref: 'field-obs-0001' }]);
      expect(parsed.value.confidence).toBe('high');
      expect(parsed.value.approval?.approvalKey).toBe('action');
    }
  });

  it('defaults the optional parts to null and requires the rest', () => {
    const parsed = parseActionProposal({
      command: envelope({}, unwrap(parseCommandName('cost.listCostItems'))),
      evidence: [],
      confidence: 'certain',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.subject).toBeNull();
      expect(parsed.value.resourceScope).toBeNull();
      expect(parsed.value.approval).toBeNull();
    }
  });

  it('rejects a non-object root', () => {
    expect(parseActionProposal(42).ok).toBe(false);
  });

  it('rejects unknown keys', () => {
    const parsed = parseActionProposal({
      ...baseProposal(),
      urgency: 'high',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('unknown-field');
      expect(parsed.error.path).toBe('urgency');
    }
  });

  it('rejects a missing command', () => {
    const { command: _omit, ...withoutCommand } = baseProposal();
    void _omit;
    const parsed = parseActionProposal(withoutCommand);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('missing-field');
      expect(parsed.error.path).toBe('command');
    }
  });

  it('rejects a malformed command envelope fail-closed', () => {
    const parsed = parseActionProposal({
      ...baseProposal(),
      command: { kind: 'command' },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toContain('command');
  });

  it('rejects a missing evidence list', () => {
    const { evidence: _omit, ...withoutEvidence } = baseProposal();
    void _omit;
    const parsed = parseActionProposal(withoutEvidence);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('evidence');
  });

  it('rejects malformed evidence references with element paths', () => {
    const parsed = parseActionProposal({
      ...baseProposal(),
      evidence: [{ slot: 'observation', ref: 'has space' }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('evidence[0].ref');
  });

  it('rejects duplicate evidence slots', () => {
    const parsed = parseActionProposal({
      ...baseProposal(),
      evidence: [
        { slot: 'observation', ref: 'field-obs-0001' },
        { slot: 'observation', ref: 'field-obs-0002' },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.received).toContain('observation');
    }
  });

  it('rejects an unknown confidence level', () => {
    const parsed = parseActionProposal({ ...baseProposal(), confidence: 'sure' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('confidence');
  });

  it('rejects a malformed approval reference', () => {
    const parsed = parseActionProposal({
      ...baseProposal(),
      approval: { instanceId: 'not-an-id', approvalKey: 'action' },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toContain('approval');
  });

  it('rejects a malformed resource scope', () => {
    const parsed = parseActionProposal({
      ...baseProposal(),
      resourceScope: { kind: 'galaxy' },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toContain('resourceScope');
  });

  it('type-guards proposals', () => {
    expect(isActionProposal({ ...baseProposal() })).toBe(true);
    expect(isActionProposal({ nope: true })).toBe(false);
  });
});

describe('actionProposal (trusted path)', () => {
  it('composes a validated proposal from plain parts', () => {
    const composed: ActionProposal = actionProposal({
      command: envelope({ note: 'R-1' }, unwrap(parseCommandName('field.recordProgress'))),
      subject: subjectRef(),
      evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
      confidence: 'high',
    });
    expect(composed.command.commandName).toBe('field.recordProgress');
    expect(composed.evidence[0]?.ref).toBe('field-obs-0001');
  });

  it('throws a loud TypeError on invalid parts', () => {
    expect(() =>
      actionProposal({
        command: envelope({}, unwrap(parseCommandName('cost.listCostItems'))),
        confidence: 'surely',
      }),
    ).toThrow(TypeError);
  });
});

describe('proposal fixture (determinism of the shared builders)', () => {
  it('carries the command envelope verbatim', () => {
    const command = envelope({ note: 'R-1' }, unwrap(parseCommandName('field.recordProgress')), {
      actor: { kind: 'agent', actorId: AGENT },
    });
    const prop = proposal(command, { confidence: 'high' });
    expect(prop.command).toEqual(command);
    expect(prop.command.causality.correlationId).toBe(CORRELATION_ID);
    expect(prop.command.scope).toEqual({
      kind: 'project',
      tenantId: prop.command.scope.tenantId,
      projectId: PROJECT_1,
    });
  });
});
