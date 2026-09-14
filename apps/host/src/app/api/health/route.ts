// Office browser host — /api/health (OFF-DEPLOY): THE readiness endpoint.
//
// GET resolves the gateway's typed HealthReport — pool reachability plus the
// applied-migration state plus the release identity — as JSON: 200 when the
// database is reachable, 503 when it is not (the probe is caught inside the
// gateway, never a thrown error; the report body is returned either way).
// An operational failure to even resolve the runtime is also a 503 with the
// operational-failure body. Rendered per-request (never cached): a readiness
// endpoint must answer about the serving process, not a build-time snapshot.
import { getHostRuntime } from '../../../server/runtime';
import { operationalFailureResponse } from '../../../server/http';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const runtime = await getHostRuntime();
    const report = await runtime.health();
    return Response.json(report, {
      status: report.database === 'reachable' ? 200 : 503,
    });
  } catch (cause) {
    return operationalFailureResponse(cause);
  }
}
