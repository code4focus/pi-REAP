import { describe, expect, it } from "vitest";
import { classify } from "../../src/policy/classifier.js";
import { extractFeatures } from "../../src/policy/features.js";

describe("deterministic classifier", () => {
  const route = (prompt: string) => classify({ features: extractFeatures({ prompt }), relation: "new", previousFailed: false, resumeGuard: false }).taskClass;
  it.each([
    ["这个函数返回什么？", "simple_query"],
    ["只读检查这个文件是否存在明显重复", "bounded_read"],
    ["实现这个功能并运行测试", "implementation"],
    ["检查并发取消协议是否存在竞态", "high_risk"],
  ] as const)("classifies %s as %s", (prompt, expected) => expect(route(prompt)).toBe(expected));
  it("uses continuation semantics for resume ambiguity", () => expect(classify({ features: extractFeatures({ prompt: "这个怎么样" }), relation: "ambiguous", previousFailed: false, resumeGuard: true }).taskClass).toBe("continuation"));
  it("treats /goal as architecture semantics", () => expect(route("/goal complete the migration plan")).toBe("architecture"));
});
