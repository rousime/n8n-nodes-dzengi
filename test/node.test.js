'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const gf = require('../dist/nodes/Dzengi/GenericFunctions');
const { Dzengi } = require('../dist/nodes/Dzengi/Dzengi.node');
const { DzengiTrigger } = require('../dist/nodes/Dzengi/DzengiTrigger.node');
const { DzengiApi } = require('../dist/credentials/DzengiApi.credentials');
const { createContext, verifySignedUrl } = require('./helpers');

test.beforeEach(() => gf.resetTransportState());

const node = new Dzengi();

async function run(parameters, responses, options = {}) {
	const ctx = createContext({ parameters: { apiVersion: 'credentials', ...parameters }, responses, ...options });
	const [output] = await node.execute.call(ctx);
	return { ctx, output, json: output.map((item) => item.json) };
}

function queryOf(request) {
	return verifySignedUrl(request.url).params;
}

// ---------------------------------------------------------------------------
// Description integrity
// ---------------------------------------------------------------------------

test('node descriptions reference existing load-option and credential-test methods', () => {
	for (const nodeType of [node, new DzengiTrigger()]) {
		const walk = (properties) => {
			for (const property of properties) {
				const method = property.typeOptions?.loadOptionsMethod;
				if (method) assert.equal(typeof nodeType.methods.loadOptions[method], 'function', `missing loadOptions ${method}`);
				if (Array.isArray(property.options)) walk(property.options.filter((option) => option.displayName));
			}
		};
		walk(nodeType.description.properties);
		for (const credential of nodeType.description.credentials) {
			assert.equal(typeof nodeType.methods.credentialTest[credential.testedBy], 'function');
			assert.equal(credential.name, new DzengiApi().name);
		}
	}
});

