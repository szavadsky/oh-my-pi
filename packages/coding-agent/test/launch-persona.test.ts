import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { readPersistedAgentPersona } from "@oh-my-pi/pi-coding-agent/session/persisted-persona";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { DiscoveredAgent } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Observable `--agent <name>` launch-as-switch contract (plan §2, PR 9510 stage 2):
 * the persona must be active on the session BEFORE the first user turn — tools
 * narrowed, model applied, identity prompt riding the append channel — and
 * explicit CLI flags must still win. Tests drive the real pipeline:
 * buildSessionOptions (CLI parse → pendingPersonaAgent) → createAgentSession
 * (PersonaRuntime.enter).
 */

const READER_AGENT_MD = `---
name: fixture-reader
description: Read-only fixture persona
tools:
  - read
spawns: []
---

You are the fixture reader persona.`;

const MODELED_AGENT_MD = `---
name: fixture-modeled
description: Persona declaring a model
model:
  - anthropic/claude-sonnet-4-5
---

You are the modeled persona.`;

const FALLBACK_AGENT_MD = `---
name: fixture-fallback
description: Persona with an ordered model fallback chain and structured output
model:
  - "no-such-provider-xyz/missing-model-7k2:max"
  - anthropic/claude-sonnet-4-5:high
  - anthropic/claude-opus-4-1:low
thinkingLevel: medium
tools:
  - read
output:
  type: object
  properties:
    status:
      type: string
  required:
    - status
spawns: []
---

You are the fallback persona.`;

const TASK_ALIAS_AGENT_MD = `---
name: fixture-task-alias
description: Persona inheriting the task role alias
model:
  - "@task"
thinkingLevel: high
---

You are the task alias persona.`;

let workspace: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(() => {
	workspace = TempDir.createSync("@omp-launch-persona-");
	authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
});

afterAll(async () => {
	authStorage.close();
	await workspace.remove();
});

let session: AgentSession | undefined;

afterEach(async () => {
	if (session) {
		await session.dispose();
		session = undefined;
	}
});

async function writeFixtureAgents(...files: Array<{ name: string; content: string }>): Promise<void> {
	const agentsDir = path.join(workspace.path(), ".omp", "agents");
	await fs.mkdir(agentsDir, { recursive: true });
	for (const file of files) {
		await fs.writeFile(path.join(agentsDir, file.name), file.content, "utf-8");
	}
}

interface SessionOpts {
	args: string[];
	extraOptions?: Record<string, unknown>;
}

/** Full launch path: parseArgs → buildSessionOptions → createAgentSession. */
async function launch({ args, extraOptions }: SessionOpts): Promise<AgentSession> {
	const parsed = parseArgs(["--cwd", workspace.path(), ...args]);
	const settings = Settings.isolated({ "async.enabled": false });
	const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);
	Object.assign(options, {
		authStorage,
		modelRegistry,
		settings,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		...extraOptions,
	});
	const result = await createAgentSession(options as Parameters<typeof createAgentSession>[0]);
	session = result.session;
	return session;
}

