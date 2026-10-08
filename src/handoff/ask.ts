// How a handoff asks the person a question (add-relay-switch, design decisions 16 and 17). relay
// asks only when standard input and standard output are terminals. --yes answers relay's own
// questions and nothing else, and every answer records how it was given.
import { CommandError } from "../cli/errors";

export interface Asker {
  terminal: boolean;
  yes: boolean;
  // Answers the person already gave, in the terminal of a relay switch that handed the switch to the
  // relay run of another terminal, or through the local API. A preset answer is used without asking
  // again.
  preset?: {
    newAccount?: AnswerHow;
    personalAccount?: AnswerHow;
    instructionFiles?: { how: AnswerHow; paths: string[] };
  };
  say(line: string): void;
  // Prints the question and reads one answer line; null at the end of input.
  ask(question: string): Promise<string | null>;
}

// "api": confirm_new_provider in a request to the local API (add-daemon-api-and-status, decision 17).
export type AnswerHow = "terminal" | "flag" | "api";

// A step that needs the person at a terminal, refused before anything changed: a question with no
// terminal, no --yes and no preset answer, or a next agent that must start in a terminal. The
// command-line tool prints its lines as for any CommandError. The local API answers 409:
// confirmation_required with `question` when it is the question about a new account, otherwise
// interactive_start_required (add-daemon-api-and-status, design decision 17).
export class PersonNeeded extends CommandError {
  constructor(code: number, lines: string[], readonly question: string | null = null) {
    super(code, lines);
    this.name = "PersonNeeded";
  }
}

// "y" or "yes" in any case is yes; anything else, an empty line included, is no.
export function isYes(answer: string | null): boolean {
  const word = answer?.trim().toLowerCase();
  return word === "y" || word === "yes";
}
