// The templates of the job files that relay init writes (the job-files spec). state.json is
// written by state.ts and the event log by events.ts.
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export function taskTemplate(title: string, jobId: string): string {
  return `# ${title}

<!-- relay job ${jobId}. Agents read this file first. Keep it current. -->

## Goal

Describe what this job should achieve.

## Acceptance criteria

- [ ] Describe how to tell the job is done.

## Plan

## Done

## In progress

## Left to do
`;
}

export function checkpointTemplate(jobId: string): string {
  return `# Checkpoint

<!-- relay job ${jobId}. The latest handoff, written for the next agent. -->

No handoff yet. relay writes this file when work moves to another agent.
`;
}

export function decisionsTemplate(jobId: string): string {
  return `# Decisions

<!-- relay job ${jobId}. One entry per decision, newest last: the date, the decision, and why. -->
`;
}

// Writes task.md, checkpoint.md and decisions.md into a .relay folder that was just created.
// Each file must not exist yet, and a symbolic link in its place is never followed.
export function writeTemplates(relayDir: string, jobId: string, title: string): void {
  writeNewFile(join(relayDir, "task.md"), taskTemplate(title, jobId));
  writeNewFile(join(relayDir, "checkpoint.md"), checkpointTemplate(jobId));
  writeNewFile(join(relayDir, "decisions.md"), decisionsTemplate(jobId));
}

function writeNewFile(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
