import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ScopedModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { fingerprintAgentContent } from "@oh-my-pi/pi-coding-agent/task/agent-policy";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { TempDir } from "@oh-my-pi/pi-utils";

const OPENAI_TEST_MODEL = getBundledModel("openai", "gpt-4o-mini");

interface ArgsWithPromptCacheKey extends Args {
	providerPromptCacheKey?: string;
}

interface SourceSessionFixture {
	cwd: string;
	sourceFile: string;
	sourceHeader: SessionHeader;
	forkSessionDir: string;
}

async function createSourceSessionFixture(tempDir: TempDir, parentId: string): Promise<SourceSessionFixture> {
	const cwd = tempDir.join("project");
	const sourceDir = tempDir.join("source-sessions");
	const forkSessionDir = tempDir.join("forked-sessions");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(sourceDir, { recursive: true });
	await fs.mkdir(forkSessionDir, { recursive: true });
	const sourceFile = path.join(sourceDir, `${parentId}.jsonl`);
	const sourceHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: parentId,
		timestamp: new Date().toISOString(),
		cwd,
	};
	await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
	return { cwd, sourceFile, sourceHeader, forkSessionDir };
}

async function createPersonaRecordedSessionFixture(
	tempDir: TempDir,
	parentId: string,
	agentName: string,
	source: "bundled" | "user" | "project",
): Promise<SourceSessionFixture> {
	const fixture = await createSourceSessionFixture(tempDir, parentId);
	const timestamp = new Date().toISOString();
	const agentChange = {
		type: "agent_change",
		id: "agent-1",
		parentId: null,
		timestamp,
		agent: agentName,
		source,
	};
	await Bun.write(fixture.sourceFile, `${JSON.stringify(fixture.sourceHeader)}\n${JSON.stringify(agentChange)}\n`);
	return fixture;
}

async function createMinimalSession(
	tempDir: TempDir,
	options: CreateAgentSessionOptions,
): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	const authStorage = await AuthStorage.create(tempDir.join("sdk-auth.db"));
	authStorage.setRuntimeApiKey("openai", "test-key");
	const shouldSupplyModel = options.sessionManager?.getHeader()?.parentSession === undefined;
	const result = await createAgentSession({
		...options,
		cwd: options.cwd ?? tempDir.path(),
		agentDir: tempDir.path(),
		authStorage,
		modelRegistry: undefined,
		model: shouldSupplyModel ? (options.model ?? OPENAI_TEST_MODEL) : options.model,
		settings: Settings.isolated({
			"async.enabled": false,
			"marketplace.autoUpdate": "off",
		}),
		disableExtensionDiscovery: true,
		preloadedExtensions: undefined,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: {
			rootPath: options.cwd ?? tempDir.path(),
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		enableMCP: false,
		enableLsp: false,
		...(options.toolNames !== undefined ? { toolNames: options.toolNames } : {}),
	});
	return { session: result.session, authStorage };
}

