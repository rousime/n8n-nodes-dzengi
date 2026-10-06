'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

const gf = require('../dist/nodes/Dzengi/GenericFunctions');
const {
	DzengiStreamClient,
	classifyStreamEvent,
	diffSnapshots,
	toSnapshot,
} = require('../dist/nodes/Dzengi/DzengiWebSocketClient');
const { DzengiTrigger } = require('../dist/nodes/Dzengi/DzengiTrigger.node');
const { API_KEY, API_SECRET, hmac, createContext } = require('./helpers');

/** Independent check of the WebSocket signature (official client algorithm). */
function wsSignatureValid(payload) {
	const { signature, ...rest } = payload;
	const text = Object.keys(rest)
		.sort()
		.map((key) => `${key}=${rest[key]}`)
		.join('&');
	return hmac(text) === signature;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 4000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (check()) return;
		await wait(20);
	}
	throw new Error('Timed out waiting for condition');
}

/**
 * Minimal Dzengi WebSocket mock: answers subscriptions, time, openOrders, account,
 * tradingPositions and fetchOrder; records every message it receives.
 */
function startMockServer(state) {
	const server = new WebSocketServer({ port: 0 });
	const received = [];
	const sockets = [];
	server.on('connection', (socket) => {
		sockets.push(socket);
		socket.on('message', (raw) => {
			const message = JSON.parse(raw.toString());
			received.push(message);
			const reply = (payload, status = 'OK') =>
				socket.send(JSON.stringify({ status, destination: message.destination, correlationId: String(message.correlationId), payload }));
			const { destination, payload } = message;
			if (destination.endsWith('.subscribe')) {
				reply({ subscriptions: Object.fromEntries(payload.symbols.map((symbol) => [symbol, 'OK'])) });
			} else if (destination === 'ping') {
				reply({});
			} else if (destination.endsWith('/time')) {
				reply({ serverTime: Date.now() });
			} else if (!wsSignatureValid(payload) || payload.apiKey !== API_KEY) {
				reply({ code: -1022, msg: 'Signature for this request is not valid.' }, 'NOK');
			} else if (destination.endsWith('/openOrders')) {
				reply({ openOrders: state.orders });
			} else if (destination.endsWith('/account')) {
				reply({ balances: state.balances });
			} else if (destination.endsWith('/tradingPositions')) {
				reply({ positions: state.positions });
			} else if (destination.endsWith('/fetchOrder')) {
				reply({ orderId: payload.orderId, symbol: payload.symbol, status: 'FILLED' });
			} else {
				reply({ code: -1, msg: `unknown destination ${destination}` }, 'NOK');
			}
		});
	});
	const ready = new Promise((resolve) => server.on('listening', resolve));
	return {
		server,
		received,
		sockets,
		ready,
		get url() {
			return `ws://127.0.0.1:${server.address().port}`;
		},
		push(destination, payload) {
			for (const socket of sockets) {
				if (socket.readyState === 1) socket.send(JSON.stringify({ status: 'OK', destination, payload }));
			}
		},
		close: () => new Promise((resolve) => {
			for (const socket of sockets) socket.terminate();
			server.close(resolve);
		}),
	};
}

test('classifies Dzengi stream payloads by shape', () => {
	assert.equal(classifyStreamEvent('internal.quote', { symbolName: 'BTC/USD', bid: 1, ofr: 2 }), 'priceUpdate');
	assert.equal(classifyStreamEvent(undefined, { symbol: 'X', o: 1, h: 2, l: 0, c: 1, t: 1, interval: '1m' }), 'candleUpdate');
	assert.equal(classifyStreamEvent(undefined, { symbol: 'X', data: { ts: 1, bid: { 1: 2 }, ofr: {} } }), 'orderBookUpdate');
	assert.equal(classifyStreamEvent(undefined, { symbol: 'X', price: 1, size: 2, id: 1 }), 'marketTrade');
	assert.equal(classifyStreamEvent('something.else', { foo: 1 }), undefined);
});

test('snapshot diff reports created, updated (numerically) and removed entries', () => {
	const before = toSnapshot([{ id: 'a', qty: '1.0' }, { id: 'b', qty: 1 }], (e) => e.id);
	const after = toSnapshot([{ id: 'a', qty: 1 }, { id: 'c', qty: 1 }], (e) => e.id);
	const diff = diffSnapshots(before, after, ['qty']);
	assert.deepEqual(diff.created.map((e) => e.id), ['c']);
	assert.deepEqual(diff.updated, []); // "1.0" vs 1 is not a change
	assert.deepEqual(diff.removed.map((e) => e.id), ['b']);
});

