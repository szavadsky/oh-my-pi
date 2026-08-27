import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import * as modelResolver from "../config/model-resolver";
import { Settings } from "../config/settings";
import { buildSessionOptions } from "../main";
import * as systemPrompt from "../system-prompt";
import * as discovery from "../task/discovery";
import { parseConfiguredThinkingLevel } from "../thinking";

const HIGH = parseConfiguredThinkingLevel("high")!;
const LOW = parseConfiguredThinkingLevel("low")!;

const mockModel = { provider: "test", id: "model" } as unknown as Model;

function makeModelRegistry() {
	return {
		getAll: () => [mockModel],
		getAvailable: () => [mockModel],
		find: () => mockModel,
		getApiKey: async () => "test-key",
		hasConfiguredAuth: () => true,
		resolver: () => async () => "test-key",
		authStorage: {} as any,
	} as any;
}

function makeSettings(): Settings {
	return Settings.isolated({});
}

function makeSessionManager(context: { agentPersona?: { agent: string; source: "bundled" | "user" | "project" } }) {
	return {
		buildSessionContext: () => context,
		getCwd: () => "/test",
		getHeader: () => null,
	} as any;
}

describe("buildSessionOptions --agent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("sets agentPersona when --agent is provided with valid name", async () => {
		const mockAgent = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "You are a test agent.",
			tools: ["read", "grep"],
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "resolveModelOverride").mockReturnValue({
			model: undefined,
			explicitThinkingLevel: false,
		});
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const options = await buildSessionOptions(
			{ agent: "test-agent" } as any,
			[],
			undefined,
			makeModelRegistry(),
			makeSettings(),
		);

		expect(options.agentPersona).toBe(mockAgent);
	});

	test("throws for unknown agent name", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockReturnValue(undefined);
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		expect(
			buildSessionOptions({ agent: "unknown" } as any, [], undefined, makeModelRegistry(), makeSettings()),
		).rejects.toThrow("Unknown agent");
	});

	test("throws for subagent-only agent", async () => {
		const mockAgent = {
			name: "sub-only",
			description: "Subagent only",
			systemPrompt: "",
			availability: "subagent" as const,
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		expect(
			buildSessionOptions({ agent: "sub-only" } as any, [], undefined, makeModelRegistry(), makeSettings()),
		).rejects.toThrow("subagent-only");
	});

	test("--agent with --tools uses CLI tools, not agent tools", async () => {
		const mockAgent = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "",
			tools: ["read", "grep"],
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "resolveModelOverride").mockReturnValue({
			model: undefined,
			explicitThinkingLevel: false,
		});
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const options = await buildSessionOptions(
			{ agent: "test-agent", tools: ["bash"] } as any,
			[],
			undefined,
			makeModelRegistry(),
			makeSettings(),
		);

		expect(options.toolNames).toEqual(["bash"]);
	});

	test("--agent without --tools uses agent tool list from policy", async () => {
		const mockAgent = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "",
			tools: ["read", "grep"],
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "resolveModelOverride").mockReturnValue({
			model: undefined,
			explicitThinkingLevel: false,
		});
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const options = await buildSessionOptions(
			{ agent: "test-agent" } as any,
			[],
			undefined,
			makeModelRegistry(),
			makeSettings(),
		);

		expect(options.toolNames).toContain("read");
		expect(options.toolNames).toContain("grep");
		expect(options.toolNames).toContain("hub");
	});

	test("--agent with --thinking uses CLI thinking level", async () => {
		const mockAgent = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "",
			tools: ["read"],
			thinkingLevel: HIGH,
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "resolveModelOverride").mockReturnValue({
			model: undefined,
			explicitThinkingLevel: false,
		});
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const options = await buildSessionOptions(
			{ agent: "test-agent", thinking: "low" } as any,
			[],
			undefined,
			makeModelRegistry(),
			makeSettings(),
		);

		expect(options.thinkingLevel).toBe(LOW);
	});

	test("--agent without --thinking uses agent thinking level from policy", async () => {
		const mockAgent = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "",
			tools: ["read"],
			thinkingLevel: HIGH,
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "resolveModelOverride").mockReturnValue({
			model: undefined,
			explicitThinkingLevel: false,
		});
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const options = await buildSessionOptions(
			{ agent: "test-agent" } as any,
			[],
			undefined,
			makeModelRegistry(),
			makeSettings(),
		);

		expect(options.thinkingLevel).toBe(HIGH);
	});

	test("--agent without --model uses agent model from policy", async () => {
		const mockAgent = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "",
			tools: ["read"],
			model: ["@slow"],
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "resolveModelOverride").mockReturnValue({
			model: mockModel,
			explicitThinkingLevel: false,
		});
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const options = await buildSessionOptions(
			{ agent: "test-agent" } as any,
			[],
			undefined,
			makeModelRegistry(),
			makeSettings(),
		);

		expect(options.model).toBe(mockModel);
	});

	test("--agent with --model uses CLI model, not agent model", async () => {
		const cliModel = { provider: "cli", id: "model" } as any;
		const mockAgent = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "",
			tools: ["read"],
			model: ["@slow"],
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "resolveCliModel").mockReturnValue({
			model: cliModel,
			warning: undefined,
			error: undefined,
		});
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const options = await buildSessionOptions(
			{ agent: "test-agent", model: "cli/model" } as any,
			[],
			undefined,
			makeModelRegistry(),
			makeSettings(),
		);

		expect(options.model).toBe(cliModel);
	});

	test("--agent with deferred --model suffix preserves CLI thinking over persona default", async () => {
		// A deferred --model selector (e.g. a role like `slow:low` whose model
		// only resolves after extensions register) sets options.modelPattern and
		// must also carry the inline `:low` thinking suffix through deferral, so
		// a persona's thinkingLevel frontmatter cannot clobber the user's
		// explicit CLI thinking choice.
		const mockAgent = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "",
			tools: ["read"],
			model: ["@slow"],
			thinkingLevel: HIGH,
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		// Deferred resolution: model not found in the built-in registry, but a
		// configured pattern (role) exists — extensions may register it later.
		vi.spyOn(modelResolver, "resolveCliModel").mockReturnValue({
			model: undefined,
			configuredPatterns: ["@slow"],
			configuredPatternIndex: 0,
			warning: undefined,
			error: 'Model "slow:low" not found. Run "omp models" to see available models.',
		});
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const options = await buildSessionOptions(
			{ agent: "test-agent", model: "slow:low" } as any,
			[],
			undefined,
			makeModelRegistry(),
			makeSettings(),
		);

		expect(options.modelPattern).toBe("slow:low");
		// The inline `:low` suffix must win over the persona's HIGH default and
		// be locked against a later persona switch.
		expect(options.thinkingLevel).toBe(LOW);
		expect(options.cliThinkingLocked).toBe(true);
	});
});

