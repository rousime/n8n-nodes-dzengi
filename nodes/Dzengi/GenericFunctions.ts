/**
 * Transport layer for the Dzengi.com API: URL resolution, HMAC-SHA256 signing,
 * rate limiting, retries, server-time synchronisation, error mapping, response
 * normalisation, pagination and dynamic option loaders.
 *
 * Signing rules (https://dzengi.com/general-rest-api-information):
 *  - The API key is sent in the `X-MBX-APIKEY` header.
 *  - `totalParams` = query string concatenated with the request body, exactly as sent.
 *  - `signature` = hex HMAC-SHA256(secretKey, totalParams), appended as the last parameter.
 *  - Signed requests must include `timestamp` (ms) and may include `recvWindow` (≤ 60 000).
 *
 * WebSocket requests are signed differently: the payload keys are sorted
 * alphabetically and joined as raw `key=value` pairs (see `buildWsSignaturePayload`).
 */
import { createHmac } from 'crypto';
import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodeCredentialTestResult,
	INodePropertyOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import type {
	DzengiApiVersion,
	DzengiApiVersionSetting,
	DzengiContext,
	DzengiEnvironment,
	DzengiTradingMode,
	IDzengiCredentials,
	IDzengiErrorBody,
	IDzengiRequestOptions,
	IDzengiSymbolInfo,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DZENGI_URLS: Record<DzengiEnvironment, { rest: string; ws: string }> = {
	live: {
		rest: 'https://api-adapter.dzengi.com',
		ws: 'wss://api-adapter.dzengi.com/connect',
	},
	demo: {
		rest: 'https://demo-api-adapter.dzengi.com',
		ws: 'wss://demo-api-adapter.dzengi.com/connect',
	},
};

/** Public market data host. Endpoints live under `/api/v1` (this API has no v2). */
export const MARKETCAP_BASE_URL = 'https://marketcap.dzengi.com';

export const DEFAULT_RECV_WINDOW = 5000;
export const MAX_RECV_WINDOW = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30000;

/**
 * Minimum spacing between requests per bucket. Dzengi asks for ≤ 10 requests/s,
 * `/openOrders` is limited to 5 requests/s, and the marketcap API allows > 2000/min.
 */
const RATE_LIMIT_INTERVAL_MS: Record<string, number> = {
	adapter: 100,
	openOrders: 200,
	marketcap: 30,
};

/**
 * Hints for error codes Dzengi returns in `{ code, msg }` bodies. Dzengi uses the
 * Binance-compatible `X-MBX` convention, so these codes follow that numbering;
 * the raw code and message are always included in the error as well.
 */
const ERROR_CODE_HINTS: Record<number, string> = {
	[-1003]: 'Too many requests. Slow the workflow down (Dzengi allows about 10 requests per second).',
	[-1013]: 'The order failed a symbol filter (LOT_SIZE / MIN_NOTIONAL / price precision). Check exchangeInfo for the allowed quantity step and minimum notional.',
	[-1021]: "The request timestamp is outside recvWindow. The node re-syncs with Dzengi's server clock automatically; if this persists, check the n8n host clock or raise the receive window in the credentials.",
	[-1022]: 'Invalid signature. Check that the API secret in the credentials is correct and has no surrounding spaces.',
	[-1100]: 'A parameter contains illegal characters or an invalid format.',
	[-1102]: 'A mandatory parameter is missing or empty.',
	[-1121]: 'Invalid symbol. Use the exact symbol from exchangeInfo. Leverage symbols that contain currencies need the _LEVERAGE suffix (e.g. BTC/USD_LEVERAGE); asset-only leverage symbols are used as-is.',
	[-2010]: 'The new order was rejected (insufficient balance, market closed, or invalid parameters).',
	[-2011]: 'The cancel request was rejected (the order may already be filled or cancelled).',
	[-2013]: 'Order does not exist.',
	[-2014]: 'API key format is invalid.',
	[-2015]: 'Invalid API key, IP restriction or missing permission for this action.',
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sleep(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number): number {
	const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
	return base + Math.floor(Math.random() * 250);
}

/** Converts a number to a plain decimal string (never exponent notation like `1e-7`). */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error(`Invalid numeric value: ${value}`);
	}
	const text = String(value);
	if (!/e/i.test(text)) return text;

	const [mantissaRaw, exponentRaw] = text.toLowerCase().split('e');
	const exponent = Number(exponentRaw);
	const negative = mantissaRaw.startsWith('-');
	const mantissa = negative ? mantissaRaw.slice(1) : mantissaRaw;
	const dotIndex = mantissa.indexOf('.');
	const digits = mantissa.replace('.', '');
	const pointPosition = (dotIndex === -1 ? mantissa.length : dotIndex) + exponent;

	let result: string;
	if (pointPosition <= 0) {
		result = `0.${'0'.repeat(-pointPosition)}${digits}`;
	} else if (pointPosition >= digits.length) {
		result = digits + '0'.repeat(pointPosition - digits.length);
	} else {
		result = `${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`;
	}
	return (negative ? '-' : '') + result;
}

