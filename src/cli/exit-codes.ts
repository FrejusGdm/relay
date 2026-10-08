// The one table of exit codes. docs/cli.md has the same table, and test/cli/exit-codes.test.ts
// checks that the two agree. Later changes add their codes between 9 and 63.
export const ExitCode = Object.freeze({
  Ok: 0,
  Failed: 1,
  Usage: 2,
  NotPossibleHere: 3,
  SecretFound: 4,
  GitChanged: 5,
  Busy: 6,
  NeedsPerson: 7,
  UnsavedFiles: 8,
  DaemonNotRunning: 10,
  ProviderMissing: 20,
  NoSuchAccount: 21,
  NotSignedIn: 22,
  WouldRaisePermission: 32,
  NotAvailable: 69,
  Internal: 70,
  Settings: 78,
  Interrupted: 130,
  Terminated: 143,
});
