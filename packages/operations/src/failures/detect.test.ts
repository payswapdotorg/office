import { describe, expect, it } from 'vitest';
import { parseTenantId } from '@office/contracts';
import type { ParseResult, Scope, TenantId } from '@office/contracts';
import {
  OFFICE_FAILURE_MODE_CATALOG,
  evaluateFailureDetection,
  failureModeMatches,
  healthyTenantObservability,
  isOperationalAlertId,
  operationalAlertIdOf,
  operationalAlertsInScope,
  parseOperationalAlertId,
} from '../index';
import type {
  AdapterHealthView,
  DatabaseObservation,
  FailureDetectionReport,
  FailureModeKind,
  LedgerObservation,
  MigrationRunObservation,
  PersistenceFaultSample,
  PoolObservation,
  TenantObservability,
} from '../index';

// OFF-038 — the automated-detection acceptance: every failure mode's typed
// detection rule FIRES on its fixture input and stays SILENT on the healthy
// input; the evaluation is deterministic (run twice, byte-identical) and
// tenant-scoped with typed cross-tenant rejections both directions (A12).
// Pure: no clock, no randomness, no I/O — fixture literals only.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(
  parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'),
);
const TENANT_B: TenantId = unwrap(
  parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160f5e4d3c2b1a0'),
);
const TENANT_A_SCOPE: Scope = { kind: 'tenant', tenantId: TENANT_A };

const healthyAdapter = (adapterKind: string, systemId: string): AdapterHealthView => ({
  kind: 'adapter-health-view',
  adapterKind,
  systemId,
  status: 'healthy',
  detail: null,
});

const connectionFault = (message: string): PersistenceFaultSample => ({
  kind: 'persistence-fault-sample',
  surface: 'database',
  code: 'driver-error',
  message,
});

/** The healthy baseline with all four adapter families healthy. */
const healthyView = (): TenantObservability => ({
  ...healthyTenantObservability(TENANT_A),
  adapters: [
    healthyAdapter('construction-cde', 'cde-instance-01'),
    healthyAdapter('erp-finance', 'erp-instance-01'),
    healthyAdapter('model-cde', 'model-instance-01'),
    healthyAdapter('schedule-pm', 'schedule-instance-01'),
  ],
});

/** One observability view overriding exactly one surface. */
type ObservabilitySurface = Pick<
  TenantObservability,
  'database' | 'migrations' | 'adapters' | 'ledger' | 'pool'
>;

const viewWith = (parts: Partial<ObservabilitySurface>): TenantObservability => ({
  ...healthyView(),
  ...parts,
});

const databaseOf = (parts: Partial<DatabaseObservation>): DatabaseObservation => ({
  ...healthyView().database,
  ...parts,
});
const migrationsOf = (parts: Partial<MigrationRunObservation>): MigrationRunObservation => ({
  ...healthyView().migrations,
  ...parts,
});
const ledgerOf = (parts: Partial<LedgerObservation>): LedgerObservation => ({
  ...healthyView().ledger,
  ...parts,
});
const poolOf = (parts: Partial<PoolObservation>): PoolObservation => ({
  ...healthyView().pool,
  ...parts,
});

