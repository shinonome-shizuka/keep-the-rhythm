import {
	VpsSettingsFile,
	portableSettings,
	configForDevice,
} from "./sync/configFile";
import type { ConnectionFields } from "./sync/configFile";
import type { SyncConfig } from "./sync/model";
import { SyncStore } from "./sync/store";
import { transport } from "./sync/transport";
import { refreshActivities } from "./core/activityTracker";
import { ManualEntryModal } from "./ui/components/ManualEntry";
import {
	Plugin,
	TFile,
	TAbstractFile,
	Notice,
	moment as _moment,
} from "obsidian";

import {
	ColorConfig,
	DEFAULT_SETTINGS,
	STARTING_STATS,
	PluginData,
} from "@/defs/types";

import { invalidateAll } from "@/core/activityTracker";
import { closeDB, getDB, initDatabase } from "@/db/db";
import { EVENTS, state } from "@/core/pluginState";
import { PluginView, VIEW_TYPE } from "@/ui/views/PluginView";
import { migrateDataFromOldFormat, OldFormat } from "@/utils/migrateData";
import { SettingsTab } from "@/ui/settings/SettingsTab";
import { formatDate } from "@/utils/dateUtils";
import { checkDayChange } from "@/core/activityTracker";

import * as events from "@/core/events";
import * as codeBlocks from "@/core/codeBlocks";
import {
	checkPreviousStreak,
	activateSidebarView,
	insertCustomCodeBlock,
} from "@/core/commands";
import { CUSTOM_CODE_BLOCK_COMMANDS } from "@/core/codeBlockTemplates";

const moment = _moment as unknown as typeof _moment.default;

export default class KeepTheRhythm extends Plugin {
	data: PluginData = {
		schema: "0.2",
		settings: DEFAULT_SETTINGS,
		stats: {
			dailyActivity: [],
		},
	};

	cloud!: SyncStore;
	vpsSettingsFile!: VpsSettingsFile;
	private work: Promise<void> = Promise.resolve();
	private closing = false;
	private syncStatusEl: HTMLElement | null = null;

	private enqueue(action: () => Promise<void>) {
		if (this.closing) return;
		this.work = this.work.then(action).catch((error: unknown) => {
			console.error("KTR: Could not save activity", error);
			new Notice(
				"Could not save activity. Check available device storage.",
			);
		});
	}

	private JSON_DEBOUNCE_TIME = 1000;
	private LAST_BREAKING_CHANGE_TO_SCHEMA = "0.2";

	private JsonDebounceTimeout: number | null = null;

