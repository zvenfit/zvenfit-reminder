export type OriginFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ProxyEnv = {
  [Key in keyof Pick<WorkerEnv, "ORIGIN_URL">]: string;
};

export const MAX_UPDATE_BYTES = 1024 * 1024;

const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const JSON_CONTENT_TYPE = "application/json";
const YANDEX_FUNCTION_HOST = "functions.yandexcloud.net";
const FUNCTION_PATH_PATTERN = /^\/[a-z0-9]+$/;

function jsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function parseOrigin(rawOrigin: string): URL | null {
  try {
    const origin = new URL(rawOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.hostname !== YANDEX_FUNCTION_HOST ||
      !FUNCTION_PATH_PATTERN.test(origin.pathname) ||
      origin.search !== "" ||
      origin.hash !== ""
    ) {
      return null;
    }
    return origin;
  } catch {
    return null;
  }
}

async function readUpdateBody(request: Request): Promise<ArrayBuffer | Response> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      return jsonResponse(400, { error: "Invalid Content-Length" });
    }
    if (declaredBytes > MAX_UPDATE_BYTES) {
      return jsonResponse(413, { error: "Telegram update is too large" });
    }
  }

  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_UPDATE_BYTES) {
      return jsonResponse(413, { error: "Telegram update is too large" });
    }
    return body;
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
}

export async function handleRequest(
  request: Request,
  env: ProxyEnv,
  originFetch: OriginFetch = fetch,
): Promise<Response> {
  const requestUrl = new URL(request.url);

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    return jsonResponse(200, { ok: true });
  }

  if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/webhook") {
    return jsonResponse(404, { error: "Not found" });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, { Allow: "POST" });
  }

  const secret = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (!secret) {
    return jsonResponse(403, { error: "Forbidden" });
  }

  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith(JSON_CONTENT_TYPE)) {
    return jsonResponse(415, { error: "Expected application/json" });
  }

  const origin = parseOrigin(env.ORIGIN_URL);
  if (!origin) {
    console.error("Invalid Telegram webhook origin configuration");
    return jsonResponse(500, { error: "Proxy is not configured" });
  }

  const updateBody = await readUpdateBody(request);
  if (updateBody instanceof Response) {
    return updateBody;
  }

  const headers = new Headers({
    "Content-Type": JSON_CONTENT_TYPE,
    [TELEGRAM_SECRET_HEADER]: secret,
  });

  let originResponse: Response;
  try {
    originResponse = await originFetch(origin, {
      method: "POST",
      headers,
      body: updateBody,
      redirect: "manual",
    });
  } catch (error) {
    console.error("Telegram webhook origin request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return jsonResponse(502, { error: "Origin unavailable" });
  }

  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  const originContentType = originResponse.headers.get("Content-Type");
  if (originContentType) {
    responseHeaders.set("Content-Type", originContentType);
  }

  return new Response(originResponse.body, {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers: responseHeaders,
  });
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