/** Serialises a parameter value the way Dzengi expects it in query strings. */
export function toApiString(value: unknown): string {
	if (typeof value === 'number') return formatNumber(value);
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map((entry) => toApiString(entry)).join(',');
	throw new Error(`Unsupported parameter value: ${JSON.stringify(value)}`);
}

/** RFC 3986 percent-encoding (`/` → `%2F`, space → `%20`), as in Dzengi's examples. */
export function encodeRfc3986(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/** Drops `undefined`, `null` and empty-string values. */
export function cleanParams(params: IDataObject = {}): IDataObject {
	const cleaned: IDataObject = {};
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === '') continue;
		cleaned[key] = value;
	}
	return cleaned;
}

/**
 * Builds a deterministic query string. The same string is both signed and sent,
 * so the signature always matches what Dzengi receives.
 */
export function buildQueryString(params: IDataObject = {}): string {
	return Object.entries(cleanParams(params))
		.map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(toApiString(value))}`)
		.join('&');
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** Hex HMAC-SHA256 of `totalParams` keyed with the API secret. */
export function signPayload(secret: string, totalParams: string): string {
	return createHmac('sha256', secret).update(totalParams, 'utf8').digest('hex');
}

/**
 * Generates the Dzengi REST signature.
 *
 * Dzengi signs `totalParams = queryString + body`, and the `timestamp` is one of
 * those parameters — it is NOT concatenated separately. The `timestamp` argument
 * is used to guard against the common mistake of signing a payload that does not
 * actually contain the timestamp being sent (which Dzengi would reject).
 *
 * @example
 * generateSignature(secret, '1499827319559',
 *   'symbol=LTC%2FBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559')
 * // → 'ebec6528b2beb508b2417fa33453a4ad28c1aae8097bb243caa60d0524036f50'
 */
export function generateSignature(
	secret: string,
	timestamp: string,
	queryString = '',
	body = '',
): string {
	const totalParams = `${queryString}${body}`;
	const escaped = timestamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const timestampParam = new RegExp(`(^|&)timestamp=${escaped}(&|$)`);
	if (!timestampParam.test(queryString) && !timestampParam.test(body)) {
		throw new Error(
			'The signed payload must contain the timestamp parameter (timestamp=<ms>) in the query string or body.',
		);
	}
	return signPayload(secret, totalParams);
}

export interface ISignedParams {
	/** Encoded parameters including timestamp and recvWindow, without signature. */
	unsigned: string;
	signature: string;
	/** `unsigned&signature=…` — ready to send. */
	signed: string;
}

/** Adds `recvWindow` + `timestamp`, signs, and appends `signature` last. */
export function buildSignedParams(
	params: IDataObject,
	secret: string,
	timestamp: number,
	recvWindow = DEFAULT_RECV_WINDOW,
): ISignedParams {
	const unsigned = buildQueryString({ ...params, recvWindow, timestamp });
	const signature = generateSignature(secret, String(timestamp), unsigned);
	return { unsigned, signature, signed: `${unsigned}&signature=${signature}` };
}

/**
 * WebSocket signing payload, exactly as Dzengi's official client builds it:
 * keys sorted alphabetically, raw (un-encoded) `key=value` pairs joined by `&`.
 */
export function buildWsSignaturePayload(payload: IDataObject): string {
	return Object.keys(payload)
		.filter((key) => key !== 'signature' && payload[key] !== undefined && payload[key] !== null)
		.sort()
		.map((key) => `${key}=${String(payload[key])}`)
		.join('&');
}

/** Returns a copy of `payload` with apiKey, timestamp(, recvWindow) and signature added. */
export function signWsPayload(
	payload: IDataObject,
	apiKey: string,
	apiSecret: string,
	timestamp: number,
	recvWindow?: number,
): IDataObject {
	const signedPayload: IDataObject = { ...cleanParams(payload), apiKey, timestamp };
	if (recvWindow !== undefined) signedPayload.recvWindow = recvWindow;
	signedPayload.signature = signPayload(apiSecret, buildWsSignaturePayload(signedPayload));
	return signedPayload;
}

// ---------------------------------------------------------------------------
// Symbols, versions, environments
// ---------------------------------------------------------------------------

/**
 * Dzengi leverage symbols: when the exchange symbol contains currencies
 * (e.g. `BTC/USD`) the leverage symbol is `BTC/USD_LEVERAGE`; asset-only
 * symbols (e.g. `Oil - Brent.`) are used unchanged.
 */
export function formatLeverageSymbol(symbol: string): string {
	const trimmed = symbol.trim();
	if (!trimmed.includes('/') || trimmed.toUpperCase().endsWith('_LEVERAGE')) return trimmed;
	return `${trimmed}_LEVERAGE`;
}

export function normalizeCredentials(
	raw: ICredentialDataDecryptedObject | undefined,
): IDzengiCredentials | undefined {
	if (!raw) return undefined;
	const recvWindow = Number(raw.recvWindow);
	return {
		apiKey: String(raw.apiKey ?? '').trim(),
		apiSecret: String(raw.apiSecret ?? '').trim(),
		environment: raw.environment === 'demo' ? 'demo' : 'live',
		defaultApiVersion: raw.defaultApiVersion === 'v2' ? 'v2' : 'v1',
		recvWindow:
			Number.isFinite(recvWindow) && recvWindow > 0
				? Math.min(Math.round(recvWindow), MAX_RECV_WINDOW)
				: DEFAULT_RECV_WINDOW,
	};
}

export function resolveApiVersion(
	setting: DzengiApiVersionSetting | string | undefined,
	credentials?: IDzengiCredentials,
): DzengiApiVersion {
	if (setting === 'v1' || setting === 'v2') return setting;
	return credentials?.defaultApiVersion ?? 'v1';
}

/** Dzengi demo accounts only expose API v1 (API changelog, July 2021). */
export function versionSupportError(
	environment: DzengiEnvironment,
	version: DzengiApiVersion,
): string | undefined {
	if (environment === 'demo' && version === 'v2') {
		return 'Dzengi demo accounts only support API v1. Set the API Version to V1 or use live credentials.';
	}
	return undefined;
}

export async function getDzengiCredentials(
	this: DzengiContext,
	required: boolean,
): Promise<IDzengiCredentials | undefined> {
	let raw: ICredentialDataDecryptedObject | undefined;
	try {
		raw = await this.getCredentials<ICredentialDataDecryptedObject>('dzengiApi');
	} catch (error) {
		if (!required) return undefined;
		throw new NodeOperationError(this.getNode(), 'Dzengi API credentials are required for this operation', {
			description: 'Select or create "Dzengi API" credentials on the node.',
		});
	}
	const credentials = normalizeCredentials(raw);
	if (required && (!credentials?.apiKey || !credentials.apiSecret)) {
		throw new NodeOperationError(this.getNode(), 'The Dzengi API credentials are missing the API key or secret');
	}
	return credentials;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Parses string bodies and unwraps the `{ status, correlationId, payload }` envelope. */
export function normalizeResponse(data: unknown): unknown {
	let value = data;
	if (Buffer.isBuffer(value)) value = value.toString('utf8');
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				value = JSON.parse(trimmed);
			} catch {
				// keep the raw string
			}
		}
	}
	if (
		isRecord(value) &&
		'payload' in value &&
		('status' in value || 'correlationId' in value || 'destination' in value)
	) {
		return value.payload;
	}
	return value;
}

export function isDzengiErrorBody(value: unknown): value is IDzengiErrorBody {
	if (!isRecord(value)) return false;
	const code = Number(value.code);
	return (
		typeof value.msg === 'string' &&
		value.code !== undefined &&
		Number.isFinite(code) &&
		code !== 0 &&
		Object.keys(value).length <= 4
	);
}

/** Returns the list contained in a response (plain array, or `{ <key>: [...] }`). */
export function extractList(data: unknown, keys: string[] = []): IDataObject[] {
	if (Array.isArray(data)) return data as IDataObject[];
	if (isRecord(data)) {
		for (const key of keys) {
			if (Array.isArray(data[key])) return data[key] as IDataObject[];
		}
		const arrays = Object.values(data).filter(Array.isArray);
		if (arrays.length === 1 && Object.keys(data).length === 1) return arrays[0] as IDataObject[];
		return [data];
	}
	if (data === undefined || data === null || data === '') return [];
	return [{ value: data as string }];
}

/**
 * Converts the marketcap ticker response (an object keyed by symbol, e.g.
 * `{ "BTC/USD": { last_price, ... } }`) into a list of `{ symbol, ... }` objects.
 * Arrays and `{ data: ... }` wrappers are accepted too.
 */
export function tickerMapToList(data: unknown): IDataObject[] {
	const value = normalizeResponse(data);
	if (Array.isArray(value)) return value as IDataObject[];
	if (!isRecord(value)) return [];
	if (value.data !== undefined && (Array.isArray(value.data) || isRecord(value.data))) {
		return tickerMapToList(value.data);
	}
	return Object.entries(value)
		.filter(([, entry]) => isRecord(entry))
		.map(([symbol, entry]) => ({ symbol, ...(entry as IDataObject) }));
}

/** Order book levels `[[price, qty], ...]` → `[{ price, quantity }, ...]`. */
export function simplifyOrderBookSide(levels: unknown): IDataObject[] {
	if (!Array.isArray(levels)) return [];
	return levels.map((level) => {
		if (Array.isArray(level)) {
			return { price: Number(level[0]), quantity: Number(level[1]) };
		}
		return level as IDataObject;
	});
}

/** Kline arrays `[openTime, open, high, low, close, volume]` → objects. */
export function simplifyKlines(data: unknown): IDataObject[] {
	const list = extractList(data, ['lines']);
	return list.map((line) => {
		if (!Array.isArray(line)) return line;
		const [openTime, open, high, low, close, volume] = line as unknown[];
		return {
			openTime: Number(openTime),
			open: Number(open),
			high: Number(high),
			low: Number(low),
			close: Number(close),
			volume: volume === undefined ? undefined : Number(volume),
		};
	});
}

// ---------------------------------------------------------------------------
// Rate limiting and server time
// ---------------------------------------------------------------------------

const nextRequestSlot = new Map<string, number>();
const serverTimeOffsets = new Map<string, number>();

/** Spaces requests per bucket so a workflow does not trip Dzengi's rate limits. */
export async function throttle(bucket: string, intervalMs: number): Promise<void> {
	const now = Date.now();
	const slot = Math.max(now, nextRequestSlot.get(bucket) ?? 0);
	nextRequestSlot.set(bucket, slot + intervalMs);
	if (slot > now) await sleep(slot - now);
}

/** Test helper: clears cached clock offsets and rate-limit slots. */
export function resetTransportState(): void {
	nextRequestSlot.clear();
	serverTimeOffsets.clear();
}

export function getServerTimeOffset(restBaseUrl: string): number {
	return serverTimeOffsets.get(restBaseUrl) ?? 0;
}

async function syncServerTime(
	this: DzengiContext,
	restBaseUrl: string,
	version: DzengiApiVersion,
): Promise<number> {
	const startedAt = Date.now();
	const response = (await this.helpers.httpRequest({
		method: 'GET',
		url: `${restBaseUrl}/api/${version}/time`,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		timeout: 10000,
	})) as IFullResponse;
	const finishedAt = Date.now();
	const body = normalizeResponse(response.body);
	const serverTime = Number(isRecord(body) ? body.serverTime : body);
	if (Number(response.statusCode) >= 300 || !Number.isFinite(serverTime)) {
		throw new NodeOperationError(
			this.getNode(),
			`Could not read Dzengi server time to correct clock drift (HTTP ${String(response.statusCode)})`,
		);
	}
	const offset = Math.round(serverTime - (startedAt + finishedAt) / 2);
	serverTimeOffsets.set(restBaseUrl, offset);
	return offset;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface IErrorContext {
	method: string;
	endpoint: string;
	isMutation: boolean;
	itemIndex?: number;
}

/** Maps an HTTP status + Dzengi error body to a NodeApiError with actionable text. */
export function buildDzengiApiError(
	node: INode,
	statusCode: number,
	body: unknown,
	context: IErrorContext,
): NodeApiError {
	const errorBody = isDzengiErrorBody(body) ? body : undefined;
	const apiMessage =
		errorBody?.msg ?? (typeof body === 'string' && body.length < 500 ? body : undefined);
	const where = `${context.method} ${context.endpoint}`;

	let message: string;
	if (statusCode === 400 || (statusCode < 300 && errorBody)) {
		message = `Dzengi rejected the request: ${apiMessage ?? 'Bad request'}`;
	} else if (statusCode === 401) {
		message = 'Dzengi authentication failed — check the API key and secret';
	} else if (statusCode === 403) {
		message =
			'Dzengi denied access (403): the Web Application Firewall limit was hit or the API key lacks permission for this endpoint';
	} else if (statusCode === 404) {
		message = `Dzengi endpoint not found (404): ${context.endpoint} may not exist in the selected API version`;
	} else if (statusCode === 418) {
		message =
			'Dzengi auto-banned this IP (418) for continuing to send requests after rate-limit errors. Pause the workflow before retrying.';
	} else if (statusCode === 429) {
		message =
			'Dzengi rate limit exceeded (429) and automatic retries were exhausted. Reduce the request rate (≈10 requests/s, 5/s for open orders).';
	} else if (statusCode >= 500) {
		message = context.isMutation
			? 'Dzengi returned an internal error (5xx). The execution status is UNKNOWN — the order or position change may have been applied. Check open orders/positions before retrying.'
			: `Dzengi returned an internal error (${statusCode}). Try again later.`;
	} else {
		message = `Dzengi request failed with HTTP ${statusCode}${apiMessage ? `: ${apiMessage}` : ''}`;
	}

	const details: string[] = [];
	if (errorBody) {
		details.push(`Dzengi error ${errorBody.code}: ${errorBody.msg}`);
		const hint = ERROR_CODE_HINTS[Number(errorBody.code)];
		if (hint) details.push(hint);
	} else if (apiMessage && !message.includes(apiMessage)) {
		details.push(apiMessage);
	}
	details.push(`Request: ${where}`);

	const errorResponse: JsonObject = isRecord(body)
		? (body as JsonObject)
		: { message: apiMessage ?? message, httpCode: String(statusCode) };

	return new NodeApiError(node, errorResponse, {
		message,
		description: details.join(' — '),
		httpCode: String(statusCode),
		itemIndex: context.itemIndex,
	});
}

const RETRYABLE_NETWORK_CODES = new Set([
	'ECONNRESET',
	'ETIMEDOUT',
	'ECONNABORTED',
	'EAI_AGAIN',
	'EPIPE',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'ECONNREFUSED',
	'ENOTFOUND',
]);
/** Failures where the request certainly never reached Dzengi (safe to retry even for orders). */
const NOT_DELIVERED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

/** Plain-language reason for a socket-level failure, keyed by Node.js error code. */
const NETWORK_ERROR_REASONS: Record<string, string> = {
	ECONNREFUSED: 'Dzengi refused the connection',
	ECONNRESET: 'the connection to Dzengi was closed unexpectedly',
	EPIPE: 'the connection to Dzengi was closed unexpectedly',
	ETIMEDOUT: 'the request to Dzengi timed out',
	ECONNABORTED: 'the request to Dzengi timed out or was aborted',
	ENOTFOUND: 'the Dzengi host name could not be resolved',
	EAI_AGAIN: 'the Dzengi host name could not be resolved (temporary DNS failure)',
	ENETUNREACH: 'Dzengi is not reachable from this network',
	EHOSTUNREACH: 'Dzengi is not reachable from this network',
};

/**
 * Builds the error for a request that got no HTTP response.
 *
 * n8n's NodeApiError/NodeOperationError replace the message with a generic text when
 * the error object carries a Node.js network code (e.g. `code: 'ECONNRESET'`) or when the
 * message text contains one. That would drop the "outcome UNKNOWN" warning for orders, so
 * the raw error is not passed through (which also keeps request headers holding the API
 * key out of n8n's error data) and the code only appears in the description.
 */
function buildNetworkError(
	node: INode,
	error: unknown,
	code: string | undefined,
	context: IErrorContext,
): NodeApiError {
	const reason = (code && NETWORK_ERROR_REASONS[code]) ?? 'the request to Dzengi failed before a response was received';
	const delivered = !(code && NOT_DELIVERED_CODES.has(code));
	const message =
		context.isMutation && delivered
			? `Network error: ${reason}. The execution status is UNKNOWN — the request may have been executed. Check open orders/positions before retrying.`
			: `Network error: ${reason}.`;
	const rawMessage = isRecord(error) && typeof error.message === 'string' ? error.message : undefined;
	const details = [
		code ? `Network error code: ${code}` : undefined,
		rawMessage && !rawMessage.includes('?') ? `Details: ${rawMessage}` : undefined,
		`Request: ${context.method} ${context.endpoint}`,
	].filter(Boolean);
	return new NodeApiError(node, { message, networkErrorCode: code ?? 'unknown' } as JsonObject, {
		message,
		description: details.join(' — '),
		itemIndex: context.itemIndex,
	});
}

function networkErrorCode(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	const candidates = [error.code, isRecord(error.cause) ? error.cause.code : undefined];
	return candidates.find((candidate): candidate is string => typeof candidate === 'string');
}

/** Status/body of an HTTP error thrown by n8n's request helpers (AxiosError or legacy shape). */
function httpErrorDetails(error: unknown): { statusCode?: number; body?: unknown; headers?: IDataObject } {
	if (!isRecord(error)) return {};
	const response = isRecord(error.response) ? error.response : undefined;
	const status = Number(
		response?.status ?? response?.statusCode ?? error.statusCode ?? error.httpCode ?? error.status,
	);
	return {
		statusCode: Number.isFinite(status) && status > 0 ? status : undefined,
		body: response?.data ?? response?.body ?? error.error,
		headers: isRecord(response?.headers) ? response.headers : undefined,
	};
}

function retryAfterMs(headers: IDataObject | undefined): number | undefined {
	if (!headers) return undefined;
	const raw = headers['retry-after'] ?? headers['Retry-After'];
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60000);
	return undefined;
}

// ---------------------------------------------------------------------------
// Main request function
// ---------------------------------------------------------------------------

interface IFullResponse {
	statusCode: number;
	headers?: IDataObject;
	body: unknown;
}

/**
 * Sends a request to Dzengi.
 *
 * @param method   HTTP method.
 * @param endpoint Path after the version prefix, e.g. `/order` → `https://api-adapter.dzengi.com/api/v1/order`.
 *                 For the marketcap host, the path after `/api/v1`, e.g. `/ticker` or `/token_crypto/orderbook`.
 * @param body     Parameters for the request body (POST/PUT). For signed requests they are
 *                 sent in the query string unless `options.sendParamsIn === 'body'`.
 * @param query    Query-string parameters.
 * @param isPublic `true` for endpoints that need no authentication. Defaults the host to marketcap;
 *                 pass `options.target = 'adapter'` for unsigned api-adapter endpoints.
 * @param options  See `IDzengiRequestOptions`.
 * @returns The parsed response body, with any `{ status, payload }` envelope removed.
 */
