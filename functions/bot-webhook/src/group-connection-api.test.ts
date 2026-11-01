import { describe, expect, it, vi } from "vitest";
import { GroupConnectionError, type ParsedInitData } from "@zvenfit-reminder/shared";
import { handleGroupConnectionApi } from "./group-connection-api.js";
import type { GroupConnectionService } from "./group-connections.js";
const init: ParsedInitData = { user: { id: 10 }, authDate: 123, hash: "test", raw: {} };
const id = "11111111-1111-4111-8111-111111111111";
function setup() {
  const service = { create: vi.fn().mockResolvedValue({ connectionId: id, state: "pending" }),
    get: vi.fn().mockResolvedValue({ connectionId: id, state: "pending" }),
    retry: vi.fn().mockResolvedValue({ connectionId: id, state: "validating" }) };
  const request = (path: string, method: string, body?: unknown) => handleGroupConnectionApi({ path, httpMethod: method,
    body: body == null ? undefined : JSON.stringify(body) }, init, service as unknown as GroupConnectionService);
  return { service, request };
}
describe("group connection API", () => {
  it("uses authenticated actor without requiring a selected workspace", async () => {
    const { service, request } = setup();
    expect((await request("/api/group-connections", "POST", { clientRequestId: id, launchMode: "native" }))?.statusCode).toBe(200);
    expect(service.create).toHaveBeenCalledWith(init.user, { clientRequestId: id, launchMode: "native" });
  });
  it.each([{ actorUserId: 20 }, { chatId: -1001 }, { workspaceId: id }])("rejects client-supplied authority %j", async extra => {
    const { service, request } = setup();
    expect((await request("/api/group-connections", "POST", { clientRequestId: id, launchMode: "native", ...extra }))?.statusCode).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });
  it("GET polls without retry; retry accepts no replacement group", async () => {
    const { service, request } = setup();
    await request(`/api/group-connections/${id}`, "GET");
    expect(service.get).toHaveBeenCalledWith(10, id); expect(service.retry).not.toHaveBeenCalled();
    expect((await request(`/api/group-connections/${id}/retry`, "POST", { chatId: -1002 }))?.statusCode).toBe(400);
    await request(`/api/group-connections/${id}/retry`, "POST", {});
    expect(service.retry).toHaveBeenCalledWith(10, id);
  });
  it("hides another actor's operation and returns idempotency conflicts", async () => {
    const { service, request } = setup(); service.get.mockRejectedValue(new GroupConnectionError("not_found"));
    expect((await request(`/api/group-connections/${id}`, "GET"))?.statusCode).toBe(404);
    service.create.mockRejectedValue(new GroupConnectionError("idempotency_conflict"));
    expect((await request("/api/group-connections", "POST", { clientRequestId: id, launchMode: "native" }))?.statusCode).toBe(409);
  });
});
