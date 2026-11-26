import { describe, expect, it } from "vitest";
import { AnchorSchema } from "@argus/shared";
import { ambiguityDecision, anchorVia, describeAnchor, resolveAnchor } from "./anchors.ts";

/** A page that records which locator method an anchor resolved through. */
const root = {
  getByTestId: (v: string) => `testid:${v}`,
  getByRole: (role: string, o?: { name?: string }) => `role:${role}:${o?.name ?? ""}`,
  getByLabel: (v: string) => `label:${v}`,
  getByPlaceholder: (v: string) => `placeholder:${v}`,
  getByText: (v: string) => `text:${v}`,
  locator: (v: string) => `css:${v}`,
};

describe("anchor ladder", () => {
  it("resolves through the first rung the anchor carries, in ladder order", () => {
    const full = { testid: "t", role: "button", name: "n", label: "l", placeholder: "p", text: "x", css: ".c" };
    const order = ["testid", "role", "label", "placeholder", "text", "css"] as const;
    const expected = ["testid:t", "role:button:n", "label:l", "placeholder:p", "text:x", "css:.c"];
    const anchor: Record<string, string> = { ...full };
    order.forEach((rung, i) => {
      const got = resolveAnchor(root, anchor);
      expect(got).toEqual({ locator: expected[i], via: rung });
      expect(anchorVia(anchor)).toBe(rung);
      delete anchor[rung];
      if (rung === "role") delete anchor.name;
    });
  });

  it("refuses an empty anchor rather than matching everything", () => {
    expect(() => resolveAnchor(root, {})).toThrow("empty anchor");
    expect(AnchorSchema.safeParse({ name: "only a name" }).success).toBe(false);
  });

  it("accepts label and placeholder anchors on the wire", () => {
    expect(AnchorSchema.safeParse({ label: "Password" }).success).toBe(true);
    expect(AnchorSchema.safeParse({ placeholder: "New task title" }).success).toBe(true);
  });

  it("names an anchor the way messages show it", () => {
    expect(describeAnchor({ testid: "add-task" })).toBe("add-task");
    expect(describeAnchor({ role: "button", name: "Add" })).toBe("button/Add");
    expect(describeAnchor({ role: "alert" })).toBe("alert");
    expect(describeAnchor({ label: "Password" })).toBe("Password");
  });
});

describe("ambiguity refusal", () => {
  it("locates the anchor by flow step when there is one", () => {
    const d = ambiguityDecision(2, "Add", "text", 3, ['button "Add"']);
    expect(d.whatChanged).toBe('step 2: anchor "Add" (via text) matched 3 elements — candidates: button "Add"');
  });

  it("needs no step in a code-first test, where the stack says where", () => {
    const d = ambiguityDecision(undefined, "button/Save", "role", 2, []);
    expect(d.verdict).toBe("ambiguous_anchor");
    expect(d.whatChanged).toBe('anchor "button/Save" (via role) matched 2 elements');
  });
});
