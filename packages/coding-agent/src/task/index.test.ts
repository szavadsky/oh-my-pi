import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import * as taskDiscovery from "./discovery";
import { TaskTool } from "./index";
import type { AgentDefinition } from "./types";

const primaryAgent = {
	name: "primary-agent",
	description: "User-invocable only",
	systemPrompt: "",
	availability: "primary" as const,
	source: "project",
} satisfies AgentDefinition;

const allAgent = {
	name: "all-agent",
	description: "Available everywhere",
	systemPrompt: "",
	availability: "all" as const,
	source: "project",
} satisfies AgentDefinition;

const subagentAgent = {
	name: "subagent-agent",
	description: "Subagent only",
	systemPrompt: "",
	availability: "subagent" as const,
	source: "project",
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

describe("renderDescription agent filtering", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("filters out primary-only agents from the description", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [primaryAgent, allAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("*"));
		const description = tool.description;

		expect(description).toContain("### all-agent");
		expect(description).not.toContain("### primary-agent");
	});

	it("includes all and subagent agents in the description", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [allAgent, subagentAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("*"));
		const description = tool.description;

		expect(description).toContain("### all-agent");
		expect(description).toContain("### subagent-agent");
	});

	it("filters out disabled agents from the description", async () => {
		const disabledAgent = {
			name: "disabled-agent",
			description: "Disabled in settings",
			systemPrompt: "",
			source: "project",
		} satisfies AgentDefinition;

		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [allAgent, disabledAgent],
			projectAgentsDir: null,
		});

		const settings = Settings.isolated({
			"async.enabled": false,
			"task.batch": true,
			"task.isolation.mode": "none",
			"task.disabledAgents": ["disabled-agent"],
		});

		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};

		const tool = await TaskTool.create(session);
		const description = tool.description;

		expect(description).toContain("### all-agent");
		expect(description).not.toContain("### disabled-agent");
	});

	it("does not advertise scout when the resolved scout definition is primary-only", async () => {
		// A user/project `mode: primary` scout shadows the bundled one, so the
		// name-based spawn policy alone would advertise a scout every spawn
		// preflight rejects. The description must reflect the filtered set.
		const primaryScout = {
			name: "scout",
			description: "User-invocable only",
			systemPrompt: "",
			availability: "primary" as const,
			source: "project",
		} satisfies AgentDefinition;

		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [primaryScout, allAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("*"));
		const description = tool.description;

		expect(description).toContain("### all-agent");
		expect(description).not.toContain("### scout");
		expect(description).not.toContain('agent: "scout"');
		expect(description).not.toContain("Read-only research MUST use");
	});
});
