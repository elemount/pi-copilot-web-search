import assert from "node:assert/strict";
import test from "node:test";
import { formatMcpResult, parseSearchResult, resolveMcpAuth, searchGitHubMcp } from "../mcp.ts";

const TOKEN = "github-test-secret";
const auth = { endpoint: "https://api.enterprise.githubcopilot.com/mcp/readonly", token: TOKEN };
const answer = {
	type: "output_text",
	text: { value: "A sourced answer.", annotations: [{ url_citation: { title: "Official docs", url: "https://example.com/docs" } }] },
	bing_searches: [{ text: "search terms", url: "https://www.bing.com/search?q=terms" }],
};
const toolResult = { structuredContent: answer, content: [{ type: "text", text: JSON.stringify(answer) }] };
const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });

function server({ sse = false, sessionId = null, result = toolResult, initResult, handler } = {}) {
	const requests = [];
	const mockFetch = async (url, options) => {
		const body = options.body ? JSON.parse(options.body) : undefined;
		requests.push({ url, ...options, body });
		const custom = await handler?.(body, options, requests);
		if (custom) return custom;
		if (options.method === "DELETE") return new Response(null, { status: 204 });
		if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
		const value = body.method === "initialize"
			? rpc(1, initResult ?? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "github-mcp-server" } })
			: rpc(2, result);
		const headers = { "content-type": sse ? "text/event-stream" : "application/json" };
		if (sessionId && body.method === "initialize") headers["mcp-session-id"] = sessionId;
		const text = sse
			? ': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\nevent: message\r\ndata: ' + JSON.stringify(value) + "\r\n\r\n"
			: JSON.stringify(value);
		if (!sse) return new Response(text, { headers });
		const bytes = new TextEncoder().encode(text);
		let index = 0;
		return new Response(new ReadableStream({ pull(controller) {
			if (index >= bytes.length) controller.close();
			else { controller.enqueue(bytes.slice(index, index + 7)); index += 7; }
		} }), { headers });
	};
	return { requests, fetch: mockFetch };
}

test("OAuth uses the original GitHub token and derives the account-specific trusted endpoint", () => {
	assert.deepEqual(resolveMcpAuth({ type: "oauth", refresh: TOKEN, access: "tid=abc;proxy-ep=proxy.enterprise.githubcopilot.com;exp=1" }, "other-token"), auth);
	assert.equal(resolveMcpAuth({ type: "oauth", refresh: TOKEN, access: "proxy-ep=proxy.individual.githubcopilot.com" }).endpoint,
		"https://api.individual.githubcopilot.com/mcp/readonly");
	assert.equal(resolveMcpAuth(undefined, TOKEN).endpoint, "https://api.githubcopilot.com/mcp/readonly");
	assert.equal(resolveMcpAuth({ type: "oauth", refresh: TOKEN, access: "expired-token" }).token, TOKEN);
});

test("missing credentials and untrusted endpoints fail without exposing credentials", async () => {
	assert.throws(() => resolveMcpAuth(undefined), /login github-copilot/);
	assert.throws(() => resolveMcpAuth({ type: "api_key", key: "!secret-command" }), /login github-copilot/);
	assert.throws(() => resolveMcpAuth(undefined, "bad\ntoken"), /GitHub OAuth token/);
	for (const host of ["proxy.attacker.test", "proxy.enterprise.githubcopilot.com.attacker.test", "proxy.enterprise.githubcopilot.com@attacker.test", "proxy.enterprise.githubcopilot.com/path"]) {
		assert.throws(() => resolveMcpAuth({ type: "oauth", refresh: TOKEN, access: `proxy-ep=${host}` }), /trusted/);
	}
	let calls = 0;
	await assert.rejects(searchGitHubMcp("question", { ...auth, endpoint: "https://attacker.test/mcp" }, { fetch: async () => { calls++; } }), /untrusted/);
	assert.equal(calls, 0);
});

for (const sse of [false, true]) test(`direct MCP completes initialize → initialized → tools/call (${sse ? "chunked SSE" : "JSON"})`, async () => {
	const mock = server({ sse, sessionId: "test-session" });
	const result = await searchGitHubMcp(" public question ", auth, { fetch: mock.fetch });
	assert.deepEqual(result, { text: answer.text.value, sources: [{ title: "Official docs", url: "https://example.com/docs" }] });
	assert.deepEqual(mock.requests.map(request => request.body?.method ?? request.method), ["initialize", "notifications/initialized", "tools/call", "DELETE"]);
	assert.deepEqual(mock.requests[2].body.params, { name: "web_search", arguments: { query: "public question" } });
	for (const request of mock.requests) {
		assert.equal(request.url, auth.endpoint);
		assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
		assert.equal(request.headers["X-MCP-Tools"], "web_search");
		assert.equal(request.redirect, "error");
	}
	assert.equal(mock.requests[0].headers["Mcp-Session-Id"], undefined);
	assert.equal(mock.requests[2].headers["Mcp-Session-Id"], "test-session");
	assert.equal(mock.requests[2].headers["MCP-Protocol-Version"], "2025-03-26");
	assert.doesNotMatch(JSON.stringify(result), /github-test-secret|bing\.com/);
});

