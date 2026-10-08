// GET /v1/jobs, /v1/jobs/{job}, /v1/jobs/{job}/workers and /v1/jobs/{job}/checkpoints (design.md
// decision 14). Checkpoints are read from the git refs, which are their source of truth.
import type { Database } from "bun:sqlite";
import { listCheckpoints } from "../../checkpoint/list";
import { openRepository } from "../../git/repo";
import { getJob, listJobs, listWorkers, streamSeq, type JobView } from "../../state/queries";
import { errorResponse, jsonResponse } from "../errors";
import type { Route } from "../router";
import { snapshotResponse, STREAM_SEQ_HEADER } from "../snapshot";

const JOB_ID = /^[0-9a-f]{8}$/;

export function jobRoutes(db: Database): Route[] {
  // The job, or the 404 answer for an ID that is not indexed or not an ID at all.
  const find = (id: string): JobView | Response =>
    (JOB_ID.test(id) ? getJob(db, id) : null) ?? errorResponse(404, "job_not_found", `No job with id ${id}.`);

  return [
    {
      method: "GET",
      path: "/v1/jobs",
      handle: () => snapshotResponse(db, () => ({ jobs: listJobs(db) })),
    },
    {
      method: "GET",
      path: "/v1/jobs/{job}",
      handle: (_request, params) =>
        snapshotResponse(db, () => {
          const job = find(params.job!);
          return job instanceof Response ? job : { job };
        }),
    },
    {
      method: "GET",
      path: "/v1/jobs/{job}/workers",
      handle: (_request, params) =>
        snapshotResponse(db, () => {
          const job = find(params.job!);
          return job instanceof Response ? job : { workers: listWorkers(db, job.id) };
        }),
    },
    {
      method: "GET",
      path: "/v1/jobs/{job}/checkpoints",
      handle: async (_request, params) => {
        const seq = streamSeq(db);
        const job = find(params.job!);
        if (job instanceof Response) return job;
        if (job.project_missing) {
          return errorResponse(409, "project_missing", `The project for job ${job.id} is not at ${job.project_root} any more.`);
        }
        const checkpoints = await listCheckpoints(await openRepository(job.project_root), job.id);
        return jsonResponse(
          200,
          {
            checkpoints: checkpoints.map((checkpoint) => ({
              number: checkpoint.number,
              commit: checkpoint.commit,
              ref: checkpoint.ref,
              kind: checkpoint.kind,
              created_at: checkpoint.createdAt.toISOString(),
              message: checkpoint.message,
              head: checkpoint.head,
              left_out: checkpoint.leftOut,
            })),
          },
          { [STREAM_SEQ_HEADER]: String(seq) },
        );
      },
    },
  ];
}
