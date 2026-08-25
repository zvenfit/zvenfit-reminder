import { afterAll, describe, expect, it } from "vitest";
import { getDriver } from "./client.js";
import { OccurrencesRepository } from "./occurrences-repository.js";
import { RemindersRepository } from "./reminders-repository.js";
import { WorkspaceMembersRepository } from "./workspace-members-repository.js";
import { WorkspacesRepository } from "./workspaces-repository.js";

const integrationEnabled = process.env.RUN_YDB_INTEGRATION === "1";
const endpoint = process.env.YDB_ENDPOINT ?? "grpc://localhost:2136";
const database = process.env.YDB_DATABASE ?? "/local";
const sentinelWorkspaceId = "__runtime-health__";

describe.runIf(integrationEnabled)("YDB read query smoke", () => {
  afterAll(async () => {
    await (await getDriver(endpoint, database)).destroy();
  });

  it("compiles and executes every Mini App read query against real YDB", async () => {
    const workspaces = new WorkspacesRepository(endpoint, database);
    const reminders = new RemindersRepository(endpoint, database);
    const members = new WorkspaceMembersRepository(endpoint, database);
    const occurrences = new OccurrencesRepository(endpoint, database);

    await expect(Promise.all([
      workspaces.listForUser(0),
      reminders.listForActor(sentinelWorkspaceId, 0),
      members.listProfiles(sentinelWorkspaceId),
      occurrences.listActionableForActor(sentinelWorkspaceId, 0),
      occurrences.listHistoryForActor(sentinelWorkspaceId, 0, 1),
    ])).resolves.toEqual([[], [], [], [], []]);
  }, 20_000);
});