test('streams quotes, polls orders/balances with valid signatures, and reconnects', async (t) => {
	const state = {
		orders: [{ orderId: 'o1', symbol: 'BTC/USD', status: 'NEW', executedQty: '0', price: '100' }],
		balances: [{ accountId: 'a1', asset: 'USD', free: 100, locked: 0 }],
		positions: [],
	};
	const mock = startMockServer(state);
	await mock.ready;
	t.after(() => mock.close());

	const events = [];
	const fatal = [];
	let opens = 0;
	const client = new DzengiStreamClient(
		{
			url: mock.url,
			apiVersion: 'v1',
			events: ['priceUpdate', 'orderUpdate', 'balanceUpdate'],
			symbols: ['BTC/USD', 'ETH/USD'],
			credentials: { apiKey: API_KEY, apiSecret: API_SECRET },
			pollIntervalMs: 60000, // polls are driven manually below
			reconnect: { initialDelayMs: 50 },
		},
		{
			onEvents: (batch) => events.push(...batch),
			onError: (error, isFatal) => (isFatal ? fatal.push(error) : undefined),
			onOpen: () => opens++,
		},
	);
	client.start();
	t.after(() => client.stop());

	// Subscription request format
	await waitFor(() => mock.received.some((m) => m.destination === 'marketData.subscribe'));
	const subscribe = mock.received.find((m) => m.destination === 'marketData.subscribe');
	assert.deepEqual(subscribe.payload, { symbols: ['BTC/USD', 'ETH/USD'] });
	assert.equal(typeof subscribe.correlationId, 'number');

	// Initial private poll establishes the baseline silently (emitInitialState is off)
	await waitFor(() => mock.received.some((m) => m.destination === '/api/v1/account'));
	await wait(50);
	assert.equal(events.length, 0);

	// Pushed quote → normalised priceUpdate
	mock.push('internal.quote', { symbolName: 'BTC/USD', bid: 65000.5, ofr: 65001, bidQty: 1, ofrQty: 2, timestamp: 1700000000000 });
	await waitFor(() => events.length === 1);
	assert.deepEqual(
		{ ...events[0], receivedAt: undefined },
		{ event: 'priceUpdate', symbol: 'BTC/USD', bid: 65000.5, ask: 65001, bidQty: 1, askQty: 2, spread: 0.5, timestamp: 1700000000000, receivedAt: undefined },
	);

	// Order partially fills, a new order appears, balance moves → diff events
	state.orders = [
		{ orderId: 'o1', symbol: 'BTC/USD', status: 'PARTIALLY_FILLED', executedQty: '0.5', price: '100' },
		{ orderId: 'o2', symbol: 'ETH/USD', status: 'NEW', executedQty: '0', price: '10' },
	];
	state.balances = [{ accountId: 'a1', asset: 'USD', free: 50, locked: 25 }];
	await client.poll();
	const orderEvents = events.filter((e) => e.event === 'orderUpdate');
	assert.deepEqual(orderEvents.map((e) => [e.orderId, e.change]).sort(), [['o1', 'updated'], ['o2', 'created']]);
	assert.deepEqual(orderEvents.find((e) => e.orderId === 'o1').changedFields, ['status', 'executedQty']);
	const balance = events.find((e) => e.event === 'balanceUpdate');
	assert.equal(balance.freeDelta, -50);
	assert.equal(balance.lockedDelta, 25);
	assert.equal(balance.total, 75);

	// Order leaves the open list → closed, with final status looked up via fetchOrder
	state.orders = [state.orders[1]];
	await client.poll();
	const closed = events.find((e) => e.change === 'closed');
	assert.equal(closed.orderId, 'o1');
	assert.equal(closed.status, 'FILLED');

	// Every private request carried apiKey + timestamp + a valid signature
	const privateRequests = mock.received.filter((m) => m.destination.startsWith('/api/v1/') && !m.destination.endsWith('/time'));
	assert.ok(privateRequests.length >= 6);
	for (const request of privateRequests) assert.ok(wsSignatureValid(request.payload), `bad signature for ${request.destination}`);

	// Server drops the connection → client reconnects and re-subscribes
	const subscriptionsBefore = mock.received.filter((m) => m.destination === 'marketData.subscribe').length;
	for (const socket of mock.sockets) socket.terminate();
	await waitFor(() => opens === 2);
	await waitFor(() => mock.received.filter((m) => m.destination === 'marketData.subscribe').length === subscriptionsBefore + 1);
	assert.equal(fatal.length, 0);

	// stop() closes cleanly and does not reconnect
	await client.stop();
	await wait(200);
	assert.equal(opens, 2);
});

