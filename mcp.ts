import { formatSources, record, type Source } from "./core.ts";

export interface McpAuth { endpoint: string; token: string }
export interface McpSearchResult { text: string; sources: Source[] }
export type McpSearch = (query: string, signal?: AbortSignal) => Promise<McpSearchResult>;

/** Only curated messages from this class may reach the transcript. */
export class McpSearchError extends Error {}

/** GitHub's original OAuth token authenticates MCP; its short-lived inference token does not. */
export function resolveMcpAuth(credential: unknown, environmentToken?: string): McpAuth {
	const stored = record(credential);
	const oauth = stored.type === "oauth" && typeof stored.refresh === "string" && stored.refresh.trim();
	const token = oauth ? String(stored.refresh).trim() : environmentToken?.trim();
	if (!token || /[\r\n]/.test(token)) {
		throw new McpSearchError("GitHub MCP search requires /login github-copilot or COPILOT_GITHUB_TOKEN containing a GitHub OAuth token.");
	}
	let host = "api.githubcopilot.com";
	if (oauth && typeof stored.access === "string") {
		const proxy = stored.access.match(/(?:^|;)proxy-ep=([^;]+)/)?.[1];
		if (proxy) host = proxy.replace(/^proxy\./, "api.");
	}
	// Never forward a GitHub credential to a configured proxy or an arbitrary provider URL.
	if (!/^api(?:\.[a-z0-9-]+)*\.githubcopilot\.com$/i.test(host)) {
		throw new McpSearchError("GitHub MCP search requires a trusted githubcopilot.com endpoint. Sign in again with /login github-copilot.");
	}
	return { endpoint: `https://${host}/mcp/readonly`, token };
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;
const PROTOCOL_VERSION = "2025-03-26";
const PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION, "2025-06-18", "2025-11-25"]);

function parseJson(text: string): unknown {
	try { return JSON.parse(text); }
	catch { throw new McpSearchError("GitHub MCP returned an invalid JSON response."); }
}

/** Read either JSON or SSE, stopping as soon as the matching JSON-RPC result arrives. */
async function readRpcResponse(response: Response, id: number): Promise<Record<string, unknown>> {
	if (!response.body) throw new McpSearchError("GitHub MCP returned an empty response.");
	const sse = response.headers.get("content-type")?.includes("text/event-stream") === true;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "", bytes = 0;
	const matching = (value: unknown): Record<string, unknown> | undefined => {
		const message = record(value);
		return message.jsonrpc === "2.0" && message.id === id ? message : undefined;
	};
	const frame = (value: string) => {
		const data = value.split(/\r?\n/).filter(line => line.startsWith("data:"))
			.map(line => line.slice(5).replace(/^ /, "")).join("\n");
		return data ? matching(parseJson(data)) : undefined;
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) throw new McpSearchError("GitHub MCP response exceeded the 1 MiB safety limit.");
			text += decoder.decode(value, { stream: true });
			if (sse) {
				let separator: RegExpExecArray | null;
				while ((separator = /\r?\n\r?\n/.exec(text))) {
					const message = frame(text.slice(0, separator.index));
					text = text.slice(separator.index + separator[0].length);
					if (message) return message;
				}
			}
		}
		text += decoder.decode();
		const message = sse ? frame(text) : matching(parseJson(text));
		if (!message) throw new McpSearchError("GitHub MCP did not return the expected JSON-RPC response.");
		return message;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Reduce the MCP search agent's answer to text and real source citations, not Bing query URLs. */
export function parseSearchResult(value: unknown): McpSearchResult {
	const result = record(value);
	if (result.isError === true) throw new McpSearchError("GitHub MCP web_search returned an error. Try again later or check your Copilot access.");
	const blocks = Array.isArray(result.content) ? result.content.map(record) : [];
	const structured = record(result.structuredContent);
	const answers = typeof record(structured.text).value === "string" ? [structured] : [];
	const plain: string[] = [];
	if (!answers.length) for (const block of blocks) {
		if (block.type !== "text" || typeof block.text !== "string") continue;
		try {
			const answer = record(JSON.parse(block.text));
			if (typeof record(answer.text).value === "string") { answers.push(answer); continue; }
		} catch { /* Ordinary MCP text, not the search agent's JSON envelope. */ }
		plain.push(block.text);
	}
	const texts = answers.map(answer => String(record(answer.text).value));
	let text = [...texts, ...plain].join("\n\n").trim();
	if (!text) throw new McpSearchError("GitHub MCP web_search returned no answer.");
	if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "\n[Search answer truncated at 20,000 characters.]";
	const sources = new Map<string, Source>();
	for (const answer of answers) {
		const annotations = record(answer.text).annotations;
		for (const annotation of Array.isArray(annotations) ? annotations : []) {
			const citation = record(record(annotation).url_citation);
			if (typeof citation.url !== "string" || /[\x00-\x20\x7f]/.test(citation.url)) continue;
			try {
				const url = new URL(citation.url);
				if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || sources.size >= 30) continue;
				sources.set(citation.url, { url: citation.url, title: typeof citation.title === "string" ? citation.title.slice(0, 300) : "" });
			} catch { /* Ignore malformed source URLs. */ }
		}
	}
	return { text, sources: [...sources.values()] };
}