const expectOk = (result: ReturnType<typeof evaluateFailureDetection>): FailureDetectionReport => {
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result.error)}`);
};

// ----- the fixtures (one per failure mode) -----------------------------------------------

const FIXTURES: readonly { readonly kind: FailureModeKind; readonly view: TenantObservability }[] = [
  {
    kind: 'database-unavailability',
    view: viewWith({
      database: databaseOf({ reachable: false, connectionFaults: [connectionFault('connection refused')] }),
    }),
  },
  {
    kind: 'migration-failure-mid-batch',
    view: viewWith({ migrations: migrationsOf({ appliedInRun: 1, failed: true }) }),
  },
  {
    kind: 'adapter-provider-outage',
    view: viewWith({
      adapters: [
        healthyAdapter('construction-cde', 'cde-instance-01'),
        {
          kind: 'adapter-health-view',
          adapterKind: 'erp-finance',
          systemId: 'erp-instance-01',
          status: 'degraded',
          detail: 'provider connection unstable',
        },
        healthyAdapter('model-cde', 'model-instance-01'),
        healthyAdapter('schedule-pm', 'schedule-instance-01'),
      ],
    }),
  },
  {
    kind: 'ledger-append-failure',
    view: viewWith({
      ledger: ledgerOf({
        appendFailures: [
          {
            kind: 'persistence-fault-sample',
            surface: 'ledger',
            code: 'driver-error',
            message: 'append transaction failed',
          },
        ],
      }),
    }),
  },
  {
    kind: 'pool-exhaustion',
    view: viewWith({ pool: poolOf({ size: 20, maxSize: 20, waiting: 3 }) }),
  },
];

describe('the detection rules fire on their fixture input (OFF-038 acceptance)', () => {
  for (const fixture of FIXTURES) {
    it(`fires '${fixture.kind}' and only it`, () => {
      const report = expectOk(
        evaluateFailureDetection({ scope: TENANT_A_SCOPE, observability: fixture.view }),
      );
      expect(report.healthy).toBe(false);
      expect(report.alerts.map((alert) => alert.failureModeKind)).toEqual([fixture.kind]);
      const [alert] = report.alerts;
      if (alert === undefined) throw new Error('the fixture alert is missing');
      expect(alert.tenantId).toBe(TENANT_A);
      expect(alert.evidence.length).toBeGreaterThan(0);
      expect(alert.operatorAction).toBe(
        OFFICE_FAILURE_MODE_CATALOG.find((record) => record.kind === fixture.kind)?.operatorAction,
      );
      expect(isOperationalAlertId(alert.alertId)).toBe(true);
    });

    it(`matches '${fixture.kind}' through the typed predicate directly`, () => {
      expect(failureModeMatches(fixture.kind, fixture.view)).toBe(true);
    });
  }
});

describe('the detection rules stay silent on the healthy input', () => {
  it('emits zero alerts for the healthy view (every rule silent)', () => {
    const report = expectOk(
      evaluateFailureDetection({ scope: TENANT_A_SCOPE, observability: healthyView() }),
    );
    expect(report.healthy).toBe(true);
    expect(report.alerts).toEqual([]);
    for (const kind of ['database-unavailability', 'migration-failure-mid-batch', 'adapter-provider-outage', 'ledger-append-failure', 'pool-exhaustion'] as const) {
      expect(failureModeMatches(kind, healthyView())).toBe(false);
    }
  });

  it("stays silent below each rule's threshold (single fault, failed-first run, no waiters)", () => {
    // One connection fault with the database still reachable is below the
    // cluster threshold; a run that failed before applying anything is not
    // mid-batch; a full pool with no waiters is not exhaustion.
    const singleFault = viewWith({
      database: databaseOf({ reachable: true, connectionFaults: [connectionFault('timeout')] }),
    });
    const failedBeforeApplying = viewWith({ migrations: migrationsOf({ appliedInRun: 0, failed: true }) });
    const fullButServing = viewWith({ pool: poolOf({ size: 20, maxSize: 20, waiting: 0 }) });
    for (const view of [singleFault, failedBeforeApplying, fullButServing]) {
      const report = expectOk(evaluateFailureDetection({ scope: TENANT_A_SCOPE, observability: view }));
      expect(report.healthy).toBe(true);
      expect(report.alerts).toEqual([]);
    }
  });
});

describe('the evaluation is deterministic', () => {
  it('run twice: byte-identical typed reports', () => {
    const fixture = FIXTURES[0]?.view ?? healthyView();
    const first = expectOk(evaluateFailureDetection({ scope: TENANT_A_SCOPE, observability: fixture }));
    const second = expectOk(evaluateFailureDetection({ scope: TENANT_A_SCOPE, observability: fixture }));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('derives stable alert identities from (mode, tenant, evidence)', () => {
    const evidence = ['database reachable: false', 'connection faults observed: 1'];
    const first = operationalAlertIdOf({ failureModeId: 'database-unavailability', tenantId: TENANT_A, evidence });
    expect(first).toBe(
      operationalAlertIdOf({ failureModeId: 'database-unavailability', tenantId: TENANT_A, evidence }),
    );
    expect(first).not.toBe(
      operationalAlertIdOf({ failureModeId: 'database-unavailability', tenantId: TENANT_B, evidence }),
    );
    expect(first).toMatch(/^office-opr-v1-[0-9a-z]{32}$/);
  });
});

describe('A12: tenant scoping with typed rejections both directions', () => {
  it("typed-rejects evaluating tenant B's view under tenant A's scope", () => {
    const result = evaluateFailureDetection({
      scope: TENANT_A_SCOPE,
      observability: { ...healthyView(), tenantId: TENANT_B },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('unauthorized');
    expect(result.error.scope).toEqual(TENANT_A_SCOPE);
  });

  it("never returns a foreign tenant's alerts to a reading scope", () => {
    const alertA = expectOk(
      evaluateFailureDetection({
        scope: TENANT_A_SCOPE,
        observability: viewWith({ database: databaseOf({ reachable: false }) }),
      }),
    ).alerts;
    const alertB = expectOk(
      evaluateFailureDetection({
        scope: { kind: 'tenant', tenantId: TENANT_B },
        observability: {
          ...viewWith({ migrations: migrationsOf({ appliedInRun: 2, failed: true }) }),
          tenantId: TENANT_B,
        },
      }),
    ).alerts;
    expect(alertA.length).toBe(1);
    expect(alertB.length).toBe(1);
    expect(operationalAlertsInScope([...alertA, ...alertB], TENANT_A_SCOPE)).toEqual(alertA);
    expect(operationalAlertsInScope([...alertB, ...alertA], { kind: 'tenant', tenantId: TENANT_B })).toEqual(
      alertB,
    );
  });
});

describe('the operational alert id grammar (fail-closed)', () => {
  it('parses derived ids and rejects malformed ones', () => {
    const derived = operationalAlertIdOf({
      failureModeId: 'pool-exhaustion',
      tenantId: TENANT_A,
      evidence: ['pool size 20 of maximum 20', 'clients waiting: 3'],
    });
    expect(parseOperationalAlertId(derived)).toEqual({ ok: true, value: derived });
    for (const bad of ['', 'office-opr-v1-', 'office-alt-v1-abc', 'OFFICE-OPR-V1-abc', null, 7]) {
      expect(parseOperationalAlertId(bad).ok).toBe(false);
    }
  });
});