test('a socket that drops during the first poll does not leave a duplicate poll timer', async (t) => {
	const mock = startMockServer({ orders: [], balances: [], positions: [] });
	await mock.ready;
	t.after(() => mock.close());
	// Kill the connection as soon as the first private request arrives.
	mock.server.on('connection', (socket) => {
		socket.on('message', (raw) => {
			if (JSON.parse(raw.toString()).destination === '/api/v1/time' && mock.sockets.length === 1) socket.terminate();
		});
	});
	let opens = 0;
	const client = new DzengiStreamClient(
		{
			url: mock.url,
			apiVersion: 'v1',
			events: ['balanceUpdate'],
			symbols: [],
			credentials: { apiKey: API_KEY, apiSecret: API_SECRET },
			pollIntervalMs: 2000,
			reconnect: { initialDelayMs: 20 },
		},
		{ onEvents: () => undefined, onOpen: () => opens++ },
	);
	client.start();
	t.after(() => client.stop());
	await waitFor(() => opens === 2);
	await waitFor(() => mock.received.filter((m) => m.destination === '/api/v1/account').length >= 1);
	const accountCalls = () => mock.received.filter((m) => m.destination === '/api/v1/account').length;
	const before = accountCalls();
	await wait(2300); // exactly one interval tick expected on the live connection
	assert.equal(accountCalls() - before, 1);
});

test('rejected credentials are reported as fatal', async (t) => {
	const mock = startMockServer({ orders: [], balances: [], positions: [] });
	await mock.ready;
	t.after(() => mock.close());
	const fatal = [];
	const client = new DzengiStreamClient(
		{ url: mock.url, apiVersion: 'v1', events: ['balanceUpdate'], symbols: [], credentials: { apiKey: API_KEY, apiSecret: 'wrong-secret' } },
		{ onEvents: () => undefined, onError: (error, isFatal) => isFatal && fatal.push(error) },
	);
	client.start();
	t.after(() => client.stop());
	await waitFor(() => fatal.length === 1);
	assert.match(fatal[0].message, /rejected the credentials.*-1022/);
});

test('price throttling and batching', async (t) => {
	const mock = startMockServer({ orders: [], balances: [], positions: [] });
	await mock.ready;
	t.after(() => mock.close());
	const batches = [];
	const client = new DzengiStreamClient(
		{ url: mock.url, apiVersion: 'v1', events: ['priceUpdate'], symbols: ['BTC/USD'], minPriceIntervalMs: 10000, batchWindowMs: 100 },
		{ onEvents: (batch) => batches.push(batch) },
	);
	client.start();
	t.after(() => client.stop());
	await waitFor(() => mock.received.some((m) => m.destination === 'marketData.subscribe'));
	await wait(30);
	mock.push('internal.quote', { symbolName: 'BTC/USD', bid: 1, ofr: 2 });
	mock.push('internal.quote', { symbolName: 'BTC/USD', bid: 3, ofr: 4 }); // throttled
	mock.push('internal.quote', { symbolName: 'ETH/USD', bid: 5, ofr: 6 }); // other symbol passes
	await waitFor(() => batches.length === 1);
	assert.deepEqual(batches[0].map((e) => e.bid), [1, 5]);
});

test('Dzengi Trigger: manual run resolves on the first event and closes cleanly', async (t) => {
	const mock = startMockServer({ orders: [], balances: [], positions: [] });
	await mock.ready;
	const originalUrl = gf.DZENGI_URLS.live.ws;
	gf.DZENGI_URLS.live.ws = mock.url; // point the trigger at the mock server
	t.after(async () => {
		gf.DZENGI_URLS.live.ws = originalUrl;
		await mock.close();
	});

	const ctx = createContext({
		credentials: null,
		mode: 'manual',
		parameters: { events: ['priceUpdate'], apiVersion: 'credentials', symbols: ['BTC/USD'], options: {} },
	});
	const trigger = new DzengiTrigger();
	const response = await trigger.trigger.call(ctx);
	const manual = response.manualTriggerFunction();
	await waitFor(() => mock.received.some((m) => m.destination === 'marketData.subscribe'));
	mock.push('internal.quote', { symbolName: 'BTC/USD', bid: 10, ofr: 11 });
	await manual;
	assert.equal(ctx.emitted.length, 1);
	assert.equal(ctx.emitted[0][0][0].json.event, 'priceUpdate');
	await response.closeFunction();
});

test('Dzengi Trigger validates its configuration', async () => {
	const trigger = new DzengiTrigger();
	await assert.rejects(
		trigger.trigger.call(createContext({ credentials: null, parameters: { events: ['orderUpdate'], options: {} } })),
		/credentials are required/,
	);
	await assert.rejects(
		trigger.trigger.call(createContext({ parameters: { events: ['priceUpdate'], symbols: [], options: {} } })),
		/at least one symbol/,
	);
	await assert.rejects(
		trigger.trigger.call(
			createContext({
				credentials: { apiKey: 'k', apiSecret: 's', environment: 'demo', defaultApiVersion: 'v2' },
				parameters: { events: ['balanceUpdate'], options: {} },
			}),
		),
		/only support API v1/,
	);
});
