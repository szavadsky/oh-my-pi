import { describe, expect, test } from "bun:test";
import { resolveAgentSessionPolicy } from "../task/agent-policy";
import type { AgentDefinition } from "../task/types";
import { parseAgentFields } from "./helpers";

describe("availability parsing", () => {
	test("mode: primary → availability: primary", () => {
		const result = parseAgentFields({ name: "x", description: "y", mode: "primary" });
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("primary");
	});

	test("mode: subagent → availability: subagent", () => {
		const result = parseAgentFields({ name: "x", description: "y", mode: "subagent" });
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("subagent");
	});

	test("mode: all → availability: all", () => {
		const result = parseAgentFields({ name: "x", description: "y", mode: "all" });
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("all");
	});

	test("no mode → availability: all (default)", () => {
		const result = parseAgentFields({ name: "x", description: "y" });
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("all");
	});

	test("user-invocable: false → availability: subagent", () => {
		const result = parseAgentFields({ name: "x", description: "y", "user-invocable": false });
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("subagent");
	});

	test("disable-model-invocation: true → availability: primary", () => {
		const result = parseAgentFields({ name: "x", description: "y", "disable-model-invocation": true });
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("primary");
	});

	test("mode takes precedence over Copilot aliases", () => {
		const result = parseAgentFields({
			name: "x",
			description: "y",
			mode: "primary",
			"user-invocable": false,
		});
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("primary");
	});

	test("unknown mode → availability: all", () => {
		const result = parseAgentFields({ name: "x", description: "y", mode: "foo" });
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("all");
	});

	test("user-invocable: false + disable-model-invocation: true → availability: subagent", () => {
		const result = parseAgentFields({
			name: "x",
			description: "y",
			"user-invocable": false,
			"disable-model-invocation": true,
		});
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("subagent");
	});

	test("user-invocable: true + disable-model-invocation: true → availability: primary", () => {
		const result = parseAgentFields({
			name: "x",
			description: "y",
			"user-invocable": true,
			"disable-model-invocation": true,
		});
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("primary");
	});

	test("user-invocable: false + disable-model-invocation: false → availability: subagent", () => {
		const result = parseAgentFields({
			name: "x",
			description: "y",
			"user-invocable": false,
			"disable-model-invocation": false,
		});
		expect(result).not.toBeNull();
		expect(result!.availability).toBe("subagent");
	});

	test("spawns: [] → spawns empty string, availability unchanged", () => {
		const result = parseAgentFields({
			name: "x",
			description: "y",
			spawns: [],
		});
		expect(result).not.toBeNull();
		expect(result!.spawns).toEqual([]);
		// resolveAgentSessionPolicy should produce "" for empty spawns
		const agent: AgentDefinition = {
			...result!,
			systemPrompt: "",
			source: "user",
		};
		const policy = resolveAgentSessionPolicy(agent);
		expect(policy.spawns).toBe("");
	});

	test("primary agent tools do not include yield", () => {
		const result = parseAgentFields({ name: "x", description: "y", tools: ["read"], mode: "primary" });
		expect(result).not.toBeNull();
		expect(result!.tools).not.toContain("yield");
	});

	test("subagent agent tools include yield", () => {
		const result = parseAgentFields({ name: "x", description: "y", tools: ["read"], mode: "subagent" });
		expect(result).not.toBeNull();
		expect(result!.tools).toContain("yield");
	});
});
