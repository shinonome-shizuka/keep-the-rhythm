import { requestUrl } from "obsidian";
import type { SyncConfig, SyncReply } from "./model";
import { normalizeServerUrl } from "./model";

export async function transport(
	config: SyncConfig,
	endpoint: string,
	body: unknown,
): Promise<SyncReply> {
	let timeout: number | undefined;
	const request = requestUrl({
		url: normalizeServerUrl(config.url) + endpoint,
		method: "POST",
		headers: { Authorization: `Bearer ${config.token}` },
		contentType: "application/json",
		body: JSON.stringify(body),
		throw: false,
	});
	let response;
	try {
		response = await Promise.race([
			request,
			new Promise<never>((_resolve, reject) => {
				timeout = window.setTimeout(
					() => reject(new Error("Server request timed out")),
					15_000,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) window.clearTimeout(timeout);
	}
	if (response.status !== 200) {
		const detail = (response.json as { error?: string }).error;
		throw new Error(
			`Server returned ${response.status}: ${typeof detail === "string" ? detail.slice(0, 200) : "Check connection, token and vault ID."}`,
		);
	}
	const reply = response.json as SyncReply;
	if (
		reply.version !== 1 ||
		!Array.isArray(reply.events) ||
		!Array.isArray(reply.accepted) ||
		!Number.isSafeInteger(reply.cursor) ||
		typeof reply.hasMore !== "boolean"
	) {
		throw new Error("Unsupported server response");
	}
	return reply;
}
