// The secret scan of everything a handoff writes or sends (add-relay-switch, design decision 14),
// before anything is written or sent. It uses phase 2's scanTexts with gitleaks. A finding stops the
// handoff with exit code 4 and names the part and the line of the first finding, never the secret.
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { scanTexts } from "../secrets/scan";
import { displayName } from "./account";
import type { Provider } from "../adapters/providers";

export interface HandoffTexts {
  checkpointMd: string;
  // The lines of checkpoint.md, counted from 1, that hold the output of failing checks.
  checkOutput: { from: number; to: number };
  stateJson: string;
  events: string;
  instructions: string;
  prompt: string;
  // The cleaned notes of the outgoing agent, or null when relay built the notes.
  notes: string | null;
}

interface ScanContext {
  from: Provider;
  to: { id: string; provider: Provider };
  // The first six characters of the work checkpoint commit.
  checkpoint: string;
  env?: Record<string, string | undefined>;
}

export async function scanHandoff(texts: HandoffTexts, context: ScanContext): Promise<void> {
  const fromName = displayName(context.from);
  const toName = displayName(context.to.provider);
  const labels = {
    notes: `${fromName}'s handoff notes`,
    checkpoint: "the new .relay/checkpoint.md",
  };
  // The notes go first: they are also part of checkpoint.md, and the message should name them.
  const parts = [
    ...(texts.notes === null ? [] : [{ label: labels.notes, text: texts.notes }]),
    { label: labels.checkpoint, text: texts.checkpointMd },
    { label: "the new .relay/state.json", text: texts.stateJson },
    { label: "the new events", text: texts.events },
    { label: `the instructions for ${toName}`, text: texts.instructions },
    { label: `the prompt for ${toName}`, text: texts.prompt },
  ];
  let findings: { label: string; line: number; rule: string }[];
  try {
    findings = await scanTexts(parts, context.env === undefined ? {} : { env: context.env });
  } catch (error) {
    if (error instanceof CommandError && error.code === ExitCode.Failed) {
      throw new CommandError(ExitCode.Failed, error.lines.map((line) => line.replace(/ Nothing was saved\.$/, " Nothing was written or sent.")));
    }
    throw error;
  }
  const first = findings[0];
  if (first === undefined) return;
  const inCheckOutput = first.label === labels.checkpoint && first.line >= texts.checkOutput.from && first.line <= texts.checkOutput.to;
  const hint = first.label === labels.notes
    ? `Run "relay switch ${context.to.id} --no-summary" to hand off without ${fromName}'s notes.`
    : inCheckOutput
      ? "Fix the output of the check, or change the checks with --check."
      : `Remove the secret from the file named above, then run relay switch ${context.to.id} again.`;
  throw new CommandError(ExitCode.SecretFound, [
    `Stopped: possible secret in ${first.label}, line ${first.line} (${first.rule}).`,
    `Nothing was written or sent. ${fromName} is stopped, and your work is saved in checkpoint ${context.checkpoint}.`,
    hint,
  ]);
}
