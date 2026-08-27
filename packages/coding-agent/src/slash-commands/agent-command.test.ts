import { afterEach, describe, expect, test, vi } from "bun:test";
import * as discovery from "../task/discovery";
import { lookupBuiltinSlashCommand } from "./builtin-registry";
import type { ParsedSlashCommand, SlashCommandRuntime, TuiSlashCommandRuntime } from "./types";

describe("/agent slash command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function getAgentCommand() {
		const cmd = lookupBuiltinSlashCommand("agent");
		if (!cmd) throw new Error("/agent command not found");
		return cmd;
	}

	function makeCommand(args: string): ParsedSlashCommand {
		return { name: "agent", args, text: `/agent ${args}`.trim() };
	}

	test("handleTui with no args calls showAgentPersonaSelector", async () => {
		const showAgentPersonaSelector = vi.fn();
		const setText = vi.fn();
		const runtime = {
			ctx: {
				showAgentPersonaSelector,
				editor: { setText },
				session: {
					isStreaming: false,
					getPlanModeState: () => undefined,
					getExtensionDiscoveryMode: () => "merge",
				},
				planModeEnabled: false,
				goalModeEnabled: false,
				vibeModeEnabled: false,
			},
		} as unknown as TuiSlashCommandRuntime;

		const cmd = getAgentCommand();
		await cmd.handleTui!(makeCommand(""), runtime);

		expect(showAgentPersonaSelector).toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
	});

	test.each([
		{ flag: "goalModeEnabled", message: "Cannot switch agent during goal mode. Exit goal mode first." },
		{ flag: "vibeModeEnabled", message: "Cannot switch agent during vibe mode. Exit vibe mode first." },
	])("handleTui with args during $flag warns and does not switch", async ({ flag, message }) => {
		const switchPersona = vi.fn();
		const showWarning = vi.fn();
		const setText = vi.fn();
		const runtime = {
			ctx: {
				showWarning,
				editor: { setText },
				session: {
					isStreaming: false,
					getPlanModeState: () => undefined,
					switchAgentPersona: switchPersona,
					getExtensionDiscoveryMode: () => "merge",
				},
				planModeEnabled: false,
				goalModeEnabled: false,
				vibeModeEnabled: false,
				[flag]: true,
			},
		} as unknown as TuiSlashCommandRuntime;

		const cmd = getAgentCommand();
		await cmd.handleTui!(makeCommand("test"), runtime);

		expect(showWarning).toHaveBeenCalledWith(message);
		expect(setText).toHaveBeenCalledWith("");
		expect(switchPersona).not.toHaveBeenCalled();
	});

	test.each([
		{ flag: "goalModeEnabled", message: "Cannot switch agent during goal mode. Exit goal mode first." },
		{ flag: "vibeModeEnabled", message: "Cannot switch agent during vibe mode. Exit vibe mode first." },
	])("handleTui with no args during $flag warns and does not open picker", async ({ flag, message }) => {
		const showAgentPersonaSelector = vi.fn();
		const showWarning = vi.fn();
		const setText = vi.fn();
		const runtime = {
			ctx: {
				showAgentPersonaSelector,
				showWarning,
				editor: { setText },
				session: {
					isStreaming: false,
					getPlanModeState: () => undefined,
					getExtensionDiscoveryMode: () => "merge",
				},
				planModeEnabled: false,
				goalModeEnabled: false,
				vibeModeEnabled: false,
				[flag]: true,
			},
		} as unknown as TuiSlashCommandRuntime;

		const cmd = getAgentCommand();
		await cmd.handleTui!(makeCommand(""), runtime);

		expect(showWarning).toHaveBeenCalledWith(message);
		expect(setText).toHaveBeenCalledWith("");
		expect(showAgentPersonaSelector).not.toHaveBeenCalled();
	});

	test.each([
		{ getter: "getGoalModeState", message: "Cannot switch agent during goal mode. Exit goal mode first." },
		{ getter: "getVibeModeState", message: "Cannot switch agent during vibe mode. Exit vibe mode first." },
	])("handle during $getter warns and does not switch", async ({ getter, message }) => {
		const switchPersona = vi.fn();
		const output = vi.fn();
		const runtime = {
			session: {
				switchAgentPersona: switchPersona,
				isStreaming: false,
				getPlanModeState: () => undefined,
				getGoalModeState: () => (getter === "getGoalModeState" ? { enabled: true } : undefined),
				getVibeModeState: () => (getter === "getVibeModeState" ? { enabled: true } : undefined),
				getExtensionDiscoveryMode: () => "merge",
			},
			cwd: "/test",
			output,
			sessionManager: {} as any,
			settings: {} as any,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
		} as unknown as SlashCommandRuntime;

		const cmd = getAgentCommand();
		await cmd.handle!(makeCommand("test"), runtime);

		expect(output).toHaveBeenCalledWith(message);
		expect(switchPersona).not.toHaveBeenCalled();
	});

	test("handle with valid agent calls switchAgentPersona", async () => {
		const mockAgent = { name: "test", description: "", systemPrompt: "", source: "project" as const };
		const switchPersona = vi.fn().mockResolvedValue(undefined);
		const output = vi.fn();
		const runtime = {
			session: {
				switchAgentPersona: switchPersona,
				isStreaming: false,
				getPlanModeState: () => undefined,
				getGoalModeState: () => undefined,
				getVibeModeState: () => undefined,
				getExtensionDiscoveryMode: () => "merge",
			},
			cwd: "/test",
			output,
			sessionManager: {} as any,
			settings: { get: () => undefined } as any,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
		} as unknown as SlashCommandRuntime;

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));

		const cmd = getAgentCommand();
		await cmd.handle!(makeCommand("test"), runtime);

		expect(switchPersona).toHaveBeenCalledWith(mockAgent);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Switched to agent persona"));
	});

	test("handle with unknown agent prints error", async () => {
		const output = vi.fn();
		const runtime = {
			session: {
				switchAgentPersona: vi.fn(),
				isStreaming: false,
				getPlanModeState: () => undefined,
				getGoalModeState: () => undefined,
				getVibeModeState: () => undefined,
				getExtensionDiscoveryMode: () => "merge",
			},
			cwd: "/test",
			output,
			sessionManager: {} as any,
			settings: { get: () => undefined } as any,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
		} as unknown as SlashCommandRuntime;

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockReturnValue(undefined);

		const cmd = getAgentCommand();
		await cmd.handle!(makeCommand("unknown"), runtime);

		expect(output).toHaveBeenCalledWith(expect.stringContaining("Unknown agent"));
	});

	test("handle with subagent-only agent prints error", async () => {
		const mockAgent = {
			name: "sub",
			description: "",
			systemPrompt: "",
			availability: "subagent" as const,
			source: "project" as const,
		};
		const output = vi.fn();
		const runtime = {
			session: {
				switchAgentPersona: vi.fn(),
				isStreaming: false,
				getPlanModeState: () => undefined,
				getGoalModeState: () => undefined,
				getVibeModeState: () => undefined,
				getExtensionDiscoveryMode: () => "merge",
			},
			cwd: "/test",
			output,
			sessionManager: {} as any,
			settings: { get: () => undefined } as any,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
		} as unknown as SlashCommandRuntime;

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));

		const cmd = getAgentCommand();
		await cmd.handle!(makeCommand("sub"), runtime);

		expect(output).toHaveBeenCalledWith(expect.stringContaining("subagent-only"));
	});

	test("handle with disabled agent prints disabled error", async () => {
		const mockAgent = { name: "disabled-agent", description: "", systemPrompt: "", source: "project" as const };
		const switchPersona = vi.fn();
		const output = vi.fn();
		const runtime = {
			session: {
				switchAgentPersona: switchPersona,
				isStreaming: false,
				getPlanModeState: () => undefined,
				getGoalModeState: () => undefined,
				getVibeModeState: () => undefined,
				getExtensionDiscoveryMode: () => "merge",
			},
			cwd: "/test",
			output,
			sessionManager: {} as any,
			settings: { get: () => ["disabled-agent"] } as any,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
		} as unknown as SlashCommandRuntime;

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));

		const cmd = getAgentCommand();
		await cmd.handle!(makeCommand("disabled-agent"), runtime);

		expect(switchPersona).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("disabled"));
	});

	test("/switch-agent alias resolves to same command", async () => {
		const switchCmd = lookupBuiltinSlashCommand("switch-agent");
		expect(switchCmd).toBeDefined();
		expect(switchCmd!.name).toBe("agent");
	});

	test("handle rediscovery carries the session's extension mode", async () => {
		const mockAgent = { name: "test", description: "", systemPrompt: "", source: "project" as const };
		const switchPersona = vi.fn().mockResolvedValue(undefined);
		const output = vi.fn();
		const runtime = {
			session: {
				switchAgentPersona: switchPersona,
				isStreaming: false,
				getPlanModeState: () => undefined,
				getGoalModeState: () => undefined,
				getVibeModeState: () => undefined,
				getExtensionDiscoveryMode: () => "explicit-only" as const,
			},
			cwd: "/test",
			output,
			sessionManager: {} as any,
			settings: { get: () => undefined } as any,
			refreshCommands: vi.fn(),
			reloadPlugins: vi.fn(),
		} as unknown as SlashCommandRuntime;

		const discoverSpy = vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));

		const cmd = getAgentCommand();
		await cmd.handle!(makeCommand("test"), runtime);

		// A --no-extensions session must rediscover under explicit-only so it
		// cannot switch to a plugin/extension persona startup suppressed.
		expect(discoverSpy).toHaveBeenCalledWith("/test", undefined, {
			includeExtensions: true,
			extensionMode: "explicit-only",
		});
		expect(switchPersona).toHaveBeenCalledWith(mockAgent);
	});
});