	async onload() {
		state.setPlugin(this);
		await initDatabase();
		this.cloud = new SyncStore(transport, () => {
			refreshActivities();
			state.emit(EVENTS.REFRESH_EVERYTHING);
		});
		await this.cloud.load();
		this.vpsSettingsFile = new VpsSettingsFile(
			this.app.vault.adapter,
			`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/vps-settings.json`,
		);
		try {
			const shared = await this.vpsSettingsFile.read();
			if (shared) {
				if (shared.connection) {
					const config = configForDevice(
						shared.connection,
						this.cloud.config,
					);
					await this.cloud.setMeta("config", config);
				}
				if (shared.draft) await this.cloud.saveDraft(shared.draft);
				await this.cloud.load();
			} else await this.saveVpsSettingsFile();
		} catch {
			new Notice(
				"无法读取 VPS 配置文件，已保留当前设备的连接。请检查 vps-settings.json。",
			);
		}
		this.syncStatusEl = this.addStatusBarItem();

		this.registerInterval(
			window.setInterval(() => {
				checkDayChange();
			}, 30_000),
		);
		this.registerDomEvent(document, "visibilitychange", () =>
			checkDayChange(),
		);

		// todo: check if this is really necessary
		if (!this.cloud.active) await getDB().dailyActivity.clear();

		/////////
		const loadedData = (
			this.cloud.active
				? ((await this.cloud.meta<PluginData>("pluginData")) ??
					(await this.loadData()))
				: await this.loadData()
		) as PluginData | null;

		if (loadedData && !this.cloud.active) {
			// add setting to remove backups
			try {
				await this.backupDataToVaultFolder(loadedData);
			} catch (err) {
				console.error("KTR Error trying to create backup: ", err);
			}
		}

		/** Data is only loaded into dexie if it's the correct schema */
		if (
			loadedData &&
			loadedData.schema == this.LAST_BREAKING_CHANGE_TO_SCHEMA
		) {
			if (this.cloud.active) {
				this.data.settings = {
					...DEFAULT_SETTINGS,
					...loadedData.settings,
				};
				this.data.stats = { ...STARTING_STATS };
			} else await this.initializeDataFromJSON(loadedData);
		} else if (
			loadedData &&
			loadedData.schema !== this.LAST_BREAKING_CHANGE_TO_SCHEMA
		) {
			new Notice("KTR: Migrating data from previous versions...");
			await this.migrateDataFromJSON(loadedData);
		} else if (!loadedData) {
			this.data.schema = this.LAST_BREAKING_CHANGE_TO_SCHEMA;
			this.data.stats = {
				...STARTING_STATS,
			};
		} else {
			this.data.stats = loadedData.stats;
			this.data.settings = loadedData.settings;
		}

		if (this.cloud.config) {
			try {
				const rows = await getDB().dailyActivity.toArray();
				if (!this.cloud.active) {
					const folder = ".keep-the-rhythm";
					if (!(await this.app.vault.adapter.exists(folder)))
						await this.app.vault.adapter.mkdir(folder);
					await this.app.vault.adapter.write(
						`${folder}/pre-vps-${Date.now()}.json`,
						JSON.stringify(
							{
								...this.data,
								stats: {
									...this.data.stats,
									dailyActivity: rows,
								},
							},
							null,
							2,
						),
					);
				}
				await this.cloud.initialize(rows);
			} catch (error) {
				new Notice(
					"Could not join server history. Local records are unchanged. Check server settings and reload.",
				);
				console.error("KTR server initialization failed", error);
			}
		}

		await this.persistData();

		// #endregion

		state.setToday();

		void this.checkVaultCountStaleness();

		// /** Set of utility functions that registers required objects and sets plugin state */

		/** Initialize SIDEBAR view */
		this.registerView(VIEW_TYPE, (leaf) => {
			return new PluginView(leaf, this);
		});

		this.initializeCommands();
		this.initializeEvents();
		this.applyColorStyles();
		this.addSettingTab(new SettingsTab(this.app, this));

		/** Registers CUSTOM CODE BLOCKS */
		this.registerMarkdownCodeBlockProcessor(
			"ktr-heatmap",
			codeBlocks.createHeatmapCodeBlock,
		);

		this.registerMarkdownCodeBlockProcessor(
			"ktr-slots",
			codeBlocks.createSlotsCodeBlock,
		);

		this.registerMarkdownCodeBlockProcessor(
			"ktr-entries",
			codeBlocks.createEntriesCodeBlock,
		);

		const onRefresh = () => {
			if (this.JsonDebounceTimeout) {
				window.clearTimeout(this.JsonDebounceTimeout);
			}

			this.JsonDebounceTimeout = window.setTimeout(() => {
				void this.saveDataToJSON();
			}, this.JSON_DEBOUNCE_TIME);
		};
		state.on(EVENTS.REFRESH_EVERYTHING, onRefresh);
		this.register(() => state.off(EVENTS.REFRESH_EVERYTHING, onRefresh));
		this.registerInterval(
			window.setInterval(() => {
				void this.cloud.sync().catch(() => undefined);
			}, 30_000),
		);
		this.registerInterval(
			window.setInterval(() => {
				this.syncStatusEl?.setText(
					this.cloud.active ? `KTR: ${this.cloud.status}` : "",
				);
			}, 1000),
		);
		void this.cloud.sync().catch(() => undefined);
	}

