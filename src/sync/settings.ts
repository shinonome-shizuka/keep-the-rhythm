import { Notice } from "obsidian";
import type { Setting, SettingDefinitionGroup } from "obsidian";
import type KeepTheRhythm from "../main";
import { normalizeServerUrl } from "./model";
import type { SyncConfig } from "./model";

export function serverSettings(plugin: KeepTheRhythm): SettingDefinitionGroup {
	const current = plugin.cloud.config;
	const draft = plugin.cloud.draft ?? current;
	let url = draft?.url ?? "";
	let token = draft?.token ?? "";
	let vaultId = draft?.vaultId ?? "writing";
	let status: Setting | undefined;
	let connecting = false;
	const report = (message: string) => {
		status?.setDesc(message);
	};
	const saveDraft = async () => {
		try {
			await plugin.cloud.saveDraft({ url, token, vaultId });
			report("输入已保存在本机。点击下方按钮连接，不需要重载插件。");
		} catch {
			report("保存失败：无法写入本机缓存。请检查磁盘空间。");
		}
	};
	const configure = async (mode: "create" | "join") => {
		if (connecting) return;
		connecting = true;
		try {
			await plugin.cloud.saveDraft({ url, token, vaultId });
			const serverUrl = normalizeServerUrl(url);
			if (token.length < 32)
				throw new Error(
					"访问令牌至少需要 32 个字符。输入已保存，请核对服务器的 KTR_TOKEN。",
				);
			if (!/^[A-Za-z0-9_-]{1,100}$/.test(vaultId))
				throw new Error(
					"Vault ID 只能使用英文字母、数字、短横线和下划线，例如 writing。输入已保存。",
				);
			if (plugin.cloud.active && vaultId !== plugin.cloud.config?.vaultId)
				throw new Error("当前设备已连接，不能直接更换 Vault ID。");
			const config: SyncConfig = {
				url: serverUrl,
				token,
				vaultId,
				mode,
				active: plugin.cloud.active,
			};
			report("正在连接并核对记录，请稍候……");
			await plugin.connectServer(config);
			const pending = await plugin.cloud.pendingCount();
			report(
				`连接成功 · ${plugin.cloud.status} · 待上传 ${pending} 笔。`,
			);
			new Notice("服务器连接成功，记录已同步。");
		} catch (error) {
			const message = error instanceof Error ? error.message : "连接失败";
			report(`未连接成功：${message}`);
			new Notice(message);
		} finally {
			connecting = false;
		}
	};
	return {
		type: "group",
		heading: "VPS storage",
		items: [
			{
				name: "连接状态",
				desc: plugin.cloud.status,
				render: (setting) => {
					status = setting;
					setting.addButton((button) =>
						button.setButtonText("检查并同步").onClick(async () => {
							if (!plugin.cloud.active) {
								report(
									"尚未连接。输入会自动保存，请选择下方的“首次导入”或“加入已有记录”。",
								);
								return;
							}
							report("正在同步……");
							try {
								await plugin.cloud.sync();
							} catch {
								/* keep the detailed status */
							}
							report(
								`${plugin.cloud.status} · 待上传 ${await plugin.cloud.pendingCount()} 笔。`,
							);
						}),
					);
				},
			},
			{
				name: "Server URL",
				desc: "自动保存在本机。VPS 请使用 HTTPS 地址。",
				render: (setting) => {
					setting.addText((input) =>
						input
							.setValue(url)
							.setPlaceholder("https://ktr.example.com")
							.onChange(async (value) => {
								url = value;
								await saveDraft();
							}),
					);
				},
			},
			{
				name: "Access token",
				desc: "填写服务器的 KTR_TOKEN，只保存在本机，不进入笔记同步。",
				render: (setting) => {
					setting.addText((input) => {
						input.inputEl.type = "password";
						input.setValue(token).onChange(async (value) => {
							token = value;
							await saveDraft();
						});
					});
				},
			},
			{
				name: "Vault ID",
				desc: "所有设备填写相同值，例如 writing。",
				render: (setting) => {
					setting.addText((input) =>
						input
							.setValue(vaultId)
							.setDisabled(plugin.cloud.active)
							.onChange(async (value) => {
								vaultId = value;
								await saveDraft();
							}),
					);
				},
			},
			{
				name: "连接服务器",
				desc: plugin.cloud.active
					? "修改连接后点保存并连接，即刻生效。不要切换到不同的服务器历史。"
					: "首次导入会先备份旧记录，只做一次。其他设备选择加入，不会重复导入。不需要重载插件。",
				render: (setting) => {
					if (plugin.cloud.active)
						setting.addButton((button) =>
							button
								.setButtonText("保存并连接")
								.onClick(() =>
									configure(plugin.cloud.config!.mode),
								),
						);
					else {
						setting.addButton((button) =>
							button
								.setButtonText("首次导入历史并连接")
								.onClick(() => configure("create")),
						);
						setting.addButton((button) =>
							button
								.setButtonText("加入已有记录")
								.onClick(() => configure("join")),
						);
					}
				},
			},
			{
				name: "导出历史备份",
				desc: "保存原 data.json 格式的完整备份，包含尚未上传的记录。",
				render: (setting) => {
					setting.addButton((button) =>
						button.setButtonText("导出备份").onClick(async () => {
							try {
								new Notice(
									`备份已保存：${await plugin.exportHistory()}`,
								);
							} catch {
								new Notice("无法写入备份，请检查磁盘空间。");
							}
						}),
					);
				},
			},
		],
	};
}
