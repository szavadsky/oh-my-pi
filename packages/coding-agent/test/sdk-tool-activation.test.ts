import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { type StreamFn, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type CreateAgentSessionOptions,
	type CustomTool,
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessageEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { fingerprintAgentContent } from "@oh-my-pi/pi-coding-agent/task/agent-policy";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/** All persisted session entries for a session created with SessionManager.inMemory(). */
function sessionManagerEntries(session: AgentSession): SessionEntry[] {
	return session.sessionManager.getEntries();
}

function isCustomMessageEntry(entry: SessionEntry): entry is CustomMessageEntry {
	return entry.type === "custom_message";
}

const toolActivationExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "default_inactive_tool",
		label: "Default Inactive Tool",
		description: "Tool hidden from the initial active set unless explicitly requested.",
		parameters: type({}),
		defaultInactive: true,
		async execute() {
			return { content: [{ type: "text", text: "inactive" }] };
		},
	});
	pi.registerTool({
		name: "default_active_tool",
		label: "Default Active Tool",
		description: "Tool included in the initial active set.",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "active" }] };
		},
	});
};

const sdkCustomTool = {
	name: "sdk_custom_tool",
	label: "SDK Custom Tool",
	description: "SDK-provided custom tool used to verify activation boundaries.",
	parameters: type({}),
	async execute() {
		return { content: [{ type: "text", text: "sdk custom" }] };
	},
} satisfies CustomTool;