	private async checkVaultCountStaleness() {
		if (
			this.data.stats?.wholeVaultWordCount !== undefined &&
			this.data.stats?.wholeVaultCharCount !== undefined
		) {
			const recentActivity = await getDB()
				.dailyActivity.orderBy("date")
				.reverse()
				.first();

			if (recentActivity) {
				const daysSinceLastActivity = moment().diff(
					moment(recentActivity.date),
					"days",
				);
				if (daysSinceLastActivity > 7) {
					this.data.stats.wholeVaultWordCount = undefined;
					this.data.stats.wholeVaultCharCount = undefined;
					await this.persistData();
				}
			}
		}
	}
	private async backupDataToVaultFolder(data: PluginData) {
		if (this.cloud?.active) return;
		const backupConfig =
			data.settings.backupConfig || this.data.settings.backupConfig;

		// Check if backups are enabled
		if (!backupConfig.enabled) {
			return;
		}

		const folderPath = backupConfig.folderPath || ".keep-the-rhythm";
		const fileName = `backup-${formatDate(new Date())}-${data.schema}.json`;
		const backupPath = `${folderPath}/${fileName}`;
		const jsonData = JSON.stringify(data, null, 2);

		const folderExists = await this.app.vault.adapter.exists(folderPath);

		if (!folderExists) {
			await this.app.vault.adapter.mkdir(folderPath);
		}

		const filesOnBackupsFolder =
			await this.app.vault.adapter.list(folderPath);
		const backupFiles = filesOnBackupsFolder.files.filter((f) =>
			f.endsWith(".json"),
		);

		// Clean backups based on user preference
		const maxBackups = backupConfig.maxNumberOfBackups || 3;
		if (backupFiles.length >= maxBackups) {
			await this.cleanOlderBackups(backupFiles, maxBackups);
		}

		// This if runs if the user has data from previous schemas, checking
		// every backup to see if the data was already backed up and saving it otherwise.
		if (data.schema !== "0.3") {
			// Compare against all existing backups
			for (const filePath of backupFiles) {
				try {
					if (!(await this.app.vault.adapter.exists(filePath))) {
						return;
					}
					const contents =
						await this.app.vault.adapter.read(filePath);
					if (contents && contents === jsonData) {
						return;
					}
				} catch {
					return null;
				}
			}
			// No identical backup found, save new one
			await this.app.vault.adapter.write(backupPath, jsonData);
			new Notice("KTR: New backup saved.");
		} else {
			await this.app.vault.adapter.write(backupPath, jsonData);
			new Notice("KTR: First backup created.");
		}
	}

	private async cleanOlderBackups(backupPaths: string[], maxBackups: number) {
		// Sort backups by date (newest first)
		const backupsWithDates = backupPaths
			.map((fullPath) => {
				const fileName = fullPath.split("/").pop();
				if (!fileName) return null;

				// Match: backup-YYYY-MM-DD(-optionalSchema).json
				const match = fileName.match(
					/^backup-(\d{4}-\d{2}-\d{2})(?:-[\w\d.]+)?\.json$/,
				);
				if (!match) return null;

				const dateStr = match[1];
				const fileDate = window.moment(dateStr, "YYYY-MM-DD", true);

				if (!fileDate.isValid()) {
					console.warn(
						`Skipping file with invalid date: ${fileName}`,
					);
					return null;
				}

				return { fullPath, fileName, fileDate };
			})
			.filter((item) => item !== null)
			.sort((a, b) => b.fileDate.valueOf() - a.fileDate.valueOf());

		// Keep only the most recent maxBackups, delete the rest
		for (let i = maxBackups; i < backupsWithDates.length; i++) {
			const backup = backupsWithDates[i];
			if (!backup) continue;

			const fileExists = await this.app.vault.adapter.exists(
				backup.fullPath,
			);
			if (!fileExists) {
				console.warn(`File already missing: ${backup.fullPath}`);
				continue;
			}

			await this.app.vault.adapter.remove(backup.fullPath);
		}
	}

	private async migrateDataFromJSON(loadedData: unknown) {
		const previousStats = migrateDataFromOldFormat(loadedData as OldFormat);
		this.data.stats = previousStats.stats;
		this.data.schema = "0.2";

		if (this.data.stats) {
			await getDB().dailyActivity.bulkAdd(this.data.stats.dailyActivity);
		}
	}

	private async initializeDataFromJSON(loadedData: PluginData) {
		if (loadedData.settings) {
			this.data.settings = {
				...DEFAULT_SETTINGS,
				...loadedData.settings,
			};
		}
		if (loadedData.stats) {
			this.data.stats = loadedData.stats;
			await checkPreviousStreak();

			const dailyActivitiesFromJSON =
				this.data.stats?.dailyActivity || [];

			try {
				/** BulkPut updates the records if they already exist! */
				await getDB().dailyActivity.bulkPut(dailyActivitiesFromJSON);
			} catch (error) {
				console.error(
					"Failed loading some data, contact the developer.",
					error,
				);
			}
		}
	}

