/**
 * Regression test for issue #1234.
 *
 * `omp acp` must not auto-discover host `.mcp.json` servers when creating a
 * session for an ACP client. MCP server ownership belongs entirely to the ACP
 * client (`session/new.mcpServers` → `AcpAgent#configureMcpServers`); letting
 * `createAgentSession` run on-disk discovery in parallel registers host MCP
 * tools that shadow the client-supplied ones in the session tool registry.
 *
 * The contract enforced here is narrow on purpose: every call routed through
 * the ACP session factory must reach `createAgentSession` with
 * `enableMCP: false`, regardless of what `baseOptions` carries.
 */

import { describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("createAcpSessionFactory MCP isolation (issue #1234)", () => {
	it("forces enableMCP=false even when baseOptions opts in", async () => {
		const tempDir = TempDir.createSync("@pi-acp-mcp-isolation-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({});
			const fakeSession = {} as AgentSession;
			const captured: CreateAgentSessionOptions[] = [];
			const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				};
			};

			// baseOptions deliberately sets enableMCP=true to prove the factory ignores it.
			const factory = createAcpSessionFactory({
				baseOptions: { enableMCP: true } as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: {},
				rawArgs: [],
				createSession,
			});

			const result = await factory(tempDir.path());
			expect(result).toBe(fakeSession);
			expect(captured).toHaveLength(1);
			expect(captured[0].enableMCP).toBe(false);
		} finally {
			try {
				authStorage?.close();
			} finally {
				await Bun.sleep(0);
				await tempDir.remove();
			}
		}
	});

	it("shares the trusted extension EventBus with the ACP session", async () => {
		const tempDir = TempDir.createSync("@pi-acp-trusted-extension-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({});
			const trustedPath = tempDir.join("trusted.ts");
			const firedPath = tempDir.join("trusted-event-fired");
			const ambientFiredPath = tempDir.join("ambient-extension-loaded");
			await Bun.write(
				tempDir.join(".omp/extensions/ambient.ts"),
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ambientFiredPath)}, "loaded"); export default function () {}`,
			);
			await Bun.write(
				trustedPath,
				`import { writeFileSync } from "node:fs"; export default function (pi) { pi.events.on("acp-session-live", () => writeFileSync(${JSON.stringify(firedPath)}, "fired")); }`,
			);
			let captured: CreateAgentSessionOptions | undefined;
			const fakeSession = {} as AgentSession;
			const factory = createAcpSessionFactory({
				baseOptions: {
					disableExtensionDiscovery: true,
					additionalExtensionPaths: [trustedPath],
				} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: { trustedExtensions: [trustedPath] },
				rawArgs: [],
				createSession: async options => {
					captured = options;
					options.eventBus?.emit("acp-session-live", undefined);
					return {
						session: fakeSession,
						extensionsResult: options.preloadedExtensions,
						setToolUIContext: () => {},
						eventBus: options.eventBus,
					} as CreateAgentSessionResult;
				},
			});

			await factory(tempDir.path());

			expect(captured?.eventBus).toBeDefined();
			expect(captured?.preloadedExtensions?.extensions).toHaveLength(1);
			expect(await Bun.file(firedPath).text()).toBe("fired");
			expect(await Bun.file(ambientFiredPath).exists()).toBe(false);
		} finally {
			try {
				authStorage?.close();
			} finally {
				await tempDir.remove();
			}
		}
	});

	it("fails before ACP session creation when a trusted extension cannot load", async () => {
		const tempDir = TempDir.createSync("@pi-acp-trusted-extension-failure-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({});
			const trustedPath = tempDir.join("throwing.ts");
			await Bun.write(trustedPath, 'throw new Error("trusted extension fixture");');
			let createCalls = 0;
			const factory = createAcpSessionFactory({
				baseOptions: {
					disableExtensionDiscovery: true,
					additionalExtensionPaths: [trustedPath],
				} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: { trustedExtensions: [trustedPath] },
				rawArgs: [],
				createSession: async () => {
					createCalls++;
					throw new Error("must not create ACP session");
				},
			});

			await expect(factory(tempDir.path())).rejects.toThrow(/Trusted extension failed to load.*fixture/);
			expect(createCalls).toBe(0);
		} finally {
			try {
				authStorage?.close();
			} finally {
				await tempDir.remove();
			}
		}
	});
});

describe("createAcpSessionFactory TITLE_SYSTEM.md per-cwd resolution (PR #3736)", () => {
	it("re-resolves the title prompt for the per-session cwd instead of inheriting the launch cwd's override", async () => {
		const tempDir = TempDir.createSync("@pi-acp-title-prompt-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({});

			const projectDir = tempDir.join("project");
			await Bun.write(`${projectDir}/.omp/TITLE_SYSTEM.md`, "Project-specific title policy.");

			const fakeSession = {} as AgentSession;
			const captured: CreateAgentSessionOptions[] = [];
			const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				};
			};

			// baseOptions carries the LAUNCH cwd's prompt; the factory must
			// override it with the per-session cwd's `TITLE_SYSTEM.md`.
			const factory = createAcpSessionFactory({
				baseOptions: {
					titleSystemPrompt: "Launch-cwd policy that must not leak.",
				} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: {},
				rawArgs: [],
				createSession,
			});

			await factory(projectDir);

			expect(captured).toHaveLength(1);
			expect(captured[0].titleSystemPrompt).toBe("Project-specific title policy.");
		} finally {
			try {
				authStorage?.close();
			} finally {
				await Bun.sleep(0);
				await tempDir.remove();
			}
		}
	});
});

describe("createAcpSessionFactory per-cwd persona re-resolution (codex 3742806342)", () => {
	it("re-resolves an explicit --agent persona against the per-session cwd", async () => {
		const tempDir = TempDir.createSync("@pi-acp-persona-reresolve-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({});

			const targetDir = tempDir.join("target-project");
			// The target project shadows `scout` with a project-scoped
			// definition; a launch-cwd-resolved persona would miss it.
			await Bun.write(
				`${targetDir}/.omp/agents/scout.md`,
				'---\nname: scout\ndescription: Target-project scout persona\nmode: primary\nmodel: "@smol"\n---\n',
			);

			const fakeSession = {} as AgentSession;
			const captured: CreateAgentSessionOptions[] = [];
			const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				};
			};

			// baseOptions carries the LAUNCH-cwd `scout` definition; the
			// factory must re-resolve the --agent persona against the
			// per-session cwd and derive the model pattern from it.
			const factory = createAcpSessionFactory({
				baseOptions: {
					agentPersona: {
						name: "scout",
						description: "Launch-cwd scout",
						systemPrompt: "",
						source: "bundled" as const,
					},
					toolNamesFromAgent: true,
					toolNames: ["read"],
				} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: { agent: "scout" },
				rawArgs: [],
				createSession,
			});

			await factory(targetDir);

			expect(captured).toHaveLength(1);
			// Re-resolved under the session cwd: the project-scoped scout.
			expect(captured[0].agentPersona?.source).toBe("project");
			expect(captured[0].agentPersona?.description).toBe("Target-project scout persona");
			// The persona model patterns carry over to the re-resolved policy.
			expect(captured[0].modelPattern).toEqual(["@smol"]);
		} finally {
			try {
				authStorage?.close();
			} finally {
				await Bun.sleep(0);
				await tempDir.remove();
			}
		}
	});

	it("clears launch-cwd persona state when the per-session cwd cannot resolve the --agent", async () => {
		const tempDir = TempDir.createSync("@pi-acp-persona-clear-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({});

			const targetDir = tempDir.join("target-project");
			// The launch cwd defined a project-scoped persona that does NOT
			// exist in the target workspace (and is not a bundled agent), so
			// the per-session cwd cannot resolve it.

			const fakeSession = {} as AgentSession;
			const captured: CreateAgentSessionOptions[] = [];
			const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				};
			};

			// baseOptions carries the launch-cwd persona AND its derived
			// model/tools; the target workspace cannot resolve `launch-only`, so
			// all persona-derived fields must be cleared — never run the launch
			// persona's policy in the wrong project (codex 3742931876).
			const factory = createAcpSessionFactory({
				baseOptions: {
					agentPersona: {
						name: "launch-only",
						description: "Launch-cwd persona",
						systemPrompt: "",
						source: "project" as const,
					},
					toolNamesFromAgent: true,
					toolNames: ["read"],
					model: { provider: "openai", id: "gpt-4o-mini" } as CreateAgentSessionOptions["model"],
				} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: { agent: "launch-only" },
				rawArgs: [],
				createSession,
			});

			await factory(targetDir);

			expect(captured).toHaveLength(1);
			expect(captured[0].agentPersona).toBeUndefined();
			expect(captured[0].toolNames).toBeUndefined();
			expect(captured[0].toolNamesFromAgent).toBeUndefined();
			expect(captured[0].model).toBeUndefined();
			expect(captured[0].modelPattern).toBeUndefined();
		} finally {
			try {
				authStorage?.close();
			} finally {
				await Bun.sleep(0);
				await tempDir.remove();
			}
		}
	});
});
