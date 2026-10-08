export interface TestCounts {
  passed: number;
  failed: number;
  total: number;
  failing: string[];
  missing: number;
  // Test cases beyond the expected total. A run that reports any is a harness error.
  extra: number;
}

function decodeName(name: string): string {
  return name
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);|&#x([\da-f]+);/gi, (entity: string, decimal: string | undefined, hex: string | undefined) => {
      const point = decimal === undefined ? Number.parseInt(hex ?? "", 16) : Number.parseInt(decimal, 10);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/&amp;/g, "&");
}

type Case = { name: string; failure: boolean; error: boolean; skipped: boolean };
type Root = { tests: string | null; failures: string | null; errors: string | null; skipped: string | null };

// Returns the test cases, or null when the file is cut short or its root counts disagree with
// the test cases it holds, so a half-written report never counts as passing tests.
function parse(text: string): Case[] | null {
  const cases: Case[] = [];
  let current: Case | null = null;
  let root: Root | null = null;
  let closed = false;
  new HTMLRewriter()
    .on("testsuites", {
      element(element) {
        if (root !== null) return;
        root = {
          tests: element.getAttribute("tests"),
          failures: element.getAttribute("failures"),
          errors: element.getAttribute("errors"),
          skipped: element.getAttribute("skipped"),
        };
        element.onEndTag(() => { closed = true; });
      },
    })
    .on("testcase", {
      element(element) {
        const test = { name: decodeName(element.getAttribute("name") ?? ""), failure: false, error: false, skipped: false };
        cases.push(test);
        current = test;
        if (element.selfClosing) current = null;
        else element.onEndTag(() => { current = null; });
      },
    })
    .on("failure, error, skipped", {
      element(element) {
        if (current) current[element.tagName as "failure" | "error" | "skipped"] = true;
      },
    })
    .transform(text);
  const found = root as Root | null;
  if (found === null || !closed) return null;
  const agrees = (attribute: string | null, count: number) => attribute === null || Number(attribute) === count;
  const ok = found.tests !== null && agrees(found.tests, cases.length)
    && agrees(found.failures, cases.filter((test) => test.failure).length)
    && agrees(found.errors, cases.filter((test) => test.error).length)
    && agrees(found.skipped, cases.filter((test) => test.skipped).length);
  return ok ? cases : null;
}

export async function readJunit(path: string, expectedTotal?: number): Promise<TestCounts> {
  const file = Bun.file(path);
  const cases = (await file.exists() ? parse(await file.text()) : null) ?? [];
  const failing = cases.filter((test) => test.failure || test.error || test.skipped).map((test) => test.name);
  const missing = expectedTotal === undefined ? 0 : Math.max(0, expectedTotal - cases.length);
  const extra = expectedTotal === undefined ? 0 : Math.max(0, cases.length - expectedTotal);
  return {
    passed: cases.length - failing.length,
    failed: failing.length + missing,
    total: cases.length + missing,
    failing,
    missing,
    extra,
  };
}

// The names of the tests that passed, which the regression check compares between two reports.
export async function passingTests(path: string): Promise<string[]> {
  const file = Bun.file(path);
  const cases = (await file.exists() ? parse(await file.text()) : null) ?? [];
  return cases.filter((test) => !test.failure && !test.error && !test.skipped).map((test) => test.name);
}
