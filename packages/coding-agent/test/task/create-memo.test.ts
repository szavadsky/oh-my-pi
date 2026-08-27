import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { refreshAgentDiscovery, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

const REFRESHED_AGENTS = [
	{
		name: "task",
		description: "Refreshed task agent",
		systemPrompt: "You are the refreshed task agent.",
		source: "bundled" as const,
	},
];

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getExtensionDiscoveryMode: () => "merge",
	} as unknown as ToolSession;
}

describe("TaskTool.create discovery memo", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reuses one discovery scan across repeated creations with the same cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		const first = await TaskTool.create(createSession("/tmp"));
		const second = await TaskTool.create(createSession("/tmp"));

		expect(spy).toHaveBeenCalledTimes(1);
		expect(first.description).toBe(second.description);
	});

	it("rescans for a different cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await TaskTool.create(createSession("/tmp"));
		await TaskTool.create(createSession("/tmp/omp-memo-other"));

		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("does not cache a rejected discovery", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await expect(TaskTool.create(createSession("/tmp"))).rejects.toThrow("boom");
		const tool = await TaskTool.create(createSession("/tmp"));

		expect(tool.description).toContain("task");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("rescans for a different extension mode on the same cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		const mergeSession = createSession("/tmp");
		mergeSession.getExtensionDiscoveryMode = () => "merge";
		const explicitSession = createSession("/tmp");
		explicitSession.getExtensionDiscoveryMode = () => "explicit-only";

		await TaskTool.create(mergeSession);
		await TaskTool.create(explicitSession);

		// An explicit-only session's discovery must not be served from a
		// merge-mode memo entry: the two modes resolve different agent sets
		// (plugin roots suppressed), so the memo key must include the mode.
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("rescans when a session supplies explicit extension roots", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await TaskTool.create(createSession("/tmp"));
		const rootedSession = createSession("/tmp");
		rootedSession.extensionRoots = ["./pack"];

		await TaskTool.create(rootedSession);

		// Explicit-root sessions resolve a different agent set (the roots' own
		// agents must be present), so the memo key must include the roots — a
		// plain same-cwd entry must not serve them.
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("publishes refreshed definitions to existing and future tools", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValueOnce({ agents: TEST_AGENTS, projectAgentsDir: null })
			.mockResolvedValueOnce({ agents: REFRESHED_AGENTS, projectAgentsDir: null });
		const session = createSession("/tmp/omp-memo-refresh");
		const existing = await TaskTool.create(session);

		expect(existing.description).toContain("General-purpose task agent");
		await refreshAgentDiscovery(session.cwd);

		expect(existing.description).toContain("Refreshed task agent");
		expect(existing.description).not.toContain("General-purpose task agent");
		const future = await TaskTool.create(session);
		expect(future.description).toContain("Refreshed task agent");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("rebuilds a snapshot after a different tuple's reload cleared it", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValueOnce({ agents: TEST_AGENTS, projectAgentsDir: null }) // initial rooted create
			.mockResolvedValue({ agents: REFRESHED_AGENTS, projectAgentsDir: null }); // reload + rebuild

		const rooted = createSession("/tmp/omp-memo-rebuild");
		rooted.extensionRoots = ["./pack"];
		const tool = await TaskTool.create(rooted);
		expect(tool.description).toContain("General-purpose task agent");

		// Reload for a DIFFERENT tuple (merge, no roots): clears every snapshot
		// for the cwd, including the rooted one. The rooted tool's next prompt
		// read misses and kicks an async rediscovery (codex 3741858155) instead
		// of advertising constructor-time definitions forever.
		await refreshAgentDiscovery(rooted.cwd);
		// First read after the reload: misses and kicks the async rediscovery,
		// returning the constructor capture for this synchronous render.
		expect(tool.description).not.toContain("Refreshed task agent");
		await Bun.sleep(0);
		await Bun.sleep(0);
		// The next render reads the republished snapshot.
		expect(tool.description).toContain("Refreshed task agent");
		expect(spy).toHaveBeenCalledTimes(3); // create + reload + rebuild
	});
});
