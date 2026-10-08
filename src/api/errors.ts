// Error answers of the local API (design.md decision 13): a JSON body
// {"error": {"code": ..., "message": ...}} with one of the status codes the local-api spec allows.
// Extra fields, such as "supported" for unsupported_version, go inside the error object.

export type ErrorStatus = 400 | 403 | 404 | 405 | 409 | 411 | 413 | 422 | 431 | 500 | 503;

export const JSON_TYPE = "application/json; charset=utf-8";

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": JSON_TYPE, ...headers } });
}

export function errorResponse(
  status: ErrorStatus,
  code: string,
  message: string,
  options: { headers?: Record<string, string>; fields?: Record<string, unknown> } = {},
): Response {
  return jsonResponse(status, { error: { code, message, ...options.fields } }, options.headers);
}

// "Use GET for /v1/jobs." with an Allow header listing the methods the path accepts.
export function methodNotAllowed(methods: string[], path: string): Response {
  return errorResponse(405, "method_not_allowed", `Use ${methods.join(" or ")} for ${path}.`, {
    headers: { Allow: methods.join(", ") },
  });
}

export function internalError(): Response {
  return errorResponse(500, "internal_error", "Something went wrong inside relay. Details are in the daemon log.");
}
