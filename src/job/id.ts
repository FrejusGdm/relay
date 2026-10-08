// Job IDs (design.md decision 1): 8 random lowercase hexadecimal characters. Refs and folder
// names are built only from these IDs, never from text that an agent or a repository provides.
const JOB_ID = /^[0-9a-f]{8}$/;
const DRAWS = 5;

export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID.test(value);
}

function randomJobId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Draws until `isTaken` says an ID is free, at most five times.
export async function drawJobId(
  isTaken: (id: string) => Promise<boolean>,
  draw: () => string = randomJobId,
): Promise<string> {
  for (let attempt = 0; attempt < DRAWS; attempt++) {
    const id = draw();
    if (!(await isTaken(id))) return id;
  }
  throw new Error(`relay drew ${DRAWS} job IDs that were all in use.`);
}
