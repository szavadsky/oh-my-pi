import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Regression for issue #5305: image-gen is registered as a custom tool, and
// custom tools are force-activated regardless of the `toolNames` filter. Before
// the fix, `generate_image` survived `--no-tools` (an empty `toolNames`), any
// explicit whitelist that omitted it, and had no `generate_image.enabled`
// settings toggle. The SDK must honor the whitelist and the new setting.
describe("generate_image tool gating", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-generate-image-gating-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function activeToolNames(settings: Settings, toolNames?: string[]): Promise<string[]> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames,
		});
		sessions.push(session);
		return session.getActiveToolNames();
	}

	function customTool(name: string, mcp = false): CustomTool {
		return {
			name,
			label: name,
			description: name,
			parameters: { type: "object", properties: {} },
			...(mcp ? { mcpServerName: "test", mcpToolName: "search" } : {}),
			execute: async () => ({ content: [] }),
		} as CustomTool;
	}

	async function sessionWithCustomTools(toolNames: string[], customTools: CustomTool[]): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			enableMCP: false,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "plan.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames,
			customTools,
		});
		sessions.push(session);
		return session;
	}

	it("excludes generate_image from a restricted tool whitelist", async () => {
		const names = await activeToolNames(Settings.isolated({}), ["read"]);
		expect(names).toContain("read");
		expect(names).not.toContain("generate_image");
	});

	it("excludes generate_image under --no-tools (empty whitelist)", async () => {
		const names = await activeToolNames(Settings.isolated({}), []);
		expect(names).not.toContain("generate_image");
	});

	it("respects generate_image.enabled=false even when requested", async () => {
		const names = await activeToolNames(Settings.isolated({ "generate_image.enabled": false }), [
			"read",
			"generate_image",
		]);
		expect(names).not.toContain("generate_image");
	});

	it("includes generate_image top-level when explicitly requested and enabled", async () => {
		const names = await activeToolNames(Settings.isolated({ "generate_image.enabled": true }), [
			"read",
			"generate_image",
		]);
		expect(names).toContain("generate_image");
	});

	it("exposes generate_image as an xd:// device (not top-level) in a default session", async () => {
		// Default session (no explicit --tools) with tools.xdev on: image-gen is a
		// discoverable custom tool, so it mounts as an xd:// device instead of
		// shipping its schema top-level.
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "generate_image.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
		});
		sessions.push(session);
		expect(session.getActiveToolNames()).not.toContain("generate_image");
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("generate_image");
	});

	it("keeps ambient tools top-level across runtime selection without write", async () => {
		const ambientTool = customTool("ambient_search");
		const session = await sessionWithCustomTools(["read"], [ambientTool]);
		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getXdevToolEntries()).toEqual([]);

		await session.setActiveToolsByName(session.getEnabledToolNames());

		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(session.getXdevToolEntries()).toEqual([]);
	});

	it("exposes ambient MCP-shaped tools directly when write was not granted", async () => {
		let mcpCalls = 0;
		const mcpTool = {
			name: "mcp__test__search",
			label: "test/search",
			description: "Search the test MCP server",
			parameters: { type: "object", properties: {} },
			mcpServerName: "test",
			mcpToolName: "search",
			execute: async () => {
				mcpCalls++;
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		} as CustomTool;
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "generate_image.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames: ["read", "generate_image"],
			customTools: [mcpTool],
		});
		sessions.push(session);

		expect(session.getActiveToolNames()).toContain("generate_image");
		expect(session.getActiveToolNames()).toContain(mcpTool.name);
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(session.getXdevToolEntries()).toEqual([]);
		expect(session.getAllToolNames()).toContain(mcpTool.name);
		const directTool = session.getToolByName(mcpTool.name);
		expect(directTool).toBeDefined();
		const result = await directTool!.execute("mcp-direct-dispatch", {});
		expect(result.content.find(part => part.type === "text")?.text).toBe("ok");
		expect(mcpCalls).toBe(1);
	});

	it("does not add write for an MCP device when write was omitted", async () => {
		const session = await sessionWithCustomTools(["read"], [customTool("mcp__test__search", true)]);
		expect(session.getActiveToolNames()).toContain("mcp__test__search");
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(session.getXdevToolEntries()).toEqual([]);

		await session.refreshMCPTools([]);

		expect(session.getActiveToolNames()).not.toContain("write");
	});

	it("does not add write during enabled-set round trips", async () => {
		const session = await sessionWithCustomTools(["read"], [customTool("mcp__test__search", true)]);
		expect(session.getActiveToolNames()).not.toContain("write");

		await session.setActiveToolsByName(session.getEnabledToolNames());
		expect(session.getActiveToolNames()).toContain("mcp__test__search");
		expect(session.getActiveToolNames()).not.toContain("write");

		await session.refreshMCPTools([]);
		expect(session.getActiveToolNames()).not.toContain("write");
	});

	it("keeps deferred MCP tool refreshes inside the persona tool policy", async () => {
		const mcpTool = customTool("mcp__test__search", true);
		// No startup custom tools: the MCP server connects after the persona is
		// applied, so the deferred refresh must not broaden the active set.
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			enableMCP: false,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "plan.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			agentPersona: {
				name: "readonly-persona",
				description: "Persona granting only read",
				systemPrompt: "",
				tools: ["read"],
				source: "project" as const,
			},
		});
		sessions.push(session);

		// The persona overlay is active pre-refresh.
		expect(session.getEnabledToolNames()).toContain("read");
		expect(session.getEnabledToolNames()).not.toContain(mcpTool.name);

		// A deferred MCP connect must not broaden the catalog past the persona's
		// explicit tools (codex 3741691577): the tool is registered (visible for
		// a future switch) but stays OUT of the active set.
		await session.refreshMCPTools([mcpTool]);
		expect(session.getAllToolNames()).toContain(mcpTool.name);
		expect(session.getEnabledToolNames()).not.toContain(mcpTool.name);
	});

	it("does not install the persona tool policy when the CLI locked the tool set", async () => {
		const mcpTool = customTool("mcp__test__search", true);
		// --agent reviewer --tools read,mcp__test__search: the CLI list wins, so
		// a deferred MCP refresh must not filter the CLI-granted MCP tool against
		// the persona's own tools (codex 3741730337).
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			enableMCP: false,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "plan.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames: ["read", mcpTool.name],
			cliToolsLocked: true,
			agentPersona: {
				name: "restricted-persona",
				description: "Persona whose own tools would exclude the MCP tool",
				systemPrompt: "",
				tools: ["read"],
				source: "project" as const,
			},
		});
		sessions.push(session);

		await session.refreshMCPTools([mcpTool]);

		// The CLI-granted MCP tool stays active: no persona filter is installed.
		expect(session.getEnabledToolNames()).toContain(mcpTool.name);
	});

	it("does not install the persona tool policy when the SDK caller granted the tool set", async () => {
		const mcpTool = customTool("mcp__sdk__search", true);
		// SDK embedder passes agentPersona together with an explicit toolNames
		// list but does NOT set cliToolsLocked: startup respects the explicit
		// list (the SDK persona block only fills toolNames when undefined), so a
		// deferred MCP refresh must not filter the explicitly granted host tool
		// against the persona's own tools either (codex 3743142).
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			enableMCP: false,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "plan.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames: ["read", mcpTool.name],
			agentPersona: {
				name: "restricted-sdk-persona",
				description: "Persona whose own tools would exclude the SDK-granted MCP tool",
				systemPrompt: "",
				tools: ["read"],
				source: "project" as const,
			},
		});
		sessions.push(session);

		await session.refreshMCPTools([mcpTool]);

		// The SDK-granted MCP tool stays active: no persona filter is installed.
		expect(session.getEnabledToolNames()).toContain(mcpTool.name);
	});

	it("filters startup always-include tools through the persona tool policy", async () => {
		const ambientTool = customTool("ambient_write_like", false);
		// Persona grants only `read`; an SDK custom tool would normally be
		// always-included at startup. It must stay registered but OUT of the
		// initial active set (codex 3741730336).
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			enableMCP: false,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "plan.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			customTools: [ambientTool],
			agentPersona: {
				name: "readonly-persona-2",
				description: "Persona granting only read",
				systemPrompt: "",
				tools: ["read"],
				source: "project" as const,
			},
		});
		sessions.push(session);

		expect(session.getAllToolNames()).toContain(ambientTool.name);
		expect(session.getEnabledToolNames()).not.toContain(ambientTool.name);
	});

	it("preserves explicitly requested write after MCP devices disconnect", async () => {
		const session = await sessionWithCustomTools(["read", "write"], [customTool("mcp__test__search", true)]);

		await session.refreshMCPTools([]);

		expect(session.getActiveToolNames()).toContain("write");
	});

	it("unmounts devices when write is removed at runtime", async () => {
		const ambientTool = customTool("ambient_search");
		const session = await sessionWithCustomTools(["read", "write"], [ambientTool]);
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain(ambientTool.name);

		await session.setActiveToolsByName(["read", ambientTool.name]);

		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(session.getXdevToolEntries()).toEqual([]);
	});

	it("keeps all remaining tools top-level after MCP disconnect without write", async () => {
		const ambientTool = customTool("ambient_search");
		const session = await sessionWithCustomTools(["read"], [ambientTool, customTool("mcp__test__search", true)]);

		await session.refreshMCPTools([]);

		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(session.getXdevToolEntries()).toEqual([]);
	});

	it("keeps ambient custom tools top-level when an explicit session omitted read", async () => {
		const ambientTool = customTool("ambient_search");
		const session = await sessionWithCustomTools(["bash"], [ambientTool]);

		expect(session.getActiveToolNames()).not.toContain("read");
		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(ambientTool.name);
	});

	it("keeps ambient tools top-level when write is shadowed by a custom tool", async () => {
		const ambientTool = customTool("ambient_search");
		const shadowWrite = customTool("write");
		const session = await sessionWithCustomTools(["read"], [ambientTool, shadowWrite]);

		expect(session.hasBuiltInTool("write")).toBe(false);
		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(ambientTool.name);

		const rpcTool: AgentTool = {
			name: "rpc_shadow_search",
			label: "RPC Shadow Search",
			description: "Search RPC host data",
			parameters: type({}),
			loadMode: "discoverable",
			async execute() {
				return { content: [] };
			},
		};
		await session.refreshRpcHostTools([rpcTool]);
		expect(session.hasBuiltInTool("write")).toBe(false);
		expect(session.getActiveToolNames()).toContain(rpcTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(rpcTool.name);
	});

	it("keeps ambient tools top-level when read is shadowed by a custom tool", async () => {
		const ambientTool = customTool("ambient_search");
		const shadowRead = customTool("read");
		const session = await sessionWithCustomTools(["read"], [ambientTool, shadowRead]);

		expect(session.hasBuiltInTool("read")).toBe(false);
		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(ambientTool.name);

		const rpcTool: AgentTool = {
			name: "rpc_shadow_read_search",
			label: "RPC Shadow Read Search",
			description: "Search RPC host data",
			parameters: type({}),
			loadMode: "discoverable",
			async execute() {
				return { content: [] };
			},
		};
		await session.refreshRpcHostTools([rpcTool]);
		expect(session.getActiveToolNames()).toContain(rpcTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(rpcTool.name);
	});

	it("keeps newly discovered tools top-level after runtime read removal", async () => {
		const session = await sessionWithCustomTools(["read", "bash"], []);
		await session.setActiveToolsByName(["bash"]);

		const rpcTool: AgentTool = {
			name: "rpc_without_read",
			label: "RPC Without Read",
			description: "Search RPC host data",
			parameters: type({}),
			loadMode: "discoverable",
			async execute() {
				return { content: [] };
			},
		};
		await session.refreshRpcHostTools([rpcTool]);

		expect(session.getActiveToolNames()).not.toContain("read");
		expect(session.getActiveToolNames()).toContain(rpcTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(rpcTool.name);
	});
	it("exposes newly discovered RPC tools directly when write was omitted", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "plan.enabled": false, "generate_image.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			toolNames: ["read"],
		});
		sessions.push(session);
		expect(session.getXdevToolEntries()).toEqual([]);
		expect(session.getActiveToolNames()).not.toContain("write");

		const rpcTool: AgentTool = {
			name: "rpc_search",
			label: "RPC Search",
			description: "Search RPC host data",
			parameters: type({}),
			loadMode: "discoverable",
			async execute() {
				return { content: [] };
			},
		};
		await session.refreshRpcHostTools([rpcTool]);

		expect(session.getActiveToolNames()).toContain("rpc_search");
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(session.getXdevToolEntries()).toEqual([]);
	});

	it("filters deferred RPC host tools through the persona tool policy", async () => {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "plan.enabled": false, "generate_image.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			agentPersona: {
				name: "readonly-rpc-persona",
				description: "Persona granting only read",
				systemPrompt: "",
				tools: ["read"],
				source: "project" as const,
			},
		});
		sessions.push(session);

		const rpcTool: AgentTool = {
			name: "rpc_write_like",
			label: "RPC Write Like",
			description: "Write-like RPC host tool",
			parameters: type({}),
			loadMode: "discoverable",
			async execute() {
				return { content: [] };
			},
		};
		await session.refreshRpcHostTools([rpcTool]);

		// The persona grants only read: a deferred host set_host_tools must not
		// auto-activate a write-like tool past the policy (codex 3741758358),
		// mirroring the MCP refresh gate.
		expect(session.getAllToolNames()).toContain(rpcTool.name);
		expect(session.getEnabledToolNames()).not.toContain(rpcTool.name);
	});
});
