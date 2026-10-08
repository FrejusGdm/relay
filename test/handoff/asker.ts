// A question function for tests: it records what relay printed and gives the answers in order.
import type { Asker } from "../../src/handoff/ask";

export function fakeAsker(options: { terminal?: boolean; yes?: boolean; answers?: (string | null)[] } = {}): Asker & { said: string[] } {
  const answers = [...(options.answers ?? [])];
  const said: string[] = [];
  return {
    terminal: options.terminal ?? true,
    yes: options.yes ?? false,
    said,
    say: (line) => { said.push(line); },
    ask: async (question) => {
      said.push(question);
      return answers.length === 0 ? null : answers.shift()!;
    },
  };
}
