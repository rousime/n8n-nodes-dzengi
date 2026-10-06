'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const gf = require('../dist/nodes/Dzengi/GenericFunctions');
const { API_SECRET, hmac } = require('./helpers');

test('reproduces the official Dzengi exchange-order signature example', () => {
	const query =
		'symbol=LTC%2FBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
	assert.equal(
		gf.generateSignature(API_SECRET, '1499827319559', query),
		'ebec6528b2beb508b2417fa33453a4ad28c1aae8097bb243caa60d0524036f50',
	);
	// Same bytes sent as a request body give the same signature.
	assert.equal(
		gf.generateSignature(API_SECRET, '1499827319559', '', query),
		'ebec6528b2beb508b2417fa33453a4ad28c1aae8097bb243caa60d0524036f50',
	);
});

test('reproduces the official Dzengi leverage-order signature example via buildSignedParams', () => {
	const { unsigned, signature, signed } = gf.buildSignedParams(
		{
			symbol: 'BTC/USD_LEVERAGE',
			side: 'BUY',
			type: 'MARKET',
			timeInForce: 'GTC',
			quantity: 0.01,
			leverage: 2,
			accountId: '2376109060084932',
			takeProfit: 8000,
			stopLoss: 6000,
		},
		API_SECRET,
		1586942164000,
		60000,
	);
	assert.equal(
		unsigned,
		'symbol=BTC%2FUSD_LEVERAGE&side=BUY&type=MARKET&timeInForce=GTC&quantity=0.01&leverage=2&accountId=2376109060084932&takeProfit=8000&stopLoss=6000&recvWindow=60000&timestamp=1586942164000',
	);
	assert.equal(signature, '05fc9fd19c2b1a11215025c5dfa56da2204b04181add67670d4f92049b439f7b');
	assert.ok(signed.endsWith(`&signature=${signature}`));
});

test('generateSignature refuses payloads without the timestamp', () => {
	assert.throws(() => gf.generateSignature(API_SECRET, '123', 'symbol=BTC%2FUSD'), /timestamp/);
	assert.throws(() => gf.generateSignature(API_SECRET, '123', 'timestamp=1234'), /timestamp/);
});

test('query strings use RFC 3986 encoding and skip empty values', () => {
	assert.equal(
		gf.buildQueryString({ symbol: 'Oil - Brent.', a: undefined, b: null, c: '', flag: false, n: 1e-7 }),
		'symbol=Oil%20-%20Brent.&flag=false&n=0.0000001',
	);
});

test('formatNumber never produces exponent notation', () => {
	assert.equal(gf.formatNumber(1e-7), '0.0000001');
	assert.equal(gf.formatNumber(1.5e-7), '0.00000015');
	assert.equal(gf.formatNumber(-2e-8), '-0.00000002');
	assert.equal(gf.formatNumber(1e21), '1000000000000000000000');
	assert.equal(gf.formatNumber(0.1), '0.1');
	assert.equal(gf.formatNumber(1586942164000), '1586942164000');
	assert.throws(() => gf.formatNumber(Number.NaN));
});

test('WebSocket signing matches the official client (sorted, raw key=value)', () => {
	// Re-implementation of getHash() from github.com/dzengi-com/open-api-examples
	const official = (payload) => {
		let text = '';
		Object.keys(payload)
			.sort()
			.forEach((key) => {
				text += `${key}=${payload[key]}&`;
			});
		return hmac(text.substring(0, text.length - 1));
	};
	const signed = gf.signWsPayload({ symbol: 'ETH/USD', limit: 5 }, 'my-key', API_SECRET, 1700000000000);
	const { signature, ...rest } = signed;
	assert.equal(signature, official(rest));
	assert.equal(gf.buildWsSignaturePayload(rest), 'apiKey=my-key&limit=5&symbol=ETH/USD&timestamp=1700000000000');
});

test('leverage symbol formatting follows the Dzengi rules', () => {
	assert.equal(gf.formatLeverageSymbol('BTC/USD'), 'BTC/USD_LEVERAGE');
	assert.equal(gf.formatLeverageSymbol(' BTC/USD_LEVERAGE '), 'BTC/USD_LEVERAGE');
	assert.equal(gf.formatLeverageSymbol('Oil - Brent.'), 'Oil - Brent.');
});

test('response helpers normalise Dzengi shapes', () => {
	assert.deepEqual(gf.normalizeResponse('{"a":1}'), { a: 1 });
	assert.deepEqual(gf.normalizeResponse({ status: 'OK', correlationId: '3', payload: { x: 1 } }), { x: 1 });
	assert.deepEqual(gf.extractList({ openOrders: [{ orderId: '1' }] }, ['openOrders']), [{ orderId: '1' }]);
	assert.deepEqual(gf.extractList({ positions: [] }), []);
	assert.deepEqual(gf.extractList([]), []);
	assert.equal(gf.isDzengiErrorBody({ code: -1121, msg: 'Invalid symbol.' }), true);
	assert.equal(gf.isDzengiErrorBody({ code: 0, msg: 'ok' }), false);
	assert.equal(gf.isDzengiErrorBody({ symbol: 'BTC/USD' }), false);
});

test('marketcap ticker map is converted to a list (object keyed by symbol, array or {data})', () => {
	const map = { 'BTC/USD': { last_price: 1 }, 'ETH/USD': { last_price: 2 } };
	assert.deepEqual(gf.tickerMapToList(map), [
		{ symbol: 'BTC/USD', last_price: 1 },
		{ symbol: 'ETH/USD', last_price: 2 },
	]);
	assert.deepEqual(gf.tickerMapToList({ data: map }).length, 2);
	assert.deepEqual(gf.tickerMapToList([{ symbol: 'X' }]), [{ symbol: 'X' }]);
});

test('klines and order book levels are simplified', () => {
	assert.deepEqual(gf.simplifyKlines([[1, '2', '3', '1', '2.5', '10']]), [
		{ openTime: 1, open: 2, high: 3, low: 1, close: 2.5, volume: 10 },
	]);
	assert.deepEqual(gf.simplifyKlines({ lines: [[1, 2, 3, 1, 2]] })[0].close, 2);
	assert.deepEqual(gf.simplifyOrderBookSide([[100.5, 2]]), [{ price: 100.5, quantity: 2 }]);
});

test('demo + v2 is rejected, everything else allowed', () => {
	assert.match(gf.versionSupportError('demo', 'v2'), /only support API v1/);
	assert.equal(gf.versionSupportError('demo', 'v1'), undefined);
	assert.equal(gf.versionSupportError('live', 'v2'), undefined);
	assert.equal(gf.resolveApiVersion('credentials', { defaultApiVersion: 'v2' }), 'v2');
	assert.equal(gf.resolveApiVersion('v1', { defaultApiVersion: 'v2' }), 'v1');
	assert.equal(gf.resolveApiVersion(undefined, undefined), 'v1');
});
