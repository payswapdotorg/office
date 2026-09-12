// Office persistence — integration-test harness (OFF-004).
//
// Harness contract (the one every integration suite in the workspace uses):
//
//   * `process.env.DATABASE_URL` set to a PostgreSQL URL — `postgres://` or
//     `postgresql://` — (CI mode): the harness uses THAT server. It never
//     touches the referenced database's contents: it connects to the
//     server's maintenance database, drops/creates a uniquely named SCRATCH
//     database, and runs everything there, so pointing DATABASE_URL at a
//     populated database can never destroy it. The CI job provides
//     `postgres:17` with `POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB`.
//     A DATABASE_URL carrying any other value — unset, empty, or a foreign
//     scheme (e.g. a stray `file:` URL from an unrelated tool) — can never
//     address a PostgreSQL server, so it is treated exactly like unset and
//     selects local mode; a well-formed PostgreSQL URL that cannot be
//     reached still fails loudly rather than silently falling back.
//   * DATABASE_URL unset or non-PostgreSQL (local mode): the harness boots
//     its own embedded-postgres 17.10 cluster rootlessly on a free port
//     >= 5434 (other services on this machine own lower ports), creates the
//     scratch database on it, and tears the cluster down in `stop()` —
//     callers wire `stop()` into afterAll.
//
// Either way the caller receives a pool bound to an EMPTY scratch database:
// the "migration from an empty database" acceptance is exercised literally in
// both modes. `embedded-postgres` is a ROOT devDependency, imported
// dynamically so production imports of this package never load it.
import { createServer } from 'node:net';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { PersistenceFailure } from './failure';
import { DEFAULT_MIGRATIONS_DIR } from './migrator';
import { createPersistencePool } from './pool';
import type { PersistencePool } from './pool';

/** Options for starting the integration-test harness. */
export interface PersistenceTestHarnessOptions {
  /**
   * Scratch database name (default `office_test_<pid>_<n>`; must be a plain
   * lowercase identifier — it is interpolated into DDL).
   */
  readonly databaseName?: string;
  /** Forward embedded-postgres log output instead of silencing it. */
  readonly debug?: boolean;
}

/** A booted integration-test harness bound to an empty scratch database. */
export interface PersistenceTestHarness {
  /** Pooled surface over the empty scratch database. */
  readonly pool: PersistencePool;
  /** Connection string of the scratch database (placeholder test credentials only). */
  readonly connectionString: string;
  /** Migrations directory to run the migrator against (the package's own). */
  readonly migrationsDir: string;
  /** Tear down: end the pool, drop the scratch database, stop local cluster. */
  readonly stop: () => Promise<void>;
}

const EMBEDDED_USER = 'office';
const EMBEDDED_PASSWORD = 'office';
const PORT_SCAN_START = 5434;
const PORT_SCAN_END = 5463;
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const POSTGRES_URL_PATTERN = /^postgres(?:ql)?:\/\//;

/**
 * Whether DATABASE_URL carries a usable PostgreSQL connection string: only
 * `postgres://` / `postgresql://` URLs select CI mode. Anything else — unset,
 * empty, or a foreign scheme — cannot address a PostgreSQL server and is
 * treated exactly like unset (local mode), never as a broken server to fail
 * against.
 */
const isPostgresUrl = (raw: string | undefined): raw is string =>
  typeof raw === 'string' && POSTGRES_URL_PATTERN.test(raw);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The process-local embedded cluster (one per process; refcounted). */
interface EmbeddedCluster {
  readonly stop: () => Promise<void>;
  readonly port: number;
  readonly dataDir: string;
}

let scratchCounter = 0;
let embeddedBoot: Promise<EmbeddedCluster> | undefined;
let embeddedReferences = 0;

const nextDatabaseName = (): string => `office_test_${process.pid}_${(scratchCounter += 1)}`;

