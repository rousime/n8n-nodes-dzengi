/**
 * WebSocket client for wss://api-adapter.dzengi.com/connect (and the demo host).
 *
 * Protocol (https://dzengi.com/general-websocket-api-information):
 *  - Every message is JSON: `{ destination, correlationId, payload }`. Responses echo
 *    the correlationId; pushed stream events carry a destination and no matching id.
 *  - Streams: `marketData.subscribe`, `depthMarketData.subscribe`,
 *    `OHLCMarketData.subscribe`, `trades.subscribe` with `payload.symbols`.
 *  - Requests: `/api/{v1|v2}/<endpoint>` (e.g. `/api/v1/account`). Private requests add
 *    `apiKey`, `timestamp` and a `signature` over the alphabetically sorted payload.
 *  - The server closes connections that are not pinged within 30 seconds.
 *
 * Dzengi does not push order or balance changes, so orderUpdate / balanceUpdate /
 * positionUpdate are produced by polling the private endpoints over this socket and
 * emitting only the differences between snapshots.
 *
 * The class has no n8n dependencies so it can be unit-tested against a local server.
 */
import WebSocket from 'ws';
import type { IDataObject } from 'n8n-workflow';

import { isDzengiErrorBody, isRecord, signWsPayload } from './GenericFunctions';
import type { DzengiApiVersion, DzengiTriggerEvent, IDzengiWsMessage } from './types';

export interface IDzengiStreamLogger {
	debug(message: string, meta?: object): void;
	info(message: string, meta?: object): void;
	warn(message: string, meta?: object): void;
	error(message: string, meta?: object): void;
}

