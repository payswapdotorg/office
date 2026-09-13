// Office operations — the deployment-topology artifact (OFF-038).
//
// A typed record of the canonical deployment shape: ONE database (the
// canonical store: schema migrations, the ledger, the projections), one
// gateway (the single API boundary every client talks through), the
// clients, the four adapter families (one-way provider ingress through
// their health/degrade surfaces), and the projections derived from the
// ledger. Pure typed data — no infrastructure code, no deployment code;
// this is the policy the runbook and the failure catalog reason about.
// Generic vocabulary only: no vendor, no cloud, no provider names.
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

/** One deployed component of the canonical topology. */
export interface TopologyComponent {
  /** Component id (generic vocabulary only). */
  readonly id: string;
  /** What the component is. */
  readonly role:
    | 'database'
    | 'gateway'
    | 'client'
    | 'adapter'
    | 'projection'
    | 'event-transport';
  /** One-line responsibility. */
  readonly responsibility: string;
}

/** One adapter family deployment, anchored to the landed adapter kinds. */
export interface AdapterDeployment {
  /** The deployment component id (the flow target of the family). */
  readonly id: string;
  /** The adapter family's kind (the landed vocabulary constant). */
  readonly adapterKind: string;
  /** The provider system instance the family serves. */
  readonly systemId: string;
  /** Which provider data the family ingests. */
  readonly objectKinds: readonly string[];
  /** The health surface operators watch (degrade/recover + healthCheck). */
  readonly healthSurface: 'adapter-health-check';
}

/** A topology invariant the deployment is operated under. */
export interface TopologyInvariant {
  readonly id: string;
  readonly statement: string;
}

/** THE typed deployment topology (the canonical single-database world). */
export interface DeploymentTopology {
  readonly kind: 'deployment-topology';
  /** The topology's name (generic vocabulary only). */
  readonly name: string;
  /** Every component, in dependency order (database first). */
  readonly components: readonly TopologyComponent[];
  /** The adapter families deployed (the landed four). */
  readonly adapters: readonly AdapterDeployment[];
  /** The invariants operations relies on (typed policy statements). */
  readonly invariants: readonly TopologyInvariant[];
  /** The data-flow edges, `from -> to`, in canonical order. */
  readonly flows: readonly { readonly from: string; readonly to: string }[];
}

const DATABASE: TopologyComponent = {
  id: 'office-database',
  role: 'database',
  responsibility:
    'THE single canonical store: schema via forward-only migrations, the append-only event ledger, and the tenant-scoped projections — one database, no second store of truth',
};

const GATEWAY: TopologyComponent = {
  id: 'office-gateway',
  role: 'gateway',
  responsibility:
    'THE single API boundary: every client session authenticates here, every command envelope is composed and authorized here, and every read crosses the tenant scope here',
};

const EVENT_TRANSPORT: TopologyComponent = {
  id: 'office-event-transport',
  role: 'event-transport',
  responsibility:
    'THE ordered event delivery between the ledger and its consumers (the outbox discipline: no event is observed before its transaction commits)',
};

const CLIENTS: readonly TopologyComponent[] = [
  {
    id: 'office-web-client',
    role: 'client',
    responsibility: 'The browser client: session-scoped reads and command submission through the gateway',
  },
  {
    id: 'office-desktop-client',
    role: 'client',
    responsibility: 'The desktop client: the same gateway contract, longer-lived sessions',
  },
  {
    id: 'office-field-client',
    role: 'client',
    responsibility: 'The field client: offline-tolerant submission through the same gateway contract',
  },
];

const PROJECTIONS: readonly TopologyComponent[] = [
  {
    id: 'office-projection-canonical',
    role: 'projection',
    responsibility:
      'The canonical projections over the ledger: tenant/project scoped tables, always derivable from the event log (rebuildable, never the source of truth)',
  },
];

const ADAPTERS: readonly AdapterDeployment[] = [
  {
    id: 'office-adapter-construction',
    adapterKind: CONSTRUCTION_ADAPTER_KIND,
    systemId: CONSTRUCTION_SYSTEM_ID,
    objectKinds: ['document', 'rfi', 'change-event', 'observation'],
    healthSurface: 'adapter-health-check',
  },
  {
    id: 'office-adapter-finance',
    adapterKind: FINANCE_ADAPTER_KIND,
    systemId: FINANCE_SYSTEM_ID,
    objectKinds: ['account', 'cost-code', 'commitment', 'invoice', 'payment'],
    healthSurface: 'adapter-health-check',
  },
  {
    id: 'office-adapter-model',
    adapterKind: MODEL_ADAPTER_KIND,
    systemId: MODEL_SYSTEM_ID,
    objectKinds: ['model', 'model-version', 'element', 'element-classification'],
    healthSurface: 'adapter-health-check',
  },
  {
    id: 'office-adapter-schedule',
    adapterKind: SCHEDULE_ADAPTER_KIND,
    systemId: SCHEDULE_SYSTEM_ID,
    objectKinds: ['project-schedule', 'activity', 'activity-dependency', 'baseline'],
    healthSurface: 'adapter-health-check',
  },
];

const INVARIANTS: readonly TopologyInvariant[] = [
  {
    id: 'single-database',
    statement:
      'Exactly one canonical database exists; every other surface is a projection or a cache and is rebuildable from the ledger',
  },
  {
    id: 'ledger-is-truth',
    statement:
      'The append-only event ledger is the single source of truth; projections are derived and never carry authority',
  },
  {
    id: 'tenant-isolation',
    statement:
      'Every persisted row and every read/write path is tenant-scoped by construction (the scope predicate is composed into the statement, never filtered after)',
  },
  {
    id: 'forward-only-schema',
    statement:
      'Schema changes land exclusively through ordered, forward-only, append-never-edit migrations; the migrator is the only schema authority and refuses edited history',
  },
  {
    id: 'gateway-only-ingress',
    statement:
      'Every client command enters through the gateway as a fail-closed, session-scoped command envelope; provider data enters only through the adapters',
  },
  {
    id: 'restorable-by-drill',
    statement:
      'The canonical database is restorable from the deterministic backup + the migration files, verified by the restore drill (backup -> destroy -> restore -> identical content)',
  },
];

const FLOWS: readonly { readonly from: string; readonly to: string }[] = [
  { from: 'office-web-client', to: 'office-gateway' },
  { from: 'office-desktop-client', to: 'office-gateway' },
  { from: 'office-field-client', to: 'office-gateway' },
  { from: 'office-gateway', to: 'office-database' },
  { from: 'office-database', to: 'office-event-transport' },
  { from: 'office-event-transport', to: 'office-projection-canonical' },
  { from: 'office-adapter-construction', to: 'office-gateway' },
  { from: 'office-adapter-finance', to: 'office-gateway' },
  { from: 'office-adapter-model', to: 'office-gateway' },
  { from: 'office-adapter-schedule', to: 'office-gateway' },
];

/** THE deployment topology record (pure typed data; generic vocabulary). */
export const OFFICE_DEPLOYMENT_TOPOLOGY: DeploymentTopology = {
  kind: 'deployment-topology',
  name: 'office-single-database-topology',
  components: [DATABASE, GATEWAY, EVENT_TRANSPORT, ...CLIENTS, ...PROJECTIONS],
  adapters: ADAPTERS,
  invariants: INVARIANTS,
  flows: FLOWS,
};