/** Probe for the first free TCP port in [start, end]. */
const findFreePort = async (start: number, end: number): Promise<number> => {
  for (let port = start; port <= end; port += 1) {
    const probe = createServer();
    const free = await new Promise<boolean>((resolveProbe) => {
      const settle = (ok: boolean): void => {
        probe.close(() => resolveProbe(ok));
      };
      probe.once('error', () => settle(false));
      probe.once('listening', () => settle(true));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new PersistenceFailure(
    'driver-error',
    `no free TCP port in ${start}..${end} for the embedded PostgreSQL cluster`,
  );
};

/** Boot the process-local embedded PostgreSQL cluster exactly once. */
const bootEmbeddedCluster = (debug: boolean): Promise<EmbeddedCluster> => {
  embeddedBoot ??= (async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const port = await findFreePort(PORT_SCAN_START, PORT_SCAN_END);
    const dataDir = resolve(repoRoot, 'node_modules', '.office-pg', `worker-${process.pid}`);
    await mkdir(dirname(dataDir), { recursive: true });
    const postgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: EMBEDDED_USER,
      password: EMBEDDED_PASSWORD,
      port,
      persistent: false,
      // Keep vitest output clean by default; `debug: true` forwards logs.
      onLog: debug ? console.log : () => undefined,
      onError: debug ? console.error : () => undefined,
    });
    await postgres.initialise();
    await postgres.start();
    return {
      stop: async () => {
        await postgres.stop();
      },
      port,
      dataDir,
    };
  })();
  return embeddedBoot;
};

/** Run DDL (drop/create scratch database) on a server's maintenance database. */
const withMaintenanceConnection = async <T>(
  connectionString: string,
  work: (client: Client) => Promise<T>,
): Promise<T> => {
  const url = new URL(connectionString);
  url.pathname = '/postgres';
  url.search = '';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const dropScratchDatabase = (maintenanceUrl: string, databaseName: string): Promise<void> =>
  withMaintenanceConnection(maintenanceUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  });

/**
 * Start the integration-test harness: an empty scratch database on the
 * DATABASE_URL server (CI mode) or on a private embedded-postgres cluster
 * (local mode). Call `stop()` exactly once, from afterAll.
 */
export async function startPersistenceTestHarness(
  options: PersistenceTestHarnessOptions = {},
): Promise<PersistenceTestHarness> {
  const databaseName = options.databaseName ?? nextDatabaseName();
  if (!IDENTIFIER_PATTERN.test(databaseName)) {
    throw new PersistenceFailure(
      'driver-error',
      `scratch database name must match ${IDENTIFIER_PATTERN.source}: ${databaseName}`,
    );
  }

  const providedUrl = process.env['DATABASE_URL'];
  let maintenanceUrl: string;
  let localCluster: EmbeddedCluster | undefined;

  if (isPostgresUrl(providedUrl)) {
    // CI mode: the DATABASE_URL server, used only through a scratch database —
    // the referenced database itself is never read or modified.
    maintenanceUrl = providedUrl;
  } else {
    // Local mode: private embedded cluster (rootless, port >= 5434).
    localCluster = await bootEmbeddedCluster(options.debug === true);
    embeddedReferences += 1;
    maintenanceUrl = `postgres://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@localhost:${localCluster.port}/postgres`;
  }

  const url = new URL(maintenanceUrl);
  await withMaintenanceConnection(maintenanceUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await client.query(`CREATE DATABASE ${databaseName}`);
  });
  url.pathname = `/${databaseName}`;
  url.search = '';
  const scratchUrl = url.toString();

  const pool = createPersistencePool({ connectionString: scratchUrl });

  const stop = async (): Promise<void> => {
    await pool.end();
    // Best-effort scratch-database cleanup; a failure here never fails tests.
    await dropScratchDatabase(maintenanceUrl, databaseName).catch(() => undefined);
    if (localCluster !== undefined) {
      embeddedReferences -= 1;
      if (embeddedReferences <= 0) {
        // Last harness in this process: stop the cluster and reset so a
        // later harness boots a fresh one.
        embeddedBoot = undefined;
        await localCluster.stop();
        await rm(localCluster.dataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };

  return {
    pool,
    connectionString: scratchUrl,
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    stop,
  };
}
