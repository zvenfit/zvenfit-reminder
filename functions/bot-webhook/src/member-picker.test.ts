import { describe, expect, it } from "vitest";
import { memberImportRequestId } from "./member-import.js";
import { memberPickerButton } from "./member-picker.js";

describe("member picker", () => {
  it("prepares a non-bot multi-user request scoped to the workspace", () => {
    const button = memberPickerButton("workspace-a");
    expect(button).toEqual({
      text: "Добавить участников",
      request_users: {
        request_id: memberImportRequestId("workspace-a"),
        user_is_bot: false,
        max_quantity: 10,
        request_name: true,
        request_username: true,
      },
    });
  });
});
