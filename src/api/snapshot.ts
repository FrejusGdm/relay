// A GET answer read from the index together with the Relay-Stream-Seq header: the highest event
// stream seq whose change the answer already shows (the Mac app proposal, design decision 17,
// requirement A). The daemon's database calls are synchronous, so nothing can change between
// reading the seq and reading the data.
import type { Database } from "bun:sqlite";
import { streamSeq } from "../state/queries";
import { jsonResponse } from "./errors";

export const STREAM_SEQ_HEADER = "Relay-Stream-Seq";

export function snapshotResponse(db: Database, read: () => unknown): Response {
  const { seq, body } = db.transaction(() => ({ seq: streamSeq(db), body: read() }))();
  if (body instanceof Response) return body;
  return jsonResponse(200, body, { [STREAM_SEQ_HEADER]: String(seq) });
}
