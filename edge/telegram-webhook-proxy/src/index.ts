export type OriginFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ProxyEnv = {
  [Key in keyof Pick<WorkerEnv, "ORIGIN_URL" | "TELEGRAM_PROXY_SECRET">]: string;
};

type SecretComparator = (provided: string, expected: string) => Promise<boolean>;

type TimingSafeSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean;
};

export const MAX_UPDATE_BYTES = 1024 * 1024;
export const MAX_TELEGRAM_API_BYTES = 256 * 1024;
export const MAX_TELEGRAM_FILE_BYTES = 512 * 1024;

const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const TELEGRAM_PROXY_SECRET_HEADER = "X-Zvenfit-Telegram-Proxy-Secret";
const TELEGRAM_BOT_TOKEN_HEADER = "X-Zvenfit-Telegram-Bot-Token";
const JSON_CONTENT_TYPE = "application/json";
const YANDEX_FUNCTION_HOST = "functions.yandexcloud.net";
const FUNCTION_PATH_PATTERN = /^\/[a-z0-9]+$/;
const TELEGRAM_METHOD_PATH_PATTERN = /^\/telegram\/([A-Za-z][A-Za-z0-9]*)$/;
const TELEGRAM_FILE_PREFIX = "/telegram-file/";
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_FILE_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const TELEGRAM_METHODS = new Set([
  "answerCallbackQuery",
  "deleteMessage",
  "editMessageText",
  "getChatMember",
  "getFile",
  "getMe",
  "getUserProfilePhotos",
  "savePreparedKeyboardButton",
  "sendMessage",
]);
const encoder = new TextEncoder();

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

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer | Response> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      return jsonResponse(400, { error: "Invalid Content-Length" });
    }
    if (declaredBytes > maxBytes) {
      return jsonResponse(413, { error: "Request body is too large" });
    }
  }

  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > maxBytes) {
      return jsonResponse(413, { error: "Request body is too large" });
    }
    return body;
  } catch {
    return jsonResponse(400, { error: "Invalid request body" });
  }
}

export async function timingSafeSecretEqual(
  provided: string,
  expected: string,
): Promise<boolean> {
  const subtle = crypto.subtle as TimingSafeSubtleCrypto;
  const [providedHash, expectedHash] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(provided)),
    subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return subtle.timingSafeEqual(providedHash, expectedHash);
}