	public applyColorStyles() {
		const containerStyle = this.app.workspace.containerEl.style;
		let light = undefined;
		let dark = undefined;

		if (this.data.settings?.heatmapConfig?.colors) {
			light = this.data.settings.heatmapConfig.colors?.light;
			dark = this.data.settings.heatmapConfig.colors?.dark;
		}

		if (light && dark) {
			for (let i = 0; i <= 4; i++) {
				const key = i as keyof ColorConfig;
				containerStyle.setProperty(`--light-${i}`, light[key]);
				containerStyle.setProperty(`--dark-${i}`, dark[key]);
			}
		}
	}

	private initializeCommands() {
		this.addRibbonIcon("calendar-days", "Keep the Rhythm", () => {
			void activateSidebarView();
		});

		this.addCommand({
			id: "open-keep-the-rhythm",
			name: "Open sidebar view",
			callback: () => {
				void activateSidebarView();
			},
		});

		this.addCommand({
			id: "add-ktr-manual-entry",
			name: "Add manual entry",
			callback: () => {
				new ManualEntryModal(state.plugin.app).open();
			},
		});

		this.addCommand({
			id: "check-ktr-streak",
			name: "Check writing goal from previous days",
			callback: () => {
				void checkPreviousStreak();
			},
		});

		for (const command of CUSTOM_CODE_BLOCK_COMMANDS) {
			this.addCommand({
				id: command.id,
				name: `Insert KTR ${command.label} code block`,
				editorCallback: (editor) => {
					insertCustomCodeBlock(command.key, editor);
				},
			});
		}
	}

