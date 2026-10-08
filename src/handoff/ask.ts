// How a handoff asks the person a question (add-relay-switch, design decisions 16 and 17). relay
// asks only when standard input and standard output are terminals. --yes answers relay's own
// questions and nothing else, and every answer records how it was given.
export interface Asker {
  terminal: boolean;
  yes: boolean;
  // Answers the person already gave, in the terminal of a relay switch that handed the switch to the
  // relay run of another terminal. A preset answer is used without asking again.
  preset?: {
    newAccount?: AnswerHow;
    personalAccount?: AnswerHow;
    instructionFiles?: { how: AnswerHow; paths: string[] };
  };
  say(line: string): void;
  // Prints the question and reads one answer line; null at the end of input.
  ask(question: string): Promise<string | null>;
}

export type AnswerHow = "terminal" | "flag";

// "y" or "yes" in any case is yes; anything else, an empty line included, is no.
export function isYes(answer: string | null): boolean {
  const word = answer?.trim().toLowerCase();
  return word === "y" || word === "yes";
}
