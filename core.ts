import type { Api, Model } from "@earendil-works/pi-ai";

export interface Source { url: string; title: string }
type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as RecordValue : {};
}

/** Native search is limited to verified providers, GPT models, and the Responses wire protocol. */
export function supportsSearch(model: Model<Api> | undefined): boolean {
	return !!model && /^gpt-/i.test(model.id) && model.api === "openai-responses"
		&& ["github-copilot", "openai"].includes(model.provider);
}

export type SearchRoute = "native" | "mcp";
export function searchRoute(model: Model<Api> | undefined): SearchRoute | undefined {
	if (!model) return undefined;
	if (supportsSearch(model)) return "native";
	// Unsupported GPT endpoints must not silently fall back to another search backend.
	return /^gpt-/i.test(model.id) ? undefined : "mcp";
}

export function addSearch(payload: unknown, model: Model<Api> | undefined): RecordValue | undefined {
	const request = record(payload);
	if (!supportsSearch(model) || request.model !== model?.id) return undefined;
	const tools = Array.isArray(request.tools) ? request.tools : [];
	if (tools.some(tool => ["web_search", "web_search_preview"].includes(String(record(tool).type)))) return undefined;
	// Preserve local function tools and tool_choice: the model decides when to search.
	return { ...request, tools: [...tools, { type: "web_search" }] };
}

/** Collect citation URLs that Pi's normal Responses parser does not retain. */
export class SearchCollector {
	completed = 0;
	private sources = new Map<string, Source>();

	private scan(value: unknown): void {
		if (Array.isArray(value)) { for (const v of value) this.scan(v); return; }
		const obj = record(value);
		if (typeof obj.url === "string") {
			try {
				const url = new URL(obj.url);
				if (["https:", "http:"].includes(url.protocol) && this.sources.size < 30) {
					const previous = this.sources.get(obj.url);
					this.sources.set(obj.url, {
						url: obj.url,
						title: typeof obj.title === "string" ? obj.title.slice(0, 300) : previous?.title ?? "",
					});
				}
			} catch { /* Ignore malformed citations. */ }
		}
		for (const key of ["content", "annotations", "sources", "action", "url_citation"]) {
			if (obj[key] !== undefined) this.scan(obj[key]);
		}
	}

	consume(data: unknown): void {
		const event = record(data);
		if (event.type === "response.output_item.done") {
			const item = record(event.item);
			if (item.type === "web_search_call" && item.status === "completed") this.completed++;
			this.scan(item);
		} else if (event.type === "response.output_text.annotation.added") {
			this.scan(event.annotation);
		}
	}

	getSources(): Source[] { return [...this.sources.values()]; }
}

export function formatSources(sources: Source[]): string {
	return "Web search sources:\n" + sources.map((s, i) =>
		`${i + 1}. ${s.title.replace(/[\r\n\x00-\x1f\x7f]/g, " ")} — ${s.url.replace(/[\r\n\x00-\x1f\x7f]/g, "")}`,
	).join("\n");
}
