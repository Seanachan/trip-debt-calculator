import { describe, it, expect } from "vitest";
import { memberForUid, memberNamed } from "../join";

const members = [
  { id: "uid-kai", name: "阿凱" },
  { id: "auto-ming", name: "小明" },
  { id: "uid-ann", name: "Ann" },
];

describe("memberNamed", () => {
  it("finds the member a typed name already belongs to", () => {
    expect(memberNamed(members, "阿凱")?.id).toBe("uid-kai");
  });

  it("ignores spaces, letter case and full-width letters", () => {
    expect(memberNamed(members, "  阿凱 ")?.id).toBe("uid-kai");
    expect(memberNamed(members, "ann")?.id).toBe("uid-ann");
    expect(memberNamed(members, "Ａｎｎ")?.id).toBe("uid-ann");
  });

  it("does not match a different name or an empty one", () => {
    expect(memberNamed(members, "凱")).toBeUndefined();
    expect(memberNamed(members, "   ")).toBeUndefined();
  });
});

describe("memberForUid", () => {
  it("recognises the sign-in that joined as a member", () => {
    expect(memberForUid(members, "uid-kai")?.name).toBe("阿凱");
  });

  it("recognises nobody without a sign-in or for a stranger", () => {
    expect(memberForUid(members, null)).toBeUndefined();
    expect(memberForUid(members, "uid-someone-else")).toBeUndefined();
  });
});