describe("provider prompt-cache key session affinity", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses --prompt-cache-key without folding it into provider session id or prompt text", () => {
		const parsed = parseArgs([
			"--provider-session-id",
			"provider-lineage",
			"--prompt-cache-key",
			"cache-affinity",
			"hello",
		]);
		const promptCacheArgs: ArgsWithPromptCacheKey = parsed;

		expect(parsed.providerSessionId).toBe("provider-lineage");
		expect(promptCacheArgs.providerPromptCacheKey).toBe("cache-affinity");
		expect(parsed.messages).toEqual(["hello"]);
		expect(parsed.unrecognizedFlags).toEqual([]);
	});

	it("creates an agent whose prompt-cache key can differ from provider request lineage", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-sdk-");
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const created = await createMinimalSession(tempDir, {
				providerSessionId: "provider-lineage",
				providerPromptCacheKey: "cache-affinity",
				sessionManager: SessionManager.inMemory(tempDir.path()),
			});
			session = created.session;
			authStorage = created.authStorage;

			expect(session.agent.sessionId).toBe("provider-lineage");
			expect(session.agent.promptCacheKey).toBe("cache-affinity");
			expect(session.agent.promptCacheKey).not.toBe(session.agent.sessionId);
		} finally {
			await session?.dispose();
			authStorage?.close();
		}
	});

	it("initializes a full fork with child request lineage and parent prompt-cache affinity", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-fork-");
		const source = await createSourceSessionFixture(tempDir, "parent-cache-session");
		const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const created = await createMinimalSession(tempDir, {
				cwd: source.cwd,
				sessionManager: forkedManager,
			});
			session = created.session;
			authStorage = created.authStorage;
			const childSessionId = forkedManager.getSessionId();

			expect(forkedManager.getHeader()?.parentSession).toBe(source.sourceHeader.id);
			expect(childSessionId).toBeString();
			expect(childSessionId).not.toBe(source.sourceHeader.id);
			expect(session.agent.sessionId).toBe(childSessionId);
			expect(session.agent.promptCacheKey).toBe(source.sourceHeader.id);
			expect(session.agent.promptCacheKey).not.toBe(session.agent.sessionId);
		} finally {
			await session?.dispose();
			authStorage?.close();
		}
	});

	it("does not auto-inherit parent prompt-cache affinity when fork startup changes request-shaping inputs", async () => {
		const cases: Array<{ name: string; options: CreateAgentSessionOptions }> = [
			{
				name: "model",
				options: { model: OPENAI_TEST_MODEL },
			},
			{
				name: "thinking",
				options: { thinkingLevel: ThinkingLevel.High },
			},
			{
				name: "system",
				options: { customSystemPrompt: "Use a different provider prompt." },
			},
			{
				name: "tools",
				options: { toolNames: ["read"] },
			},
		];

		for (const entry of cases) {
			using tempDir = TempDir.createSync(`@omp-prompt-cache-fork-${entry.name}-`);
			const source = await createSourceSessionFixture(tempDir, `parent-cache-session-${entry.name}`);
			const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
			let session: AgentSession | undefined;
			let authStorage: AuthStorage | undefined;
			try {
				const created = await createMinimalSession(tempDir, {
					...entry.options,
					cwd: source.cwd,
					sessionManager: forkedManager,
				});
				session = created.session;
				authStorage = created.authStorage;

				expect(forkedManager.getHeader()?.parentSession).toBe(source.sourceHeader.id);
				expect(session.agent.promptCacheKey, entry.name).toBeUndefined();
			} finally {
				await session?.dispose();
				authStorage?.close();
			}
		}
	});

	it("does not pre-pin parent prompt-cache affinity when a scoped model selects the startup route", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-scoped-model-");
		const source = await createSourceSessionFixture(tempDir, "parent-cache-session-scoped");
		const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
		const authStorage = await AuthStorage.create(tempDir.join("scoped-auth.db"));
		authStorage.setRuntimeApiKey(OPENAI_TEST_MODEL.provider, "test-key");
		try {
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const parsed = parseArgs([
				"--cwd",
				source.cwd,
				"--models",
				`${OPENAI_TEST_MODEL.provider}/${OPENAI_TEST_MODEL.id}`,
			]);
			const scopedModels: ScopedModel[] = [
				{
					model: OPENAI_TEST_MODEL,
					explicitThinkingLevel: false,
				},
			];

			const options = await buildSessionOptions(
				parsed,
				scopedModels,
				forkedManager,
				modelRegistry,
				Settings.isolated({ "marketplace.autoUpdate": "off" }),
			);

			expect(options.model).toBe(OPENAI_TEST_MODEL);
			expect(options.providerPromptCacheKey).toBeUndefined();
		} finally {
			authStorage.close();
		}
	});

	it("does not auto-inherit parent prompt-cache affinity when fork startup changes the agent persona", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-agent-");
		const source = await createSourceSessionFixture(tempDir, "parent-cache-session-agent");
		const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
		const authStorage = await AuthStorage.create(tempDir.join("agent-auth.db"));
		const agentPersona = {
			name: "test-agent",
			description: "A test agent",
			systemPrompt: "You are a test agent.",
			source: "bundled" as const,
		};
		try {
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [agentPersona],
				projectAgentsDir: null,
			});
			const parsed = parseArgs(["--cwd", source.cwd, "--agent", "test-agent"]);

			const options = await buildSessionOptions(
				parsed,
				[],
				forkedManager,
				new ModelRegistry(authStorage, tempDir.join("models.yml")),
				Settings.isolated({ "marketplace.autoUpdate": "off" }),
			);

			expect(forkedManager.getHeader()?.parentSession).toBe(source.sourceHeader.id);
			expect(options.agentPersona).toBe(agentPersona);
			expect(options.providerPromptCacheKey).toBeUndefined();
		} finally {
			authStorage.close();
		}
	});

	it("rejects a startup --agent that is listed in task.disabledAgents", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-disabled-agent-");
		const source = await createSourceSessionFixture(tempDir, "parent-cache-disabled-agent");
		const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
		const authStorage = await AuthStorage.create(tempDir.join("agent-auth.db"));
		const agentPersona = {
			name: "disabled-agent",
			description: "A disabled test agent",
			systemPrompt: "You are a disabled test agent.",
			source: "bundled" as const,
		};
		try {
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [agentPersona],
				projectAgentsDir: null,
			});
			const parsed = parseArgs(["--cwd", source.cwd, "--agent", "disabled-agent"]);

			await expect(
				buildSessionOptions(
					parsed,
					[],
					forkedManager,
					new ModelRegistry(authStorage, tempDir.join("models.yml")),
					Settings.isolated({ "task.disabledAgents": ["disabled-agent"] }),
				),
			).rejects.toThrow('Agent "disabled-agent" is disabled in settings (task.disabledAgents).');
		} finally {
			authStorage.close();
		}
	});

	// Session file with a persisted agent_change; used to drive the resume paths.
	async function createPersonaResumeFixture(
		tempDir: TempDir,
		id: string,
		agentName: string,
		fingerprint?: string,
	): Promise<{ cwd: string; sessionFile: string; sessionDir: string }> {
		const cwd = tempDir.join("project");
		const sessionDir = tempDir.join("sessions");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
		const sessionFile = path.join(sessionDir, `${id}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		const agentChange: Record<string, unknown> = {
			type: "agent_change",
			id: "agent-1",
			parentId: null,
			timestamp,
			agent: agentName,
			source: "bundled",
		};
		if (fingerprint !== undefined) agentChange.fingerprint = fingerprint;
		await Bun.write(
			sessionFile,
			`${[{ type: "session", version: 3, id, timestamp, cwd }, agentChange]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return { cwd, sessionFile, sessionDir };
	}

	it("does not apply a rehydrated persona's model/thinking on resume", async () => {
		using tempDir = TempDir.createSync("@omp-resume-rehydrated-persona-");
		const { cwd, sessionFile, sessionDir } = await createPersonaResumeFixture(
			tempDir,
			"resume-rehydrated",
			"persona-x",
		);
		const manager = await SessionManager.open(sessionFile, sessionDir);
		const authStorage = await AuthStorage.create(tempDir.join("agent-auth.db"));
		const persona = {
			name: "persona-x",
			description: "A persona",
			systemPrompt: "You are persona x.",
			model: ["anthropic/claude-sonnet-4-5"],
			thinkingLevel: ThinkingLevel.High,
			source: "bundled" as const,
		};
		try {
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [persona],
				projectAgentsDir: null,
			});
			const parsed = parseArgs(["--cwd", cwd, "--continue"]);

			const options = await buildSessionOptions(
				parsed,
				[],
				manager,
				new ModelRegistry(authStorage, tempDir.join("models.yml")),
				Settings.isolated({ "marketplace.autoUpdate": "off" }),
			);

			// Rehydrated from the transcript: persona frontmatter must not override
			// the transcript's own model/thinking entries (thread main.ts:1147).
			expect(options.agentPersona).toBe(persona);
			expect(options.model).toBeUndefined();
			expect(options.thinkingLevel).toBeUndefined();
		} finally {
			authStorage.close();
		}
	});

	it("applies an explicit --agent persona's model/thinking on resume", async () => {
		using tempDir = TempDir.createSync("@omp-resume-explicit-agent-");
		const { cwd, sessionFile, sessionDir } = await createPersonaResumeFixture(
			tempDir,
			"resume-explicit",
			"persona-x",
		);
		const manager = await SessionManager.open(sessionFile, sessionDir);
		const authStorage = await AuthStorage.create(tempDir.join("agent-auth.db"));
		const persona = {
			name: "persona-x",
			description: "A persona",
			systemPrompt: "You are persona x.",
			model: ["anthropic/claude-sonnet-4-5"],
			thinkingLevel: ThinkingLevel.High,
			source: "bundled" as const,
		};
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [persona],
				projectAgentsDir: null,
			});
			const parsed = parseArgs(["--cwd", cwd, "--continue", "--agent", "persona-x"]);

			const options = await buildSessionOptions(
				parsed,
				[],
				manager,
				new ModelRegistry(authStorage, tempDir.join("models.yml")),
				Settings.isolated({ "marketplace.autoUpdate": "off" }),
			);

			// Explicit --agent on a resume is a fresh selection: its frontmatter
			// model/thinking apply (thread main.ts:1068).
			expect(options.agentPersona).toBe(persona);
			expect(options.model).toBeDefined();
			expect(options.model?.provider).toBe("anthropic");
			expect(options.thinkingLevel).toBe(ThinkingLevel.High);
		} finally {
			authStorage.close();
		}
	});

	it("prefers the persona's model over the remembered scoped default", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-persona-model-");
		const source = await createSourceSessionFixture(tempDir, "parent-cache-persona-model");
		const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey(OPENAI_TEST_MODEL.provider, "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const persona = {
			name: "model-persona",
			description: "Persona with a model",
			systemPrompt: "You are model-persona.",
			model: ["anthropic/claude-sonnet-4-5"],
			source: "bundled" as const,
		};
		try {
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [persona],
				projectAgentsDir: null,
			});
			const parsed = parseArgs(["--cwd", source.cwd, "--agent", "model-persona"]);
			const scopedModels: ScopedModel[] = [{ model: OPENAI_TEST_MODEL, explicitThinkingLevel: false }];
			const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
			settings.setModelRole("default", `${OPENAI_TEST_MODEL.provider}/${OPENAI_TEST_MODEL.id}`);

			const options = await buildSessionOptions(
				parsed,
				scopedModels,
				forkedManager,
				new ModelRegistry(authStorage, tempDir.join("models.yml")),
				settings,
			);

			// The persona is an explicit selection: its model frontmatter wins
			// over the remembered scoped default (thread main.ts:1042).
			expect(options.model?.provider).toBe("anthropic");
		} finally {
			authStorage.close();
		}
	});

	it("keeps an inline --model thinking suffix over persona thinking frontmatter", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-thinking-suffix-");
		const source = await createSourceSessionFixture(tempDir, "parent-cache-thinking-suffix");
		const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey(OPENAI_TEST_MODEL.provider, "test-key");
		const persona = {
			name: "high-thinking-persona",
			description: "Persona with high thinking",
			systemPrompt: "You are high-thinking-persona.",
			thinkingLevel: ThinkingLevel.High,
			source: "bundled" as const,
		};
		try {
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [persona],
				projectAgentsDir: null,
			});
			// `slow:low` — an explicit inline thinking suffix on --model.
			const parsed = parseArgs(["--cwd", source.cwd, "--agent", "high-thinking-persona", "--model", "slow:low"]);

			const options = await buildSessionOptions(
				parsed,
				[],
				forkedManager,
				new ModelRegistry(authStorage, tempDir.join("models.yml")),
				Settings.isolated({ "marketplace.autoUpdate": "off" }),
			);

			// The explicit CLI model's :low suffix must not be clobbered by the
			// persona's thinkingLevel (thread main.ts:1146).
			expect(options.cliThinkingLocked).toBe(true);
			expect(options.thinkingLevel).toBe(ThinkingLevel.Low);
		} finally {
			authStorage.close();
		}
	});

	it("does not inherit the provider prompt-cache key when an SDK fork changes the persona", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-sdk-persona-");
		const source = await createPersonaRecordedSessionFixture(
			tempDir,
			"parent-cache-sdk-persona",
			"old-persona",
			"user",
		);
		const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const created = await createMinimalSession(tempDir, {
				cwd: source.cwd,
				sessionManager: forkedManager,
				agentPersona: {
					name: "new-persona",
					description: "New persona",
					systemPrompt: "You are new-persona.",
					source: "project" as const,
				},
			});
			session = created.session;
			authStorage = created.authStorage;

			// The transcript recorded user/old-persona; the SDK call switches to
			// project/new-persona, so the inherited header cache key must be
			// dropped (thread sdk.ts:1702).
			expect(session.agent.promptCacheKey).toBeUndefined();
		} finally {
			await session?.dispose();
			authStorage?.close();
		}
	});

	it("drops the fork-inherited prompt-cache key when the resumed persona's fingerprint changed", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-fp-change-");
		const persona = {
			name: "fp-persona",
			description: "Persona",
			systemPrompt: "Original prompt.",
			source: "bundled" as const,
		};
		const { cwd, sessionFile, sessionDir } = await createPersonaResumeFixture(
			tempDir,
			"fp-change-session",
			"fp-persona",
			fingerprintAgentContent(persona),
		);
		const forkedManager = await SessionManager.forkFrom(sessionFile, cwd, sessionDir);
		// The CLI resume path pre-copies the header key into options with source
		// "fork" before the persona rehydrates; simulate that here.
		expect(forkedManager.getHeader()?.providerPromptCacheKey).toBe("fp-change-session");
		const authStorage = await AuthStorage.create(tempDir.join("fp-auth.db"));
		let session: AgentSession | undefined;
		try {
			// The persona file changed since the transcript was saved: same name/source,
			// different content fingerprint. The fork-sourced cache key is stale and
			// must not survive (thread sdk.ts:1423).
			const created = await createMinimalSession(tempDir, {
				cwd,
				sessionManager: forkedManager,
				providerPromptCacheKey: forkedManager.getHeader()?.providerPromptCacheKey,
				providerPromptCacheKeySource: "fork",
				agentPersona: {
					...persona,
					systemPrompt: "Edited prompt.",
				},
			});
			session = created.session;
			expect(session.agent.promptCacheKey).toBeUndefined();
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	});

	it("drops the fork-inherited prompt-cache key when the persisted persona has no fingerprint", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-no-fp-");
		const persona = {
			name: "legacy-persona",
			description: "Persona",
			systemPrompt: "Legacy prompt.",
			source: "bundled" as const,
		};
		// Legacy transcript: agent_change written without a content fingerprint.
		const { cwd, sessionFile, sessionDir } = await createPersonaResumeFixture(
			tempDir,
			"legacy-fp-session",
			"legacy-persona",
		);
		const forkedManager = await SessionManager.forkFrom(sessionFile, cwd, sessionDir);
		const authStorage = await AuthStorage.create(tempDir.join("legacy-auth.db"));
		let session: AgentSession | undefined;
		try {
			// An undefined persisted fingerprint is unknown content — the inherited
			// key must be dropped rather than trusted (thread sdk.ts:1389).
			const created = await createMinimalSession(tempDir, {
				cwd,
				sessionManager: forkedManager,
				providerPromptCacheKey: forkedManager.getHeader()?.providerPromptCacheKey,
				providerPromptCacheKeySource: "fork",
				agentPersona: persona,
			});
			session = created.session;
			expect(session.agent.promptCacheKey).toBeUndefined();
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	});

	it("drops the fork-inherited prompt-cache key when the persisted persona cannot be rehydrated", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-unresolved-persona-");
		// Transcript records bundled/gone-persona, but the definition was deleted
		// (or disabled / switched to subagent-only) since: startup rehydrates
		// nothing, so the prompt and tool set are rebuilt without the persona.
		const { cwd, sessionFile, sessionDir } = await createPersonaResumeFixture(
			tempDir,
			"unresolved-persona-session",
			"gone-persona",
			"stale-fingerprint",
		);
		const forkedManager = await SessionManager.forkFrom(sessionFile, cwd, sessionDir);
		expect(forkedManager.getHeader()?.providerPromptCacheKey).toBe("unresolved-persona-session");
		const authStorage = await AuthStorage.create(tempDir.join("unresolved-auth.db"));
		let session: AgentSession | undefined;
		try {
			// No agentPersona passed and discovery would resolve none: the
			// recorded-but-unresolvable persona is still cache-changing, so the
			// fork-sourced key must be dropped (thread sdk.ts:1385).
			const created = await createMinimalSession(tempDir, {
				cwd,
				sessionManager: forkedManager,
				providerPromptCacheKey: forkedManager.getHeader()?.providerPromptCacheKey,
				providerPromptCacheKeySource: "fork",
			});
			session = created.session;
			expect(session.agent.promptCacheKey).toBeUndefined();
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	});
});