export interface IDzengiStreamConfig {
	url: string;
	apiVersion: DzengiApiVersion;
	events: DzengiTriggerEvent[];
	/** Symbols for the public streams. */
	symbols: string[];
	credentials?: { apiKey: string; apiSecret: string };
	/** Candle intervals for OHLCMarketData.subscribe (default 1m). */
	candleIntervals?: string[];
	/** `classic` or `heikin-ashi`. */
	candleType?: string;
	/** How often private endpoints are polled. Default 5 000 ms. */
	pollIntervalMs?: number;
	/** Emit the first snapshot of orders/balances/positions as `snapshot` events. */
	emitInitialState?: boolean;
	/** Look up the final status (FILLED / CANCELED …) of orders that disappear. Default true. */
	resolveClosedOrders?: boolean;
	/** Emit at most one price update per symbol per this many ms (0 = every tick). */
	minPriceIntervalMs?: number;
	/** Collect events for this many ms and emit them together (0 = emit immediately). */
	batchWindowMs?: number;
	/** Attach the raw Dzengi payload to every event. */
	includeRaw?: boolean;
	/** WebSocket ping frame interval. Default 10 000 ms (Dzengi drops sockets idle for 30 s). */
	heartbeatIntervalMs?: number;
	/** Application-level `ping` destination interval. Default 20 000 ms. */
	appPingIntervalMs?: number;
	/** Reconnect if nothing (message or pong) was received for this long. Default 45 000 ms. */
	livenessTimeoutMs?: number;
	/** Timeout for request/response round trips. Default 15 000 ms. */
	requestTimeoutMs?: number;
	reconnect?: { initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
	/** Consecutive failed polls before the error is reported as fatal. Default 5. */
	maxPollFailures?: number;
	/** Test hook. */
	websocketFactory?: (url: string) => WebSocket;
}

export interface IDzengiStreamHandlers {
	onEvents(events: IDataObject[]): void;
	/** `fatal` errors mean the trigger cannot continue (bad symbols, rejected credentials …). */
	onError?(error: Error, fatal: boolean): void;
	onOpen?(): void;
	log?: IDzengiStreamLogger;
}

interface IPendingRequest {
	destination: string;
	resolve: (payload: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const SUBSCRIBE_DESTINATIONS: Partial<Record<DzengiTriggerEvent, string>> = {
	priceUpdate: 'marketData.subscribe',
	orderBookUpdate: 'depthMarketData.subscribe',
	candleUpdate: 'OHLCMarketData.subscribe',
	marketTrade: 'trades.subscribe',
};

const ORDER_COMPARE_FIELDS = [
	'status',
	'executedQty',
	'origQty',
	'price',
	'stopLoss',
	'takeProfit',
	'expireTimestamp',
	'trailingStopLoss',
	'guaranteedStopLoss',
];
const POSITION_COMPARE_FIELDS = [
	'state',
	'openQuantity',
	'closeQuantity',
	'closePrice',
	'takeProfit',
	'stopLoss',
	'trailingStopLoss',
	'guaranteedStopLoss',
];
const BALANCE_COMPARE_FIELDS = ['free', 'locked'];

const noopLogger: IDzengiStreamLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface ISnapshotDiff {
	created: IDataObject[];
	updated: Array<{ current: IDataObject; previous: IDataObject; changedFields: string[] }>;
	removed: IDataObject[];
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	const na = Number(a);
	const nb = Number(b);
	if (a !== undefined && b !== undefined && a !== null && b !== null && a !== '' && b !== '') {
		if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
	}
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Compares two snapshots keyed by `keyOf` and reports created / updated / removed entries. */
export function diffSnapshots(
	previous: Map<string, IDataObject>,
	current: Map<string, IDataObject>,
	compareFields: string[],
): ISnapshotDiff {
	const diff: ISnapshotDiff = { created: [], updated: [], removed: [] };
	for (const [key, entry] of current) {
		const before = previous.get(key);
		if (!before) {
			diff.created.push(entry);
			continue;
		}
		const changedFields = compareFields.filter((field) => !sameValue(before[field], entry[field]));
		if (changedFields.length) diff.updated.push({ current: entry, previous: before, changedFields });
	}
	for (const [key, entry] of previous) {
		if (!current.has(key)) diff.removed.push(entry);
	}
	return diff;
}

export function toSnapshot(list: IDataObject[], keyOf: (entry: IDataObject) => string | undefined): Map<string, IDataObject> {
	const map = new Map<string, IDataObject>();
	for (const entry of list) {
		const key = keyOf(entry);
		if (key) map.set(key, entry);
	}
	return map;
}

function listFrom(payload: unknown, key: string): IDataObject[] {
	if (Array.isArray(payload)) return payload as IDataObject[];
	if (isRecord(payload) && Array.isArray(payload[key])) return payload[key] as IDataObject[];
	return [];
}

function toNumber(value: unknown): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** `{ "65000.1": 0.5, ... }` → `[{ price, quantity }]` sorted best-first. */
function depthSide(levels: unknown, descending: boolean): IDataObject[] {
	if (!isRecord(levels)) return [];
	return Object.entries(levels)
		.map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) }))
		.filter((level) => Number.isFinite(level.price))
		.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
}

/** Identifies a pushed stream event from its destination and payload shape. */
export function classifyStreamEvent(destination: string | undefined, payload: IDataObject): DzengiTriggerEvent | undefined {
	const target = (destination ?? '').toLowerCase();
	if ('symbolName' in payload && ('bid' in payload || 'ofr' in payload)) return 'priceUpdate';
	if ('o' in payload && 'c' in payload && ('interval' in payload || 't' in payload)) return 'candleUpdate';
	if (isRecord(payload.data) && ('bid' in payload.data || 'ofr' in payload.data)) return 'orderBookUpdate';
	if ('price' in payload && 'size' in payload) return 'marketTrade';
	if (target.includes('quote')) return 'priceUpdate';
	if (target.includes('ohlc') || target.includes('candle')) return 'candleUpdate';
	if (target.includes('depth')) return 'orderBookUpdate';
	if (target.includes('trade')) return 'marketTrade';
	return undefined;
}

