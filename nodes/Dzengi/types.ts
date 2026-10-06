/**
 * Shared type definitions for the Dzengi.com n8n nodes.
 *
 * Field names follow the Dzengi Swagger specification
 * (https://apitradedoc.dzengi.com/swagger-ui.html) so that data emitted by the
 * nodes matches what users see in the official documentation.
 */
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	ILoadOptionsFunctions,
	IPollFunctions,
	ITriggerFunctions,
} from 'n8n-workflow';

/** `live` = real-money account, `demo` = Dzengi demo account (API v1 only). */
export type DzengiEnvironment = 'live' | 'demo';

/** Dzengi REST/WebSocket API version. v2 adds Hong Kong markets and the full leverage list. */
export type DzengiApiVersion = 'v1' | 'v2';

/** Value of the node-level "API Version" dropdown. `credentials` defers to the credential default. */
export type DzengiApiVersionSetting = DzengiApiVersion | 'credentials';

/** EXCHANGE = spot trading, LEVERAGE = margin/CFD-style trading. */
export type DzengiTradingMode = 'EXCHANGE' | 'LEVERAGE';

/** Which host a request is sent to. */
export type DzengiRequestTarget =
	/** api-adapter host: versioned `/api/{v1|v2}` REST API (signed or unsigned). */
	| 'adapter'
	/** marketcap host: unauthenticated public market data API (`/api/v1` only). */
	| 'marketcap';

/** Decrypted credential data as stored by `DzengiApi.credentials.ts`. */
export interface IDzengiCredentials {
	apiKey: string;
	apiSecret: string;
	environment: DzengiEnvironment;
	defaultApiVersion: DzengiApiVersion;
	recvWindow?: number;
}

/** Any n8n execution context that can perform HTTP requests and read credentials. */
export type DzengiContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| ITriggerFunctions
	| IHookFunctions
	| IPollFunctions;

/** Extra knobs for `dzengiApiRequest`. All optional. */
export interface IDzengiRequestOptions {
	/** Overrides the credential default API version. Ignored for the marketcap host. */
	apiVersion?: DzengiApiVersionSetting;
	/**
	 * Host to call. Defaults to `marketcap` when `isPublic` is true and `adapter` otherwise.
	 * Use `{ target: 'adapter' }` with `isPublic: true` for unsigned api-adapter endpoints
	 * such as `/exchangeInfo`, `/depth`, `/klines` and `/ticker/24hr`.
	 */
	target?: DzengiRequestTarget;
	/** Environment for requests made without credentials (public endpoints). Default `live`. */
	environment?: DzengiEnvironment;
	/**
	 * Where signed POST/PUT parameters are placed. Dzengi accepts both; the Swagger
	 * spec documents everything as query parameters, so `query` is the default.
	 */
	sendParamsIn?: 'query' | 'body';
	/** Body encoding when `sendParamsIn` is `body`. Dzengi expects form-urlencoded. */
	bodyType?: 'form' | 'json';
	/** Max automatic retries for rate limits / transient errors. Default 3. */
	maxRetries?: number;
	/** Per-request timeout in ms. Default 30 000. */
	timeout?: number;
	/** Rate-limit bucket key override (e.g. `openOrders`, which Dzengi limits to 5 req/s). */
	rateLimitBucket?: string;
	/** Item index, used to attach errors to the right input item. */
	itemIndex?: number;
}

/** Dzengi's error body, e.g. `{ "code": -1121, "msg": "Invalid symbol." }`. */
export interface IDzengiErrorBody {
	code: number;
	msg: string;
}

/** Entry of `GET /api/{v}/exchangeInfo` → `symbols[]` (subset of fields used by the node). */
export interface IDzengiSymbolInfo extends IDataObject {
	symbol: string;
	name?: string;
	status?: string;
	baseAsset?: string;
	quoteAsset?: string;
	marketType?: 'SPOT' | 'LEVERAGE' | string;
	marketModes?: string[];
	assetType?: string;
	orderTypes?: string[];
}

/** `GET /account` → `balances[]`. */
export interface IDzengiBalance extends IDataObject {
	accountId: string;
	asset: string;
	free: number;
	locked: number;
	collateralCurrency?: boolean;
	default?: boolean;
}

/** `GET /openOrders` entry (QueryOrderResponse). */
export interface IDzengiOrder extends IDataObject {
	orderId: string;
	symbol: string;
	status: string;
	side: string;
	type: string;
	price?: string;
	origQty?: string;
	executedQty?: string;
	time?: number;
	updateTime?: number;
	leverage?: boolean;
	accountId?: string;
}

/** `GET /tradingPositions` → `positions[]` (PositionDto). */
export interface IDzengiPosition extends IDataObject {
	id: string;
	accountId: string;
	symbol?: string;
	state: string;
	openQuantity: number;
	openPrice: number;
	takeProfit?: number;
	stopLoss?: number;
}

/** Envelope used by the WebSocket API for every request/response/event. */
export interface IDzengiWsMessage {
	status?: string;
	destination?: string;
	correlationId?: string | number;
	payload?: unknown;
}

/** Events the trigger node can emit. */
export type DzengiTriggerEvent =
	| 'priceUpdate'
	| 'orderBookUpdate'
	| 'candleUpdate'
	| 'marketTrade'
	| 'orderUpdate'
	| 'balanceUpdate'
	| 'positionUpdate';

/** Public streams are pushed by Dzengi; private ones are polled over the authenticated socket. */
export const PUBLIC_STREAM_EVENTS: DzengiTriggerEvent[] = [
	'priceUpdate',
	'orderBookUpdate',
	'candleUpdate',
	'marketTrade',
];
export const PRIVATE_POLLED_EVENTS: DzengiTriggerEvent[] = [
	'orderUpdate',
	'balanceUpdate',
	'positionUpdate',
];
