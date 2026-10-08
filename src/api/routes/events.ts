// GET /v1/events[?job=<id>][&since=<seq>] (design.md decision 15). The since parameter wins over
// the Last-Event-ID header when both are given.
import type { EventStream } from "../sse";
import { errorResponse } from "../errors";
import type { Route } from "../router";

const WHOLE_NUMBER = /^\d{1,15}$/;
const JOB_ID = /^[0-9a-f]{8}$/;

export function eventRoutes(stream: EventStream): Route[] {
  return [
    {
      method: "GET",
      path: "/v1/events",
      handle: (request) => {
        const query = new URL(request.url).searchParams;
        const position = query.get("since") ?? request.headers.get("last-event-id");
        if (position !== null && !WHOLE_NUMBER.test(position)) {
          return errorResponse(400, "bad_request", "since and Last-Event-ID must be whole numbers.");
        }
        const job = query.get("job");
        if (job !== null && !JOB_ID.test(job)) return errorResponse(400, "bad_request", "job must be a job ID of 8 hexadecimal characters.");
        return stream.open(position === null ? null : Number(position), job);
      },
    },
  ];
}