describe("--agent launch-as-switch", () => {
	it("narrows the session's active tools to the persona's tools before the first turn", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		const launched = await launch({ args: ["--agent", "fixture-reader"] });

		expect(launched.getPersonaRuntime()?.policy.isPersonaActive()).toBe(true);
		const enabled = new Set(launched.getEnabledToolNames());
		expect(enabled.has("read")).toBe(true);
		expect(enabled.has("write")).toBe(false);
		expect(enabled.has("bash")).toBe(false);
		expect(enabled.has("edit")).toBe(false);
	});

	it("applies the persona's identity prompt through the append channel", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		const launched = await launch({ args: ["--agent", "fixture-reader"] });

		expect(launched.getPersonaAppendPrompt()).toContain("fixture reader persona");
		const systemPrompt = launched.systemPrompt.join("\n");
		expect(systemPrompt).toContain("You are the fixture reader persona.");
	});

	it("applies the persona's declared model", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		const launched = await launch({ args: ["--agent", "fixture-modeled"] });

		expect(launched.model?.provider).toBe("anthropic");
		expect(launched.model?.id).toBe("claude-sonnet-4-5");
	});

	it("explicit --model beats the persona's declared model", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		const override = getBundledModel("anthropic", "claude-opus-4-5");
		if (!override) throw new Error("Expected built-in anthropic opus model to exist");
		const launched = await launch({
			args: ["--agent", "fixture-modeled", "--model", `${override.provider}/${override.id}`],
		});

		// The explicit CLI model wins over the persona's declared model — distinct
		// ids make the override observable rather than a coincidental identity.
		expect(launched.model?.id).toBe(override.id);
		expect(launched.model?.id).not.toBe("claude-sonnet-4-5");
	});

	it("no --agent flag still installs a persona runtime (no persona active)", async () => {
		const launched = await launch({ args: [] });

		// The runtime is unconditional so `/agent` and resume reconcile work in
		// sessions launched without a persona; only activation is persona-specific.
		const runtime = launched.getPersonaRuntime();
		expect(runtime).toBeDefined();
		expect(runtime?.policy.isPersonaActive()).toBe(false);
		expect(launched.getPersonaAppendPrompt()).toBeUndefined();
		const enabled = launched.getEnabledToolNames();
		expect(enabled).toContain("read");
		expect(enabled).toContain("write");
	});

	it("--agent with a nonexistent name fails session construction", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		await expect(launch({ args: ["--agent", "does-not-exist"] })).rejects.toThrow(/does-not-exist/);
	});

	it("explicit --tools conflicts with --agent: persona grant wins", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		const launched = await launch({
			args: ["--agent", "fixture-reader", "--tools", "grep,read"],
		});

		// Persona tools: [read] intersect the CLI grant → only `read` survives.
		const enabled = new Set(launched.getEnabledToolNames());
		expect(enabled.has("read")).toBe(true);
		expect(enabled.has("grep")).toBe(false);
		expect(enabled.has("write")).toBe(false);
	});

	it("resolves --agent inside a CLI --extension package (root pre-resolution)", async () => {
		// fo0dP: the --agent resolution site must derive the SAME extension roots
		// the session will use; an agent shipped in a CLI --extension package is
		// sub-discovered through <root>/agents and must resolve at launch.
		const ext = path.join(workspace.path(), "ext-pkg");
		const agentsDir = path.join(ext, "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await fs.writeFile(
			path.join(agentsDir, "extension-fixture.md"),
			"---\nname: extension-fixture\ndescription: Agent shipped in a CLI extension package\n---\n\nYou are the extension fixture persona.",
		);
		const launched = await launch({ args: ["--agent", "extension-fixture", "--extension", ext] });

		expect(launched.getPersonaRuntime()?.policy.isPersonaActive()).toBe(true);
		expect(launched.getPersonaAppendPrompt()).toContain("extension fixture persona");
	});

	it("buildSessionOptions threads pendingPersonaAgent with explicit CLI overrides", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		const parsed = parseArgs([
			"--cwd",
			workspace.path(),
			"--agent",
			"fixture-modeled",
			"--model",
			"anthropic/claude-opus-4-1",
		]);
		const options = await buildSessionOptions(
			parsed,
			[],
			SessionManager.inMemory(),
			modelRegistry,
			Settings.isolated(),
		);

		const personaAgent = options.pendingPersonaAgent as DiscoveredAgent | undefined;
		expect(personaAgent?.name).toBe("fixture-modeled");
		expect(options.pendingPersonaExplicit?.model).toBe("anthropic/claude-opus-4-1");
	});

	// P1 (PRRT_kwDOQxs0bc6fsoeX): with `--provider azure --model gpt-4.1` the CLI
	// resolver selects azure's copy, but persisting the BARE pattern lets resume
	// reconcile re-resolve it against any provider carrying that id. The journal
	// must carry the provider-qualified selector the resolver actually honored.
	it("persists the provider-qualified model when --provider qualifies --model", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		const parsed = parseArgs([
			"--cwd",
			workspace.path(),
			"--agent",
			"fixture-modeled",
			"--provider",
			"anthropic",
			"--model",
			"claude-opus-4-1",
		]);
		const options = await buildSessionOptions(
			parsed,
			[],
			SessionManager.inMemory(),
			modelRegistry,
			Settings.isolated(),
		);

		expect(options.pendingPersonaExplicit?.model).toBe("anthropic/claude-opus-4-1");

		// The qualified selector survives the journal round-trip a resume reads.
		const launched = await launch({
			args: ["--agent", "fixture-modeled", "--provider", "anthropic", "--model", "claude-opus-4-1"],
			extraOptions: {
				sessionManager: SessionManager.create(workspace.path(), path.join(workspace.path(), "sessions")),
			},
		});
		await launched.sessionManager.ensureOnDisk();
		await launched.sessionManager.flush();
		const sessionFile = launched.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file for a persona launch");
		const lines = (await fs.readFile(sessionFile, "utf-8")).split("\n").filter(line => line.trim() !== "");
		const desired = readPersistedAgentPersona(
			lines.map(line => JSON.parse(line) as { type: unknown; mode?: unknown; data?: unknown }),
		);
		expect(desired?.explicit?.model).toBe("anthropic/claude-opus-4-1");

		// And resume reconcile resolves it to the requested provider, not a
		// same-id copy from another provider.
		expect(launched.model?.provider).toBe("anthropic");
		expect(launched.model?.id).toBe("claude-opus-4-1");
	});

	it("launch appends an agent mode_change journal entry for future resume reconcile", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		const launched = await launch({ args: ["--agent", "fixture-reader"] });

		const modeChanges = launched.sessionManager
			.getEntries()
			.filter(entry => entry.type === "mode_change" && (entry as { mode?: string }).mode === "agent");
		expect(modeChanges).toHaveLength(1);
		expect((modeChanges[0] as { data?: { name?: string } }).data?.name).toBe("fixture-reader");
	});

	it("persists explicit CLI overrides nested so resume reconcile reads them back", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		// The shared `launch` helper wires an in-memory manager; this test needs the
		// real JSONL file a stored session carries, so supply a persisting one.
		const launched = await launch({
			args: ["--agent", "fixture-modeled", "--model", "anthropic/claude-sonnet-4-5", "--thinking", "high"],
			extraOptions: {
				sessionManager: SessionManager.create(workspace.path(), path.join(workspace.path(), "sessions")),
			},
		});
		await launched.sessionManager.ensureOnDisk();
		await launched.sessionManager.flush();

		// The journal must carry the nested contract (acp readPersistedAgentPersona
		// narrows `data.explicit`), not a flat spread of the overrides.
		const sessionFile = launched.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file for a persona launch");
		const lines = (await fs.readFile(sessionFile, "utf-8")).split("\n").filter(line => line.trim() !== "");
		const agentEntry = lines
			.map(line => JSON.parse(line) as { type?: string; mode?: string; data?: Record<string, unknown> })
			.filter(entry => entry.type === "mode_change" && entry.mode === "agent")
			.at(-1);
		if (!agentEntry) throw new Error("Expected agent mode_change entry on disk");
		const explicitRaw = agentEntry.data?.explicit;
		expect(explicitRaw).toEqual({ model: "anthropic/claude-sonnet-4-5", thinking: "high", tools: undefined });

		// And the reader narrows it back to the resume shape.
		const desired = readPersistedAgentPersona(
			launched.sessionManager.getEntries().map(entry => entry as { type: unknown; mode?: unknown; data?: unknown }),
		);
		expect(desired?.name).toBe("fixture-modeled");
		expect(desired?.explicit?.model).toBe("anthropic/claude-sonnet-4-5");
	});

	// fr-vU: `--no-tools` grants NOTHING at launch; the empty explicit grant
	// must persist so a resume cannot widen the persona back to its full
	// frontmatter toolset.
	it("--no-tools persists an empty explicit grant for resume", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		const parsed = parseArgs(["--cwd", workspace.path(), "--agent", "fixture-modeled", "--no-tools"]);
		const options = await buildSessionOptions(
			parsed,
			[],
			SessionManager.inMemory(),
			modelRegistry,
			Settings.isolated(),
		);

		// The empty grant is durable on the launch options…
		expect(options.pendingPersonaExplicit?.tools).toEqual([]);
		expect(options.pendingPersonaAgent?.name).toBe("fixture-modeled");

		// …and survives the journal round-trip a resume reads back.
		const launched = await launch({
			args: ["--agent", "fixture-modeled", "--no-tools"],
			extraOptions: {
				sessionManager: SessionManager.create(workspace.path(), path.join(workspace.path(), "sessions")),
			},
		});
		await launched.sessionManager.ensureOnDisk();
		await launched.sessionManager.flush();

		const sessionFile = launched.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file for a persona launch");
		const lines = (await fs.readFile(sessionFile, "utf-8")).split("\n").filter(line => line.trim() !== "");
		const desired = readPersistedAgentPersona(
			lines.map(line => JSON.parse(line) as { type: unknown; mode?: unknown; data?: unknown }),
		);
		expect(desired?.explicit?.tools).toEqual([]);
	});

	// P2 (PRRT_kwDOQxs0bc6fvFVo): `--provider openai --model gpt-5:high` — the
	// provider-qualified composition of the persona's explicit model override
	// must preserve the thinking suffix, or resume reconcile silently
	// re-classifies the effort.
	it("persists the thinking suffix through the provider-qualified pattern", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		const parsed = parseArgs([
			"--cwd",
			workspace.path(),
			"--agent",
			"fixture-modeled",
			"--provider",
			"anthropic",
			"--model",
			"claude-opus-4-1:high",
		]);
		const options = await buildSessionOptions(
			parsed,
			[],
			SessionManager.inMemory(),
			modelRegistry,
			Settings.isolated(),
		);

		expect(options.pendingPersonaExplicit?.model).toBe("anthropic/claude-opus-4-1:high");
	});

	// j2m (PRRT_kwDOQxs0bc6ftJ2Z): a live /agent switch under a CLI tool ceiling
	// must serialize the ceiling into explicit.tools BEFORE enter, so the journal
	// entry carries it and a resume cannot widen the persona past it.
	it("live persona switch under --tools persists the CLI ceiling as explicit.tools (j2m)", async () => {
		await writeFixtureAgents({ name: "fixture-reader.md", content: READER_AGENT_MD });
		// A persona with a WIDER frontmatter toolset than the CLI ceiling.
		await writeFixtureAgents({
			name: "fixture-wide.md",
			content: `---
name: fixture-wide
description: Persona with a wide toolset
tools: [read, write, bash]
---

You are the wide persona.`,
		});

		const launched = await launch({
			args: ["--agent", "fixture-reader", "--tools", "read,write"],
			extraOptions: {
				sessionManager: SessionManager.create(workspace.path(), path.join(workspace.path(), "sessions")),
			},
		});
		expect(launched.getPersonaRuntime()?.policy.isPersonaActive()).toBe(true);

		// Live-switch to the WIDE persona — the CLI ceiling must ride the entry.
		const runtime = launched.getPersonaRuntime()!;
		const { agents } = await discoverAgents(workspace.path());
		const wide = getAgent(agents, "fixture-wide");
		expect(wide).toBeDefined();
		// Enter the wide persona through the same seam the TUI/ACP handler uses:
		// explicit overrides carrying the session's durable CLI ceiling.
		const cliGrant = launched.getToolPolicy()?.cliGrant;
		expect(cliGrant).not.toBeNull();
		const explicitOverrides = cliGrant ? { tools: [...cliGrant] } : {};
		await runtime.reconcile({ agent: wide!, explicit: explicitOverrides }, { apply: async () => {} });
		launched.sessionManager.appendModeChange("agent", {
			name: wide!.name,
			...(Object.keys(explicitOverrides).length > 0 ? { explicit: explicitOverrides } : {}),
		});

		// bash was in the wide frontmatter but OUTSIDE the CLI ceiling: still denied.
		const policy = launched.getToolPolicy()!;
		expect(policy.isPersonaActive()).toBe(true);
		expect(policy.effective("bash")).toBe(false);
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("write")).toBe(true);

		// The journal entry carries the ceiling so a resume reconcile cannot widen.
		await launched.sessionManager.ensureOnDisk();
		await launched.sessionManager.flush();
		const sessionFile = launched.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file for a persona launch");
		const lines = (await fs.readFile(sessionFile, "utf-8")).split("\n").filter(line => line.trim() !== "");
		const desired = readPersistedAgentPersona(
			lines.map(line => JSON.parse(line) as { type: unknown; mode?: unknown; data?: unknown }),
		);
		expect(desired?.name).toBe("fixture-wide");
		expect(desired?.explicit?.tools).toEqual(["read", "write"]);
	});

	// Launch parity with task subagents (PR 12783 onto 11004): the persona's
	// full ordered model list becomes a deferred modelPattern chain — a missing
	// selector skips, the first available one selects, its explicit effort wins
	// over the persona thinking default, and the remaining selectors install as
	// the runtime retry fallback under a persona-scoped role.
	it("buildSessionOptions turns the persona model list into an ordered deferred pattern chain", async () => {
		await writeFixtureAgents({ name: "fixture-fallback.md", content: FALLBACK_AGENT_MD });
		const parsed = parseArgs(["--cwd", workspace.path(), "--agent", "fixture-fallback"]);
		const options = await buildSessionOptions(
			parsed,
			[],
			SessionManager.inMemory(),
			modelRegistry,
			Settings.isolated(),
		);

		expect(options.pendingPersonaAgent?.name).toBe("fixture-fallback");
		expect(options.model).toBeUndefined();
		expect(options.modelPattern).toEqual([
			"no-such-provider-xyz/missing-model-7k2:max",
			"anthropic/claude-sonnet-4-5:high",
			"anthropic/claude-opus-4-1:low",
		]);
		expect(options.modelPatternFallbackRole).toBe("persona:fixture-fallback");
		// The persona thinking default rides the DEFERRED pattern default only —
		// an explicit selector suffix must still outrank it after resolution.
		expect(options.modelPatternDefaultThinkingLevel).toBe(ThinkingLevel.Medium);
		expect(options.thinkingLevel).toBeUndefined();
		expect(options.outputSchema).toEqual({
			type: "object",
			properties: { status: { type: "string" } },
			required: ["status"],
		});
		expect(options.requireYieldTool).toBe(true);
	});

	it("launch selects the first available selector at its explicit effort and installs the rest as fallback", async () => {
		await writeFixtureAgents({ name: "fixture-fallback.md", content: FALLBACK_AGENT_MD });
		const settings = Settings.isolated();
		const launched = await launch({ args: ["--agent", "fixture-fallback"], extraOptions: { settings } });

		// The missing first selector skips; the second resolves and its explicit
		// `:high` effort beats the persona's `thinkingLevel: medium` default.
		expect(launched.model?.provider).toBe("anthropic");
		expect(launched.model?.id).toBe("claude-sonnet-4-5");
		expect(launched.configuredThinkingLevel()).toBe(ThinkingLevel.High);

		// Structured output activates yield alongside the persona's own tools.
		const enabled = new Set(launched.getEnabledToolNames());
		expect(enabled.has("read")).toBe(true);
		expect(enabled.has("yield")).toBe(true);

		// The third selector installs as the persona role's runtime retry chain —
		// read back through the same Settings instance the session was built with.
		const chains = settings.get("retry.fallbackChains");
		expect(chains?.["persona:fixture-fallback"]).toContain("anthropic/claude-opus-4-1:low");
	});

	// Role-alias parity: a persona declaring `model: @task` expands through
	// resolveAgentModelSelection exactly like a task spawn, inheriting the
	// task role's configured retry fallback chain.
	it("a role-alias persona inherits the role's configured fallback chain", async () => {
		await writeFixtureAgents({ name: "fixture-task-alias.md", content: TASK_ALIAS_AGENT_MD });
		const settings = Settings.isolated();
		settings.setModelRole("task", "zai/glm-5.3:high");
		settings.override("retry.fallbackChains", {
			task: ["zai/glm-5.3-flash:max", "anthropic/claude-haiku-4-5:low"],
		});
		const parsed = parseArgs(["--cwd", workspace.path(), "--agent", "fixture-task-alias"]);
		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.modelPattern).toEqual(["zai/glm-5.3:high"]);
		expect(options.modelPatternFallbackRole).toBe("persona:fixture-task-alias");
		expect(options.modelPatternDefaultThinkingLevel).toBe(ThinkingLevel.High);
		expect(options.modelPatternDefaultFallbackChain).toEqual([
			"zai/glm-5.3-flash:max",
			"anthropic/claude-haiku-4-5:low",
		]);
	});

	// A single plain (non-role) pattern inherits the configured DEFAULT retry
	// chain as its fallback when no role-specific chain applies.
	it("a single-model persona inherits the default fallback chain", async () => {
		await writeFixtureAgents({ name: "fixture-modeled.md", content: MODELED_AGENT_MD });
		const settings = Settings.isolated();
		settings.override("retry.fallbackChains", { default: ["zai/glm-5.3-flash:max"] });
		const parsed = parseArgs(["--cwd", workspace.path(), "--agent", "fixture-modeled"]);
		const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.modelPattern).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(options.modelPatternFallbackRole).toBe("persona:fixture-modeled");
		expect(options.modelPatternDefaultFallbackChain).toEqual(["zai/glm-5.3-flash:max"]);
	});
});
