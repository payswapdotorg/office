// Office browser host — /api/workspace (OFF-DEPLOY).
//
// GET returns the hosted session's project workspace view model — the
// gateway's scope-checked read surface over the composed world (the hosted
// operator session; A12: a typed rejection is a 4xx body, never a throw).
import { getHostRuntime } from '../../../server/runtime';
import { operationalFailureResponse, rejectionResponse } from '../../../server/http';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const runtime = await getHostRuntime();
    const loaded = await runtime.reads.workspace();
    if (!loaded.ok) return rejectionResponse(loaded.error);
    return Response.json(loaded.value);
  } catch (cause) {
    return operationalFailureResponse(cause);
  }
}
