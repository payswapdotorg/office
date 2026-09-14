// Office browser host — /api/ledger (OFF-DEPLOY): the evidence read surface.
//
// GET returns the ledger browser's evidence overview — the gateway's
// evidenceOverview view (the slice summarized by the event-name vocabulary's
// domain segments + the aggregate streams, deterministically ordered) —
// for the hosted session. With `?event=<id>` it returns the event's own
// evidence view AND its A3 causality chain (walked backwards to the
// originating command); an unknown id is the typed not-found rejection
// (404 — A12, no existence oracle), never a throw.
import { getHostRuntime } from '../../../server/runtime';
import { operationalFailureResponse, rejectionResponse } from '../../../server/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = await getHostRuntime();
    const eventId = new URL(request.url).searchParams.get('event');
    if (eventId === null) {
      return Response.json(runtime.reads.evidenceOverview());
    }
    const event = runtime.reads.evidenceEvent(undefined, eventId);
    if (!event.ok) return rejectionResponse(event.error);
    const causality = runtime.reads.causalityChain(undefined, eventId);
    if (!causality.ok) return rejectionResponse(causality.error);
    return Response.json({ event: event.value, causality: causality.value });
  } catch (cause) {
    return operationalFailureResponse(cause);
  }
}