export async function dzengiApiRequest(
	this: DzengiContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	query: IDataObject = {},
	isPublic = false,
	options: IDzengiRequestOptions = {},
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
	const target = options.target ?? (isPublic ? 'marketcap' : 'adapter');
	const credentials = await getDzengiCredentials.call(this, !isPublic);
	const environment: DzengiEnvironment = isPublic
		? (options.environment ?? credentials?.environment ?? 'live')
		: (credentials as IDzengiCredentials).environment;
	const version = resolveApiVersion(options.apiVersion, credentials);
	const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
	const restBaseUrl = DZENGI_URLS[environment].rest;

	if (target === 'adapter') {
		const unsupported = versionSupportError(environment, version);
		if (unsupported) {
			throw new NodeOperationError(this.getNode(), unsupported, { itemIndex: options.itemIndex });
		}
	}

	const baseUrl = target === 'marketcap' ? `${MARKETCAP_BASE_URL}/api/v1` : `${restBaseUrl}/api/${version}`;
	const url = `${baseUrl}${path}`;
	const signed = !isPublic;
	const isMutation = method !== 'GET';
	const paramsInBody =
		(method === 'POST' || method === 'PUT') && options.sendParamsIn === 'body';
	const bucket =
		options.rateLimitBucket ?? (target === 'marketcap' ? 'marketcap' : path === '/openOrders' ? 'openOrders' : 'adapter');
	const interval = RATE_LIMIT_INTERVAL_MS[bucket] ?? RATE_LIMIT_INTERVAL_MS.adapter;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	let timeResynced = false;

	for (let attempt = 0; ; attempt++) {
		// Build (and for signed requests, re-sign with a fresh timestamp) on every attempt.
		const headers: IDataObject = { Accept: 'application/json' };
		let requestUrl = url;
		let requestBody: string | IDataObject | undefined;

		if (signed) {
			const creds = credentials as IDzengiCredentials;
			headers['X-MBX-APIKEY'] = creds.apiKey;
			const timestamp = Date.now() + getServerTimeOffset(restBaseUrl);
			const allParams = { ...cleanParams(query), ...cleanParams(body) };
			const { signed: signedString } = buildSignedParams(
				allParams,
				creds.apiSecret,
				timestamp,
				creds.recvWindow,
			);
			if (paramsInBody) {
				headers['Content-Type'] = 'application/x-www-form-urlencoded';
				requestBody = signedString;
			} else {
				requestUrl = `${url}?${signedString}`;
			}
		} else {
			const qs = buildQueryString(query);
			if (qs) requestUrl = `${url}?${qs}`;
			const cleanedBody = cleanParams(body);
			if (Object.keys(cleanedBody).length > 0 && method !== 'GET') {
				if (options.bodyType === 'form') {
					headers['Content-Type'] = 'application/x-www-form-urlencoded';
					requestBody = buildQueryString(cleanedBody);
				} else {
					headers['Content-Type'] = 'application/json';
					requestBody = cleanedBody;
				}
			}
		}

		const requestOptions: IHttpRequestOptions = {
			method,
			url: requestUrl,
			headers,
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
		};
		if (requestBody !== undefined) requestOptions.body = requestBody;

		await throttle(bucket, interval);

		let response: IFullResponse;
		try {
			response = (await this.helpers.httpRequest(requestOptions)) as IFullResponse;
		} catch (error) {
			// HTTP status errors normally come back in `response` (ignoreHttpStatusErrors);
			// handle a thrown HTTP error the same way in case a helper ignores that flag.
			const httpDetails = httpErrorDetails(error);
			if (httpDetails.statusCode !== undefined) {
				response = {
					statusCode: httpDetails.statusCode,
					body: httpDetails.body,
					headers: httpDetails.headers,
				};
			} else {
				const code = networkErrorCode(error);
				const safeToRetry =
					code !== undefined &&
					RETRYABLE_NETWORK_CODES.has(code) &&
					(!isMutation || NOT_DELIVERED_CODES.has(code));
				if (safeToRetry && attempt < maxRetries) {
					await sleep(backoffDelay(attempt));
					continue;
				}
				throw buildNetworkError(this.getNode(), error, code, {
					method,
					endpoint: path,
					isMutation,
					itemIndex: options.itemIndex,
				});
			}
		}

		const statusCode = Number(response.statusCode ?? 200);
		const data = normalizeResponse(response.body);
		const errorBody = isDzengiErrorBody(data) ? data : undefined;

		if (statusCode >= 200 && statusCode < 300 && !errorBody) {
			return data;
		}

		// Clock drift: Dzengi rejected the timestamp. The request was not executed, so it is
		// safe to re-sync with the server clock and retry once, even for orders.
		if (
			signed &&
			!timeResynced &&
			(Number(errorBody?.code) === -1021 || /recvWindow|timestamp/i.test(errorBody?.msg ?? ''))
		) {
			timeResynced = true;
			await syncServerTime.call(this, restBaseUrl, version);
			continue;
		}

		// 429 means the request was rejected, so retrying is safe for every method.
		if (statusCode === 429 && attempt < maxRetries) {
			await sleep(retryAfterMs(response.headers) ?? backoffDelay(attempt));
			continue;
		}

		// 5xx: the outcome of a mutation is unknown, so only reads are retried.
		if (statusCode >= 500 && !isMutation && attempt < maxRetries) {
			await sleep(backoffDelay(attempt));
			continue;
		}

		throw buildDzengiApiError(this.getNode(), statusCode, data, {
			method,
			endpoint: path,
			isMutation,
			itemIndex: options.itemIndex,
		});
	}
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface IDzengiPaginationOptions {
	/** Maximum items to return; `undefined` returns everything Dzengi exposes. */
	limit?: number;
	/** Largest `limit` sent per request. */
	pageSize: number;
	/** Name of the "from" time parameter (`startTime` or `from`). */
	startParam: string;
	/** Name of the "to" time parameter (`endTime` or `to`). */
	endParam: string;
	/** Item field(s) holding the timestamp in ms, first match wins. */
	timeFields: string[];
	/** Item field(s) uniquely identifying an item, used to de-duplicate page overlaps. */
	idFields: string[];
	/** Keys that may wrap the list in the response, e.g. `myTrades`, `history`. */
	listKeys?: string[];
	/** Safety cap on the number of requests. Default 50. */
	maxPages?: number;
}

function firstNumber(item: IDataObject, fields: string[]): number | undefined {
	for (const field of fields) {
		const value = Number(item[field]);
		if (item[field] !== undefined && Number.isFinite(value)) return value;
	}
	return undefined;
}

/**
 * Pages backwards through time-indexed endpoints (`/myTrades`,
 * `/tradingPositionsHistory`, …) by moving the end of the time window to the
 * oldest item received. Results are de-duplicated and returned oldest first,
 * like Dzengi itself; with `limit`, the newest `limit` items are returned.
 */
export async function dzengiApiRequestAllItems(
	this: DzengiContext,
	endpoint: string,
	query: IDataObject,
	paging: IDzengiPaginationOptions,
	requestOptions: IDzengiRequestOptions = {},
): Promise<IDataObject[]> {
	const collected: IDataObject[] = [];
	const seen = new Set<string>();
	const startTime = query[paging.startParam] as number | undefined;
	let endTime = query[paging.endParam] as number | undefined;
	let previousOldest = Number.POSITIVE_INFINITY;
	const maxPages = paging.maxPages ?? 50;

	for (let page = 0; page < maxPages; page++) {
		const remaining =
			paging.limit === undefined ? paging.pageSize : Math.min(paging.pageSize, paging.limit - collected.length);
		if (remaining <= 0) break;

		const pageQuery: IDataObject = { ...query, limit: remaining };
		if (endTime !== undefined) pageQuery[paging.endParam] = endTime;

		const data = await dzengiApiRequest.call(this, 'GET', endpoint, {}, pageQuery, false, requestOptions);
		const items = extractList(data, paging.listKeys);

		let added = 0;
		let oldest = Number.POSITIVE_INFINITY;
		for (const item of items) {
			const time = firstNumber(item, paging.timeFields);
			if (time !== undefined && time < oldest) oldest = time;
			const idParts = paging.idFields.map((field) => item[field]).filter((part) => part !== undefined);
			const key = idParts.length > 0 ? idParts.join('|') : JSON.stringify(item);
			if (seen.has(key)) continue;
			seen.add(key);
			collected.push(item);
			added++;
		}

		const fullPage = items.length >= remaining;
		const madeProgress = added > 0 && oldest < previousOldest;
		if (!fullPage || !madeProgress || !Number.isFinite(oldest)) break;
		if (startTime !== undefined && oldest <= startTime) break;
		previousOldest = oldest;
		// Inclusive bound + de-duplication avoids losing items that share the boundary timestamp.
		endTime = oldest;
	}

	collected.sort(
		(a, b) => (firstNumber(a, paging.timeFields) ?? 0) - (firstNumber(b, paging.timeFields) ?? 0),
	);
	if (paging.limit !== undefined && collected.length > paging.limit) {
		return collected.slice(collected.length - paging.limit);
	}
	return collected;
}

// ---------------------------------------------------------------------------
// Exchange info
// ---------------------------------------------------------------------------

/** Fetches `exchangeInfo.symbols` (public, unsigned api-adapter endpoint). */
export async function getExchangeSymbols(
	this: DzengiContext,
	apiVersion: DzengiApiVersionSetting | undefined,
	environment?: DzengiEnvironment,
): Promise<IDzengiSymbolInfo[]> {
	const data = await dzengiApiRequest.call(this, 'GET', '/exchangeInfo', {}, {}, true, {
		target: 'adapter',
		apiVersion,
		environment,
	});
	return extractList(data, ['symbols']).filter(
		(entry): entry is IDzengiSymbolInfo => typeof entry.symbol === 'string',
	);
}

export function filterSymbolsByMode(
	symbols: IDzengiSymbolInfo[],
	mode: DzengiTradingMode | 'ALL' | undefined,
): IDzengiSymbolInfo[] {
	if (mode === 'LEVERAGE') {
		return symbols.filter(
			(entry) => entry.marketType === 'LEVERAGE' || entry.symbol.toUpperCase().endsWith('_LEVERAGE'),
		);
	}
	if (mode === 'EXCHANGE') {
		return symbols.filter(
			(entry) => entry.marketType !== 'LEVERAGE' && !entry.symbol.toUpperCase().endsWith('_LEVERAGE'),
		);
	}
	return symbols;
}

// ---------------------------------------------------------------------------
// Dynamic option loaders (methods.loadOptions)
// ---------------------------------------------------------------------------

function currentParameter(context: ILoadOptionsFunctions, name: string): unknown {
	try {
		return context.getCurrentNodeParameter(name);
	} catch {
		return undefined;
	}
}

function loaderEnvironment(context: ILoadOptionsFunctions): DzengiEnvironment | undefined {
	const options = currentParameter(context, 'options');
	if (isRecord(options) && (options.environment === 'demo' || options.environment === 'live')) {
		return options.environment;
	}
	return undefined;
}

function symbolToOption(entry: IDzengiSymbolInfo): INodePropertyOptions {
	const label = entry.name && entry.name !== entry.symbol ? `${entry.symbol} — ${entry.name}` : entry.symbol;
	const details = [entry.assetType, entry.marketType, entry.status].filter(Boolean).join(' · ');
	return { name: label, value: entry.symbol, description: details || undefined };
}

function sortOptions(options: INodePropertyOptions[]): INodePropertyOptions[] {
	return options.sort((a, b) => String(a.value).localeCompare(String(b.value)));
}

/**
 * Symbols from the public marketcap ticker (`https://marketcap.dzengi.com/api/v1/ticker`).
 * The response is an object keyed by symbol; crypto pairs only.
 */
export async function getSymbols(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const response = await dzengiApiRequest.call(this, 'GET', '/ticker', {}, {}, true, {
		target: 'marketcap',
	});
	return sortOptions(
		tickerMapToList(response)
			.filter((entry) => typeof entry.symbol === 'string')
			.map((entry) => ({
				name: String(entry.symbol),
				value: String(entry.symbol),
				description: typeof entry.description === 'string' ? entry.description : undefined,
			})),
	);
}

/**
 * Tradable symbols from `exchangeInfo`, filtered by the node's Trading Mode
 * (EXCHANGE → spot symbols, LEVERAGE → leverage symbols) and API version.
 */
export async function getTradingSymbols(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const mode = currentParameter(this, 'tradingMode') as DzengiTradingMode | undefined;
	const apiVersion = currentParameter(this, 'apiVersion') as DzengiApiVersionSetting | undefined;
	const symbols = filterSymbolsByMode(
		await getExchangeSymbols.call(this, apiVersion, loaderEnvironment(this)),
		mode,
	);
	if (symbols.length === 0 && mode === 'LEVERAGE') {
		throw new NodeOperationError(
			this.getNode(),
			'This API version returned no leverage instruments. Dzengi publishes the full leverage list in API v2 — set API Version to V2, or enter the symbol with an expression (e.g. BTC/USD_LEVERAGE).',
		);
	}
	return sortOptions(symbols.map(symbolToOption));
}

/** Every symbol from `exchangeInfo` (exchange and leverage). */
export async function getAllTradingSymbols(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const apiVersion = currentParameter(this, 'apiVersion') as DzengiApiVersionSetting | undefined;
	const symbols = await getExchangeSymbols.call(this, apiVersion, loaderEnvironment(this));
	return sortOptions(symbols.map(symbolToOption));
}

// ---------------------------------------------------------------------------
// Credential test (methods.credentialTest)
// ---------------------------------------------------------------------------

function legacyErrorMessage(error: unknown): string {
	const { body } = httpErrorDetails(error);
	const parsed = normalizeResponse(body);
	if (isDzengiErrorBody(parsed)) return `${parsed.code}: ${parsed.msg}`;
	if (isRecord(error) && typeof error.message === 'string') return error.message;
	return 'Unknown error';
}

/** Verifies the key/secret pair with a signed `GET /account`. */
export async function testDzengiCredentials(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	const credentials = normalizeCredentials(credential.data);
	if (!credentials?.apiKey || !credentials.apiSecret) {
		return { status: 'Error', message: 'API key and API secret are both required' };
	}
	const version = credentials.defaultApiVersion;
	const unsupported = versionSupportError(credentials.environment, version);
	if (unsupported) return { status: 'Error', message: unsupported };

	const baseUrl = `${DZENGI_URLS[credentials.environment].rest}/api/${version}`;

	let offset = 0;
	try {
		const startedAt = Date.now();
		const timeResponse = normalizeResponse(
			await this.helpers.request({ method: 'GET', uri: `${baseUrl}/time`, json: true }),
		);
		const serverTime = Number(isRecord(timeResponse) ? timeResponse.serverTime : timeResponse);
		if (Number.isFinite(serverTime)) offset = Math.round(serverTime - (startedAt + Date.now()) / 2);
	} catch (error) {
		return {
			status: 'Error',
			message: `Could not reach ${baseUrl}: ${legacyErrorMessage(error)}`,
		};
	}

	const { signed } = buildSignedParams(
		{ showZeroBalance: false },
		credentials.apiSecret,
		Date.now() + offset,
		credentials.recvWindow,
	);
	try {
		const account = normalizeResponse(
			await this.helpers.request({
				method: 'GET',
				uri: `${baseUrl}/account?${signed}`,
				headers: { 'X-MBX-APIKEY': credentials.apiKey },
				json: true,
			}),
		);
		if (isDzengiErrorBody(account)) {
			return { status: 'Error', message: `Dzengi rejected the credentials (${account.code}: ${account.msg})` };
		}
	} catch (error) {
		return { status: 'Error', message: `Dzengi rejected the credentials (${legacyErrorMessage(error)})` };
	}
	return {
		status: 'OK',
		message: `Connected to Dzengi ${credentials.environment} (API ${version})`,
	};
}