export function formatMcpResult(result: McpSearchResult): string {
	return result.text + (result.sources.length ? "\n\n" + formatSources(result.sources) : "");
}

/** A fresh, bounded Streamable HTTP MCP exchange for each search. No subprocess or Pi MCP server. */
export async function searchGitHubMcp(query: string, auth: McpAuth, options: {
	signal?: AbortSignal;
	fetch?: typeof fetch;
	timeoutMs?: number;
} = {}): Promise<McpSearchResult> {
	if (!query.trim() || query.length > 8_000) throw new McpSearchError("Search query must contain 1–8,000 characters.");
	// Validate again at the network boundary, including injected/test auth objects.
	if (!/^https:\/\/api(?:\.[a-z0-9-]+)*\.githubcopilot\.com\/mcp\/readonly$/i.test(auth.endpoint)) {
		throw new McpSearchError("Refusing to send GitHub credentials to an untrusted MCP endpoint.");
	}
	if (!auth.token.trim() || /[\r\n]/.test(auth.token)) throw new McpSearchError("GitHub MCP requires a valid GitHub OAuth token.");
	const request = options.fetch ?? globalThis.fetch;
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 90_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.token}`,
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"X-MCP-Host": "pi-web-search",
		"Copilot-Integration-Id": "vscode-chat",
		"X-MCP-Tools": "web_search",
	};
	let sessionId: string | null = null;
	const post = async (body: unknown) => {
		signal.throwIfAborted();
		const response = await request(auth.endpoint, {
			method: "POST", redirect: "error", headers: { ...headers }, body: JSON.stringify(body), signal,
		});
		if (!response.ok) {
			await response.body?.cancel();
			const hint = [401, 403].includes(response.status) ? " Sign in again with /login github-copilot and check Copilot permissions." : "";
			throw new McpSearchError(`GitHub MCP request failed (HTTP ${response.status}).${hint}`);
		}
		return response;
	};
	const rpc = async (id: number, method: string, params: unknown) => {
		const response = await post({ jsonrpc: "2.0", id, method, params });
		if (method === "initialize") sessionId = response.headers.get("mcp-session-id");
		const message = await readRpcResponse(response, id);
		if (message.error !== undefined) throw new McpSearchError("GitHub MCP returned a JSON-RPC error. Check Copilot access or try again later.");
		if (!Object.hasOwn(message, "result")) throw new McpSearchError("GitHub MCP returned a malformed JSON-RPC result.");
		return message.result;
	};
	try {
		const init = record(await rpc(1, "initialize", {
			protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-web-search", version: "2.0.0" },
		}));
		if (typeof init.protocolVersion !== "string" || !PROTOCOL_VERSIONS.has(init.protocolVersion)) {
			throw new McpSearchError("GitHub MCP negotiated an unsupported protocol version.");
		}
		headers["MCP-Protocol-Version"] = init.protocolVersion;
		if (sessionId) headers["Mcp-Session-Id"] = sessionId;
		const ready = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
		await ready.body?.cancel();
		const result = parseSearchResult(await rpc(2, "tools/call", { name: "web_search", arguments: { query: query.trim() } }));
		// A provider must never be able to reflect our credential into a tool result.
		result.text = result.text.split(auth.token).join("[redacted]");
		result.sources = result.sources.filter(source => !source.url.includes(auth.token))
			.map(source => ({ ...source, title: source.title.split(auth.token).join("[redacted]") }));
		return result;
	} catch (error) {
		if (options.signal?.aborted) throw new McpSearchError("Web search cancelled.");
		if (timeout.aborted) throw new McpSearchError("GitHub MCP web search timed out.");
		if (error instanceof McpSearchError) throw error;
		// Do not expose fetch exceptions, authentication payloads or server error bodies.
		throw new McpSearchError("GitHub MCP web search request failed. Check your connection and Copilot access.");
	} finally {
		if (sessionId) {
			try {
				const closed = await request(auth.endpoint, { method: "DELETE", redirect: "error", headers: { ...headers, "Mcp-Session-Id": sessionId }, signal: AbortSignal.timeout(2_000) });
				await closed.body?.cancel();
			} catch { /* Session cleanup must not hide the search result or original error. */ }
		}
	}
}
