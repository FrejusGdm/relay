// POST /v1/jobs/{job}/checkpoint and POST /v1/jobs/{job}/switch (design.md decision 17, the
// local-api spec, "Checkpoint and switch actions"). A request names only the job, a message and an
// account: no command, no path and no other field is accepted, and the project folder comes from
// the index. One operation runs per job at a time.
import type { Database } from "bun:sqlite";
import { checkpointJob, switchJob, type EngineContext, type JobPlace } from "../../daemon/engines";
import type { Operations } from "../../daemon/operations";
import { getJob, getWorker } from "../../state/queries";
import { engineErrorResponse } from "../engine-errors";
import { errorResponse, jsonResponse } from "../errors";
import type { Route } from "../router";

const JOB_ID = /^[0-9a-f]{8}$/;
const TARGET = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9_-]*$/;
const MESSAGE_LIMIT = 500;

interface ActionOptions {
  db: Database;
  operations: Operations;
  engines: EngineContext;
  // Brings the index up to date with the job's events, so the answer and the GET answers after it
  // show what the operation changed.
  catchUp: () => Promise<void>;
}

export function actionRoutes(opts: ActionOptions): Route[] {
  const { db, operations, engines } = opts;
  const find = (id: string): JobPlace | Response => {
    const job = JOB_ID.test(id) ? getJob(db, id) : null;
    if (job === null) return errorResponse(404, "job_not_found", `No job with id ${id}.`);
    if (job.project_missing) return errorResponse(409, "project_missing", `The project for job ${job.id} is not at ${job.project_root} any more.`);
    return { id: job.id, root: job.project_root };
  };

  return [
    {
      method: "POST",
      path: "/v1/jobs/{job}/checkpoint",
      handle: async (request, params) => {
        const job = find(params.job!);
        if (job instanceof Response) return job;
        const body = await readBody(request, ["message"]);
        if (body instanceof Response) return body;
        const message = body.message;
        if (message !== undefined && (typeof message !== "string" || message.length > MESSAGE_LIMIT)) {
          return errorResponse(400, "bad_request", `message must be text of at most ${MESSAGE_LIMIT} characters.`);
        }
        try {
          const result = await operations.run(job.id, "checkpoint", async () => {
            const saved = await checkpointJob(engines, job, message);
            await opts.catchUp();
            return saved;
          });
          return jsonResponse(result.created ? 201 : 200, { checkpoint: result.checkpoint });
        } catch (error) {
          return engineErrorResponse(error);
        }
      },
    },
    {
      method: "POST",
      path: "/v1/jobs/{job}/switch",
      handle: async (request, params) => {
        const job = find(params.job!);
        if (job instanceof Response) return job;
        const body = await readBody(request, ["target", "confirm_new_provider"]);
        if (body instanceof Response) return body;
        const { target, confirm_new_provider: confirm } = body;
        if (typeof target !== "string" || !TARGET.test(target)) {
          return errorResponse(400, "invalid_target", `${typeof target === "string" ? target : "The target"} is not an account name. Use provider:account, for example codex:personal.`);
        }
        if (confirm !== undefined && typeof confirm !== "boolean") {
          return errorResponse(400, "bad_request", "confirm_new_provider must be true or false.");
        }
        try {
          const result = await operations.run(job.id, "switch", async () => {
            const switched = await switchJob(engines, job, target, confirm === true);
            await opts.catchUp();
            return switched;
          });
          const worker = result.workerId === null ? null : getWorker(db, result.workerId);
          return jsonResponse(200, { handoff: result.handoff, worker });
        } catch (error) {
          return engineErrorResponse(error, target);
        }
      },
    },
  ];
}

// The JSON object of the body, which may be empty, with only the given fields.
async function readBody(request: Request, fields: string[]): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return errorResponse(400, "bad_request", "The request body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return errorResponse(400, "bad_request", "The request body must be a JSON object.");
  }
  const extra = Object.keys(value).find((key) => !fields.includes(key));
  if (extra !== undefined) {
    return errorResponse(400, "bad_request", `relay does not accept the field ${JSON.stringify(extra)} here. Send only ${fields.join(" and ")}.`);
  }
  return value as Record<string, unknown>;
}