describe("buildSessionOptions resume agent persona", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("re-resolves agent from session context on resume", async () => {
		const mockAgent = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "You are a test agent.",
			tools: ["read", "grep"],
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "resolveModelOverride").mockReturnValue({
			model: undefined,
			explicitThinkingLevel: false,
		});
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const sessionManager = makeSessionManager({
			agentPersona: { agent: "test-agent", source: "project" },
		});

		const options = await buildSessionOptions({} as any, [], sessionManager, makeModelRegistry(), makeSettings());

		expect(options.agentPersona).toBe(mockAgent);
	});

	test("silently falls back to default when agent .md deleted on resume", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockReturnValue(undefined);
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const sessionManager = makeSessionManager({
			agentPersona: { agent: "deleted-agent", source: "project" },
		});

		const options = await buildSessionOptions({} as any, [], sessionManager, makeModelRegistry(), makeSettings());

		expect(options.agentPersona).toBeUndefined();
	});

	test("silently falls back when persisted agent changed to subagent-only", async () => {
		const mockAgent = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "",
			availability: "subagent" as const,
			source: "project" as const,
		};

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [mockAgent],
			projectAgentsDir: null,
		});
		vi.spyOn(discovery, "getAgent").mockImplementation((agents, name) => agents.find(a => a.name === name));
		vi.spyOn(systemPrompt, "resolvePromptInput").mockResolvedValue(undefined);
		vi.spyOn(modelResolver, "getModelMatchPreferences").mockReturnValue({
			usageOrder: [],
			providerOrder: [],
			deprioritizeProviders: [],
		});

		const sessionManager = makeSessionManager({
			agentPersona: { agent: "test-agent", source: "project" },
		});

		const options = await buildSessionOptions({} as any, [], sessionManager, makeModelRegistry(), makeSettings());

		expect(options.agentPersona).toBeUndefined();
	});
});