test("a stateless MCP server needs no DELETE and accepts a newer negotiated protocol", async () => {
	const mock = server({ initResult: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
	await searchGitHubMcp("question", auth, { fetch: mock.fetch });
	assert.equal(mock.requests.length, 3);
	assert.equal(mock.requests[2].headers["MCP-Protocol-Version"], "2025-11-25");
});

test("SSE result is consumed without waiting for the server to close the stream", async () => {
	let cancelled = false;
	const mock = server({ handler: body => {
		if (body?.method !== "tools/call") return;
		return new Response(new ReadableStream({ start(controller) {
			controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(rpc(2, toolResult))}\n\n`));
		}, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
	} });
	assert.equal((await searchGitHubMcp("question", auth, { fetch: mock.fetch })).text, answer.text.value);
	assert.equal(cancelled, true);
});

test("parses text-only envelopes, deduplicates sources, filters unsafe URLs and avoids duplicate answers", () => {
	assert.equal(parseSearchResult(toolResult).text, answer.text.value);
	assert.deepEqual(parseSearchResult({ content: toolResult.content }), parseSearchResult(toolResult));
	assert.deepEqual(parseSearchResult({ content: [{ type: "text", text: "Plain answer" }] }), { text: "Plain answer", sources: [] });
	const bad = structuredClone(answer);
	bad.text.annotations.push(...bad.text.annotations, ...["javascript:alert(1)", "https://user:password@example.com", "https://example.com/\nforged", "not a URL"].map(url => ({ url_citation: { url } })));
	assert.deepEqual(parseSearchResult({ structuredContent: bad }).sources, [{ title: "Official docs", url: "https://example.com/docs" }]);
	assert.match(formatMcpResult(parseSearchResult(toolResult)), /Web search sources/);
	assert.equal(formatMcpResult({ text: "plain", sources: [] }), "plain");
});

test("tool errors and empty answers are failures, while large text results are bounded", () => {
	assert.throws(() => parseSearchResult({ isError: true, content: [{ type: "text", text: TOKEN }] }), error => !error.message.includes(TOKEN) && /returned an error/.test(error.message));
	assert.throws(() => parseSearchResult({ content: [] }), /no answer/);
	const result = parseSearchResult({ structuredContent: { text: { value: "x".repeat(30_000) } } });
	assert.ok(result.text.length < 21_000);
	assert.match(result.text, /truncated/);
});

test("HTTP/auth failures are sanitized and never replay a failed tool call", async () => {
	for (const status of [400, 401, 403, 429, 500]) {
		const mock = server({ sessionId: "session", handler: body => body?.method === "tools/call" ? new Response(TOKEN, { status }) : undefined });
		await assert.rejects(searchGitHubMcp("question", auth, { fetch: mock.fetch }), error => error.message.includes(`HTTP ${status}`) && !error.message.includes(TOKEN));
		assert.equal(mock.requests.filter(request => request.body?.method === "tools/call").length, 1);
		assert.equal(mock.requests.at(-1).method, "DELETE");
	}
});

test("JSON-RPC errors and malformed responses do not expose server bodies", async () => {
	for (const text of [TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: TOKEN } }), JSON.stringify(rpc(99, {})), JSON.stringify({ jsonrpc: "2.0", id: 1 })]) {
		await assert.rejects(searchGitHubMcp("question", auth, { fetch: async () => new Response(text) }), error => !error.message.includes(TOKEN));
	}
	const invalidVersion = server({ initResult: { protocolVersion: "2099-01-01" } });
	await assert.rejects(searchGitHubMcp("question", auth, { fetch: invalidVersion.fetch }), /unsupported protocol/);
});

test("responses are size bounded, network exceptions are sanitized, credentials are redacted from results", async () => {
	await assert.rejects(searchGitHubMcp("question", auth, { fetch: async () => new Response("x".repeat(1024 * 1024 + 1)) }), /1 MiB/);
	await assert.rejects(searchGitHubMcp("question", auth, { fetch: async () => { throw new Error(TOKEN); } }), error => !error.message.includes(TOKEN));
	const reflected = structuredClone(answer);
	reflected.text.value = `Answer ${TOKEN}`;
	reflected.text.annotations.push({ url_citation: { title: TOKEN, url: `https://example.com/${TOKEN}` } });
	const mock = server({ result: { structuredContent: reflected } });
	assert.doesNotMatch(JSON.stringify(await searchGitHubMcp("question", auth, { fetch: mock.fetch })), new RegExp(TOKEN));
});

test("cancellation and timeout abort requests without leaking their exceptions", async () => {
	const controller = new AbortController();
	controller.abort(new Error(TOKEN));
	let calls = 0;
	await assert.rejects(searchGitHubMcp("question", auth, { signal: controller.signal, fetch: async () => { calls++; } }), /cancelled/);
	assert.equal(calls, 0);
	await assert.rejects(searchGitHubMcp("question", auth, { timeoutMs: 5, fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
		const fallback = setTimeout(() => reject(new Error("Abort was not propagated")), 100);
		signal.addEventListener("abort", () => { clearTimeout(fallback); reject(signal.reason); }, { once: true });
	}) }), /timed out/);
});

test("invalid queries do not perform any requests", async () => {
	for (const query of ["", "   ", "x".repeat(8_001)]) {
		await assert.rejects(searchGitHubMcp(query, auth, { fetch: async () => { throw new Error("must not fetch"); } }), /1–8,000/);
	}
});