async function handleTelegramApiRequest(
  request: Request,
  env: ProxyEnv,
  method: string,
  telegramFetch: OriginFetch,
  secretsEqual: SecretComparator,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, { Allow: "POST" });
  }
  if (!TELEGRAM_METHODS.has(method)) {
    return jsonResponse(404, { error: "Telegram method is not allowed" });
  }

  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith(JSON_CONTENT_TYPE)) {
    return jsonResponse(415, { error: "Expected application/json" });
  }

  const providedSecret = request.headers.get(TELEGRAM_PROXY_SECRET_HEADER);
  if (!providedSecret || !await secretsEqual(providedSecret, env.TELEGRAM_PROXY_SECRET)) {
    return jsonResponse(403, { error: "Forbidden" });
  }

  const botToken = request.headers.get(TELEGRAM_BOT_TOKEN_HEADER);
  if (!botToken || !TELEGRAM_BOT_TOKEN_PATTERN.test(botToken)) {
    return jsonResponse(403, { error: "Forbidden" });
  }

  const requestBody = await readBoundedBody(request, MAX_TELEGRAM_API_BYTES);
  if (requestBody instanceof Response) {
    return requestBody;
  }

  let telegramResponse: Response;
  try {
    telegramResponse = await telegramFetch(
      `https://api.telegram.org/bot${botToken}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": JSON_CONTENT_TYPE },
        body: requestBody,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    console.error(JSON.stringify({
      message: "Telegram API proxy request failed",
      method,
      error: error instanceof Error ? error.name : "UnknownError",
    }));
    return jsonResponse(502, { error: "Telegram API unavailable" });
  }

  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  const responseContentType = telegramResponse.headers.get("Content-Type");
  if (responseContentType) {
    responseHeaders.set("Content-Type", responseContentType);
  }
  return new Response(telegramResponse.body, {
    status: telegramResponse.status,
    statusText: telegramResponse.statusText,
    headers: responseHeaders,
  });
}

function parseTelegramFilePath(pathname: string): string | null {
  if (!pathname.startsWith(TELEGRAM_FILE_PREFIX)) return null;
  let filePath: string;
  try {
    filePath = decodeURIComponent(pathname.slice(TELEGRAM_FILE_PREFIX.length));
  } catch {
    return null;
  }
  if (filePath.length === 0 || filePath.length > 256) return null;
  const segments = filePath.split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) =>
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      !TELEGRAM_FILE_SEGMENT_PATTERN.test(segment))
  ) {
    return null;
  }
  return segments.join("/");
}

async function handleTelegramFileRequest(
  request: Request,
  env: ProxyEnv,
  filePath: string,
  telegramFetch: OriginFetch,
  secretsEqual: SecretComparator,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" }, { Allow: "GET" });
  }
  const providedSecret = request.headers.get(TELEGRAM_PROXY_SECRET_HEADER);
  if (!providedSecret || !await secretsEqual(providedSecret, env.TELEGRAM_PROXY_SECRET)) {
    return jsonResponse(403, { error: "Forbidden" });
  }
  const botToken = request.headers.get(TELEGRAM_BOT_TOKEN_HEADER);
  if (!botToken || !TELEGRAM_BOT_TOKEN_PATTERN.test(botToken)) {
    return jsonResponse(403, { error: "Forbidden" });
  }

  let telegramResponse: Response;
  try {
    telegramResponse = await telegramFetch(
      `https://api.telegram.org/file/bot${botToken}/${filePath}`,
      {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    console.error(JSON.stringify({
      message: "Telegram file proxy request failed",
      error: error instanceof Error ? error.name : "UnknownError",
    }));
    return jsonResponse(502, { error: "Telegram file unavailable" });
  }
  if (!telegramResponse.ok) {
    return jsonResponse(502, { error: "Telegram file unavailable" });
  }

  const contentType = telegramResponse.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
  if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    return jsonResponse(502, { error: "Unsupported Telegram file" });
  }
  const declaredSize = Number(telegramResponse.headers.get("Content-Length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_TELEGRAM_FILE_BYTES) {
    return jsonResponse(413, { error: "Telegram file is too large" });
  }
  const body = await telegramResponse.arrayBuffer();
  if (body.byteLength > MAX_TELEGRAM_FILE_BYTES) {
    return jsonResponse(413, { error: "Telegram file is too large" });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    },
  });
}

export async function handleRequest(
  request: Request,
  env: ProxyEnv,
  originFetch: OriginFetch = fetch,
  secretsEqual: SecretComparator = timingSafeSecretEqual,
): Promise<Response> {
  const requestUrl = new URL(request.url);

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    return jsonResponse(200, { ok: true });
  }

  const telegramFilePath = parseTelegramFilePath(requestUrl.pathname);
  if (telegramFilePath) {
    return handleTelegramFileRequest(
      request,
      env,
      telegramFilePath,
      originFetch,
      secretsEqual,
    );
  }

  const telegramMethod = requestUrl.pathname.match(TELEGRAM_METHOD_PATH_PATTERN)?.[1];
  if (telegramMethod) {
    return handleTelegramApiRequest(
      request,
      env,
      telegramMethod,
      originFetch,
      secretsEqual,
    );
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
    console.error(JSON.stringify({ message: "Invalid Telegram webhook origin configuration" }));
    return jsonResponse(500, { error: "Proxy is not configured" });
  }

  const updateBody = await readBoundedBody(request, MAX_UPDATE_BYTES);
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
    console.error(JSON.stringify({
      message: "Telegram webhook origin request failed",
      error: error instanceof Error ? error.name : "UnknownError",
    }));
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
