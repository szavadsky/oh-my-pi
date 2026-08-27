import * as path from "node:path";
import type { AgentDefinition } from "./types";

export type ExtensionDiscoveryMode = "explicit-only" | "merge";

/**
 * Memoized agent definitions per (cwd, extension mode, explicit extension
 * roots), published by the task tool's discovery pipeline
 * (`discoverAgentsForCreate` / `refreshAgentDiscovery`). Lives in its own
 * module so both the task barrel and the prompt-side scout-availability
 * checks (tools, sdk) can read the same snapshot the task tool advertises
 * without a task↔tools import cycle.
 *
 * Keyed by extension mode and explicit roots as well as cwd: an
 * `--no-extensions` session (`explicit-only`) suppresses ambient
 * marketplace-plugin and OMP settings/installed roots, and SDK sessions that
 * pass explicit extension packages must keep seeing exactly those roots when
 * discovery re-runs after the construction-time invocation scope is gone.
 */
const discoverySnapshots = new Map<string, AgentDefinition[]>();

function snapshotKey(
	cwd: string,
	extensionMode: ExtensionDiscoveryMode,
	extensionRoots: readonly string[] = [],
): string {
	// Resolve raw spellings against the cwd so equivalent relative/absolute
	// spellings collapse to one key.
	const roots = extensionRoots.map(raw => path.resolve(cwd, raw)).join(";");
	return `${path.resolve(cwd)}\0${extensionMode}\0${roots}`;
}

/** Definitions snapshot for a cwd, or undefined before discovery completes. */
export function getDiscoveredAgentsSnapshot(
	cwd: string,
	extensionMode: ExtensionDiscoveryMode = "merge",
	extensionRoots: readonly string[] = [],
): AgentDefinition[] | undefined {
	return discoverySnapshots.get(snapshotKey(cwd, extensionMode, extensionRoots));
}

/** Publish a completed discovery result for a cwd. */
export function setDiscoveredAgentsSnapshot(
	cwd: string,
	agents: AgentDefinition[],
	extensionMode: ExtensionDiscoveryMode = "merge",
	extensionRoots: readonly string[] = [],
): void {
	discoverySnapshots.set(snapshotKey(cwd, extensionMode, extensionRoots), agents);
}

/** Drop all cached snapshots (discovery binding changes / explicit reloads). */
export function clearDiscoveredAgentSnapshots(): void {
	discoverySnapshots.clear();
}

/**
 * Drop every snapshot for a cwd (any extension mode / roots tuple). A
 * plugin/skill reload changes what discovery resolves for the cwd across all
 * scopes, so live sessions with a different mode/roots tuple must not keep
 * advertising the pre-reload definitions.
 */
export function clearDiscoveredAgentSnapshotsForCwd(cwd: string): void {
	const resolved = path.resolve(cwd);
	for (const key of discoverySnapshots.keys()) {
		if (key.startsWith(`${resolved}\0`)) discoverySnapshots.delete(key);
	}
}
