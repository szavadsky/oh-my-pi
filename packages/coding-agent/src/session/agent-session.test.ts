import { describe, expect, test } from "bun:test";
import { resolveAgentSessionPolicy } from "../task/agent-policy";

describe("resolveAgentSessionPolicy main-persona edge cases", () => {
	test("empty tools array returns undefined toolNames", () => {
		const result = resolveAgentSessionPolicy({
			name: "t",
			description: "d",
			systemPrompt: "",
			tools: [],
			source: "project",
		});
		expect(result.toolNames).toBeUndefined();
	});

	test("empty spawns array serializes to empty string, task not auto-added", () => {
		const result = resolveAgentSessionPolicy({
			name: "t",
			description: "d",
			systemPrompt: "",
			tools: ["read"],
			spawns: [],
			source: "project",
		});
		expect(result.spawns).toBe("");
		expect(result.toolNames).not.toContain("task");
	});

	test("no tools with explicit spawns returns undefined toolNames and preserved spawns", () => {
		const result = resolveAgentSessionPolicy({
			name: "t",
			description: "d",
			systemPrompt: "",
			spawns: ["scout"],
			source: "project",
		});
		expect(result.toolNames).toBeUndefined();
		expect(result.spawns).toBe("scout");
	});

	test("exec pseudo-tool expands to bash and eval", () => {
		const result = resolveAgentSessionPolicy({
			name: "t",
			description: "d",
			systemPrompt: "",
			tools: ["exec", "read"],
			source: "project",
		});
		expect(result.toolNames).toEqual(expect.arrayContaining(["bash", "eval", "read"]));
		expect(result.toolNames).not.toContain("exec");
	});
});