describe("createAgentSession defaultInactive tool activation", () => {
	const tempDirs: string[] = [];

	// Built once and shared by every session. `ModelRegistry` eagerly loads all
	// bundled + cached models and `discoverAuthStorage` opens the auth DB — the
	// dominant (~50ms) slice of a cold boot, and identical for every test here.
	// Injecting it drops each per-test boot to the ~4ms of activation-specific work
	// these tests vary, and skips the background model refresh the SDK would
	// otherwise start when it builds its own registry.
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
		// The switch-reconcile tests below drive InteractiveMode (for plan/goal
		// transient-state teardown), which renders status via the global theme.
		await initTheme();
	});

	// Shared options for every session. `rules: []` and `workspaceTree` short-circuit
	// the two slow startup scans (rule discovery + native workspace walk, ~100ms each)
	// that are irrelevant to tool activation: these tests assert only which tools are
	// registered/active and that tool names appear in the system prompt. The shared
	// `modelRegistry` is injected here; each call still returns fresh
	// `settings`/`sessionManager` instances to keep tests isolated.
	const baseOptions = (tempDir: string): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}

		VibeSessionRegistry.resetGlobalForTests();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	it("excludes defaultInactive extension tools from the initial active set unless explicitly requested", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
		});

		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["default_active_tool", "default_inactive_tool"]),
			);
			// Discoverable extension tools mount as xd:// devices, not top-level active tools.
			const deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			expect(deviceNames).toContain("default_active_tool");
			expect(session.getActiveToolNames()).not.toContain("default_active_tool");
			expect(deviceNames).not.toContain("default_inactive_tool");
			expect(session.getActiveToolNames()).not.toContain("default_inactive_tool");
			expect(session.systemPrompt.join("\n")).toContain("default_active_tool");
			expect(session.systemPrompt.join("\n")).not.toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("forwards built-in and external xd:// devices to Cursor provider contexts", async () => {
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			model: cursorModel,
		});
		const externalMcpTool: CustomTool = {
			name: "mcp__fixture_report",
			label: "fixture/report",
			description: "Report a fixture result.",
			parameters: type({}),
			strict: true,
			mcpServerName: "fixture",
			mcpToolName: "report",
			async execute() {
				return { content: [{ type: "text", text: "reported" }] };
			},
		};

		try {
			await session.refreshMCPTools([externalMcpTool]);
			const deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			expect(deviceNames).toEqual(expect.arrayContaining(["ast_edit", "mcp__fixture_report"]));
			expect(session.getActiveToolNames()).not.toContain("mcp__fixture_report");

			const context = await session.agent.buildSideRequestContext([]);
			const providerToolNames = context.tools?.map(tool => tool.name);
			expect(providerToolNames).toEqual(expect.arrayContaining(["ast_edit", "mcp__fixture_report"]));
		} finally {
			await session.dispose();
		}
	});

	it("allows explicitly requested defaultInactive extension tools into the initial active set", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
			toolNames: ["read", "default_inactive_tool"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "default_inactive_tool", "default_active_tool"]),
			);
			// No granted write tool → no xd:// transport: extension tools surface
			// top-level instead of mounting with an auto-granted write.
			expect(session.getActiveToolNames()).not.toContain("write");
			expect(session.getXdevToolEntries()).toEqual([]);
			expect(session.systemPrompt.join("\n")).toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("activates the yield tool when requireYieldTool is set and toolNames is explicit", async () => {
		// Regression for #1408: plan-mode subagents pass an explicit `toolNames` list
		// (e.g. `["read", "grep", "glob", "lsp", "web_search"]`). Without this
		// invariant, `yield` ended up registered but not active, and the model
		// could not satisfy the idle-reminder contract that demands a `yield` call.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			requireYieldTool: true,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getActiveToolNames()).toContain("yield");
		} finally {
			await session.dispose();
		}
	});

	it("normalizes legacy builtin toolNames before selecting the active SDK tools", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "search", "find"],
		});

		try {
			const activeToolNames = session.getActiveToolNames();

			expect(activeToolNames).toContain("read");
			expect(activeToolNames).toContain("grep");
			expect(activeToolNames).toContain("glob");
			expect(activeToolNames).not.toContain("search");
			expect(activeToolNames).not.toContain("find");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the write tool registered for plan mode even when no deferrable tool is requested", async () => {
		// Regression for #1428 (adapted to the xd://propose device): plan mode
		// submits its finalized plan by writing the chosen slug/title to
		// xd://propose, dispatched through the plan-proposal handler
		// (interactive-mode.ts: `setPlanProposalHandler`). With an explicit
		// read-only `toolNames` (e.g. `read`, `search`, `find`, `web_search`)
		// the registry has no `write` and no `deferrable` tool; dropping it would
		// silently activate plan mode with no way to submit the plan.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("write")).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("does not force write into the registry when neither a deferrable tool nor plan mode needs it", async () => {
		const tempDir = makeTempDir();

		const settings = Settings.isolated();
		settings.set("plan.enabled", false);

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("write")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("does not activate write merely because plan mode is available", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read"],
		});

		try {
			await session.setActiveToolsByName(["read"]);
			expect(session.getActiveToolNames()).not.toContain("write");
		} finally {
			await session.dispose();
		}
	});

	it("preserves write explicitly selected by a runtime caller", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read"],
		});

		try {
			await session.setActiveToolsByName(["read", "write"]);
			await session.refreshMCPTools([]);
			expect(session.getActiveToolNames()).toContain("write");
		} finally {
			await session.dispose();
		}
	});
	it("registers vibe tools only during explicit vibe activation and exposes parent Todo bookkeeping", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));
		const previousActiveToolNames = session.getActiveToolNames();

		try {
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeUndefined();
			}

			await session.activateVibeTools(["read", "todo"]);
			const todo = session.getToolByName("todo");
			if (!todo) throw new Error("Expected real Todo tool");
			expect(session.getActiveToolNames()).toContain("todo");
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeDefined();
				expect(session.getActiveToolNames()).toContain(name);
			}

			await todo.execute("vibe-todo-init", {
				op: "init",
				list: [{ phase: "Work", items: ["Worker change"] }],
			});
			await todo.execute("vibe-todo-done", { op: "done", task: "Worker change" });
			expect(session.getTodoPhases()).toMatchObject([
				{
					name: "Work",
					tasks: [{ content: "Worker change", status: "completed" }],
				},
			]);

			await session.deactivateVibeTools(previousActiveToolNames);
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeUndefined();
			}
			expect(session.getActiveToolNames()).toEqual(previousActiveToolNames);
		} finally {
			await session.dispose();
		}
	});

	it("rehydrates completed parent Todo work from persisted session history", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager,
		});

		try {
			await session.activateVibeTools(["read", "todo"]);
			const todo = session.getToolByName("todo");
			if (!todo) throw new Error("Expected real Todo tool");
			const init = await todo.execute("vibe-todo-init", {
				op: "init",
				list: [{ phase: "Worker flow", items: ["Reconcile worker result"] }],
			});
			const done = await todo.execute("vibe-todo-done", { op: "done", task: "Reconcile worker result" });
			for (const [toolCallId, result] of [
				["vibe-todo-init", init],
				["vibe-todo-done", done],
			] as const) {
				sessionManager.appendMessage({
					role: "toolResult",
					toolCallId,
					toolName: "todo",
					content: result.content,
					details: result.details,
					isError: result.isError === true,
					timestamp: Date.now(),
				});
			}
			await sessionManager.ensureOnDisk();
			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("Expected persisted session file");

			session.setTodoPhases([]);
			expect(session.getTodoPhases()).toEqual([]);
			expect(await session.switchSession(sessionFile)).toBe(true);
			expect(session.getTodoPhases()).toMatchObject([
				{
					name: "Worker flow",
					tasks: [{ content: "Reconcile worker result", status: "completed" }],
				},
			]);
		} finally {
			await session.dispose();
		}
	});

	it("does not register the xAI TTS tool unless enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
		});

		try {
			expect(session.getToolByName("tts")).toBeUndefined();
			expect(session.getAllToolNames()).not.toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("registers the xAI TTS tool when enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "speechgen.enabled": true }),
		});

		try {
			expect(session.getToolByName("tts")).toBeDefined();
			// tts is a discoverable custom tool → mounted as an xd:// device, not top-level.
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the stable MCP tool-name collision winner during SDK startup and warns", async () => {
		const tempDir = makeTempDir();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const createMcpTool = (serverName: string, label: string): CustomTool => ({
			name: "mcp__foo_bar_lookup",
			label,
			description: `Lookup from ${serverName}`,
			parameters: type({}),
			mcpServerName: serverName,
			mcpToolName: "lookup",
			async execute() {
				return { content: [{ type: "text", text: serverName }] };
			},
		});

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			customTools: [createMcpTool("foo.bar", "foo.bar/lookup"), createMcpTool("foo_bar", "foo_bar/lookup")],
		});

		try {
			expect(session.getToolByName("mcp__foo_bar_lookup")?.label).toBe("foo.bar/lookup");
			expect(warn).toHaveBeenCalledWith("MCP tool name collision; keeping stable winner", {
				name: "mcp__foo_bar_lookup",
				keptServer: "foo.bar",
				keptTool: "lookup",
				ignoredServer: "foo_bar",
				ignoredTool: "lookup",
			});
		} finally {
			await session.dispose();
		}
	});

	it("keeps restricted host tool lists isolated from configured custom capabilities", async () => {
		const restrictedDir = makeTempDir();
		const normalDir = makeTempDir();
		const configuredSettings = () =>
			Settings.isolated({
				"providers.imageOrder": ["openai"],
				"generate_image.enabled": true,
				"speechgen.enabled": true,
				"memory.backend": "hindsight",
				"autolearn.enabled": true,
			});

		const inheritedManager = {
			getServerInstructions: () => new Map([["private-server", "must not reach restricted child"]]),
		} as unknown as MCPManager;

		const { session: restricted } = await createAgentSession({
			...baseOptions(restrictedDir),
			settings: configuredSettings(),
			extensions: [toolActivationExtension],
			customTools: [sdkCustomTool],
			toolNames: ["read", "lsp", "hub"],
			requireYieldTool: true,
			restrictToolNames: true,
			enableMCP: true,
			mcpManager: inheritedManager,
			enableLsp: true,
			enableIrc: true,
		});

		try {
			expect(restricted.getAllToolNames()).toEqual(["read", "lsp", "yield"]);
			expect(restricted.getActiveToolNames()).toEqual(["read", "lsp", "yield"]);
			for (const name of [
				"generate_image",
				"tts",
				"recall",
				"retain",
				"reflect",
				"learn",
				"manage_skill",
				"default_active_tool",
				"default_inactive_tool",
				"sdk_custom_tool",
				"hub",
			]) {
				expect(restricted.getToolByName(name)).toBeUndefined();
			}
			expect(restricted.getXdevToolEntries()).toEqual([]);
			expect(restricted.systemPrompt.join("\n")).not.toContain("private-server");
			expect(restricted.systemPrompt.join("\n")).not.toContain("MCP Server Instructions");
		} finally {
			await restricted.dispose();
		}

		const { session: normal } = await createAgentSession({
			...baseOptions(normalDir),
			settings: configuredSettings(),
			extensions: [toolActivationExtension],
			customTools: [sdkCustomTool],
			toolNames: ["read", "generate_image"],
			requireYieldTool: true,
			restrictToolNames: false,
		});

		try {
			const activeToolNames = normal.getActiveToolNames();
			expect(activeToolNames).toEqual(
				expect.arrayContaining([
					"read",
					"yield",
					"generate_image",
					"learn",
					"manage_skill",
					"tts",
					"default_active_tool",
					"sdk_custom_tool",
				]),
			);
			// Without a granted write tool the session allocates no xd:// state;
			// SDK custom and extension capabilities surface top-level instead.
			expect(activeToolNames).not.toContain("write");
			expect(normal.getXdevToolEntries()).toEqual([]);
			expect(normal.getAllToolNames()).toEqual(
				expect.arrayContaining([
					"generate_image",
					"read",
					"yield",
					"tts",
					"default_active_tool",
					"sdk_custom_tool",
					"recall",
					"retain",
					"reflect",
				]),
			);
		} finally {
			await normal.dispose();
		}
	});

	it("permits only explicitly named SDK custom tools when a restricted caller opts in", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			customTools: [sdkCustomTool],
			toolNames: ["read", "sdk_custom_tool"],
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
		});

		try {
			expect(session.getAllToolNames()).toEqual(["read", "sdk_custom_tool"]);
			expect(session.getActiveToolNames()).toEqual(["read", "sdk_custom_tool"]);
			expect(session.getToolByName("sdk_custom_tool")).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("renders report-issue guidance only for unrestricted sessions", async () => {
		const normalDir = makeTempDir();
		const restrictedDir = makeTempDir();
		const { session: normal } = await createAgentSession({
			...baseOptions(normalDir),
			settings: Settings.isolated({ "dev.autoqa": true }),
		});
		const { session: restricted } = await createAgentSession({
			...baseOptions(restrictedDir),
			settings: Settings.isolated({ "dev.autoqa": true }),
			toolNames: ["read"],
			restrictToolNames: true,
		});

		try {
			expect(normal.systemPrompt.join("\n")).toContain("xd://report_issue");
			expect(restricted.systemPrompt.join("\n")).not.toContain("xd://report_issue");
		} finally {
			await Promise.all([normal.dispose(), restricted.dispose()]);
		}
	});

	it("ignores an inherited MCP manager when MCP is disabled", async () => {
		const tempDir = makeTempDir();
		const inheritedManager = {
			getServerInstructions: () => new Map([["private-server", "must not reach restricted child"]]),
		} as unknown as MCPManager;

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			enableMCP: false,
			mcpManager: inheritedManager,
		});

		try {
			expect(session.systemPrompt.join("\n")).not.toContain("private-server");
			expect(session.systemPrompt.join("\n")).not.toContain("MCP Server Instructions");
		} finally {
			await session.dispose();
		}
	});

	it("drives scout availability from the persona spawn policy", async () => {
		const tempDir = makeTempDir();
		// A persona whose spawns excludes scout must not advertise the scout
		// agent in the base system prompt: the prompt is initialized from the
		// resolved persona spawns, not the raw options.spawns default.
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			agentPersona: {
				name: "no-scout",
				description: "Persona with restricted spawns",
				systemPrompt: "",
				spawns: ["reviewer"],
				source: "project" as const,
			},
		});

		try {
			const prompt = session.systemPrompt.join("\n");
			// scoutAvailable=false drops the "single read-only scout" clause.
			expect(prompt).not.toContain("a single read-only scout while you keep working is fine");
		} finally {
			await session.dispose();
		}
	});

	it("recomputes plan-mode scout availability after a live persona switch", async () => {
		const tempDir = makeTempDir();
		// Session manager cwd must match the discovery-snapshot key the SDK
		// publishes for `options.cwd`; the default in-memory manager uses
		// getProjectDir() and would miss the snapshot.
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager: SessionManager.inMemory(tempDir),
		});
		const restrictedPersona = {
			name: "restricted-spawns",
			description: "Persona whose spawns exclude scout",
			systemPrompt: "",
			spawns: ["reviewer"],
			source: "project" as const,
		};
		const unrestrictedPersona = {
			name: "unrestricted-spawns",
			description: "Persona with unrestricted spawns",
			systemPrompt: "",
			source: "project" as const,
		};

		try {
			// Restricted persona: plan-mode context must not advertise scout.
			await session.switchAgentPersona(restrictedPersona);
			session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			await session.sendPlanModeContext();
			const restrictedMessage = sessionManagerEntries(session)
				.filter(isCustomMessageEntry)
				.find(entry => entry.customType === "plan-mode-context");
			const restrictedContent = String(restrictedMessage?.content ?? "");
			expect(restrictedContent).not.toContain("Launch parallel `scout` subagents");
			session.setPlanModeState(undefined);

			// Unrestricted persona: the same plan-mode message advertises scout again.
			await session.switchAgentPersona(unrestrictedPersona);
			session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			await session.sendPlanModeContext();
			const unrestrictedMessage = sessionManagerEntries(session)
				.filter(isCustomMessageEntry)
				.filter(entry => entry.customType === "plan-mode-context")
				.at(-1);
			const unrestrictedContent = String(unrestrictedMessage?.content ?? "");
			expect(unrestrictedContent).toContain("Launch parallel `scout` subagents");
		} finally {
			session.setPlanModeState(undefined);
			await session.dispose();
		}
	});

	it("re-discovers agents for the prompt cwd after a session switch", async () => {
		// When a live session switches to a transcript in another project, the
		// session adopts that cwd and switchSession rebuilds the base prompt
		// with it. The scout-availability check used the construction-time
		// discovery list on a snapshot miss, so a target project that shadows
		// `scout` as `mode: primary` still advertised scout spawning (or hid
		// it when the source did). The rebuild must re-discover for the live
		// prompt cwd instead (codex 3742717642).
		const tempDir = makeTempDir();
		const targetCwd = path.join(tempDir, "target-project");
		fs.mkdirSync(path.join(targetCwd, ".omp", "agents"), { recursive: true });
		// A project-level scout that shadows the bundled one as primary-only:
		// spawn attempts reject it, so the base prompt must not advertise it.
		await Bun.write(
			path.join(targetCwd, ".omp", "agents", "scout.md"),
			"---\nname: scout\ndescription: Project-scoped scout that is not spawnable\nmode: primary\n---\n",
		);
		const targetFile = path.join(targetCwd, "target.jsonl");
		// No recorded persona: the switch clears persona state to the launch
		// baseline, and the base prompt rebuild runs with the target cwd.
		await writeSwitchTarget(targetFile);

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "active")),
		});

		try {
			expect(await session.switchSession(targetFile)).toBe(true);
			// The target project's primary-only scout must not be advertised.
			expect(session.systemPrompt.join("\n")).not.toContain(
				"a single read-only scout while you keep working is fine",
			);
		} finally {
			await session.dispose();
		}
	});

	it("rejects a subagent-only persona passed as agentPersona", async () => {
		const tempDir = makeTempDir();

		await expect(
			createAgentSession({
				...baseOptions(tempDir),
				agentPersona: {
					name: "sub-only",
					description: "Subagent only",
					systemPrompt: "",
					availability: "subagent" as const,
					source: "project" as const,
				},
			}),
		).rejects.toThrow('Agent "sub-only" is subagent-only and cannot be selected as main persona.');
	});

	it("switchAgentPersona rejects a subagent-only persona without mutating session state", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));

		try {
			const personaBefore = session.agentPersona;
			const toolsBefore = session.getEnabledToolNames();
			const modelBefore = session.model;

			await expect(
				session.switchAgentPersona({
					name: "sub-only",
					description: "Subagent only",
					systemPrompt: "",
					availability: "subagent" as const,
					source: "project" as const,
				}),
			).rejects.toThrow('Agent "sub-only" is subagent-only and cannot be selected as main persona.');

			expect(session.agentPersona).toBe(personaBefore);
			expect(session.getEnabledToolNames()).toEqual(toolsBefore);
			expect(session.model).toBe(modelBefore);
		} finally {
			await session.dispose();
		}
	});

	it("switchAgentPersona rejects a disabled persona without mutating session state", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "task.disabledAgents": ["disabled-target"] }),
		});

		try {
			const personaBefore = session.agentPersona;
			const toolsBefore = session.getEnabledToolNames();
			const modelBefore = session.model;

			await expect(
				session.switchAgentPersona({
					name: "disabled-target",
					description: "Target persona disabled in settings",
					systemPrompt: "",
					source: "project" as const,
				}),
			).rejects.toThrow('Agent "disabled-target" is disabled in settings (task.disabledAgents).');

			expect(session.agentPersona).toBe(personaBefore);
			expect(session.getEnabledToolNames()).toEqual(toolsBefore);
			expect(session.model).toBe(modelBefore);
		} finally {
			await session.dispose();
		}
	});

	it("rejects a disabled persona supplied directly at session construction", async () => {
		// CLI startup and live /agent both enforce task.disabledAgents, but a
		// directly-supplied options.agentPersona (SDK embedder, the ACP
		// factory's per-cwd re-resolve) bypassed both and started the session
		// with the disabled persona (codex 3742974505).
		const tempDir = makeTempDir();
		await expect(
			createAgentSession({
				...baseOptions(tempDir),
				settings: Settings.isolated({ "task.disabledAgents": ["disabled-at-construction"] }),
				agentPersona: {
					name: "disabled-at-construction",
					description: "Persona disabled in settings",
					systemPrompt: "",
					source: "project" as const,
				},
			}),
		).rejects.toThrow('Agent "disabled-at-construction" is disabled in settings (task.disabledAgents).');
	});

	it("rejects a persona switch while the session is streaming", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));
		try {
			(session.agent.state as { isStreaming: boolean }).isStreaming = true;
			await expect(
				session.switchAgentPersona({
					name: "streaming-target",
					description: "Target persona",
					systemPrompt: "",
					source: "project" as const,
				}),
			).rejects.toThrow("Cannot switch agent while streaming.");
		} finally {
			await session.dispose();
		}
	});

	it("rejects a persona switch during plan, goal, and vibe mode without mutating session state", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));
		try {
			const personaBefore = session.agentPersona;
			const toolsBefore = session.getEnabledToolNames();
			const persona = {
				name: "mode-target",
				description: "Target persona",
				systemPrompt: "",
				source: "project" as const,
			};
			const cases: Array<[() => void, RegExp]> = [
				[
					() => session.setPlanModeState({ enabled: true, planFilePath: "/tmp/plan.md" }),
					/Cannot switch agent during plan mode\./,
				],
				[
					() =>
						session.setGoalModeState({
							enabled: true,
							mode: "active",
							goal: {
								id: "g",
								objective: "test",
								status: "active",
								tokensUsed: 0,
								timeUsedSeconds: 0,
								createdAt: 0,
								updatedAt: 0,
							},
						}),
					/Cannot switch agent during goal mode\./,
				],
				[() => session.setVibeModeState({ enabled: true }), /Cannot switch agent during vibe mode\./],
			];
			for (const [enable, message] of cases) {
				enable();
				await expect(session.switchAgentPersona(persona)).rejects.toThrow(message);
				// The rejected switch must not have mutated persona/tools.
				expect(session.agentPersona).toBe(personaBefore);
				expect(session.getEnabledToolNames()).toEqual(toolsBefore);
				session.setPlanModeState(undefined);
				session.setGoalModeState(undefined);
				session.setVibeModeState(undefined);
			}
		} finally {
			await session.dispose();
		}
	});

	it("rejects a persona switch when the persona model does not resolve", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({ ...baseOptions(tempDir), sessionManager });
		try {
			const personaBefore = session.agentPersona;
			const toolsBefore = session.getEnabledToolNames();
			const modelBefore = session.model;

			await expect(
				session.switchAgentPersona({
					name: "unresolved-model-target",
					description: "Target persona",
					systemPrompt: "",
					model: ["zzz-no-such-provider/zzz-no-such-model"],
					source: "project" as const,
				}),
			).rejects.toThrow(/declares model "zzz-no-such-provider\/zzz-no-such-model" which does not resolve/);

			// The failed switch must not have mutated persona, tools, or model,
			// and must not have recorded an agent_change.
			expect(session.agentPersona).toBe(personaBefore);
			expect(session.getEnabledToolNames()).toEqual(toolsBefore);
			expect(session.model).toBe(modelBefore);
			expect(sessionManager.buildSessionContext().agentPersona).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("keeps explicit CLI tool/model/thinking selections across a persona switch", async () => {
		const tempDir = makeTempDir();
		// A reasoning-capable model so the thinking-level assertion is meaningful:
		// on gpt-4o-mini (no reasoning) every selector clamps to undefined and the
		// lock would pass vacuously.
		const reasoningModel = getBundledModel("openai", "gpt-5");
		if (!reasoningModel) throw new Error("expected bundled OpenAI gpt-5 model");
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			model: reasoningModel,
			toolNames: ["read", "write"],
			thinkingLevel: ThinkingLevel.Low,
			cliToolsLocked: true,
			cliModelLocked: true,
			cliThinkingLocked: true,
			// Startup persona with a tool set that differs from the explicit CLI selection.
			agentPersona: {
				name: "locked-start",
				description: "Startup persona with differing tools",
				systemPrompt: "",
				tools: ["glob"],
				source: "project" as const,
			},
		});

		try {
			const modelBefore = session.model;
			const thinkingBefore = session.configuredThinkingLevel();

			// Target persona whose tools/model/thinking would all override the
			// explicit CLI selections — none of them may apply while locked.
			await session.switchAgentPersona({
				name: "locked-target",
				description: "Target persona",
				systemPrompt: "",
				tools: ["read"],
				model: ["openai/gpt-4o"],
				thinkingLevel: ThinkingLevel.High,
				source: "project" as const,
			});

			const enabled = session.getEnabledToolNames();
			expect(enabled).toEqual(expect.arrayContaining(["read", "write"]));
			// The target persona's restricted policy (auto-widened to include task/hub)
			// must not replace the locked explicit set.
			expect(enabled).not.toContain("task");
			expect(enabled).not.toContain("hub");
			expect(session.model).toBe(modelBefore);
			expect(session.configuredThinkingLevel()).toBe(thinkingBefore);
		} finally {
			await session.dispose();
		}
	});

	it("preserves a locked CLI thinking level when a persona switch changes the model", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			model: getBundledModel("openai", "gpt-5"),
			thinkingLevel: ThinkingLevel.Low,
			// --thinking only: the model is NOT locked, so a persona with model:
			// reaches the switch's model step, whose inline model suffix would
			// otherwise setThinkingLevel(high) over the locked CLI level.
			cliThinkingLocked: true,
		});

		try {
			const thinkingBefore = session.configuredThinkingLevel();
			expect(thinkingBefore).toBe(ThinkingLevel.Low);

			await withProviderAuth(["openai"], async () => {
				await session.switchAgentPersona({
					name: "thinking-lock-target",
					description: "Target persona whose inline model suffix demands high thinking",
					systemPrompt: "",
					model: ["openai/gpt-5:high"],
					source: "project" as const,
				});
			});

			// The persona's model may apply, but the locked CLI thinking must survive.
			expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		} finally {
			await session.dispose();
		}
	});

	it("rehydrates the recorded persona when switching sessions", async () => {
		const tempDir = makeTempDir();
		const targetFile = path.join(tempDir, "target-persona.jsonl");
		const timestamp = "2026-08-08T00:00:00.000Z";
		// A transcript whose agent_change records the bundled `reviewer` persona.
		await Bun.write(
			targetFile,
			`${[
				{ type: "session", version: 3, id: "target-persona", timestamp, cwd: tempDir },
				{
					type: "agent_change",
					id: "persona-change",
					parentId: null,
					timestamp,
					agent: "reviewer",
					source: "bundled",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		// Persisting manager so switchSession can read the target file.
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "active")),
		});
		try {
			await expect(session.switchSession(targetFile)).resolves.toBe(true);
			// The target transcript's recorded persona must become live: /resume
			// and tree switches previously kept the previous session's persona
			// (or none) until a full restart (codex review 3741561701).
			expect(session.agentPersona?.name).toBe("reviewer");
			expect(session.agentPersona?.source).toBe("bundled");
			// The reviewer persona's tool policy is applied, not the previous set.
			expect(session.getEnabledToolNames()).toEqual(expect.arrayContaining(["read", "grep"]));
		} finally {
			await session.dispose();
		}
	});

	it("clears the previous persona when the target session records none", async () => {
		const tempDir = makeTempDir();
		const targetFile = path.join(tempDir, "target-plain.jsonl");
		const timestamp = "2026-08-08T00:00:00.000Z";
		// Target transcript with NO agent_change at all.
		await Bun.write(
			targetFile,
			`${[
				{ type: "session", version: 3, id: "target-plain", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp,
					model: "openai/gpt-4o-mini",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		// Control session with no persona: its enabled set IS the registry
		// default the cleared session must return to.
		const { session: control } = await createAgentSession(baseOptions(tempDir));
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "active")),
			spawns: "*",
			agentPersona: {
				name: "pre-switch-persona",
				description: "Persona active before the switch",
				systemPrompt: "",
				tools: ["read"],
				spawns: ["scout"],
				source: "project" as const,
			},
		});
		try {
			expect(session.agentPersona?.name).toBe("pre-switch-persona");
			// The persona's restricted tool policy is active pre-switch.
			expect(session.getEnabledToolNames()).not.toContain("write");

			await expect(session.switchSession(targetFile)).resolves.toBe(true);

			// The target has no recorded persona: the previous persona's prompt,
			// tool overlay, and spawn policy must be cleared back to the launch
			// baseline, not carried over (codex review 3741664565).
			expect(session.agentPersona).toBeUndefined();
			expect([...session.getEnabledToolNames()].sort()).toEqual([...control.getEnabledToolNames()].sort());
		} finally {
			await session.dispose();
			await control.dispose();
		}
	});

	it("does not restore a disabled persona during a session switch", async () => {
		const tempDir = makeTempDir();
		const targetFile = path.join(tempDir, "target-disabled.jsonl");
		const timestamp = "2026-08-08T00:00:00.000Z";
		// Target transcript recording the bundled reviewer persona, which the
		// session now disables.
		await Bun.write(
			targetFile,
			`${[
				{ type: "session", version: 3, id: "target-disabled", timestamp, cwd: tempDir },
				{
					type: "agent_change",
					id: "persona-change",
					parentId: null,
					timestamp,
					agent: "reviewer",
					source: "bundled",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "active")),
			settings: Settings.isolated({ "task.disabledAgents": ["reviewer"] }),
		});
		try {
			await expect(session.switchSession(targetFile)).resolves.toBe(true);

			// Startup resume and live /agent both reject disabled personas; the
			// in-process switch must not restore one (codex review 3741664569).
			expect(session.agentPersona).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("restores the registry-default tool set after a persona switch leaves the agent tool policy", async () => {
		const tempDir = makeTempDir();
		// Control session with no persona: its enabled set IS the registry default
		// that the persona-restored session must return to.
		const { session: control } = await createAgentSession(baseOptions(tempDir));
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNamesFromAgent: true,
			// Startup persona with an explicit tool list: the pre-persona baseline
			// must be the registry default, not this persona's restricted list.
			agentPersona: {
				name: "restricted-start",
				description: "Startup persona with explicit tools",
				systemPrompt: "",
				tools: ["read"],
				source: "project" as const,
			},
		});

		try {
			const controlDefault = control.getEnabledToolNames();
			// The registry default is a meaningful superset of the persona's
			// restricted policy (read + auto-added task/hub).
			expect(controlDefault).toEqual(expect.arrayContaining(["read", "write", "grep"]));

			await session.switchAgentPersona({
				name: "unrestricted-target",
				description: "Target persona without tools",
				systemPrompt: "",
				source: "project" as const,
			});

			// Switching away from a persona with tools must restore the pre-persona
			// baseline — the registry default, not the persona's restricted list.
			// Compared as sets: presentation order may differ between the control
			// session's startup partition and the restored session's re-apply.
			expect([...session.getEnabledToolNames()].sort()).toEqual([...controlDefault].sort());
		} finally {
			await session.dispose();
			await control.dispose();
		}
	});

	it("carries the applied model into the new transcript on /new with an active persona", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager,
			agentPersona: {
				name: "carried-persona",
				description: "Persona carried across /new",
				systemPrompt: "",
				source: "project" as const,
			},
		});

		try {
			await session.newSession();

			const entries = sessionManager.getEntries();
			const agentChanges = entries.filter(entry => entry.type === "agent_change");
			const modelChanges = entries.filter(entry => entry.type === "model_change");

			// The persona must be carried into the new transcript…
			expect(agentChanges.at(-1)).toEqual(expect.objectContaining({ agent: "carried-persona", source: "project" }));
			// …and so must the applied model: resume treats a recorded persona
			// as rehydrated and does not reapply its frontmatter, so the JSONL
			// needs the actual model_change or the next resume falls back to
			// the remembered/default model (codex review 3741326128).
			expect(modelChanges.at(-1)).toEqual(expect.objectContaining({ model: "openai/gpt-4o-mini" }));
			expect(sessionManager.buildSessionContext().models.default).toBe("openai/gpt-4o-mini");
		} finally {
			await session.dispose();
		}
	});

	it("fingerprints agent_change entries written by live persona switches", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager,
		});

		try {
			await session.switchAgentPersona({
				name: "fingerprinted-persona",
				description: "Persona switched in live",
				systemPrompt: "You are fingerprinted.",
				source: "project" as const,
			});

			// The persisted agent_change must carry the definition content
			// fingerprint so a later fork/resume can detect same-identity
			// content changes and invalidate the provider prompt cache
			// (thread sdk.ts:6435).
			const persona = sessionManager.buildSessionContext().agentPersona;
			expect(persona).toEqual(
				expect.objectContaining({
					agent: "fingerprinted-persona",
					source: "project",
					fingerprint: expect.any(String),
				}),
			);
			expect(persona?.fingerprint).toBe(
				fingerprintAgentContent({
					name: "fingerprinted-persona",
					description: "Persona switched in live",
					systemPrompt: "You are fingerprinted.",
					source: "project" as const,
				}),
			);
		} finally {
			await session.dispose();
		}
	});

	it("persists an explicit startup persona onto a resumed transcript", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.inMemory();
		// Seed a prior transcript so the session is a resume, not a fresh one.
		sessionManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });
		expect(sessionManager.buildSessionContext().agentPersona).toBeUndefined();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager,
			agentPersona: {
				name: "resumed-persona",
				description: "Startup persona on a resumed transcript",
				systemPrompt: "",
				source: "project" as const,
			},
		});

		try {
			// The explicit startup persona must be recorded on the resumed
			// transcript so the next resume rehydrates it (thread: persist
			// explicit persona changes on resume).
			expect(sessionManager.buildSessionContext().agentPersona).toEqual(
				expect.objectContaining({ agent: "resumed-persona", source: "project" }),
			);
		} finally {
			await session.dispose();
		}
	});

	it("re-appends the explicit persona when the resumed name resolves to a different source", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.inMemory();
		// Transcript records user/foo; the explicit --agent foo now resolves to a
		// newly added project/foo. Only the name matches, so the append must still
		// fire or the next resume would silently rehydrate the old user/foo.
		sessionManager.appendAgentChange("foo", "user");
		sessionManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager,
			agentPersona: {
				name: "foo",
				description: "Newly added project persona",
				systemPrompt: "",
				source: "project" as const,
			},
		});

		try {
			expect(sessionManager.buildSessionContext().agentPersona).toEqual(
				// fingerprint is present on entries the SDK wrote; assert the
				// stable identity fields.
				expect.objectContaining({ agent: "foo", source: "project" }),
			);
		} finally {
			await session.dispose();
		}
	});

	it("re-appends the persona when same identity content changed since save", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.inMemory();
		// Transcript records project/foo with the OLD definition fingerprint; the
		// persona file's model:/thinkingLevel: was edited since, so the explicit
		// --agent foo resolves to the same name+source but different content.
		// Without a re-append the next resume would rehydrate the stale
		// transcript values even though this run applied the new defaults.
		sessionManager.appendAgentChange(
			"foo",
			"project",
			fingerprintAgentContent({ name: "foo", description: "old", systemPrompt: "old body", source: "project" }),
		);
		sessionManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });

		await withProviderAuth(["openai"], async () => {
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				model: undefined,
				agentPersona: {
					name: "foo",
					description: "Edited persona",
					systemPrompt: "new body",
					model: ["openai/gpt-4o"],
					source: "project" as const,
				},
			});

			try {
				expect(sessionManager.buildSessionContext().agentPersona).toEqual(
					expect.objectContaining({ agent: "foo", source: "project" }),
				);
				// The changed fingerprint must have appended a second entry so the
				// latest agent_change carries the new content.
				expect(sessionManager.getEntries().filter(e => e.type === "agent_change")).toHaveLength(2);
				// The edited persona's model: is a fresh selection (content
				// changed since the transcript), so it must be applied — not
				// skipped by the identity-only rehydrated gate (codex 3741691583).
				expect(session.model?.id).toBe("gpt-4o");
			} finally {
				await session.dispose();
			}
		});
	});

	it("re-appends the persona when the stored legacy entry has no fingerprint", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.inMemory();
		// Legacy transcript: the agent_change was written without a content
		// fingerprint. An explicit --agent resume of the same identity applies
		// the current definition; without a re-append the next resume would
		// rehydrate the stale transcript values (thread sdk.ts:3423).
		sessionManager.appendAgentChange("foo", "project");
		sessionManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });

		const persona = {
			name: "foo",
			description: "Edited persona",
			systemPrompt: "new body",
			source: "project" as const,
		};

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager,
			agentPersona: persona,
		});

		try {
			expect(sessionManager.buildSessionContext().agentPersona).toEqual(
				expect.objectContaining({
					agent: "foo",
					source: "project",
					fingerprint: fingerprintAgentContent(persona),
				}),
			);
			// The legacy entry migrated: a second agent_change now carries the
			// current definition's fingerprint.
			expect(sessionManager.getEntries().filter(e => e.type === "agent_change")).toHaveLength(2);
		} finally {
			await session.dispose();
		}
	});

	it("skips the append when the resumed persona matches name and source", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.inMemory();
		// Plain resume rehydrates the persisted persona; a matching append would
		// only duplicate the entry.
		const persona = {
			name: "foo",
			description: "Persisted persona",
			systemPrompt: "",
			source: "project" as const,
		};
		sessionManager.appendAgentChange("foo", "project", fingerprintAgentContent(persona));
		sessionManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager,
			agentPersona: persona,
		});

		try {
			expect(sessionManager.buildSessionContext().agentPersona).toEqual(
				expect.objectContaining({
					agent: "foo",
					source: "project",
					fingerprint: fingerprintAgentContent(persona),
				}),
			);
			// Exactly one agent_change entry: the guard did not append a duplicate.
			expect(sessionManager.getEntries().filter(e => e.type === "agent_change")).toHaveLength(1);
		} finally {
			await session.dispose();
		}
	});

	it("persists an explicit persona's model when identity matches but the transcript model postdates it", async () => {
		// The explicit --agent persona is a fresh selection: its frontmatter
		// model/thinking apply for this run even when the recorded identity
		// AND fingerprint match (the append guard skips). If the transcript's
		// model_change postdates the agent_change (the model was switched
		// in-session later), the next resume would rehydrate the older model
		// and silently revert the reselection unless this run persists its
		// applied values (codex 3742448940).
		const tempDir = makeTempDir();
		await withProviderAuth(["openai"], async () => {
			const sessionManager = SessionManager.inMemory();
			// Identity + fingerprint match the explicit persona below...
			const persona = {
				name: "model-persona",
				description: "Persona with a model",
				systemPrompt: "",
				model: ["openai/gpt-4o"],
				source: "project" as const,
			};
			sessionManager.appendAgentChange("model-persona", "project", fingerprintAgentContent(persona));
			// ...but the transcript's latest model_change records an OLDER
			// model, switched after the persona was recorded.
			sessionManager.appendModelChange("openai/gpt-4o-mini");
			sessionManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });

			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager,
				model: getBundledModel("openai", "gpt-4o"),
				agentPersona: persona,
			});

			try {
				// The explicit selection's model is live...
				expect(session.model?.id).toBe("gpt-4o");
				// ...and persisted: the last model_change must record it so the
				// next resume rehydrates the reselection, not the stale one.
				const modelChanges = sessionManager.getEntries().filter(e => e.type === "model_change");
				expect(modelChanges[modelChanges.length - 1].model).toBe("openai/gpt-4o");
				// The identity match still skipped the agent_change append.
				expect(sessionManager.getEntries().filter(e => e.type === "agent_change")).toHaveLength(1);
			} finally {
				await session.dispose();
			}
		});
	});

	// A session created on another provider keeps its configured-mode `edit` in
	// the registry (only a Cursor-created session moves it out) and the tool
	// roster is built once, at creation — switching to Cursor later does not
	// rebuild it. These two cover both directions of that wiring: the granted
	// session must still reach a replace-mode instance for `pi_edit` (whose
	// `old_string`/`new_string` args do not validate against the default `hashline`
	// schema), and the restricted one must still be refused.
	//
	// The handlers are internal to the session; `streamFn` is where they are
	// handed to the provider, which is the externally observable seam.
	const captureCursorExecHandlers = async (session: AgentSession, cursorModel: Model): Promise<CursorExecHandlers> => {
		let handlers: CursorExecHandlers | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			// The session installs the concrete class; the provider option is
			// typed as the wire-level interface, whose `piEdit` answers a proto
			// result rather than the tool result the class returns.
			handlers = options?.cursorExecHandlers as CursorExecHandlers | undefined;
			throw new Error("captured");
		};
		vi.spyOn(session.agent, "streamFn").mockImplementation(streamFn);

		await session.setModel(cursorModel);
		// Not wrapped in a catch: `prompt` resolves even when the turn fails (the
		// loop records the stream error), so a rejection here is a genuine setup
		// failure and must surface rather than be mistaken for the capture.
		await session.prompt("hi");
		if (!handlers) throw new Error("no exec handlers reached the provider");
		return handlers;
	};

	// `setModel` and `prompt` both refuse a provider with no configured auth.
	// Granted on the suite's isolated storage rather than through the provider's
	// env var — an env mutation would outlive this file — and removed after,
	// since the storage is shared by every test here.
	const withProviderAuth = async (providers: string[], run: () => Promise<void>): Promise<void> => {
		for (const provider of providers) modelRegistry.authStorage.setRuntimeApiKey(provider, "test-key");
		try {
			await run();
		} finally {
			for (const provider of providers) modelRegistry.authStorage.removeRuntimeApiKey(provider);
		}
	};

	it("answers a native pi_edit after a session switches onto Cursor", async () => {
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const target = path.join(tempDir, "sample.txt");
		fs.writeFileSync(target, "alpha\nbeta\n");

		await withProviderAuth(["cursor"], async () => {
			const { session } = await createAgentSession(baseOptions(tempDir));
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				const result = await handlers.piEdit({
					toolCallId: "sdk-switch-1",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);

				expect(result.isError).toBeFalsy();
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\ngamma\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("refuses a native pi_edit after a read-only session switches onto Cursor", async () => {
		// The bridge instance is constructed, not looked up, so building it for
		// a roster that was never granted `edit` would hand a read-only session
		// a mutating tool the native frames reach regardless of the advertised
		// catalog (issue #5680). Making the construction provider-independent
		// must not widen it.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const target = path.join(tempDir, "sample.txt");
		fs.writeFileSync(target, "alpha\nbeta\n");

		await withProviderAuth(["cursor"], async () => {
			const { session } = await createAgentSession({ ...baseOptions(tempDir), toolNames: ["read"] });
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				const result = await handlers.piEdit({
					toolCallId: "sdk-switch-2",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);

				expect(result.isError).toBe(true);
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\nbeta\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("resolves bridge frame paths through the session's live cwd", async () => {
		// The bridge is built once, at session creation, while the session's cwd
		// moves under it (`/cd`, resume, branch restore). The path-confining
		// frames — the native `delete`, and a `download_path` resource read —
		// resolve a relative path against whichever cwd the bridge was handed, so
		// a startup snapshot means acting on the workspace the session has left
		// while reporting success for the path the server named.
		const tempDir = makeTempDir();
		const movedDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const staleTarget = path.join(tempDir, "obsolete.txt");
		const liveTarget = path.join(movedDir, "obsolete.txt");
		fs.writeFileSync(staleTarget, "preserve me");
		fs.writeFileSync(liveTarget, "remove me");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory();
			const { session } = await createAgentSession({ ...baseOptions(tempDir), sessionManager });
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				await sessionManager.moveTo(movedDir);

				const result = await handlers.delete({ toolCallId: "sdk-cwd-1", path: "obsolete.txt" } as never);

				expect(result.isError).toBe(false);
				expect(fs.existsSync(liveTarget)).toBe(false);
				expect(fs.existsSync(staleTarget)).toBe(true);
			} finally {
				await session.dispose();
			}
		});
	});

	it("does not execute an unadvertised edit call through the fallback resolver", async () => {
		// One resolver serves two roles: the session's device resolver is passed
		// to the bridge as `getTool` AND installed as the agent loop's
		// `resolveFallbackTool`, which runs for ANY call the advertised set does
		// not contain. It must stay device-only: routing `edit` through it would
		// execute a replace-mode edit for a call the model was never offered —
		// a hallucinated one, or a tool the session deselected after startup.
		// `pi_edit` gets its instance from `getEditReplaceTool` instead.
		const tempDir = makeTempDir();
		const target = path.join(tempDir, "sample.txt");
		fs.writeFileSync(target, "alpha\nbeta\n");

		await withProviderAuth(["openai"], async () => {
			// Granted at startup, so an `edit` instance exists to leak, then
			// deselected — the exact state that makes the fallback dangerous.
			const { session } = await createAgentSession(baseOptions(tempDir));
			try {
				await session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "edit"));
				expect(session.getActiveToolNames()).not.toContain("edit");

				// A real mock provider, not a hand-rolled stream: the loop builds
				// the assistant message from the full event sequence, and an
				// incomplete one is dropped before tool dispatch ever runs.
				const toolCallId = "unadvertised-edit-1";
				const mock = createMockModel({
					responses: [
						{
							content: [
								{
									type: "toolCall",
									id: toolCallId,
									name: "edit",
									arguments: { path: target, old_string: "beta", new_string: "gamma" },
								},
							],
						},
						{ content: [{ type: "text", text: "done" }] },
					],
				});
				vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);

				await session.prompt("hi");

				// The surfaced result, not just the file: an unchanged file alone
				// would also pass if the fallback HAD resolved the tool and the
				// edit then failed validation or approval. Only "not found"
				// proves the resolver refused to hand one over.
				const result = session.messages.find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolCallId === toolCallId,
				);
				expect(result?.isError).toBe(true);
				expect(JSON.stringify(result?.content)).toContain("Tool edit not found");
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\nbeta\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("runs advisor tools through the approval gate", async () => {
		// The advisor's tools are built straight from `BUILTIN_TOOLS`, outside
		// the registry loop that wraps everything else. Its own loop and its
		// Cursor exec bridge (`piWrite`/`piBash`) run those instances directly,
		// so an unwrapped one executes whatever it is handed regardless of the
		// user's `tools.approval.<tool>` policy — the gate lives in
		// `ExtensionToolWrapper`, not in either caller.
		const tempDir = makeTempDir();
		const target = path.join(tempDir, "advisor-write.txt");

		// An advisor only builds once a model resolves for it, and both the
		// explicit override and the `advisor` role chain resolve against
		// `modelRegistry.getAvailable()` — the models this machine holds auth
		// for. Grant the suite's isolated storage a key and name the model
		// outright, or the roster silently resolves to `no_model` wherever no
		// provider is configured (CI) while passing on a developer box whose
		// environment happens to carry provider keys.
		await withProviderAuth(["openai"], async () => {
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				settings: Settings.isolated({ "advisor.enabled": true, "tools.approval": { write: "deny" } }),
			});
			try {
				// The default advisor roster is read-only (read/grep/glob); the
				// reviewed hole needs one actually granted a mutating tool.
				session.applyAdvisorConfigs([{ name: "writer", tools: ["write"], model: "gpt-4o-mini" }], undefined);
				const advisor = session.getAdvisorAgent();
				if (!advisor) throw new Error("expected an advisor agent");
				const writeTool = advisor.state.tools?.find(tool => tool.name === "write");
				if (!writeTool) throw new Error("expected the advisor to hold a write tool");

				// The gate rejects rather than returning an error result — that throw
				// IS the refusal, and it only happens when the instance is wrapped.
				await expect(
					writeTool.execute("advisor-w1", { path: target, content: "written" }, undefined, undefined, {
						settings: session.settings,
					} as never),
				).rejects.toThrow(/blocked by user policy/);
				expect(fs.existsSync(target)).toBe(false);
			} finally {
				await session.dispose();
			}
		});
	});

	// ---------------------------------------------------------------------------
	// Session-switch rollback / transient-mode reconciliation regressions
	// (adversarial review of the switchSession + InteractiveMode reconcile path).
	// ---------------------------------------------------------------------------

	/** Writes a minimal target transcript with an optional recorded persona. */
	async function writeSwitchTarget(
		filePath: string,
		options: { agent?: { name: string; source: string }; fingerprint?: string } = {},
	): Promise<void> {
		const timestamp = "2026-08-08T00:00:00.000Z";
		const entries: Array<Record<string, unknown>> = [
			{ type: "session", version: 3, id: path.basename(filePath), timestamp, cwd: path.dirname(filePath) },
		];
		if (options.agent) {
			entries.push({
				type: "agent_change",
				id: "persona-change",
				parentId: null,
				timestamp,
				agent: options.agent.name,
				source: options.agent.source,
				// A real saved transcript carries the definition fingerprint (the
				// SDK's appendAgentChange always writes one). Without it the
				// switch treats the recorded content as unknown and reapplies
				// the persona's model/thinking defaults — a legacy-only path.
				fingerprint:
					options.fingerprint ??
					fingerprintAgentContent(
						getBundledAgent(options.agent.name) ?? {
							name: options.agent.name,
							description: options.agent.name,
							systemPrompt: "",
							source: options.agent.source as "bundled" | "user" | "project",
						},
					),
			});
		}
		await Bun.write(filePath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	}

	it("restores the source session's tool presentation when a session switch rolls back", async () => {
		// switchSession's forward path runs the target persona's overlay
		// (restore + applyToolOverlay), rewriting SessionTools' presentation
		// state (runtime selection, xd:// mount partition, applied signature).
		// The catch block reassigns `#agentToolOverlay` to the source overlay
		// but — before the fix — never re-applies it: the rollback's
		// `agent.setTools(previousTools)` restores only the agent's tool
		// *instances*, so the session stays on the target's applied set instead
		// of the source overlay's baseline until the next full tool re-apply.
		const tempDir = makeTempDir();
		const targetFile = path.join(tempDir, "target-reviewer.jsonl");
		await writeSwitchTarget(targetFile, { agent: { name: "reviewer", source: "bundled" } });

		// Control session with no persona: its enabled set IS the launch
		// baseline (the persona overlay's restore target) for a session whose
		// registry matches the source's.
		const { session: control } = await createAgentSession(baseOptions(tempDir));
		// Source session with a persona overlay active pre-switch. `agentPersona`
		// must be passed at startup so the constructor arms `#agentToolOverlay`
		// with the SDK-provided initialToolOverlayRestore.
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "active")),
			agentPersona: {
				name: "pre-switch-persona",
				description: "Persona active before the switch",
				systemPrompt: "",
				tools: ["read"],
				source: "project" as const,
			},
		});
		try {
			expect(session.agentPersona?.name).toBe("pre-switch-persona");

			// Fail the switch AFTER the forward path applied the target persona's
			// overlay (the first `replaceMessages` in the try block runs after the
			// persona block); the rollback's own replaceMessages must go through.
			vi.spyOn(session.agent, "replaceMessages").mockImplementationOnce(() => {
				throw new Error("injected switch failure");
			});

			await expect(session.switchSession(targetFile)).rejects.toThrow("injected switch failure");

			// The source persona is restored, and SessionTools' presentation must
			// match the launch baseline again — not the target persona's applied
			// set (which would otherwise leak until the next tool re-apply).
			expect(session.agentPersona?.name).toBe("pre-switch-persona");
			expect([...session.getEnabledToolNames()].sort()).toEqual([...control.getEnabledToolNames()].sort());
		} finally {
			await session.dispose();
			await control.dispose();
		}
	});

	it("reapplies a changed persona's model/thinking on session switch", async () => {
		// switchSession treats the recorded persona as a rehydrated selection
		// and restores the transcript's model/thinking — but when the
		// definition CONTENT changed since the transcript saved (fingerprint
		// differs), the current definition's frontmatter model/thinking must
		// be reapplied after that restore. Without it the in-process switch
		// silently keeps running the stale model/thinking until the process
		// restarts, while a cold resume of the same transcript reapplies the
		// new defaults (codex 3742448937).
		const tempDir = makeTempDir();
		await withProviderAuth(["openai", "openai-codex"], async () => {
			const targetFile = path.join(tempDir, "target-reviewer.jsonl");
			// Stale fingerprint: the persona's model:/thinkingLevel: changed
			// since this transcript recorded it.
			await writeSwitchTarget(targetFile, {
				agent: { name: "reviewer", source: "bundled" },
				fingerprint: "stale-content-fingerprint",
			});

			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager: SessionManager.create(tempDir, path.join(tempDir, "active")),
			});

			try {
				expect(session.model?.provider).toBe("openai");
				expect(await session.switchSession(targetFile)).toBe(true);
				expect(session.agentPersona?.name).toBe("reviewer");

				// The reviewer's model: @slow must now be live — the stale
				// transcript (which recorded no model_change at all) cannot
				// win over the changed definition's frontmatter.
				const reviewer = getBundledAgent("reviewer");
				if (!reviewer) throw new Error("expected bundled reviewer agent");
				const resolved = resolveModelOverride(reviewer.model ?? [], modelRegistry, Settings.isolated());
				if (!resolved.model) throw new Error("expected @slow to resolve in the test registry");
				expect(session.model?.provider).toBe(resolved.model.provider);
				expect(session.model?.id).toBe(resolved.model.id);

				// The reapply persisted an agent_change carrying the CURRENT
				// fingerprint, so the next resume compares against this
				// content rather than the stale recorded one.
				const entries = sessionManagerEntries(session);
				const agentChanges = entries.filter(e => e.type === "agent_change");
				expect(agentChanges).toHaveLength(2);
				expect(agentChanges[agentChanges.length - 1].fingerprint).toBe(fingerprintAgentContent(reviewer));
			} finally {
				await session.dispose();
			}
		});
	});

	it("does not record a fresh fingerprint when the changed persona model cannot resolve", async () => {
		// When the switched-to persona's definition changed but its new model:
		// cannot resolve in this process (deleted provider, disabled extension),
		// the reapply keeps the transcript's restored model. Recording the new
		// fingerprint anyway would mark the changed persona as rehydrated, so
		// the next resume skips reapplying the model even after the provider
		// becomes available again (codex 3742717639).
		const tempDir = makeTempDir();
		const targetFile = path.join(tempDir, "target-unresolvable.jsonl");
		const persona = {
			name: "unresolvable-model",
			description: "Persona whose model cannot resolve",
			systemPrompt: "",
			model: ["openai/gpt-nonexistent"],
			source: "project" as const,
		};
		// Stale fingerprint: the persona's model: changed since this
		// transcript recorded it.
		await writeSwitchTarget(targetFile, {
			agent: { name: "unresolvable-model", source: "project" },
			fingerprint: "stale-content-fingerprint",
		});

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [persona],
			projectAgentsDir: null,
		});

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "active")),
		});

		try {
			expect(await session.switchSession(targetFile)).toBe(true);
			expect(session.agentPersona?.name).toBe("unresolvable-model");

			// The model policy was NOT applied (unresolvable), so no fresh
			// agent_change may be appended: the transcript entry keeps the
			// stale fingerprint and the next resume retries the reapply.
			const entries = sessionManagerEntries(session);
			const agentChanges = entries.filter(e => e.type === "agent_change");
			expect(agentChanges).toHaveLength(1);
			expect(agentChanges[0].fingerprint).toBe("stale-content-fingerprint");
		} finally {
			await session.dispose();
		}
	});

	it("does not clobber the target persona's tools when switching out of goal mode", async () => {
		// #clearTransientModeState's goal branch ran from the post-switch
		// reconciler and re-applied `#goalModePreviousTools` — the SOURCE
		// session's pre-goal snapshot — onto the target, clobbering the target
		// persona tools switchSession just rehydrated (mirrors the plan/vibe
		// branches; same-session /goal exit still restores via #exitGoalMode).
		const tempDir = makeTempDir();
		const targetFile = path.join(tempDir, "target-reviewer.jsonl");
		await writeSwitchTarget(targetFile, { agent: { name: "reviewer", source: "bundled" } });

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "active")),
			agentPersona: {
				name: "pre-switch-persona",
				description: "Persona active before the switch",
				systemPrompt: "",
				tools: ["read"],
				source: "project" as const,
			},
		});
		await Settings.init({ inMemory: true, cwd: tempDir });
		const mode = new InteractiveMode(session, "test");
		try {
			await mode.init({ suppressWelcomeIntro: true });
			// Source session in goal mode: the persona's "read"-restricted set
			// (auto-widened to task+hub by resolveAgentSessionPolicy) is
			// augmented with the hidden `goal` tool.
			await mode.handleGoalModeCommand("Ship the release");
			expect(mode.goalModeEnabled).toBe(true);
			expect([...session.getEnabledToolNames()].sort()).toEqual(["goal", "hub", "read", "task"]);

			// Target records the bundled reviewer persona and no goal/plan mode.
			expect(await session.switchSession(targetFile)).toBe(true);

			// Goal state torn down, target persona live, and the target's tool
			// set survives — the source's pre-goal set must not be re-applied.
			expect(mode.goalModeEnabled).toBe(false);
			expect(mode.goalModePaused).toBe(false);
			expect(session.agentPersona?.name).toBe("reviewer");
			// Reviewer policy: read,grep,glob,bash,lsp,web_search,ast_grep +
			// auto-added task (spawns: scout) + hub; lsp/ast_grep gated out of
			// the registry by baseOptions (enableLsp: false, astGrep disabled).
			const reviewerSet = ["bash", "glob", "grep", "hub", "read", "task", "web_search"];
			expect([...session.getEnabledToolNames()].sort()).toEqual(reviewerSet);
		} finally {
			mode.stop();
			await session.dispose();
		}
	});

	it("applies an inline thinking suffix when the persona's base model is unchanged", async () => {
		// The changed-persona reapply block skipped setModel when the resolved
		// persona model equals the restored transcript model — but that skip
		// also dropped the inline `:level` suffix: a persona edited from
		// `model: openai/gpt-5` to `model: openai/gpt-5:high` changes only
		// the thinking, and the switch left the stale transcript selector in
		// place because policy.thinkingLevel was unset (codex 3742662984).
		// gpt-5 is reasoning-capable so the high selector can actually stick
		// (on gpt-4o, which has no thinking support, every level clamps to
		// undefined and the assertion would pass vacuously).
		const tempDir = makeTempDir();
		await withProviderAuth(["openai"], async () => {
			const persona = {
				name: "suffix-persona",
				description: "Persona with an inline thinking suffix",
				systemPrompt: "",
				model: ["openai/gpt-5:high"],
				source: "project" as const,
			};
			const targetFile = path.join(tempDir, "target-suffix.jsonl");
			// The recorded persona carried the SAME base model without the
			// suffix: content changed, identity did not.
			await writeSwitchTarget(targetFile, {
				agent: { name: "suffix-persona", source: "project" },
				fingerprint: fingerprintAgentContent({ ...persona, model: ["openai/gpt-5"] }),
			});

			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [persona],
				projectAgentsDir: null,
			});

			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				sessionManager: SessionManager.create(tempDir, path.join(tempDir, "active")),
			});

			try {
				expect(await session.switchSession(targetFile)).toBe(true);
				expect(session.agentPersona?.name).toBe("suffix-persona");
				// The base model is unchanged, but the new inline suffix must
				// now be live rather than the stale transcript thinking.
				expect(session.model?.id).toBe("gpt-5");
				expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
			} finally {
				await session.dispose();
			}
		});
	});

	it("restores the pre-plan baseline only for no-persona targets on switch out of plan mode", async () => {
		// The plan branch drops `#planModeToolOverlay` without restoring it
		// (the source overlay would clobber the target). For a target with NO
		// recorded persona, switchSession clears persona state and restores the
		// launch baseline; a persona-SOURCED pre-plan snapshot must not be
		// re-applied on top of it (it is the old persona's restricted set —
		// codex 3742806339). Only a persona-less source captured the launch
		// baseline itself, so the pre-plan restore is limited to that case. A
		// persona target already rehydrated its own tools and must keep them.
		const tempDir = makeTempDir();
		const personaTargetFile = path.join(tempDir, "target-reviewer.jsonl");
		await writeSwitchTarget(personaTargetFile, { agent: { name: "reviewer", source: "bundled" } });
		const plainTargetFile = path.join(tempDir, "target-plain.jsonl");
		await writeSwitchTarget(plainTargetFile);

		// Control session with no persona: its enabled set is the launch
		// baseline, which must differ from the persona-restricted set for the
		// no-persona-target assertion below to discriminate the fix.
		const { session: control } = await createAgentSession(baseOptions(tempDir));
		const controlBaseline = [...control.getEnabledToolNames()].sort();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager: SessionManager.create(tempDir, path.join(tempDir, "active")),
			agentPersona: {
				name: "pre-switch-persona",
				description: "Persona active before the switch",
				systemPrompt: "",
				tools: ["read"],
				source: "project" as const,
			},
		});
		await Settings.init({ inMemory: true, cwd: tempDir });
		const mode = new InteractiveMode(session, "test");
		try {
			await mode.init({ suppressWelcomeIntro: true });
			// Source session in plan mode: the persona's "read"-restricted set
			// (auto-widened to task+hub) is augmented with the built-in `write`.
			await mode.handlePlanModeCommand();
			expect(mode.planModeEnabled).toBe(true);
			expect([...session.getEnabledToolNames()].sort()).toEqual(["hub", "read", "task", "write"]);

			// Case A: target with a persona — its tools must survive untouched
			// (an unconditional restore would clobber them with the source's
			// pre-plan snapshot). `write` may be present as a separate
			// pre-existing artifact: the forward persona apply runs while plan
			// mode state is still live, so the transport forces `write`
			// top-level; only the reconciler clears plan mode after.
			expect(await session.switchSession(personaTargetFile)).toBe(true);
			expect(mode.planModeEnabled).toBe(false);
			expect(session.agentPersona?.name).toBe("reviewer");
			const reviewerSet = ["bash", "glob", "grep", "hub", "read", "task", "web_search"];
			expect(
				session
					.getEnabledToolNames()
					.filter(name => name !== "write")
					.sort(),
			).toEqual(reviewerSet);

			// Re-arm plan mode on the reviewer-active session, then switch to a
			// target with NO recorded persona: the source's pre-plan snapshot is
			// the reviewer's restricted set and must NOT leak onto the
			// persona-less target — switchSession already restored the launch
			// baseline, so the target ends on the full baseline, not the stale
			// persona tools.
			await mode.handlePlanModeCommand();
			expect(mode.planModeEnabled).toBe(true);
			const prePlanSet = [...session.getEnabledToolNames()].sort();
			expect(prePlanSet).toContain("write");
			// The reviewer-restricted pre-plan snapshot must observably differ
			// from the launch baseline, or the final assertion cannot
			// discriminate the fix.
			expect(prePlanSet).not.toEqual(controlBaseline);

			expect(await session.switchSession(plainTargetFile)).toBe(true);
			expect(mode.planModeEnabled).toBe(false);
			expect(session.agentPersona).toBeUndefined();
			// The persona-less target keeps the launch baseline switchSession
			// restored — the source persona's restricted pre-plan set must not
			// be re-applied on top of it.
			expect([...session.getEnabledToolNames()].sort()).toEqual(controlBaseline);
		} finally {
			mode.stop();
			await session.dispose();
			await control.dispose();
		}
	});
});
