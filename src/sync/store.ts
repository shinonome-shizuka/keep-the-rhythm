import { getDB } from "../db/db";
import type { DailyActivity } from "../db/types";
import {
	addToRow,
	liveDeltas,
	materialize,
	rowKey,
	validateDelta,
} from "./model";
import type { Delta, SyncConfig, SyncEvent, SyncReply } from "./model";

export type Transport = (
	config: SyncConfig,
	endpoint: string,
	body: unknown,
) => Promise<SyncReply>;

export class SyncStore {
	config: SyncConfig | null = null;
	status = "Local storage";
	draft: { url: string; token: string; vaultId: string } | null = null;
	private running: Promise<void> | null = null;
	private stopped = false;
	constructor(
		private transport: Transport,
		private refresh: () => void,
		private db = getDB(),
	) {}
	get active() {
		return this.config?.active === true;
	}

	async meta<T>(key: string): Promise<T | undefined> {
		return (await this.db.syncMeta.get(key))?.value as T | undefined;
	}
	async setMeta(key: string, value: unknown) {
		await this.db.syncMeta.put({ key, value });
	}
	async load() {
		this.config = (await this.meta<SyncConfig>("config")) ?? null;
		this.draft =
			(await this.meta<{ url: string; token: string; vaultId: string }>(
				"connectionDraft",
			)) ??
			(this.config
				? {
						url: this.config.url,
						token: this.config.token,
						vaultId: this.config.vaultId,
					}
				: null);
	}

	async saveDraft(
		patch: Partial<{ url: string; token: string; vaultId: string }>,
	) {
		this.draft = {
			url: "",
			token: "",
			vaultId: "writing",
			...this.draft,
			...patch,
		};
		await this.setMeta("connectionDraft", { ...this.draft });
	}

	async initialize(rows: DailyActivity[]) {
		const config = this.config;
		if (!config) return;
		if (!config.active) {
			if (config.mode === "create") {
				for (const row of rows)
					for (const change of row.changes.length
						? row.changes
						: [{ timeKey: "00:00", w: 0, c: 0 }])
						validateDelta({ ...row, ...change });
				// Become durable locally before any network request. Even a lost
				// bootstrap response or an offline first start cannot lose new edits.
				const seed: SyncEvent = {
					id: "seed",
					clock: 0,
					kind: "seed",
					rows: rows.map(({ id: _id, ...row }) => row),
				};
				await this.db.transaction(
					"rw",
					this.db.syncMeta,
					this.db.syncEvents,
					async () => {
						await this.db.syncEvents.clear();
						await this.db.syncEvents.put({
							id: "seed",
							pending: 0,
							event: seed,
						});
						await this.setMeta("seed", seed);
						await this.setMeta("bootstrapDone", false);
						await this.setMeta("cursor", 0);
						await this.setMeta("clock", 0);
						await this.setMeta("config", {
							...config,
							active: true,
						});
					},
				);
				this.config = { ...config, active: true };
				this.status = "History saved locally; waiting for first upload";
				return;
			}
			// Verify and download ALL pages before switching away from local data.
			let cursor = 0;
			const events: SyncEvent[] = [];
			let reply: SyncReply;
			do {
				reply = await this.transport(config, "/v1/sync", {
					vaultId: config.vaultId,
					cursor,
					events: [],
				});
				events.push(...reply.events.map((item) => item.event));
				cursor = reply.cursor;
			} while (reply.hasMore);
			await this.db.transaction(
				"rw",
				this.db.syncMeta,
				this.db.syncEvents,
				this.db.dailyActivity,
				async () => {
					await this.db.syncEvents.clear();
					await this.db.syncEvents.bulkPut(
						events.map((event) => ({
							id: event.id,
							pending: 0,
							event,
						})),
					);
					await this.setMeta("cursor", cursor);
					await this.setMeta(
						"clock",
						events.reduce(
							(clock, event) => Math.max(clock, event.clock),
							0,
						),
					);
					await this.setMeta("config", { ...config, active: true });
					await this.rebuild();
				},
			);
			this.config = { ...config, active: true };
		} else {
			await this.db.transaction(
				"rw",
				this.db.dailyActivity,
				this.db.syncEvents,
				() => this.rebuild(),
			);
		}
		this.status = "Ready to sync";
	}

	private async rebuild() {
		const rows = materialize(
			(await this.db.syncEvents.toArray()).map((item) => item.event),
		);
		const old = await this.db.dailyActivity.toArray();
		const ids = new Map(old.map((row) => [rowKey(row), row.id]));
		await this.db.dailyActivity.clear();
		await this.db.dailyActivity.bulkPut(
			rows.map((row) => ({ ...row, id: ids.get(rowKey(row)) })),
		);
	}

