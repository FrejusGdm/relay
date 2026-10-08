// Routes a Request to its handler (design.md decisions 13 and 16). It refuses requests from web
// pages, answers any major version other than v1 with unsupported_version, and gives 404 and 405
// answers for unknown paths and methods. Routing is plain fetch-style code, so tests call it
// without a socket.
import { errorResponse, methodNotAllowed } from "./errors";

export interface Route {
  method: "GET" | "POST";
  path: string;   // "/v1/jobs/{job}": each {name} matches one path segment
  handle(request: Request, params: Record<string, string>): Response | Promise<Response>;
}

export interface Router {
  handle(request: Request): Promise<Response>;
  allow(path: string): string[];
}

const OTHER_VERSION = /^\/v(\d+)(?:\/|$)/;

export function createRouter(routes: Route[]): Router {
  const compiled = routes.map((route) => ({ route, pattern: compile(route.path) }));
  const matching = (path: string) =>
    compiled.flatMap(({ route, pattern }) => {
      const match = pattern.exec(path);
      return match === null ? [] : [{ route, params: { ...match.groups } }];
    });
  const allow = (path: string) => {
    const methods = matching(path).map(({ route }) => route.method);
    return methods.length > 0 ? [...new Set(methods)] : ["GET", "POST"];
  };

  return {
    allow,
    async handle(request) {
      if (request.headers.has("origin")) {
        return errorResponse(403, "origin_not_allowed", "relay does not accept requests from web pages.");
      }
      const path = new URL(request.url).pathname;
      const version = OTHER_VERSION.exec(path);
      if (version !== null && version[1] !== "1") {
        return errorResponse(404, "unsupported_version", "This relay daemon speaks v1.", { fields: { supported: ["v1"] } });
      }
      const found = matching(path);
      if (found.length === 0) return errorResponse(404, "not_found", `There is no ${path}.`);
      const hit = found.find(({ route }) => route.method === request.method);
      if (hit === undefined) return methodNotAllowed(allow(path), path);
      return hit.route.handle(request, hit.params);
    },
  };
}

function compile(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) => {
      const param = /^\{([a-z_]+)\}$/.exec(segment);
      return param === null ? segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : `(?<${param[1]}>[^/]+)`;
    })
    .join("/");
  return new RegExp(`^${source}$`);
}
