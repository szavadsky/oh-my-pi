import { describe, expect, test } from "bun:test";
import { parseConfiguredThinkingLevel } from "../thinking";
import { resolveAgentSessionPolicy } from "./agent-policy";

const HIGH = parseConfiguredThinkingLevel("high")!;

describe("resolveAgentSessionPolicy", () => {
	test("auto-adds task when spawns resolves to non-empty even without spawns field", () => {
		const result = resolveAgentSessionPolicy({
			name: "test",
			description: "test",
			systemPrompt: "",
			tools: ["read", "grep"],
			source: "project",
		});
		expect(result.toolNames).toContain("task");
		expect(result.toolNames).toContain("hub");
		expect(result.spawns).toBe("*");
	});

	test("absent tools returns undefined toolNames", () => {
		const result = resolveAgentSessionPolicy({
			name: "test",
			description: "test",
			systemPrompt: "",
			source: "project",
		});
		expect(result.toolNames).toBeUndefined();
		expect(result.spawns).toBe("*");
	});

	test("explicit spawns serializes correctly", () => {
		const result = resolveAgentSessionPolicy({
			name: "test",
			description: "test",
			systemPrompt: "",
			tools: ["read"],
			spawns: ["scout", "reviewer"],
			source: "project",
		});
		expect(result.spawns).toBe("scout,reviewer");
	});

	test("model and thinkingLevel pass through", () => {
		const result = resolveAgentSessionPolicy({
			name: "test",
			description: "test",
			systemPrompt: "body",
			model: ["@slow"],
			thinkingLevel: HIGH,
			source: "project",
		});
		expect(result.modelPatterns).toEqual(["@slow"]);
		expect(result.thinkingLevel).toBe(HIGH);
		expect(result.systemPromptBody).toBe("body");
	});

	test("spawns wildcard serializes as *", () => {
		const result = resolveAgentSessionPolicy({
			name: "test",
			description: "test",
			systemPrompt: "",
			tools: ["read"],
			spawns: "*",
			source: "project",
		});
		expect(result.spawns).toBe("*");
	});

	test("hub is auto-added when missing from tools", () => {
		const result = resolveAgentSessionPolicy({
			name: "test",
			description: "test",
			systemPrompt: "",
			tools: ["read", "task"],
			source: "project",
		});
		expect(result.toolNames).toContain("hub");
	});

	test("hub is not duplicated when already present", () => {
		const result = resolveAgentSessionPolicy({
			name: "test",
			description: "test",
			systemPrompt: "",
			tools: ["read", "hub"],
			source: "project",
		});
		expect(result.toolNames).toEqual(["read", "hub", "task"]);
	});

	test("wildcard tools resolves to unrestricted (undefined toolNames)", () => {
		// `tools: ["*"]` is the custom-agent sentinel for "all available tools";
		// a literal `*` is not a registered tool name and would be filtered out
		// during activation, leaving only the auto-added task/hub.
		const result = resolveAgentSessionPolicy({
			name: "test",
			description: "test",
			systemPrompt: "",
			tools: ["*"],
			source: "project",
		});
		expect(result.toolNames).toBeUndefined();
	});
});
