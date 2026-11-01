import { z } from "zod";
import { GroupConnectionError, groupConnectionInputSchema, type ParsedInitData } from "@zvenfit-reminder/shared";
import { getPath, jsonResponse, type ApiGatewayEvent, type ApiGatewayResponse } from "./api.js";
import type { GroupConnectionService } from "./group-connections.js";

export async function handleGroupConnectionApi(event: ApiGatewayEvent, initData: ParsedInitData,
  service: GroupConnectionService): Promise<ApiGatewayResponse | null> {
  const path = getPath(event);
  if (path !== "/api/group-connections" && !path.startsWith("/api/group-connections/")) return null;
  const match = /^\/api\/group-connections\/([0-9a-f-]{36})(\/retry)?$/i.exec(path);
  const method = event.httpMethod ?? "GET";
  try {
    if (method === "POST" && path === "/api/group-connections") {
      const payload = JSON.parse(event.body ?? "{}");
      return jsonResponse(200, await service.create(initData.user, groupConnectionInputSchema.parse(payload)));
    }
    if (match && z.string().uuid().safeParse(match[1]).success) {
      if (method === "GET" && !match[2]) return jsonResponse(200, await service.get(initData.user.id, match[1].toLowerCase()));
      if (method === "POST" && match[2]) {
        z.object({}).strict().parse(JSON.parse(event.body ?? "{}"));
        return jsonResponse(200, await service.retry(initData.user.id, match[1].toLowerCase()));
      }
    }
    return jsonResponse(404, { error: "Not found", code: "not_found" });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return jsonResponse(400, { error: "Invalid request", code: "invalid_payload" });
    if (error instanceof GroupConnectionError) return jsonResponse(error.code === "not_found" ? 404 : 409, { error: error.code, code: error.code });
    throw error;
  }
}