/** Turns a raw Dzengi stream payload into the trigger's output shape. */
export function normalizeStreamEvent(event: DzengiTriggerEvent, payload: IDataObject): IDataObject {
	const receivedAt = Date.now();
	if (event === 'priceUpdate') {
		const bid = toNumber(payload.bid);
		const ask = toNumber(payload.ofr);
		return {
			event,
			symbol: payload.symbolName,
			bid,
			ask,
			bidQty: toNumber(payload.bidQty),
			askQty: toNumber(payload.ofrQty),
			spread: bid !== undefined && ask !== undefined ? Number((ask - bid).toPrecision(12)) : undefined,
			timestamp: toNumber(payload.timestamp),
			receivedAt,
		};
	}
	if (event === 'candleUpdate') {
		return {
			event,
			symbol: payload.symbol,
			interval: payload.interval,
			type: payload.type,
			openTime: toNumber(payload.t),
			open: toNumber(payload.o),
			high: toNumber(payload.h),
			low: toNumber(payload.l),
			close: toNumber(payload.c),
			receivedAt,
		};
	}
	if (event === 'orderBookUpdate') {
		const data = isRecord(payload.data) ? payload.data : payload;
		const bids = depthSide(data.bid, true);
		const asks = depthSide(data.ofr, false);
		return {
			event,
			symbol: payload.symbol,
			timestamp: toNumber(data.ts),
			bestBid: bids[0]?.price,
			bestAsk: asks[0]?.price,
			bids,
			asks,
			receivedAt,
		};
	}
	// marketTrade
	return {
		event,
		symbol: payload.symbol,
		tradeId: payload.id,
		orderId: payload.orderId,
		price: toNumber(payload.price),
		quantity: toNumber(payload.size),
		side: payload.buyer === true ? 'BUY' : payload.buyer === false ? 'SELL' : undefined,
		timestamp: toNumber(payload.ts),
		receivedAt,
	};
}