test('every operation value is handled and every displayOptions key exists', () => {
	const names = new Set(node.description.properties.map((property) => property.name));
	for (const property of node.description.properties) {
		for (const key of Object.keys(property.displayOptions?.show ?? {})) {
			assert.ok(names.has(key.replace(/^\//, '')), `${property.name} depends on unknown parameter ${key}`);
		}
	}
	const resources = node.description.properties.find((p) => p.name === 'resource').options.map((o) => o.value);
	for (const resource of resources) {
		const operations = node.description.properties.filter(
			(p) => p.name === 'operation' && p.displayOptions.show.resource.includes(resource),
		);
		assert.equal(operations.length, 1, `exactly one operation selector for ${resource}`);
	}
});

test('credential type exposes the documented fields', () => {
	const fields = new DzengiApi().properties.map((property) => property.name);
	assert.deepEqual(fields, ['apiKey', 'apiSecret', 'environment', 'defaultApiVersion', 'recvWindow']);
});

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

test('order:create (exchange LIMIT) sends a signed POST /api/v1/order', async () => {
	const { ctx, json } = await run(
		{
			resource: 'order',
			operation: 'create',
			tradingMode: 'EXCHANGE',
			symbol: 'LTC/BTC',
			side: 'BUY',
			orderType: 'LIMIT',
			quantity: 1,
			price: 0.1,
			additionalFields: {},
		},
		[{ body: { orderId: 'abc', status: 'NEW' } }],
	);
	const [request] = ctx.requests;
	assert.equal(request.method, 'POST');
	assert.ok(request.url.startsWith('https://api-adapter.dzengi.com/api/v1/order?symbol=LTC%2FBTC&side=BUY&type=LIMIT&quantity=1&price=0.1&'));
	assert.ok(verifySignedUrl(request.url).valid);
	assert.deepEqual(json, [{ tradingMode: 'EXCHANGE', orderId: 'abc', status: 'NEW' }]);
});

test('order:create (leverage) formats the symbol and sends leverage fields on v2', async () => {
	const { ctx } = await run(
		{
			apiVersion: 'v2',
			resource: 'order',
			operation: 'create',
			tradingMode: 'LEVERAGE',
			symbol: 'BTC/USD',
			side: 'SELL',
			orderType: 'MARKET',
			quantity: 0.01,
			leverageOptions: { leverage: 5, accountId: ' 2376109060084932 ', takeProfit: 6000, stopLoss: 0, guaranteedStopLoss: false },
			additionalFields: {},
		},
		[{ body: { orderId: 'lev-1' } }],
	);
	assert.ok(ctx.requests[0].url.startsWith('https://api-adapter.dzengi.com/api/v2/order?'));
	const params = queryOf(ctx.requests[0]);
	assert.equal(params.get('symbol'), 'BTC/USD_LEVERAGE');
	assert.equal(params.get('type'), 'MARKET');
	assert.equal(params.get('leverage'), '5');
	assert.equal(params.get('accountId'), '2376109060084932');
	assert.equal(params.get('takeProfit'), '6000');
	assert.equal(params.get('guaranteedStopLoss'), 'false');
	assert.equal(params.has('stopLoss'), false, 'zero stop loss is treated as unset');
	assert.equal(params.has('price'), false, 'market orders carry no price');
});

test('order:create validates input before calling Dzengi', async () => {
	const base = { resource: 'order', operation: 'create', tradingMode: 'EXCHANGE', symbol: 'BTC/USD', side: 'BUY', additionalFields: {} };
	await assert.rejects(run({ ...base, orderType: 'STOP', quantity: 1, price: 10 }, []), /only available in leverage/);
	await assert.rejects(run({ ...base, orderType: 'LIMIT', quantity: 1, price: 0 }, []), /Price must be greater than 0/);
	await assert.rejects(run({ ...base, orderType: 'MARKET', quantity: 0 }, []), /Quantity must be greater than 0/);
});

test('order:cancel and order:get use DELETE /order and GET /fetchOrder', async () => {
	const cancel = await run(
		{ resource: 'order', operation: 'cancel', tradingMode: 'LEVERAGE', symbol: 'ETH/USD', orderId: ' 77 ' },
		[{ body: { orderId: '77', status: 'CANCELED' } }],
	);
	assert.equal(cancel.ctx.requests[0].method, 'DELETE');
	assert.equal(queryOf(cancel.ctx.requests[0]).get('symbol'), 'ETH/USD_LEVERAGE');
	assert.equal(queryOf(cancel.ctx.requests[0]).get('orderId'), '77');

	const get = await run(
		{ resource: 'order', operation: 'get', tradingMode: 'EXCHANGE', symbol: 'ETH/USD', orderId: '77' },
		[{ body: { orderId: '77', status: 'FILLED' } }],
	);
	assert.ok(get.ctx.requests[0].url.includes('/api/v1/fetchOrder?symbol=ETH%2FUSD&orderId=77&'));
	assert.equal(get.json[0].status, 'FILLED');
});

test('order:getAll filters open orders client-side and applies the limit', async () => {
	const orders = [
		{ orderId: '1', symbol: 'BTC/USD', side: 'BUY', status: 'NEW', type: 'LIMIT', time: 1700000001000, leverage: false },
		{ orderId: '2', symbol: 'BTC/USD', side: 'SELL', status: 'NEW', type: 'LIMIT', time: 1700000002000, leverage: false },
		{ orderId: '3', symbol: 'BTC/USD_LEVERAGE', side: 'BUY', status: 'PARTIALLY_FILLED', type: 'STOP', time: 1700000003000, leverage: true },
		{ orderId: '4', symbol: 'ETH/USD', side: 'BUY', status: 'NEW', type: 'LIMIT', time: 1700000004000, leverage: false },
	];
	const filtered = await run(
		{ resource: 'order', operation: 'getAll', returnAll: true, filters: { side: 'BUY', tradingMode: 'EXCHANGE', startTime: new Date(1700000001500).toISOString() } },
		[{ body: { openOrders: orders } }],
	);
	assert.deepEqual(filtered.json.map((o) => o.orderId), ['4']);

	const limited = await run({ resource: 'order', operation: 'getAll', returnAll: false, limit: 2, filters: {} }, [{ body: orders }]);
	assert.deepEqual(limited.json.map((o) => o.orderId), ['1', '2']);
});

test('order:update uses PUT /order for exchange and /updateTradingOrder for leverage', async () => {
	const exchange = await run(
		{ resource: 'order', operation: 'update', tradingMode: 'EXCHANGE', orderId: '5', exchangeUpdateFields: { price: 101.5 } },
		[{ body: { orderId: '5' } }],
	);
	assert.equal(exchange.ctx.requests[0].method, 'PUT');
	assert.equal(queryOf(exchange.ctx.requests[0]).get('price'), '101.5');

	const leverage = await run(
		{ resource: 'order', operation: 'update', tradingMode: 'LEVERAGE', orderId: '6', leverageUpdateFields: { stopLoss: 90, trailingStopLoss: true } },
		[{ body: { requestId: 1, state: 'PROCESSED' } }],
	);
	assert.ok(leverage.ctx.requests[0].url.includes('/api/v1/updateTradingOrder?orderId=6&stopLoss=90&trailingStopLoss=true&'));

	await assert.rejects(
		run({ resource: 'order', operation: 'update', tradingMode: 'EXCHANGE', orderId: '5', exchangeUpdateFields: {} }, []),
		/at least one field/,
	);
});

// ---------------------------------------------------------------------------
// Account & positions
// ---------------------------------------------------------------------------

const account = {
	canTrade: true,
	balances: [
		{ accountId: 'a1', asset: 'USD', free: 100, locked: 5 },
		{ accountId: 'a1', asset: 'BTC', free: 0.5, locked: 0 },
	],
};

test('account:getBalances returns a summary with optional positions, or one item per balance', async () => {
	const summary = await run(
		{ resource: 'account', operation: 'getBalances', output: 'summary', balanceOptions: { includePositions: true, assets: 'usd' } },
		[{ body: account }, { body: { positions: [{ id: 'p1', state: 'ACTIVE' }] } }],
	);
	assert.equal(queryOf(summary.ctx.requests[0]).get('showZeroBalance'), 'false');
	assert.ok(summary.ctx.requests[1].url.includes('/api/v1/tradingPositions?'));
	assert.equal(summary.json.length, 1);
	assert.deepEqual(summary.json[0].balances.map((b) => b.asset), ['USD']);
	assert.equal(summary.json[0].positions[0].id, 'p1');

	const split = await run({ resource: 'account', operation: 'getBalances', output: 'balances', balanceOptions: {} }, [{ body: account }]);
	assert.deepEqual(split.json.map((b) => b.asset), ['USD', 'BTC']);
});

test('account:getTradeHistory pages /myTrades and returns the newest trades', async () => {
	const { ctx, json } = await run(
		{ resource: 'account', operation: 'getTradeHistory', symbol: 'BTC/USD', returnAll: false, limit: 2, filters: {} },
		[{ body: [{ id: 't1', time: 1 }, { id: 't2', time: 2 }] }],
	);
	assert.equal(queryOf(ctx.requests[0]).get('limit'), '2');
	assert.deepEqual(json.map((t) => t.id), ['t1', 't2']);
});

test('position operations map to the leverage endpoints', async () => {
	const close = await run({ resource: 'position', operation: 'close', positionId: 'p-1' }, [
		{ body: { request: [{ id: 9, state: 'PROCESSED', rqType: 'ORDER_NEW' }] } },
	]);
	assert.equal(close.ctx.requests[0].method, 'POST');
	assert.ok(close.ctx.requests[0].url.includes('/api/v1/closeTradingPosition?positionId=p-1&'));
	assert.deepEqual(close.json[0], { positionId: 'p-1', requests: [{ id: 9, state: 'PROCESSED', rqType: 'ORDER_NEW' }] });

	const update = await run(
		{ resource: 'position', operation: 'update', positionId: 'p-1', updateFields: { takeProfit: 70000 } },
		[{ body: { requestId: 3, state: 'PENDING' } }],
	);
	assert.ok(update.ctx.requests[0].url.includes('/api/v1/updateTradingPosition?positionId=p-1&takeProfit=70000&'));

	const list = await run(
		{ resource: 'position', operation: 'getAll', returnAll: true, filters: { symbol: 'BTC/USD' } },
		[{ body: { positions: [{ id: '1', symbol: 'BTC/USD_LEVERAGE' }, { id: '2', symbol: 'ETH/USD_LEVERAGE' }] } }],
	);
	assert.deepEqual(list.json.map((p) => p.id), ['1']);

	const history = await run(
		{ resource: 'position', operation: 'getHistory', returnAll: false, limit: 10, filters: { startTime: '2026-01-01T00:00:00Z' } },
		[{ body: { history: [{ execId: 'e1', positionId: 'p', execTimestamp: 1767225600001 }] } }],
	);
	assert.equal(queryOf(history.ctx.requests[0]).get('from'), String(Date.parse('2026-01-01T00:00:00Z')));
	assert.equal(history.json[0].execId, 'e1');
});

// ---------------------------------------------------------------------------
// Market data (public)
// ---------------------------------------------------------------------------

test('marketData:getTickers (marketcap) works without credentials and filters symbols', async () => {
	const { ctx, json } = await run(
		{ resource: 'marketData', operation: 'getTickers', source: 'marketcap', market: 'tokenCrypto', returnAll: true, options: { symbols: 'btc/usd' } },
		[{ body: { 'BTC/USD': { last_price: 65000 }, 'ETH/USD': { last_price: 3000 } } }],
		{ credentials: null },
	);
	assert.equal(ctx.requests[0].url, 'https://marketcap.dzengi.com/api/v1/token_crypto/ticker');
	assert.deepEqual(json, [{ symbol: 'BTC/USD', last_price: 65000 }]);
});

test('marketData:getTickers (trading API) calls the versioned /ticker/24hr', async () => {
	const { ctx, json } = await run(
		{ apiVersion: 'v2', resource: 'marketData', operation: 'getTickers', source: 'tradingApi', returnAll: false, limit: 1, options: {} },
		[{ body: [{ symbol: 'A' }, { symbol: 'B' }] }],
		{ credentials: null },
	);
	assert.equal(ctx.requests[0].url, 'https://api-adapter.dzengi.com/api/v2/ticker/24hr');
	assert.deepEqual(json, [{ symbol: 'A' }]);
});

test('marketData:getOrderBook simplifies levels and computes best bid/ask and spread', async () => {
	const { ctx, json } = await run(
		{ resource: 'marketData', operation: 'getOrderBook', symbol: 'BTC/USD', depth: 5, options: { environment: 'demo' } },
		[{ body: { lastUpdateId: 7, bids: [[100.1, 2], [100, 1]], asks: [[100.3, 1]] } }],
		{ credentials: null },
	);
	assert.equal(ctx.requests[0].url, 'https://demo-api-adapter.dzengi.com/api/v1/depth?symbol=BTC%2FUSD&limit=5');
	assert.deepEqual(json[0], {
		symbol: 'BTC/USD',
		lastUpdateId: 7,
		bestBid: 100.1,
		bestAsk: 100.3,
		spread: 0.2,
		bids: [{ price: 100.1, quantity: 2 }, { price: 100, quantity: 1 }],
		asks: [{ price: 100.3, quantity: 1 }],
	});
});

test('marketData:getSymbolInfo finds the symbol in exchangeInfo or explains why not', async () => {
	const exchangeInfo = { symbols: [{ symbol: 'BTC/USD', marketType: 'SPOT' }, { symbol: 'BTC/USD_LEVERAGE', marketType: 'LEVERAGE' }] };
	const found = await run({ resource: 'marketData', operation: 'getSymbolInfo', symbol: 'btc/usd_leverage', options: {} }, [{ body: exchangeInfo }], { credentials: null });
	assert.equal(found.json[0].marketType, 'LEVERAGE');
	await assert.rejects(
		run({ resource: 'marketData', operation: 'getSymbolInfo', symbol: 'NOPE', options: {} }, [{ body: exchangeInfo }], { credentials: null }),
		/not found/,
	);
});

test('marketData:getCandles maps klines to objects and Heikin-Ashi to the REST type name', async () => {
	const { ctx, json } = await run(
		{ resource: 'marketData', operation: 'getCandles', symbol: 'ETH/USD', interval: '1h', candleLimit: 2, options: { candleType: 'heikinAshi' } },
		[{ body: [[1700000000000, '1', '2', '0.5', '1.5', '10']] }],
		{ credentials: null },
	);
	const params = new URLSearchParams(ctx.requests[0].url.split('?')[1]);
	assert.equal(params.get('type'), 'heiken-ashi');
	assert.equal(params.get('interval'), '1h');
	assert.deepEqual(json[0], { symbol: 'ETH/USD', interval: '1h', openTime: 1700000000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
});

// ---------------------------------------------------------------------------
// Errors & load options
// ---------------------------------------------------------------------------

test('continueOnFail turns API errors into error items paired with the input', async () => {
	const { json, output } = await run(
		{ resource: 'order', operation: 'get', tradingMode: 'EXCHANGE', symbol: 'X', orderId: '1' },
		[{ statusCode: 400, body: { code: -2013, msg: 'Order does not exist.' } }],
		{ continueOnFail: true },
	);
	assert.match(json[0].error, /Order does not exist/);
	assert.match(json[0].description, /-2013/);
	assert.deepEqual(output[0].pairedItem, { item: 0 });
});

test('load options: marketcap symbols and exchangeInfo symbols filtered by trading mode', async () => {
	const tickerCtx = createContext({ credentials: null, responses: [{ body: { 'ETH/USD': { description: 'ETH/USD' }, 'BTC/USD': {} } }] });
	const tickerOptions = await gf.getSymbols.call(tickerCtx);
	assert.deepEqual(tickerOptions.map((o) => o.value), ['BTC/USD', 'ETH/USD']);

	const info = { symbols: [{ symbol: 'BTC/USD', name: 'Bitcoin / US Dollar', marketType: 'SPOT' }, { symbol: 'BTC/USD_LEVERAGE', marketType: 'LEVERAGE' }] };
	const leverageCtx = createContext({ parameters: { tradingMode: 'LEVERAGE', apiVersion: 'v2' }, responses: [{ body: info }] });
	const leverage = await gf.getTradingSymbols.call(leverageCtx);
	assert.deepEqual(leverage.map((o) => o.value), ['BTC/USD_LEVERAGE']);
	assert.ok(leverageCtx.requests[0].url.startsWith('https://api-adapter.dzengi.com/api/v2/exchangeInfo'));

	const exchangeCtx = createContext({ parameters: { tradingMode: 'EXCHANGE' }, responses: [{ body: info }] });
	const exchange = await gf.getTradingSymbols.call(exchangeCtx);
	assert.equal(exchange[0].name, 'BTC/USD — Bitcoin / US Dollar');

	const emptyCtx = createContext({ parameters: { tradingMode: 'LEVERAGE' }, responses: [{ body: { symbols: [info.symbols[0]] } }] });
	await assert.rejects(gf.getTradingSymbols.call(emptyCtx), /API v2/);
});

test('credential test performs a signed GET /account and reports Dzengi errors', async () => {
	const calls = [];
	const testCtx = (accountResponse) => ({
		logger: {},
		helpers: {
			request: async (options) => {
				calls.push(options);
				if (options.uri.endsWith('/time')) return { serverTime: Date.now() };
				if (accountResponse instanceof Error) throw accountResponse;
				return accountResponse;
			},
		},
	});
	const credential = {
		id: '1',
		name: 'Dzengi',
		type: 'dzengiApi',
		data: { apiKey: 'key', apiSecret: 'secret', environment: 'live', defaultApiVersion: 'v1', recvWindow: 5000 },
	};
	const ok = await gf.testDzengiCredentials.call(testCtx({ balances: [] }), credential);
	assert.equal(ok.status, 'OK');
	const accountCall = calls.find((call) => call.uri.includes('/account?'));
	assert.equal(accountCall.headers['X-MBX-APIKEY'], 'key');
	assert.ok(verifySignedUrl(accountCall.uri, 'secret').valid);

	const rejected = Object.assign(new Error('400'), { response: { status: 400, body: { code: -2015, msg: 'Invalid API-key' } } });
	const bad = await gf.testDzengiCredentials.call(testCtx(rejected), credential);
	assert.equal(bad.status, 'Error');
	assert.match(bad.message, /-2015: Invalid API-key/);

	const demoV2 = await gf.testDzengiCredentials.call(testCtx({}), { ...credential, data: { ...credential.data, environment: 'demo', defaultApiVersion: 'v2' } });
	assert.match(demoV2.message, /only support API v1/);
});
