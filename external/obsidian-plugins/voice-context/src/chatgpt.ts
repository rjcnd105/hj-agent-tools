import { requestUrl } from "obsidian";
import type { AddressInfo } from "net";
import type VoiceContextPlugin from "./main";
import { ApiError, apiErrorFrom, decodeJwt, pkceChallenge, randomToken } from "./protocol";

// Sign in with ChatGPT: https://developers.openai.com/siwc
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN_SECRET_ID = "voice-context-chatgpt";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REFRESH_MARGIN_MS = 120_000;
const RELOGIN_CODES = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
]);

interface StoredTokens {
	access: string;
	refresh: string;
	expiresAt: number;
	refreshAfter: number;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	expires_in?: number;
	scope?: string;
	earliest_refresh_at?: number | string;
}

const toMillis = (v: number | string | undefined) => {
	if (v == null) return 0;
	const n = typeof v === "number" ? v : Number.isFinite(Number(v)) ? Number(v) : Date.parse(v);
	if (!Number.isFinite(n)) return 0;
	return n < 1e12 ? n * 1000 : n;
};

const CALLBACK_PAGE = (message: string) =>
	`<!doctype html><meta charset="utf-8"><title>Voice Context</title><body style="font:16px system-ui;padding:3em">${message}</body>`;

/** Tokens live in Obsidian's SecretStorage, never in data.json (which may sync). */
export class ChatGPTAuth {
	private refreshing: Promise<string> | null = null;

	constructor(private readonly plugin: VoiceContextPlugin) {}

	private get secrets() {
		return this.plugin.app.secretStorage;
	}

	private read(): StoredTokens | null {
		const raw = this.secrets.getSecret(TOKEN_SECRET_ID);
		if (!raw) return null;
		try {
			return JSON.parse(raw) as StoredTokens;
		} catch {
			return null;
		}
	}

	private write(tokens: StoredTokens | null) {
		this.secrets.setSecret(TOKEN_SECRET_ID, tokens ? JSON.stringify(tokens) : "");
	}

	get signedIn() {
		return this.read() !== null;
	}

	/** Desktop only: loopback redirect on 127.0.0.1 with PKCE. */
	async signIn(): Promise<void> {
		const http = require("http") as typeof import("http");
		const settings = this.plugin.settings;
		const hostId = settings.chatgpt?.hostId ?? `urn:uuid:${crypto.randomUUID()}`;
		const savedClientId = settings.chatgpt?.clientId ?? null;
		const verifier = randomToken(32);
		const state = randomToken(16);
		const nonce = randomToken(16);

		const server = http.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/callback`;
			const callback = new Promise<URLSearchParams>((resolve, reject) => {
				const timer = window.setTimeout(() => reject(new Error("로그인 시간이 초과되었습니다 (5분)")), LOGIN_TIMEOUT_MS);
				server.on("request", (req, res) => {
					const url = new URL(req.url ?? "/", redirectUri);
					if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) {
						res.writeHead(404).end();
						return;
					}
					const error = url.searchParams.get("error");
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(CALLBACK_PAGE(error ? "로그인에 실패했습니다. Obsidian으로 돌아가 오류를 확인하세요." : "로그인했습니다. 이 탭을 닫고 Obsidian으로 돌아가세요."));
					window.clearTimeout(timer);
					if (error) reject(new Error(url.searchParams.get("error_description") ?? error));
					else resolve(url.searchParams);
				});
			});

			const params = new URLSearchParams({
				client_id: savedClientId ?? "dynamic_agent_client",
				response_type: "code",
				redirect_uri: redirectUri,
				scope: SCOPE,
				resource: RESOURCE,
				state,
				nonce,
				code_challenge: await pkceChallenge(verifier),
				code_challenge_method: "S256",
				ext_agent_host_id: hostId,
			});
			if (!savedClientId) params.set("agent_name_hint", "Obsidian Voice Context");
			if (settings.chatgpt?.email) params.set("login_hint", settings.chatgpt.email);
			window.open(`${AUTHORIZE_URL}?${params}`);

			const query = await callback;
			const code = query.get("code");
			const clientId = query.get("client_id") ?? savedClientId;
			if (!code || !clientId) throw new Error("로그인 응답에 code 또는 client_id가 없습니다");
			const tokens = await this.tokenRequest({
				grant_type: "authorization_code",
				client_id: clientId,
				code,
				code_verifier: verifier,
				redirect_uri: redirectUri,
				resource: RESOURCE,
			});
			if (!tokens.scope?.split(" ").includes("chatgpt.tokens.use.direct")) {
				throw new Error("ChatGPT 구독 사용 권한(chatgpt.tokens.use.direct)이 승인되지 않았습니다");
			}
			const claims = tokens.id_token ? decodeJwt(tokens.id_token) : {};
			if (tokens.id_token && claims.nonce !== nonce) throw new Error("로그인 응답의 nonce가 일치하지 않습니다");
			this.store(tokens, null);
			settings.chatgpt = { hostId, clientId, email: typeof claims.email === "string" ? claims.email : (settings.chatgpt?.email ?? null) };
			await this.plugin.saveSettings();
		} finally {
			server.close();
		}
	}

	async accessToken(): Promise<string> {
		const tokens = this.read();
		if (!tokens) throw new Error("ChatGPT에 로그인되어 있지 않습니다");
		const now = Date.now();
		if (now < tokens.expiresAt - REFRESH_MARGIN_MS || now < tokens.refreshAfter) return tokens.access;
		// Refresh tokens rotate, so concurrent refreshes would invalidate each other.
		this.refreshing ??= this.refresh(tokens).finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	async signOut(): Promise<void> {
		const tokens = this.read();
		const clientId = this.plugin.settings.chatgpt?.clientId;
		this.write(null);
		if (!tokens || !clientId) return;
		try {
			const config = (await requestUrl(`${ISSUER}/.well-known/openid-configuration`)).json as { revocation_endpoint?: string };
			if (!config.revocation_endpoint) return;
			await requestUrl({
				url: config.revocation_endpoint,
				method: "POST",
				contentType: "application/x-www-form-urlencoded",
				body: new URLSearchParams({ token: tokens.refresh, token_type_hint: "refresh_token", client_id: clientId }).toString(),
				throw: false,
			});
		} catch (e) {
			console.warn("[voice-context] token revocation failed", e);
		}
	}

	private async refresh(tokens: StoredTokens): Promise<string> {
		const clientId = this.plugin.settings.chatgpt?.clientId;
		if (!clientId) throw new Error("ChatGPT client_id가 없습니다. 설정에서 다시 로그인하세요");
		try {
			const next = await this.tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh, resource: RESOURCE });
			return this.store(next, tokens).access;
		} catch (e) {
			if (e instanceof ApiError && RELOGIN_CODES.has(e.code ?? "")) {
				this.write(null);
				throw new Error("ChatGPT 로그인이 만료되었습니다. 설정에서 다시 로그인하세요");
			}
			throw e;
		}
	}

	private store(res: TokenResponse, previous: StoredTokens | null): StoredTokens {
		const refresh = res.refresh_token ?? previous?.refresh;
		if (!refresh) throw new Error("refresh_token을 받지 못했습니다");
		const tokens = {
			access: res.access_token,
			refresh,
			expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000,
			refreshAfter: toMillis(res.earliest_refresh_at),
		};
		this.write(tokens);
		return tokens;
	}

	private async tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
		const res = await requestUrl({
			url: TOKEN_URL,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: new URLSearchParams(form).toString(),
			throw: false,
		});
		if (res.status >= 400) throw apiErrorFrom(res.status, res.text);
		return res.json as TokenResponse;
	}
}
