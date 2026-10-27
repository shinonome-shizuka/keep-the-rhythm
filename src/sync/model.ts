import type { DailyActivity, TimeEntry } from "../db/types";

export type Delta = Omit<DailyActivity, "id" | "changes"> & TimeEntry;
interface Envelope {
	id: string;
	clock: number;
}
export type SyncEvent =
	| (Envelope & { kind: "delta"; value: Delta })
	| (Envelope & { kind: "remove"; targets: string[] })
	| (Envelope & { kind: "rename"; targets: string[]; path: string })
	| (Envelope & { kind: "seed"; rows: DailyActivity[] });
export interface StoredEvent {
	id: string;
	pending: number;
	event: SyncEvent;
}
export interface SyncConfig {
	url: string;
	token: string;
	vaultId: string;
	mode: "create" | "join";
	active: boolean;
}
export interface SyncReply {
	version: 1;
	accepted: string[];
	events: { seq: number; event: SyncEvent }[];
	cursor: number;
	hasMore: boolean;
}
export const rowKey = (row: { date: string; filePath: string }) =>
	JSON.stringify([row.date, row.filePath]);

// A removal names only events that the deleting device has seen. Concurrent
// offline writing survives; repeated deletes cannot subtract the same words twice.
export function liveDeltas(events: SyncEvent[]): Map<string, Delta> {
	const deltas = new Map<string, Delta>();
	const removed = new Set<string>();
	const renamed = new Map<
		string,
		{ path: string; clock: number; id: string }
	>();
	for (const event of events) {
		if (event.kind === "delta") deltas.set(event.id, { ...event.value });
		if (event.kind === "seed")
			event.rows.forEach((row, i) => {
				const changes = row.changes.length
					? row.changes
					: [{ timeKey: "00:00", w: 0, c: 0 }];
				changes.forEach((change, j) =>
					deltas.set(`seed:${i}:${j}`, {
						date: row.date,
						filePath: row.filePath,
						wordCountStart: row.wordCountStart,
						charCountStart: row.charCountStart,
						...change,
					}),
				);
			});
		if (event.kind === "remove")
			event.targets.forEach((id) => removed.add(id));
		if (event.kind === "rename")
			event.targets.forEach((id) => {
				const previous = renamed.get(id);
				if (
					!previous ||
					event.clock > previous.clock ||
					(event.clock === previous.clock && event.id > previous.id)
				) {
					renamed.set(id, {
						path: event.path,
						clock: event.clock,
						id: event.id,
					});
				}
			});
	}
	for (const [id, delta] of deltas) {
		if (removed.has(id)) deltas.delete(id);
		else if (renamed.has(id)) delta.filePath = renamed.get(id)!.path;
	}
	return deltas;
}

export function addToRow(row: DailyActivity, delta: Delta) {
	const entry = row.changes.find(
		(change) => change.timeKey === delta.timeKey,
	);
	if (entry) {
		entry.w += delta.w;
		entry.c += delta.c;
	} else row.changes.push({ timeKey: delta.timeKey, w: delta.w, c: delta.c });
	row.changes.sort((a, b) => a.timeKey.localeCompare(b.timeKey));
}

export function materialize(events: SyncEvent[]): DailyActivity[] {
	const rows = new Map<string, DailyActivity>();
	// Stable ordering also selects a deterministic start count across devices.
	for (const [, delta] of [...liveDeltas(events)].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const key = rowKey(delta);
		let row = rows.get(key);
		if (!row) {
			row = {
				date: delta.date,
				filePath: delta.filePath,
				wordCountStart: delta.wordCountStart,
				charCountStart: delta.charCountStart,
				changes: [],
			};
			rows.set(key, row);
		}
		addToRow(row, delta);
	}
	return [...rows.values()].sort((a, b) =>
		rowKey(a).localeCompare(rowKey(b)),
	);
}

export function normalizeServerUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.username || url.password || url.search || url.hash)
		throw new Error(
			"Use a server URL without credentials, query or fragment.",
		);
	if (
		url.protocol !== "https:" &&
		!(
			url.protocol === "http:" &&
			["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
		)
	) {
		throw new Error(
			"Use HTTPS for your VPS. HTTP is allowed only on localhost.",
		);
	}
	return url.toString().replace(/\/+$/, "");
}

export function validateDelta(value: Delta) {
	if (
		![value.w, value.c, value.wordCountStart, value.charCountStart].every(
			Number.isSafeInteger,
		)
	)
		throw new Error("Counts must be whole numbers.");
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
		!Number.isFinite(Date.parse(value.date)) ||
		new Date(value.date).toISOString().slice(0, 10) !== value.date
	)
		throw new Error("Use a valid date in YYYY-MM-DD format.");
	if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.timeKey))
		throw new Error("Invalid time.");
	if (
		!value.filePath ||
		value.filePath.length > 4096 ||
		value.filePath.includes("\0")
	)
		throw new Error("Invalid file path.");
}
