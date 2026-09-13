import { describe, expect, it } from 'vitest';
import { isCommandName, isEntityKind } from '@office/contracts';
import { providerObjectKind } from '@office/adapters-sdk';
import {
  ACCOUNT_OBJECT_KIND,
  COMMITMENT_OBJECT_KIND,
  COST_CODE_OBJECT_KIND,
  FINANCE_ADAPTER_KIND,
  FINANCE_CAPABILITIES,
  FINANCE_CAPABILITY_NAMES,
  FINANCE_OBJECT_KINDS,
  FINANCE_OBJECT_MAPPINGS,
  FINANCE_SYSTEM_ID,
  INVOICE_OBJECT_KIND,
  PAYMENT_OBJECT_KIND,
  financeObjectMappingOf,
} from './vocabulary';

// OFF-024 — the finance vocabulary: the generic ERP/finance identity surface
// (adapter family 'erp-finance', fixture system 'erp-instance-01', the five
// financial object kinds) and THE object mapping table — every provider
// object kind declared with the canonical entity kind it translates into,
// the authz capability the sync authorizes through, and the LANDED canonical
// command names proposed for each change kind. The null mappings are the
// fail-closed gaps: canonical financial semantics the landed cost domain
// does not carry (append-only cost items, immutable invoice amounts,
// append-only payment references) — the adapter refuses to invent them.

describe('finance vocabulary (OFF-024)', () => {
  it('uses the generic ERP/finance provider vocabulary only (no vendor)', () => {
    expect(FINANCE_ADAPTER_KIND).toBe('erp-finance');
    expect(FINANCE_SYSTEM_ID).toBe('erp-instance-01');
    expect(FINANCE_OBJECT_KINDS).toStrictEqual([
      'account',
      'cost-code',
      'commitment',
      'invoice',
      'payment',
    ]);
  });

  it('maps every object kind into the landed canonical cost-domain kinds', () => {
    const canonicalKinds = FINANCE_OBJECT_MAPPINGS.map((mapping) => mapping.canonicalKind);
    expect(canonicalKinds).toStrictEqual([
      'budget',
      'cost-item',
      'commitment',
      'invoice',
      'payment-reference',
    ]);
    for (const kind of canonicalKinds) {
      expect(isEntityKind(kind), kind).toBe(true);
    }
  });

  it('proposes only LANDED canonical command names (the merged cost domain)', () => {
    for (const mapping of FINANCE_OBJECT_MAPPINGS) {
      for (const command of [
        mapping.createCommand,
        mapping.updateCommand,
        mapping.deleteCommand,
      ]) {
        if (command === null) continue;
        expect(isCommandName(command), command).toBe(true);
      }
    }
    expect(FINANCE_OBJECT_MAPPINGS.map((mapping) => mapping.createCommand)).toStrictEqual([
      'cost.createBudget',
      'cost.recordCostItem',
      'cost.createCommitment',
      'cost.recordInvoice',
      'cost.referencePayment',
    ]);
  });

  it('declares five unique object-kind surfaces through one declared capability', () => {
    const kinds = FINANCE_OBJECT_MAPPINGS.map((mapping) => mapping.objectKind);
    expect(new Set(kinds).size).toBe(5);
    for (const mapping of FINANCE_OBJECT_MAPPINGS) {
      expect(mapping.capability).toBe('cost.write');
    }
    expect(FINANCE_CAPABILITY_NAMES.every((name) => name === 'cost.write')).toBe(true);
    // The capabilities value is composed FROM the table (they cannot drift).
    expect(FINANCE_CAPABILITIES.objectKinds.map((entry) => entry.objectKind)).toStrictEqual(
      FINANCE_OBJECT_KINDS,
    );
  });

  it('documents the fail-closed transitions (null = no landed canonical command)', () => {
    // The four families of unmapped provider transitions: canonical cost
    // items are append-only, invoice amounts are immutable at record time,
    // payment references never change or retract, and budgets keep their
    // revision history.
    expect(financeObjectMappingOf(COST_CODE_OBJECT_KIND)?.updateCommand).toBeNull();
    expect(financeObjectMappingOf(COST_CODE_OBJECT_KIND)?.deleteCommand).toBeNull();
    expect(financeObjectMappingOf(INVOICE_OBJECT_KIND)?.updateCommand).toBeNull();
    expect(financeObjectMappingOf(INVOICE_OBJECT_KIND)?.deleteCommand).toBeNull();
    expect(financeObjectMappingOf(PAYMENT_OBJECT_KIND)?.updateCommand).toBeNull();
    expect(financeObjectMappingOf(PAYMENT_OBJECT_KIND)?.deleteCommand).toBeNull();
    expect(financeObjectMappingOf(ACCOUNT_OBJECT_KIND)?.deleteCommand).toBeNull();
    // The mapped ones: budget revisions, commitment amendments and closures.
    expect(financeObjectMappingOf(ACCOUNT_OBJECT_KIND)?.updateCommand).toBe('cost.reviseBudget');
    expect(financeObjectMappingOf(COMMITMENT_OBJECT_KIND)?.updateCommand).toBe(
      'cost.amendCommitment',
    );
    expect(financeObjectMappingOf(COMMITMENT_OBJECT_KIND)?.deleteCommand).toBe(
      'cost.closeCommitment',
    );
  });

  it('resolves declared object kinds and fails closed on undeclared ones', () => {
    for (const kind of FINANCE_OBJECT_KINDS) {
      expect(financeObjectMappingOf(kind)?.objectKind).toBe(kind);
    }
    expect(financeObjectMappingOf(COMMITMENT_OBJECT_KIND)).not.toBeNull();
    // Undeclared kinds resolve to null — never a silent translation.
    expect(financeObjectMappingOf(providerObjectKind('timesheet'))).toBeNull();
  });
});
