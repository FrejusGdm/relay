// POST /v1/hooks/{provider}/{event} (design.md decisions 14 and 18). relay hook sends the spool line
// it would otherwise append to the spool. The daemon checks the line again, because any program of
// the same user can send one, puts it on the hook queue and answers 202 at once.
import { EVENT_NAME, isProvider, parseSpoolLine } from "../../hooks/fields";
import type { HookQueue } from "../../hooks/mapping";
import { errorResponse, jsonResponse } from "../errors";
import type { Route } from "../router";

// afterAccept runs after each accepted event: the daemon then drains the spool, so lines written
// while it was slow to answer are taken as soon as it answers again.
export function hookRoutes(queue: HookQueue, afterAccept: () => void = () => {}): Route[] {
  return [
    {
      method: "POST",
      path: "/v1/hooks/{provider}/{event}",
      handle: async (request, params) => {
        const { provider, event } = params as { provider: string; event: string };
        if (!isProvider(provider) || !EVENT_NAME.test(event)) {
          return errorResponse(400, "bad_request", "Use /v1/hooks/claude/<event> or /v1/hooks/codex/<event>, with an event name of letters, digits and underscores.");
        }
        let value: unknown;
        try {
          value = JSON.parse(await request.text());
        } catch {
          return errorResponse(400, "bad_request", "The request body is not valid JSON.");
        }
        const line = parseSpoolLine(value, new Date());
        if (line === null || line.provider !== provider || line.event !== event) {
          return errorResponse(400, "bad_request", "The request body is not a hook event in the format of relay's spool.");
        }
        if (!queue.offer(line)) return errorResponse(503, "hook_queue_full", "The relay daemon is behind on hook events.");
        afterAccept();
        return jsonResponse(202, { accepted: true });
      },
    },
  ];
}
