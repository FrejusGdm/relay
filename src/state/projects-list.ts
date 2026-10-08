// RELAY_HOME/projects.list: the known project roots, one absolute path per line (design.md
// decision 12). A root is appended with one short write when it is not listed yet; lines are
// deduplicated when read, so two commands appending the same root at once do no harm.
import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;

export function projectsListPath(relayHome: string): string {
  return join(relayHome, "projects.list");
}

// The listed roots in first-seen order, without duplicates, blank lines or relative paths.
export function readProjects(relayHome: string): string[] {
  let text: string;
  try {
    text = readFileSync(projectsListPath(relayHome), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES);
  return [...new Set(text.split("\n").filter((line) => line !== "" && isAbsolute(line)))];
}

export function registerProject(relayHome: string, root: string): void {
  if (!isAbsolute(root) || root.includes("\n") || readProjects(relayHome).includes(root)) return;
  appendFileSync(projectsListPath(relayHome), `${root}\n`, { mode: 0o600 });
}
