import type { ToolSession } from "../tools";
import { getDiscoveredAgentsSnapshot } from "./discovery-snapshot";
import type { AgentDefinition } from "./types";

/** Default agent used when a session has unrestricted spawning. */
export const DEFAULT_SPAWN_AGENT = "task";

/** Spawn policy derived from a parent agent's `spawns` frontmatter. */
export interface ResolvedSpawnPolicy {
	/** True when at least one subagent may be spawned. */
	enabled: boolean;
	/** Agent used when the caller omits the agent field. */
	defaultAgent: string;
	/** Explicitly allowed agents, or `null` when the policy is unrestricted. */
	allowedAgents: readonly string[] | null;
	/** Text used in spawn rejection messages. */
	allowedErrorText: string;
	/** Backtick-quoted explicit agents for prompt descriptions. */
	allowedPromptText?: string;
}

/** Resolves spawn frontmatter into the default and prompt/error surfaces. */
export function resolveSpawnPolicy(parentSpawns: string | boolean | null | undefined): ResolvedSpawnPolicy {
	let normalized: string;
	if (parentSpawns === false) {
		normalized = "";
	} else if (parentSpawns === true || parentSpawns === null || parentSpawns === undefined) {
		normalized = "*";
	} else {
		normalized = parentSpawns.trim();
	}

	if (normalized === "*") {
		return {
			enabled: true,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents: null,
			allowedErrorText: "*",
		};
	}

	const allowedAgents = normalized
		.split(",")
		.map(spawn => spawn.trim())
		.filter(Boolean);
	if (allowedAgents.length === 0) {
		return {
			enabled: false,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents,
			allowedErrorText: "none (spawns disabled for this agent)",
		};
	}

	return {
		enabled: true,
		defaultAgent: allowedAgents[0] ?? DEFAULT_SPAWN_AGENT,
		allowedAgents,
		allowedErrorText: allowedAgents.join(","),
		allowedPromptText: allowedAgents.map(agent => `\`${agent}\``).join(", "),
	};
}

/**
 * Whether the `scout` agent is spawnable in a session: not disabled via
 * `task.disabledAgents`, and permitted by the session spawn policy.
 */
export function isScoutSpawnable(
	disabledAgents: readonly string[] | undefined,
	spawns: string | boolean | null | undefined,
): boolean {
	if (disabledAgents?.includes("scout")) return false;
	const policy = resolveSpawnPolicy(spawns);
	if (!policy.enabled) return false;
	return policy.allowedAgents === null || policy.allowedAgents.includes("scout");
}

/**
 * Whether the `scout` agent is both permitted by the spawn policy AND
 * actually spawnable in the current discovery: the resolved definition must
 * exist and not be primary-only. A user/project `mode: primary` scout shadows
 * the bundled one (discovery dedupes by name + precedence), so the name-based
 * policy alone can advertise a scout that every spawn attempt rejects.
 */
export function isSpawnableScoutInAgents(
	agents: readonly AgentDefinition[],
	disabledAgents: readonly string[] | undefined,
	spawns: string | boolean | null | undefined,
): boolean {
	if (!isScoutSpawnable(disabledAgents, spawns)) return false;
	const scout = agents.find(agent => agent.name === "scout");
	return scout !== undefined && scout.availability !== "primary";
}

/**
 * Scout availability for a live session's tool descriptions. Uses the memoized
 * discovery snapshot (same definitions the task tool advertises) when one is
 * available, falling back to the name-only policy until discovery lands.
 */
export function scoutAvailableForSession(session: ToolSession): boolean {
	const disabledAgents = session.settings.get("task.disabledAgents") as string[] | undefined;
	const spawns = session.getSessionSpawns?.() ?? "*";
	return scoutAvailableFromState(
		disabledAgents,
		spawns,
		session.cwd,
		session.getExtensionDiscoveryMode?.(),
		session.extensionRoots,
	);
}

/**
 * Shared core of the scout-availability checks: spawn policy + disabledAgents
 * gate, then the memoized discovery snapshot (falling back to "allowed" until
 * discovery lands). Single source of truth for the system-prompt/plan-mode/
 * workflow-notice advertisement (AgentSession.#isScoutAvailable) and the
 * tool-description advertisements (scoutAvailableForSession) so the two
 * surfaces cannot drift.
 */
export function scoutAvailableFromState(
	disabledAgents: readonly string[] | undefined,
	spawns: string | boolean | null | undefined,
	cwd: string,
	extensionMode: "explicit-only" | "merge" | undefined,
	extensionRoots: readonly string[] | undefined,
): boolean {
	if (!isScoutSpawnable(disabledAgents, spawns)) return false;
	const agents = getDiscoveredAgentsSnapshot(cwd, extensionMode ?? "merge", extensionRoots);
	if (agents === undefined) return true;
	const scout = agents.find(agent => agent.name === "scout");
	return scout !== undefined && scout.availability !== "primary";
}
