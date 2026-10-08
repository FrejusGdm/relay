#!/usr/bin/env python3
"""Run discovered unittest tests and write a JUnit XML report.
Record each test outcome, including import errors and subtest failures.
"""

import os
import sys
import time
import unittest
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field


@dataclass
class Case:
    classname: str
    name: str
    started: float
    elapsed: float = 0.0
    outcomes: list[tuple[str, str, str, str]] = field(default_factory=list)


class JunitResult(unittest.TextTestResult):
    def __init__(self, stream, descriptions, verbosity):
        super().__init__(stream, descriptions, verbosity)
        self.cases: list[Case] = []
        self.current: Case | None = None

    def startTest(self, test):
        super().startTest(test)
        self.current = Case(
            f"{type(test).__module__}.{type(test).__qualname__}",
            getattr(test, "_testMethodName", str(test)),
            time.perf_counter(),
        )
        self.cases.append(self.current)

    def stopTest(self, test):
        if self.current is not None:
            self.current.elapsed = time.perf_counter() - self.current.started
        self.current = None
        super().stopTest(test)

    def record_error(self, kind, test, err):
        if self.current is not None:
            self.current.outcomes.append((
                kind, str(err[1]), err[0].__name__, self._exc_info_to_string(err, test),
            ))

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.record_error("failure", test, err)

    def addError(self, test, err):
        super().addError(test, err)
        self.record_error("error", test, err)

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        if self.current is not None:
            self.current.outcomes.append(("skipped", reason, "", ""))

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        if self.current is not None:
            self.current.outcomes.append(("failure", "unexpected success", "", "unexpected success"))

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            self.record_error("failure", subtest, err)


def write_report(path: str, directory: str, cases: list[Case]) -> None:
    counts = {
        "tests": str(len(cases)),
        "failures": str(sum(any(o[0] == "failure" for o in c.outcomes) for c in cases)),
        "errors": str(sum(any(o[0] == "error" for o in c.outcomes) for c in cases)),
        "skipped": str(sum(any(o[0] == "skipped" for o in c.outcomes) for c in cases)),
        "time": f"{sum(c.elapsed for c in cases):.6f}",
    }
    root = ET.Element("testsuites", {"name": "unittest", **counts})
    suite = ET.SubElement(root, "testsuite", {"name": directory, **counts})
    for case in cases:
        element = ET.SubElement(suite, "testcase", {
            "classname": case.classname, "name": case.name, "time": f"{case.elapsed:.6f}",
        })
        for kind, message, error_type, traceback in case.outcomes:
            attributes = {"message": message}
            if kind != "skipped":
                attributes["type"] = error_type
            child = ET.SubElement(element, kind, attributes)
            if traceback:
                child.text = traceback
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: python3 unittest_junit.py <junit-output-path> <test-directory>", file=sys.stderr)
        return 1
    path, directory = sys.argv[1:]
    sys.path.insert(0, os.getcwd())
    try:
        suite = unittest.TestLoader().discover(directory, pattern="test*.py")
    except Exception as error:
        print(error, file=sys.stderr)
        write_report(path, directory, [])
        return 1
    result = unittest.TextTestRunner(
        stream=sys.stderr, verbosity=1, resultclass=JunitResult,
    ).run(suite)
    write_report(path, directory, result.cases)
    return 0 if result.wasSuccessful() and not any(c.outcomes for c in result.cases) else 1


if __name__ == "__main__":
    sys.exit(main())