	private initializeEvents() {
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, info) => {
				const file = info.file;
				if (!file) return;
				const snapshot = { file, content: editor.getValue() };
				this.enqueue(() =>
					events.handleEditorChange(editor, info, this, snapshot),
				);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile)
					this.enqueue(() => events.handleFileDelete(file));
			}),
		);
		// this.registerEvent(
		// 	this.app.vault.on("create", (file: TAbstractFile) => {
		// 		// if (file instanceof TFile) events.handleFileCreate(file);
		// 	}),
		// );
		this.registerEvent(
			this.app.vault.on(
				"rename",
				(file: TAbstractFile, oldPath: string) => {
					if (file instanceof TFile)
						this.enqueue(() =>
							events.handleFileRename(file, oldPath),
						);
				},
			),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) this.enqueue(() => events.handleFileOpen(file));
			}),
		);
	}

	// #endregion

	// #region Unloading

	onunload(): void {
		void this.cleanupOnUnload();
	}

	private async cleanupOnUnload(): Promise<void> {
		this.closing = true;
		await this.work;
		await events.flushNow();
		await this.cloud.stop();
		await this.vpsSettingsFile.flush();

		if (this.JsonDebounceTimeout)
			window.clearTimeout(this.JsonDebounceTimeout);

		await this.saveDataToJSON();
		await this.backupDataToVaultFolder(this.data);

		invalidateAll();
		closeDB();
	}

	// #endregion

	async onExternalSettingsChange() {
		if (this.cloud.active) return;
		try {
			const newData = (await this.loadData()) as PluginData;

			if (JSON.stringify(newData) == JSON.stringify(this.data)) {
				return;
			}

			for (const activity of newData.stats?.dailyActivity ?? []) {
				let existingActivity;

				if (activity.id) {
					existingActivity = await getDB().dailyActivity.get(
						activity.id,
					);
				}

				if (
					existingActivity &&
					JSON.stringify(existingActivity) ===
						JSON.stringify(activity)
				) {
					continue;
				}

				await getDB().dailyActivity.put(activity);
			}

			/** Assign new external settings*/
			if (this.data.settings !== newData.settings) {
				this.data.settings = {
					...DEFAULT_SETTINGS,
					...newData.settings,
				};
			}

			invalidateAll();
			state.emit(EVENTS.REFRESH_EVERYTHING);
		} catch (error) {
			console.error("Error in onExternalSettingsChange:", error);
		}
	}

	// #region SAVING DATA

	async saveVpsSettingsFile(): Promise<void> {
		await this.vpsSettingsFile.write(
			portableSettings(this.cloud.config, this.cloud.draft),
		);
	}

	async saveVpsDraft(fields: ConnectionFields): Promise<void> {
		await this.cloud.saveDraft(fields);
		await this.saveVpsSettingsFile();
	}

	async connectServer(config: SyncConfig): Promise<void> {
		const operation = this.work.then(async () => {
			await events.flushNow();
			await this.cloud.stop();
			const next = new SyncStore(transport, () => {
				refreshActivities();
				state.emit(EVENTS.REFRESH_EVERYTHING);
			});
			await next.setMeta("config", config);
			await next.load();
			this.cloud = next;
			try {
				await this.saveVpsSettingsFile();
				const rows = await getDB().dailyActivity.toArray();
				if (!config.active)
					await this.writeHistoryBackup(rows, "pre-vps");
				await next.initialize(rows);
				await this.persistData();
				await next.sync();
				refreshActivities();
				state.emit(EVENTS.REFRESH_EVERYTHING);
			} catch (error) {
				if (!next.active)
					next.status = `Connection failed: ${error instanceof Error ? error.message : "request failed"}. Local records unchanged.`;
				throw error;
			}
		});
		this.work = operation.catch(() => undefined);
		await operation;
	}

	private async writeHistoryBackup(
		rows: import("./db/types").DailyActivity[],
		prefix: string,
	): Promise<string> {
		const folder = ".keep-the-rhythm";
		if (!(await this.app.vault.adapter.exists(folder)))
			await this.app.vault.adapter.mkdir(folder);
		const path = `${folder}/${prefix}-${Date.now()}.json`;
		await this.app.vault.adapter.write(
			path,
			JSON.stringify(
				{
					...this.data,
					stats: { ...this.data.stats, dailyActivity: rows },
				},
				null,
				2,
			),
		);
		return path;
	}

	async exportHistory(): Promise<string> {
		await this.work;
		await events.flushNow();
		const folder = ".keep-the-rhythm";
		if (!(await this.app.vault.adapter.exists(folder)))
			await this.app.vault.adapter.mkdir(folder);
		const path = `${folder}/export-${Date.now()}.json`;
		const rows = await getDB().dailyActivity.toArray();
		await this.app.vault.adapter.write(
			path,
			JSON.stringify(
				{
					...this.data,
					stats: { ...this.data.stats, dailyActivity: rows },
				},
				null,
				2,
			),
		);
		return path;
	}

	private async persistData() {
		if (this.cloud?.active) {
			await this.cloud.setMeta("pluginData", {
				...this.data,
				stats: undefined,
			});
		} else await this.saveData(this.data);
	}

	private async saveDataToJSON() {
		const dailyActivityDB = await getDB().dailyActivity.toArray();
		if (this.cloud.active && this.data.stats) {
			const totals = new Map<string, number>();
			for (const row of dailyActivityDB)
				totals.set(
					row.date,
					(totals.get(row.date) ?? 0) +
						row.changes.reduce((sum, entry) => sum + entry.w, 0),
				);
			this.data.stats.daysWithCompletedGoal = [...totals]
				.filter(
					([, words]) => words >= this.data.settings.dailyWritingGoal,
				)
				.map(([date]) => date);
		}

		this.data.stats = {
			...this.data.stats,
			dailyActivity: dailyActivityDB,
		};

		await this.persistData();
	}

	public async updateCurrentStreak(increase: boolean) {
		if (!this.data.stats) return;

		// TODO: check previous date to see when was the last one

		if (!this.data.stats.daysWithCompletedGoal) {
			this.data.stats.daysWithCompletedGoal = [];
		}

		if (increase) {
			if (this.data.stats.daysWithCompletedGoal.includes(state.today)) {
				return;
			}
			this.data.stats.daysWithCompletedGoal.push(state.today);
		} else {
			if (this.data.stats.daysWithCompletedGoal.includes(state.today)) {
				const newArray = this.data.stats.daysWithCompletedGoal?.filter(
					(item) => item !== state.today,
				);
				this.data.stats.daysWithCompletedGoal = newArray;
			}
		}
		void this.quietSave();
	}

	public async updateAndSaveEverything() {
		await this.persistData();
		invalidateAll();
		state.setToday(); // already refreshes everything
	}

	public async quietSave() {
		await this.persistData();
	}

	// #endregion
}
