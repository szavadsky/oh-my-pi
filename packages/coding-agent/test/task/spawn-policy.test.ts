import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import initAgentPrompt from "../../src/prompts/agents/init.md" with { type: "text" };
import { fingerprintAgentContent } from "../../src/task/agent-policy";
import * as taskDiscovery from "../../src/task/discovery";
import { TaskTool } from "../../src/task/index";
import { isScoutSpawnable } from "../../src/task/spawn-policy";
import { resolveEffectiveSubagentPolicy, StructuredSubagentError } from "../../src/task/structured-subagent";
import type { AgentDefinition } from "../../src/task/types";
import { getTaskSchema } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const factFinderAgent = {
	name: "fact-finder",
	description: "Find facts.",
	systemPrompt: "Find facts.",
	source: "project",
} satisfies AgentDefinition;

const oracleAgent = {
	name: "oracle",
	description: "Answer hard questions.",
	systemPrompt: "Answer hard questions.",
	source: "bundled",
} satisfies AgentDefinition;

function makeSession(spawns: string): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": true,
		"task.isolation.mode": "none",
	});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => spawns,
	};
}

describe("task spawn policy surfaces", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("includes the spawns policy in the persona content fingerprint", () => {
		// A spawns-only frontmatter edit changes the task/scout prompt text, so
		// the provider prompt-cache key must be invalidated on resume — the
		// fingerprint hashes everything that shapes that text (codex 3741758350).
		const base = {
			name: "spawns-fp",
			description: "Persona",
			systemPrompt: "Body.",
			source: "project" as const,
		};
		const unrestricted = fingerprintAgentContent(base);
		const restricted = fingerprintAgentContent({ ...base, spawns: ["scout"] });
		expect(restricted).not.toBe(unrestricted);
	});

	it("uses the first allowed spawn as the schema default", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: "fact-finder" });
		const parsed = schema({ task: "check" });

		expect(parsed).toEqual({ agent: "fact-finder", task: "check" });
	});

	it("filters the agent list to the restricted spawn policy in the description", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [factFinderAgent, oracleAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("fact-finder"));
		const description = tool.description;

		expect(description).toContain("### fact-finder");
		expect(description).not.toContain("### oracle");
	});
});

describe("resolveEffectiveSubagentPolicy primary-only rejection", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("allows all/subagent agents at preflight", async () => {
		const allAgent = {
			name: "all-agent",
			description: "",
			systemPrompt: "",
			availability: "all" as const,
			source: "project" as const,
		} satisfies AgentDefinition;

		const subAgent = {
			name: "sub-agent",
			description: "",
			systemPrompt: "",
			availability: "subagent" as const,
			source: "project" as const,
		} satisfies AgentDefinition;

		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [allAgent, subAgent],
			projectAgentsDir: null,
		});

		const session = makeSession("*");

		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "task",
				assignment: "do something",
				agent: "all-agent",
			}),
		).resolves.toBeDefined();

		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "task",
				assignment: "do something",
				agent: "sub-agent",
			}),
		).resolves.toBeDefined();
	});

	it("rejects primary-only agent", async () => {
		const primaryOnlyAgent = {
			name: "primary-only",
			description: "",
			systemPrompt: "",
			availability: "primary" as const,
			source: "project" as const,
		} satisfies AgentDefinition;

		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [primaryOnlyAgent],
			projectAgentsDir: null,
		});

		const session = makeSession("*");

		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "task",
				assignment: "do something",
				agent: "primary-only",
			}),
		).rejects.toThrow(StructuredSubagentError);

		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "task",
				assignment: "do something",
				agent: "primary-only",
			}),
		).rejects.toThrow(/primary-only/);
	});
});

describe("isScoutSpawnable", () => {
	it("is true with no disabled agents and unrestricted spawns", () => {
		expect(isScoutSpawnable(undefined, "*")).toBe(true);
		expect(isScoutSpawnable([], "*")).toBe(true);
	});

	it("is false when scout is disabled via task.disabledAgents", () => {
		expect(isScoutSpawnable(["scout"], "*")).toBe(false);
		expect(isScoutSpawnable(["scout", "reviewer"], "*")).toBe(false);
	});

	it("is false when spawning is disabled", () => {
		expect(isScoutSpawnable(undefined, false)).toBe(false);
		expect(isScoutSpawnable(undefined, "")).toBe(false);
	});

	it("is false when scout is not in the allowed spawn list", () => {
		expect(isScoutSpawnable(undefined, "reviewer")).toBe(false);
	});

	it("is true when scout is in the allowed spawn list", () => {
		expect(isScoutSpawnable(undefined, "scout,reviewer")).toBe(true);
		expect(isScoutSpawnable(["reviewer"], "scout")).toBe(true);
	});
});

describe("task tool description scout gating", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function renderDescription(disabledScout: boolean): Promise<string> {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [
				{ name: "scout", description: "Read-only scout.", systemPrompt: "Scout.", source: "bundled" },
				{ name: "reviewer", description: "Reviewer.", systemPrompt: "Review.", source: "bundled" },
			],
			projectAgentsDir: null,
		});
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.batch": true,
			"task.isolation.mode": "none",
			...(disabledScout ? { "task.disabledAgents": ["scout"] } : {}),
		});
		const tool = await TaskTool.create({
			cwd: process.cwd(),
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);
		return tool.description;
	}

	it("mentions scout in the task description when scout is enabled", async () => {
		expect(await renderDescription(false)).toContain("scout");
	});

	it("omits every scout reference from the task description when scout is disabled", async () => {
		const description = await renderDescription(true);
		expect(description).not.toContain("scout");
		// The read-only agent remains listed as an available agent (the spawn
		// policy only filters disabledAgents, so reviewer stays); only the
		// hard-coded scout guidance is dropped.
		expect(description).toContain("### reviewer");
	});
});

describe("bundled agent prompt scout gating", () => {
	it("does not hard-code scout in the init agent prompt", () => {
		expect(initAgentPrompt.toLowerCase()).not.toContain("scout");
		expect(initAgentPrompt).toContain("multiple research agents");
	});
});
