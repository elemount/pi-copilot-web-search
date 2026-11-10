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
