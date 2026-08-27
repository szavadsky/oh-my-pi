import type { ConfiguredThinkingLevel } from "../thinking";
import type { AgentDefinition } from "./types";

export interface AgentSessionPolicy {
	/** Tool names to activate (undefined = keep current set). */
	toolNames?: string[];
	/** Spawn allowlist serialized for ToolSession.getSessionSpawns (undefined = keep current). */
	spawns?: string;
	/** Model pattern(s) from frontmatter (undefined = keep current). */
	modelPatterns?: string[];
	/** Thinking level from frontmatter (undefined = keep current). */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Agent system prompt body, appended to the default prompt via appendParts. */
	systemPromptBody: string;
}

/**
 * Resolve an AgentDefinition into session-level policy fields.
 * Shared by main-agent selection and (future) subagent policy resolution.
 */
export function resolveAgentSessionPolicy(agent: AgentDefinition): AgentSessionPolicy {
	// Spawns: replicate executor.ts:2272-2278, but main persona: absent spawns → "*"
	const spawns =
		agent.spawns === undefined
			? "*"
			: agent.spawns === "*"
				? "*"
				: agent.spawns.length === 0
					? ""
					: agent.spawns.join(",");

	// Tools: replicate executor.ts:2244-2268 logic.
	// `tools: ["*"]` (or a bare `*`) is the GitHub custom-agent sentinel for
	// "all available tools" — equivalent to omitting tools. Treat it as
	// unrestricted: a literal `*` is not a registered tool name, so activation
	// would otherwise filter it out and leave only the auto-added task/hub.
	// Auto-add `task` when spawning is enabled (resolved spawns is non-empty),
	// so a persona with explicit tools but no `spawns` field can still spawn.
	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0 && !agent.tools.includes("*")) {
		toolNames = [...agent.tools];
		// `yield` is auto-added by parseAgentFields for non-primary agents
		// (helpers.ts:271) but has no meaningful behavior in the main session.
		toolNames = toolNames.filter(n => n !== "yield");
		// `exec` is a subagent pseudo-tool (executor.ts expands it into bash +
		// eval); it is not a registered tool name, so activation would silently
		// drop it. Expand it the same way for the main persona (eval gates its
		// own backends at execution time).
		if (toolNames.includes("exec")) {
			const expanded = toolNames.filter(n => n !== "exec");
			expanded.push("bash", "eval");
			toolNames = Array.from(new Set(expanded));
		}
		if (spawns && spawns !== "" && !toolNames.includes("task")) {
			toolNames = [...toolNames, "task"];
		}
		if (!toolNames.includes("hub")) {
			toolNames = [...toolNames, "hub"];
		}
	}

	return {
		toolNames,
		spawns,
		modelPatterns: agent.model,
		thinkingLevel: agent.thinkingLevel,
		systemPromptBody: agent.systemPrompt,
	};
}

/**
 * Fingerprint the content of an agent definition: everything that shapes the
 * session's system prompt, tool set, model, or thinking (system prompt body,
 * tools, model patterns, thinking level, spawns policy). Used to detect that a
 * persona's content changed between saves without its name/source changing, so
 * the inherited provider prompt-cache key can be dropped on resume. Spawns are
 * included because the task/scout prompt text is built from the spawn policy —
 * a spawns-only edit must invalidate the cache too (codex 3741758350).
 */
export function fingerprintAgentContent(agent: AgentDefinition): string {
	const policy = resolveAgentSessionPolicy(agent);
	return String(
		Bun.hash(
			[
				policy.systemPromptBody,
				...(policy.toolNames ? [...policy.toolNames].sort() : []),
				...(policy.modelPatterns ? [...policy.modelPatterns] : []),
				policy.thinkingLevel ?? "",
				policy.spawns ?? "",
			].join("\u0000"),
		),
	);
}