	async record(value: Delta) {
		validateDelta(value);
		await this.mutate(async (id, clock) => ({
			kind: "delta",
			id,
			clock,
			value,
		}));
	}
	async remove(filePath: string, date: string) {
		await this.mutate(async (id, clock) => ({
			kind: "remove",
			id,
			clock,
			targets: await this.targets(filePath, date),
		}));
	}
	async rename(from: string, path: string) {
		await this.mutate(async (id, clock) => ({
			kind: "rename",
			id,
			clock,
			path,
			targets: await this.targets(from),
		}));
	}
	private async targets(path: string, date?: string) {
		const events = (await this.db.syncEvents.toArray()).map(
			(item) => item.event,
		);
		return [...liveDeltas(events)]
			.filter(
				([, value]) =>
					value.filePath === path && (!date || value.date === date),
			)
			.map(([id]) => id);
	}

	private async mutate(
		make: (id: string, clock: number) => Promise<SyncEvent>,
	) {
		if (!this.active) throw new Error("Server storage is not active.");
		await this.db.transaction(
			"rw",
			this.db.syncMeta,
			this.db.syncEvents,
			this.db.dailyActivity,
			async () => {
				const clock = ((await this.meta<number>("clock")) ?? 0) + 1;
				const event = await make(crypto.randomUUID(), clock);
				await this.setMeta("clock", clock);
				await this.db.syncEvents.add({
					id: event.id,
					pending: 1,
					event,
				});
				if (event.kind === "delta") {
					const value = event.value;
					let row = await this.db.dailyActivity
						.where("[date+filePath]")
						.equals([value.date, value.filePath])
						.first();
					if (!row)
						row = {
							date: value.date,
							filePath: value.filePath,
							wordCountStart: value.wordCountStart,
							charCountStart: value.charCountStart,
							changes: [],
						};
					addToRow(row, value);
					await this.db.dailyActivity.put(row);
				} else await this.rebuild();
			},
		);
		this.refresh();
	}

	async pendingCount(): Promise<number> {
		return await this.db.syncEvents.where("pending").equals(1).count();
	}

	sync(): Promise<void> {
		if (this.stopped || !this.active) return Promise.resolve();
		if (!this.running)
			this.running = this.exchange().finally(() => {
				this.running = null;
			});
		return this.running;
	}
	private async exchange() {
		const config = this.config!;
		try {
			this.status = "Syncing";
			if (
				config.mode === "create" &&
				!(await this.meta<boolean>("bootstrapDone"))
			) {
				const seed = await this.meta<SyncEvent>("seed");
				await this.transport(config, "/v1/bootstrap", {
					vaultId: config.vaultId,
					seed,
				});
				await this.setMeta("bootstrapDone", true);
			}
			// Bound a pass so continuous typing cannot keep it alive indefinitely.
			for (let page = 0; page < 100 && !this.stopped; page++) {
				const pending = await this.db.syncEvents
					.where("pending")
					.equals(1)
					.limit(100)
					.toArray();
				const cursor = (await this.meta<number>("cursor")) ?? 0;
				const reply = await this.transport(config, "/v1/sync", {
					vaultId: config.vaultId,
					cursor,
					events: pending.map((item) => item.event),
				});
				if (this.stopped) return;
				await this.db.transaction(
					"rw",
					this.db.syncMeta,
					this.db.syncEvents,
					this.db.dailyActivity,
					async () => {
						for (const id of reply.accepted)
							await this.db.syncEvents.update(id, { pending: 0 });
						for (const { event } of reply.events)
							await this.db.syncEvents.put({
								id: event.id,
								pending: 0,
								event,
							});
						await this.setMeta("cursor", reply.cursor);
						await this.setMeta(
							"clock",
							Math.max(
								(await this.meta<number>("clock")) ?? 0,
								...reply.events.map((item) => item.event.clock),
							),
						);
						if (reply.events.length) await this.rebuild();
					},
				);
				this.refresh();
				if (!reply.hasMore && pending.length < 100) break;
			}
			const count = await this.db.syncEvents
				.where("pending")
				.equals(1)
				.count();
			this.status = count
				? `${count} changes waiting to upload`
				: `Synced at ${new Date().toLocaleTimeString()}`;
		} catch (error) {
			this.status = `Offline / sync failed: ${error instanceof Error ? error.message : "request failed"}. Changes kept on this device.`;
			throw error;
		}
	}
	async stop() {
		this.stopped = true;
		await this.running?.catch(() => undefined);
	}
}
