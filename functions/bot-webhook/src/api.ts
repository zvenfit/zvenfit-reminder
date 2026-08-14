export function jsonResponse(statusCode: number, body: unknown): ApiGatewayResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data, X-Workspace-Id",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

export interface ApiGatewayEvent {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  path?: string;
  url?: string;
  isBase64Encoded?: boolean;
}

export interface ApiGatewayResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export function getPath(event: ApiGatewayEvent): string {
  if (event.path) {
    return event.path;
  }
  try {
    return new URL(event.url ?? "/").pathname;
  } catch {
    return "/";
  }
}

export function getHeader(event: ApiGatewayEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const direct = headers[name];
  if (direct) {
    return direct;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}
