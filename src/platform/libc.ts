// The calls into the C library that relay needs and Bun does not offer (design.md decision 4). This
// is the only module that imports bun:ffi. The library is opened on first use, so commands that
// never lock a file or check a socket peer never load it.
import { dlopen, FFIType, ptr } from "bun:ffi";

const fdAndInt = { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
const fdAndTwoPointers = { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } as const;
const getsockoptArgs = {
  args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
  returns: FFIType.i32,
} as const;

function openDarwin() {
  return dlopen("libc.dylib", { flock: fdAndInt, getpeereid: fdAndTwoPointers }).symbols;
}

function openLinux() {
  return dlopen("libc.so.6", { flock: fdAndInt, getsockopt: getsockoptArgs }).symbols;
}

let darwin: ReturnType<typeof openDarwin> | undefined;
let linux: ReturnType<typeof openLinux> | undefined;

function library() {
  if (process.platform === "darwin") return (darwin ??= openDarwin());
  if (process.platform === "linux") return (linux ??= openLinux());
  throw new Error(`relay does not support ${process.platform}.`);
}

// flock(2). Returns 0 on success and -1 on failure.
export function flock(fd: number, operation: number): number {
  return library().flock(fd, operation);
}

// getpeereid(3), macOS only. Fills uid[0] and gid[0]; returns 0 on success.
export function getpeereid(fd: number, uid: Uint32Array, gid: Uint32Array): number {
  return (darwin ??= openDarwin()).getpeereid(fd, ptr(uid), ptr(gid));
}

// getsockopt(2), Linux only. Fills value and sets length[0] to the bytes written; returns 0 on
// success.
export function getsockopt(fd: number, level: number, name: number, value: Uint8Array, length: Uint32Array): number {
  return (linux ??= openLinux()).getsockopt(fd, level, name, ptr(value), ptr(length));
}
