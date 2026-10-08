// The job files in .relay/ (the job-files spec). relay init creates the first five, in this
// order; the next agent writes verify.md after a handoff. Checkpoints store exactly these files.
// Only src/job/events.ts writes events.jsonl; other modules take the names from here.
export const JOB_FILES = ["task.md", "state.json", "checkpoint.md", "decisions.md", "events.jsonl"] as const;
export const VERIFY_FILE = "verify.md";
