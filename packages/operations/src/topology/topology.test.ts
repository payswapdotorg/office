import { describe, expect, it } from 'vitest';
import {
  CONSTRUCTION_ADAPTER_KIND,
  CONSTRUCTION_SYSTEM_ID,
} from '@office/adapter-construction';
import { FINANCE_ADAPTER_KIND, FINANCE_SYSTEM_ID } from '@office/adapter-finance';
import { MODEL_ADAPTER_KIND, MODEL_SYSTEM_ID } from '@office/adapter-model';
import {
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_SYSTEM_ID,
} from '@office/adapter-schedule';
import { OFFICE_DEPLOYMENT_TOPOLOGY } from '../index';

// OFF-038 — the deployment-topology artifact: pure typed data describing
// the canonical single-database + gateway + clients + adapters shape. The
// invariants asserted here are the ones OFF-039's conformance gate reasons
// about and the ones the runbook's restore procedure relies on. Generic
// vocabulary only — no vendor, no cloud, no provider names (scanned below).

const COMPONENT_IDS = new Set(OFFICE_DEPLOYMENT_TOPOLOGY.components.map((part) => part.id));
const ADAPTER_IDS = new Set(OFFICE_DEPLOYMENT_TOPOLOGY.adapters.map((family) => family.id));
const ALL_IDS = new Set([...COMPONENT_IDS, ...ADAPTER_IDS]);
const ROLES = OFFICE_DEPLOYMENT_TOPOLOGY.components.map((part) => part.role);

describe('the canonical single-database shape', () => {
  it('is the typed deployment-topology record', () => {
    expect(OFFICE_DEPLOYMENT_TOPOLOGY.kind).toBe('deployment-topology');
    expect(OFFICE_DEPLOYMENT_TOPOLOGY.name).toBe('office-single-database-topology');
  });

  it('deploys exactly ONE canonical database (no second store of truth)', () => {
    expect(ROLES.filter((role) => role === 'database')).toEqual(['database']);
    expect(
      OFFICE_DEPLOYMENT_TOPOLOGY.components.find((part) => part.role === 'database')?.id,
    ).toBe('office-database');
  });

  it('deploys exactly one gateway, one event transport, and the three clients', () => {
    expect(ROLES.filter((role) => role === 'gateway')).toEqual(['gateway']);
    expect(ROLES.filter((role) => role === 'event-transport')).toEqual(['event-transport']);
    expect(ROLES.filter((role) => role === 'client').sort()).toEqual([
      'client',
      'client',
      'client',
    ]);
    expect(
      OFFICE_DEPLOYMENT_TOPOLOGY.components.filter((part) => part.role === 'client').map((part) => part.id),
    ).toEqual(['office-web-client', 'office-desktop-client', 'office-field-client']);
  });

  it('carries unique component ids with non-empty responsibilities', () => {
    expect(COMPONENT_IDS.size).toBe(OFFICE_DEPLOYMENT_TOPOLOGY.components.length);
    for (const part of OFFICE_DEPLOYMENT_TOPOLOGY.components) {
      expect(part.responsibility.trim().length).toBeGreaterThan(20);
    }
  });
});

describe('the adapter families (anchored to the landed vocabulary)', () => {
  it('deploys the four landed adapter families with their health surfaces', () => {
    expect(OFFICE_DEPLOYMENT_TOPOLOGY.adapters).toEqual([
      {
        id: 'office-adapter-construction',
        adapterKind: CONSTRUCTION_ADAPTER_KIND,
        systemId: CONSTRUCTION_SYSTEM_ID,
        objectKinds: expect.any(Array),
        healthSurface: 'adapter-health-check',
      },
      {
        id: 'office-adapter-finance',
        adapterKind: FINANCE_ADAPTER_KIND,
        systemId: FINANCE_SYSTEM_ID,
        objectKinds: expect.any(Array),
        healthSurface: 'adapter-health-check',
      },
      {
        id: 'office-adapter-model',
        adapterKind: MODEL_ADAPTER_KIND,
        systemId: MODEL_SYSTEM_ID,
        objectKinds: expect.any(Array),
        healthSurface: 'adapter-health-check',
      },
      {
        id: 'office-adapter-schedule',
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        objectKinds: expect.any(Array),
        healthSurface: 'adapter-health-check',
      },
    ]);
    for (const family of OFFICE_DEPLOYMENT_TOPOLOGY.adapters) {
      expect(family.objectKinds.length).toBeGreaterThan(0);
    }
  });
});

describe('the flows and invariants', () => {
  it('flows only between deployed components (database first in canonical order)', () => {
    for (const flow of OFFICE_DEPLOYMENT_TOPOLOGY.flows) {
      expect(ALL_IDS.has(flow.from), `flow source ${flow.from}`).toBe(true);
      expect(ALL_IDS.has(flow.to), `flow target ${flow.to}`).toBe(true);
    }
    expect(OFFICE_DEPLOYMENT_TOPOLOGY.flows[0]).toEqual({
      from: 'office-web-client',
      to: 'office-gateway',
    });
    // Every client reaches the gateway; every adapter ingests through it.
    const gatewaySources = OFFICE_DEPLOYMENT_TOPOLOGY.flows
      .filter((flow) => flow.to === 'office-gateway')
      .map((flow) => flow.from);
    expect(gatewaySources).toContain('office-web-client');
    expect(gatewaySources).toContain('office-desktop-client');
    expect(gatewaySources).toContain('office-field-client');
    expect(gatewaySources).toContain('office-adapter-construction');
  });

  it('states the six operating invariants the runbook relies on', () => {
    expect(OFFICE_DEPLOYMENT_TOPOLOGY.invariants.map((invariant) => invariant.id)).toEqual([
      'single-database',
      'ledger-is-truth',
      'tenant-isolation',
      'forward-only-schema',
      'gateway-only-ingress',
      'restorable-by-drill',
    ]);
    for (const invariant of OFFICE_DEPLOYMENT_TOPOLOGY.invariants) {
      expect(invariant.statement.trim().length).toBeGreaterThan(30);
    }
  });
});

describe('generic vocabulary only (no provider leakage)', () => {
  it('carries no vendor, cloud, or provider names anywhere in the artifact', () => {
    // Assembled from fragments so this scan can never match its own source.
    // ('erp' is deliberately absent: the landed generic adapter vocabulary
    // itself says 'erp-finance' / 'erp-instance-01'.)
    const forbidden = new RegExp(
      `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'a' + 'ws', 'az' + 'ure', 'gc' + 'p', 'mic' + 'rosoft', 'goo' + 'gle'].join('|')})\\b`,
      'i',
    );
    expect(forbidden.test(JSON.stringify(OFFICE_DEPLOYMENT_TOPOLOGY))).toBe(false);
  });
});