function wsErrorMessage(message: IDzengiWsMessage): string {
	const payload = message.payload;
	if (isDzengiErrorBody(payload)) return `${payload.code}: ${payload.msg}`;
	if (isRecord(payload)) {
		for (const key of ['msg', 'message', 'errorMessage', 'errorCode', 'error']) {
			if (typeof payload[key] === 'string' && payload[key]) return payload[key] as string;
		}
	}
	return `Dzengi returned status ${message.status ?? 'unknown'} for ${message.destination ?? 'request'}`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class DzengiStreamClient {
	private ws?: WebSocket;

	private stopped = true;

	private correlationId = 0;

	private readonly pending = new Map<string, IPendingRequest>();

	private connectionTimers: NodeJS.Timeout[] = [];

	private reconnectTimer?: NodeJS.Timeout;

	private batchTimer?: NodeJS.Timeout;

	private batch: IDataObject[] = [];

	private reconnectAttempts = 0;

	private lastActivityAt = 0;

	private timeOffsetMs = 0;

	private pollInFlight = false;

	private consecutivePollFailures = 0;

	private orders?: Map<string, IDataObject>;

	private balances?: Map<string, IDataObject>;

	private positions?: Map<string, IDataObject>;

	private readonly lastPriceEmit = new Map<string, number>();

	private readonly log: IDzengiStreamLogger;

	constructor(
		private readonly config: IDzengiStreamConfig,
		private readonly handlers: IDzengiStreamHandlers,
	) {
		this.log = handlers.log ?? noopLogger;
	}

	private get wantsPrivate(): boolean {
		return this.config.events.some((event) =>
			['orderUpdate', 'balanceUpdate', 'positionUpdate'].includes(event),
		);
	}

	start(): void {
		if (!this.stopped) return;
		if (this.wantsPrivate && !this.config.credentials) {
			throw new Error('Dzengi API credentials are required for order, balance and position events');
		}
		this.stopped = false;
		this.connect();
	}

	/** Closes the socket and releases every timer. Safe to call more than once. */
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.batchTimer) clearTimeout(this.batchTimer);
		this.batch = [];
		this.clearConnectionState(new Error('Dzengi stream stopped'));

		const ws = this.ws;
		this.ws = undefined;
		if (!ws) return;
		ws.removeAllListeners();
		ws.on('error', () => undefined);
		if (ws.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolve) => {
			const force = setTimeout(() => {
				ws.terminate();
				resolve();
			}, 2000);
			ws.once('close', () => {
				clearTimeout(force);
				resolve();
			});
			try {
				if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
				else ws.close(1000, 'n8n workflow deactivated');
			} catch {
				clearTimeout(force);
				resolve();
			}
		});
	}

	// -------------------------------------------------------------------
	// Connection lifecycle
	// -------------------------------------------------------------------

	private connect(): void {
		if (this.stopped) return;
		this.log.debug(`Dzengi stream connecting to ${this.config.url}`);
		const ws = this.config.websocketFactory
			? this.config.websocketFactory(this.config.url)
			: new WebSocket(this.config.url, { perMessageDeflate: true, handshakeTimeout: 15000 });
		this.ws = ws;

		ws.on('open', () => this.onOpen(ws));
		ws.on('message', (data) => this.onMessage(data));
		ws.on('pong', () => {
			this.lastActivityAt = Date.now();
		});
		ws.on('ping', () => {
			this.lastActivityAt = Date.now();
		});
		ws.on('error', (error) => {
			this.log.warn(`Dzengi stream error: ${error.message}`);
		});
		ws.on('close', (code, reason) => this.onClose(ws, code, reason.toString()));
	}

	private onOpen(ws: WebSocket): void {
		if (ws !== this.ws) return;
		this.log.info('Dzengi stream connected');
		this.reconnectAttempts = 0;
		this.lastActivityAt = Date.now();
		this.handlers.onOpen?.();

		const heartbeat = this.config.heartbeatIntervalMs ?? 10000;
		const liveness = this.config.livenessTimeoutMs ?? 45000;
		this.connectionTimers.push(
			setInterval(() => {
				if (ws.readyState !== WebSocket.OPEN) return;
				if (Date.now() - this.lastActivityAt > liveness) {
					this.log.warn('Dzengi stream is unresponsive, reconnecting');
					ws.terminate();
					return;
				}
				ws.ping();
			}, heartbeat),
		);
		this.connectionTimers.push(
			setInterval(() => {
				this.request('ping', {}).catch((error: Error) =>
					this.log.debug(`Dzengi ping failed: ${error.message}`),
				);
			}, this.config.appPingIntervalMs ?? 20000),
		);

		void this.subscribeStreams();
		if (this.wantsPrivate) void this.startPolling();
	}

	private onClose(ws: WebSocket, code: number, reason: string): void {
		if (ws !== this.ws) return;
		this.ws = undefined;
		this.clearConnectionState(new Error(`Dzengi stream closed (${code})`));
		if (this.stopped) return;

		this.reconnectAttempts++;
		const { initialDelayMs = 1000, maxDelayMs = 60000, maxAttempts = 0 } = this.config.reconnect ?? {};
		if (maxAttempts > 0 && this.reconnectAttempts > maxAttempts) {
			this.stopped = true;
			this.handlers.onError?.(
				new Error(`Dzengi stream closed (${code} ${reason}) and ${maxAttempts} reconnect attempts failed`),
				true,
			);
			return;
		}
		const delay =
			Math.min(maxDelayMs, initialDelayMs * 2 ** (this.reconnectAttempts - 1)) + Math.floor(Math.random() * 250);
		this.log.warn(`Dzengi stream closed (${code}${reason ? ` ${reason}` : ''}); reconnecting in ${delay} ms`);
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}

	private clearConnectionState(reason: Error): void {
		for (const timer of this.connectionTimers) clearInterval(timer);
		this.connectionTimers = [];
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(reason);
		}
		this.pending.clear();
		this.pollInFlight = false;
	}

	// -------------------------------------------------------------------
	// Messaging
	// -------------------------------------------------------------------

	/** Sends a request and resolves with the response payload (matched by correlationId). */
	request(destination: string, payload: IDataObject, signed = false): Promise<unknown> {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error('Dzengi stream is not connected'));
		}
		const correlationId = ++this.correlationId;
		let body = payload;
		if (signed) {
			const credentials = this.config.credentials;
			if (!credentials) return Promise.reject(new Error('Dzengi credentials are required'));
			body = signWsPayload(payload, credentials.apiKey, credentials.apiSecret, Date.now() + this.timeOffsetMs);
		}
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(String(correlationId));
				reject(new Error(`Dzengi did not answer ${destination} within ${this.config.requestTimeoutMs ?? 15000} ms`));
			}, this.config.requestTimeoutMs ?? 15000);
			this.pending.set(String(correlationId), { destination, resolve, reject, timer });
			ws.send(JSON.stringify({ destination, correlationId, payload: body }), (error) => {
				if (!error) return;
				clearTimeout(timer);
				this.pending.delete(String(correlationId));
				reject(error);
			});
		});
	}

	private onMessage(data: WebSocket.RawData): void {
		this.lastActivityAt = Date.now();
		let message: IDzengiWsMessage;
		try {
			message = JSON.parse(data.toString()) as IDzengiWsMessage;
		} catch {
			this.log.debug('Dzengi stream sent a non-JSON message');
			return;
		}
		if (!isRecord(message)) return;

		const id = message.correlationId !== undefined && message.correlationId !== null ? String(message.correlationId) : undefined;
		const pending = id ? this.pending.get(id) : undefined;
		if (id && pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			const failed =
				(message.status !== undefined && message.status !== 'OK') || isDzengiErrorBody(message.payload);
			if (failed) pending.reject(new Error(wsErrorMessage(message)));
			else pending.resolve(message.payload);
			return;
		}

		this.handlePush(message);
	}

	private handlePush(message: IDzengiWsMessage): void {
		const payloads = Array.isArray(message.payload) ? message.payload : [message.payload];
		const events: IDataObject[] = [];
		for (const payload of payloads) {
			if (!isRecord(payload)) continue;
			const type = classifyStreamEvent(message.destination, payload);
			if (!type || !this.config.events.includes(type)) continue;
			const normalized = normalizeStreamEvent(type, payload);
			if (type === 'priceUpdate' && !this.allowPrice(String(normalized.symbol))) continue;
			if (this.config.includeRaw) {
				normalized.destination = message.destination;
				normalized.raw = payload;
			}
			events.push(normalized);
		}
		if (events.length) this.emit(events);
	}

	private allowPrice(symbol: string): boolean {
		const minInterval = this.config.minPriceIntervalMs ?? 0;
		if (minInterval <= 0) return true;
		const now = Date.now();
		const last = this.lastPriceEmit.get(symbol) ?? 0;
		if (now - last < minInterval) return false;
		this.lastPriceEmit.set(symbol, now);
		return true;
	}

	private emit(events: IDataObject[]): void {
		const window = this.config.batchWindowMs ?? 0;
		if (window <= 0) {
			this.handlers.onEvents(events);
			return;
		}
		this.batch.push(...events);
		if (this.batchTimer) return;
		this.batchTimer = setTimeout(() => {
			this.batchTimer = undefined;
			const batch = this.batch;
			this.batch = [];
			if (batch.length && !this.stopped) this.handlers.onEvents(batch);
		}, window);
	}

	// -------------------------------------------------------------------
	// Public streams
	// -------------------------------------------------------------------

	private async subscribeStreams(): Promise<void> {
		for (const event of this.config.events) {
			const destination = SUBSCRIBE_DESTINATIONS[event];
			if (!destination) continue;
			const payload: IDataObject = { symbols: this.config.symbols };
			if (event === 'candleUpdate') {
				payload.intervals = this.config.candleIntervals?.length ? this.config.candleIntervals : ['1m'];
				if (this.config.candleType && this.config.candleType !== 'classic') payload.type = this.config.candleType;
			}
			try {
				const response = await this.request(destination, payload);
				const errorCode = isRecord(response) ? response.errorCode : undefined;
				if (errorCode) {
					this.handlers.onError?.(new Error(`Dzengi rejected ${destination}: ${String(errorCode)}`), true);
					continue;
				}
				const failedSymbols = isRecord(response) && isRecord(response.subscriptions)
					? Object.entries(response.subscriptions)
							.filter(([, status]) => typeof status === 'string' && !/^(ok|success|subscribed)$/i.test(status))
							.map(([symbol, status]) => `${symbol} (${String(status)})`)
					: [];
				if (failedSymbols.length) {
					this.log.warn(`Dzengi could not subscribe ${destination} for: ${failedSymbols.join(', ')}`);
				} else {
					this.log.debug(`Dzengi subscribed to ${destination}`);
				}
			} catch (error) {
				if (this.stopped) return;
				const err = error instanceof Error ? error : new Error(String(error));
				// A closed socket is handled by the reconnect logic; anything else is a real rejection.
				if (!/closed|not connected|stopped/i.test(err.message)) this.handlers.onError?.(err, true);
			}
		}
	}

	// -------------------------------------------------------------------
	// Private polling
	// -------------------------------------------------------------------

	private async startPolling(): Promise<void> {
		const ws = this.ws;
		await this.syncTime();
		await this.poll();
		// The socket may have closed (and been replaced) while awaiting; only the
		// connection that started polling may schedule the timer, or polls would double up.
		if (this.stopped || this.ws !== ws) return;
		const interval = Math.max(2000, this.config.pollIntervalMs ?? 5000);
		this.connectionTimers.push(setInterval(() => void this.poll(), interval));
	}

	private async syncTime(): Promise<void> {
		try {
			const startedAt = Date.now();
			const response = await this.request(`/api/${this.config.apiVersion}/time`, {});
			const serverTime = Number(isRecord(response) ? response.serverTime : response);
			if (Number.isFinite(serverTime)) {
				this.timeOffsetMs = Math.round(serverTime - (startedAt + Date.now()) / 2);
			}
		} catch (error) {
			this.log.debug(`Dzengi time sync failed: ${(error as Error).message}`);
		}
	}

	/** Runs one polling cycle. Public so tests can drive it deterministically. */
	async poll(): Promise<void> {
		if (this.pollInFlight || this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.pollInFlight = true;
		try {
			const events: IDataObject[] = [];
			if (this.config.events.includes('orderUpdate')) events.push(...(await this.pollOrders()));
			if (this.config.events.includes('balanceUpdate')) events.push(...(await this.pollBalances()));
			if (this.config.events.includes('positionUpdate')) events.push(...(await this.pollPositions()));
			this.consecutivePollFailures = 0;
			if (events.length) this.emit(events);
		} catch (error) {
			if (this.stopped) return;
			const err = error instanceof Error ? error : new Error(String(error));
			if (/closed|not connected|stopped/i.test(err.message)) return;
			this.consecutivePollFailures++;
			this.log.warn(`Dzengi polling failed (${this.consecutivePollFailures}x): ${err.message}`);
			if (/signature|api.?key|-1022|-2014|-2015/i.test(err.message)) {
				this.handlers.onError?.(new Error(`Dzengi rejected the credentials: ${err.message}`), true);
			} else if (this.consecutivePollFailures >= (this.config.maxPollFailures ?? 5)) {
				this.consecutivePollFailures = 0;
				this.handlers.onError?.(err, false);
			}
		} finally {
			this.pollInFlight = false;
		}
	}

	private privateDestination(endpoint: string): string {
		return `/api/${this.config.apiVersion}/${endpoint}`;
	}

	private async pollOrders(): Promise<IDataObject[]> {
		const payload = await this.request(this.privateDestination('openOrders'), {}, true);
		const current = toSnapshot(listFrom(payload, 'openOrders'), (order) =>
			order.orderId !== undefined ? String(order.orderId) : undefined,
		);
		const previous = this.orders;
		this.orders = current;
		const receivedAt = Date.now();

		if (!previous) {
			if (!this.config.emitInitialState) return [];
			return [...current.values()].map((order) => ({
				event: 'orderUpdate',
				change: 'snapshot',
				orderId: order.orderId,
				symbol: order.symbol,
				status: order.status,
				order,
				receivedAt,
			}));
		}

		const diff = diffSnapshots(previous, current, ORDER_COMPARE_FIELDS);
		const events: IDataObject[] = [];
		for (const order of diff.created) {
			events.push({ event: 'orderUpdate', change: 'created', orderId: order.orderId, symbol: order.symbol, status: order.status, order, receivedAt });
		}
		for (const { current: order, previous: before, changedFields } of diff.updated) {
			events.push({
				event: 'orderUpdate',
				change: 'updated',
				orderId: order.orderId,
				symbol: order.symbol,
				status: order.status,
				changedFields,
				order,
				previous: before,
				receivedAt,
			});
		}
		for (const before of diff.removed) {
			let finalOrder: IDataObject | undefined;
			if (this.config.resolveClosedOrders !== false && before.symbol && before.orderId) {
				try {
					const fetched = await this.request(
						this.privateDestination('fetchOrder'),
						{ symbol: String(before.symbol), orderId: String(before.orderId) },
						true,
					);
					if (isRecord(fetched)) finalOrder = fetched;
				} catch (error) {
					this.log.debug(`Could not resolve final status of order ${String(before.orderId)}: ${(error as Error).message}`);
				}
			}
			events.push({
				event: 'orderUpdate',
				change: 'closed',
				orderId: before.orderId,
				symbol: before.symbol,
				status: finalOrder?.status ?? 'CLOSED',
				order: finalOrder ?? before,
				previous: before,
				receivedAt,
			});
		}
		return events;
	}

	private async pollBalances(): Promise<IDataObject[]> {
		const payload = await this.request(this.privateDestination('account'), { showZeroBalance: true }, true);
		const current = toSnapshot(listFrom(payload, 'balances'), (balance) =>
			balance.asset !== undefined ? `${String(balance.accountId ?? '')}:${String(balance.asset)}` : undefined,
		);
		const previous = this.balances;
		this.balances = current;
		const receivedAt = Date.now();
		const shape = (balance: IDataObject, change: string, before?: IDataObject): IDataObject => {
			const free = toNumber(balance.free) ?? 0;
			const locked = toNumber(balance.locked) ?? 0;
			const result: IDataObject = {
				event: 'balanceUpdate',
				change,
				accountId: balance.accountId,
				asset: balance.asset,
				free,
				locked,
				total: Number((free + locked).toPrecision(15)),
				receivedAt,
			};
			if (before) {
				const previousFree = toNumber(before.free) ?? 0;
				const previousLocked = toNumber(before.locked) ?? 0;
				result.previousFree = previousFree;
				result.previousLocked = previousLocked;
				result.freeDelta = Number((free - previousFree).toPrecision(15));
				result.lockedDelta = Number((locked - previousLocked).toPrecision(15));
			}
			return result;
		};

		if (!previous) {
			return this.config.emitInitialState ? [...current.values()].map((balance) => shape(balance, 'snapshot')) : [];
		}
		const diff = diffSnapshots(previous, current, BALANCE_COMPARE_FIELDS);
		return [
			...diff.created.map((balance) => shape(balance, 'created')),
			...diff.updated.map(({ current: balance, previous: before }) => shape(balance, 'updated', before)),
			...diff.removed.map((before) => shape({ ...before, free: 0, locked: 0 }, 'removed', before)),
		];
	}

	private async pollPositions(): Promise<IDataObject[]> {
		const payload = await this.request(this.privateDestination('tradingPositions'), {}, true);
		const current = toSnapshot(listFrom(payload, 'positions'), (position) =>
			position.id !== undefined ? String(position.id) : undefined,
		);
		const previous = this.positions;
		this.positions = current;
		const receivedAt = Date.now();
		const shape = (position: IDataObject, change: string, extra: IDataObject = {}): IDataObject => ({
			event: 'positionUpdate',
			change,
			positionId: position.id,
			symbol: position.symbol,
			state: position.state,
			position,
			...extra,
			receivedAt,
		});

		if (!previous) {
			return this.config.emitInitialState ? [...current.values()].map((position) => shape(position, 'snapshot')) : [];
		}
		const diff = diffSnapshots(previous, current, POSITION_COMPARE_FIELDS);
		return [
			...diff.created.map((position) => shape(position, 'opened')),
			...diff.updated.map(({ current: position, previous: before, changedFields }) =>
				shape(position, 'updated', { changedFields, previous: before }),
			),
			...diff.removed.map((before) => shape(before, 'closed', { previous: before })),
		];
	}
}
