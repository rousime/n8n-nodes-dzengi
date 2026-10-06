'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const gf = require('../dist/nodes/Dzengi/GenericFunctions');
const { API_KEY, createContext, verifySignedUrl, networkError } = require('./helpers');

test.beforeEach(() => gf.resetTransportState());

test('signed GET goes to the versioned adapter URL with API key header and valid signature', async () => {
	const ctx = createContext({ responses: [{ body: { balances: [] } }] });
	const result = await gf.dzengiApiRequest.call(ctx, 'GET', '/account', {}, { showZeroBalance: false });
	assert.deepEqual(result, { balances: [] });

	const [request] = ctx.requests;
	assert.equal(request.method, 'GET');
	assert.ok(request.url.startsWith('https://api-adapter.dzengi.com/api/v1/account?showZeroBalance=false&recvWindow=5000&timestamp='));
	assert.equal(request.headers['X-MBX-APIKEY'], API_KEY);
	assert.equal(request.ignoreHttpStatusErrors, true);
	assert.equal(request.returnFullResponse, true);
	const { valid, params } = verifySignedUrl(request.url);
	assert.ok(valid, 'signature must verify');
	assert.ok(Math.abs(Number(params.get('timestamp')) - Date.now()) < 5000);
});

test('API version override and demo environment pick the right host', async () => {
	const live = createContext({ responses: [{ body: {} }] });
	await gf.dzengiApiRequest.call(live, 'GET', '/tradingPositions', {}, {}, false, { apiVersion: 'v2' });
	assert.ok(live.requests[0].url.startsWith('https://api-adapter.dzengi.com/api/v2/tradingPositions?'));

	const demo = createContext({
		credentials: { apiKey: 'k', apiSecret: 's', environment: 'demo', defaultApiVersion: 'v1' },
		responses: [{ body: {} }],
	});
	await gf.dzengiApiRequest.call(demo, 'GET', '/account');
	assert.ok(demo.requests[0].url.startsWith('https://demo-api-adapter.dzengi.com/api/v1/account?'));

	await assert.rejects(
		gf.dzengiApiRequest.call(demo, 'GET', '/account', {}, {}, false, { apiVersion: 'v2' }),
		/demo accounts only support API v1/,
	);
});

test('public marketcap requests need no credentials and send no API key', async () => {
	const ctx = createContext({ credentials: null, responses: [{ body: { 'BTC/USD': { last_price: 1 } } }] });
	const result = await gf.dzengiApiRequest.call(ctx, 'GET', '/ticker', {}, {}, true);
	assert.deepEqual(result, { 'BTC/USD': { last_price: 1 } });
	assert.equal(ctx.requests[0].url, 'https://marketcap.dzengi.com/api/v1/ticker');
	assert.equal(ctx.requests[0].headers['X-MBX-APIKEY'], undefined);
});

test('unsigned adapter requests (exchangeInfo, depth) are versioned and unsigned', async () => {
	const ctx = createContext({ credentials: null, responses: [{ body: { bids: [], asks: [] } }] });
	await gf.dzengiApiRequest.call(ctx, 'GET', '/depth', {}, { symbol: 'BTC/USD', limit: 5 }, true, {
		target: 'adapter',
		apiVersion: 'v2',
	});
	assert.equal(ctx.requests[0].url, 'https://api-adapter.dzengi.com/api/v2/depth?symbol=BTC%2FUSD&limit=5');
});

test('private requests without credentials fail with a clear message', async () => {
	const ctx = createContext({ credentials: null });
	await assert.rejects(gf.dzengiApiRequest.call(ctx, 'GET', '/account'), /credentials are required/);
});

test('timestamp errors (-1021) re-sync the server clock and retry once', async () => {
	const serverTime = Date.now() + 120000; // server clock two minutes ahead
	const ctx = createContext({
		responses: (request) => {
			if (request.url.includes('/time')) return { body: { serverTime } };
			const ts = Number(new URLSearchParams(request.url.split('?')[1]).get('timestamp'));
			if (Math.abs(ts - serverTime) > 5000) {
				return { statusCode: 400, body: { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' } };
			}
			return { body: { orderId: '42' } };
		},
	});
	const result = await gf.dzengiApiRequest.call(ctx, 'POST', '/order', { symbol: 'BTC/USD', side: 'BUY', type: 'MARKET', quantity: 1 });
	assert.deepEqual(result, { orderId: '42' });
	assert.equal(ctx.requests.length, 3); // rejected order, /time, accepted order
	assert.ok(ctx.requests[1].url.endsWith('/api/v1/time'));
	assert.ok(verifySignedUrl(ctx.requests[2].url).valid);
});

test('429 is retried (honouring Retry-After), also for orders', async () => {
	const ctx = createContext({
		responses: [
			{ statusCode: 429, headers: { 'retry-after': '0' }, body: { code: -1003, msg: 'Too many requests' } },
			{ body: { orderId: '1' } },
		],
	});
	const result = await gf.dzengiApiRequest.call(ctx, 'POST', '/order', { symbol: 'X', side: 'BUY', type: 'MARKET', quantity: 1 });
	assert.equal(result.orderId, '1');
	assert.equal(ctx.requests.length, 2);
	// A retried signed request is re-signed with a fresh timestamp.
	assert.ok(verifySignedUrl(ctx.requests[1].url).valid);
});

test('418 (IP ban) is not retried and explains what happened', async () => {
	const ctx = createContext({ responses: [{ statusCode: 418, body: '' }] });
	await assert.rejects(gf.dzengiApiRequest.call(ctx, 'GET', '/account'), (error) => {
		assert.match(error.message, /auto-banned/);
		assert.equal(error.httpCode, '418');
		return true;
	});
	assert.equal(ctx.requests.length, 1);
});

test('Dzengi error bodies become NodeApiErrors with code, message and hint', async () => {
	const ctx = createContext({ responses: [{ statusCode: 400, body: { code: -1121, msg: 'Invalid symbol.' } }] });
	await assert.rejects(
		gf.dzengiApiRequest.call(ctx, 'DELETE', '/order', {}, { symbol: 'NOPE', orderId: '1' }, false, { itemIndex: 3 }),
		(error) => {
			assert.equal(error.name, 'NodeApiError');
			assert.match(error.message, /Invalid symbol/);
			assert.equal(error.httpCode, '400');
			assert.match(error.description, /-1121/);
			assert.match(error.description, /_LEVERAGE/);
			assert.match(error.description, /DELETE \/order/);
			assert.equal(error.context.itemIndex, 3);
			return true;
		},
	);
});

test('error bodies returned with HTTP 200 are still treated as errors', async () => {
	const ctx = createContext({ responses: [{ statusCode: 200, body: { code: -2010, msg: 'Insufficient balance' } }] });
	await assert.rejects(gf.dzengiApiRequest.call(ctx, 'GET', '/account'), /Insufficient balance/);
});

test('5xx on a mutation is not retried and reports an unknown outcome', async () => {
	const ctx = createContext({ responses: [{ statusCode: 503, body: 'Service Unavailable' }] });
	await assert.rejects(
		gf.dzengiApiRequest.call(ctx, 'POST', '/order', { symbol: 'X', side: 'BUY', type: 'MARKET', quantity: 1 }),
		/UNKNOWN/,
	);
	assert.equal(ctx.requests.length, 1);
});

test('5xx on a read is retried', async () => {
	const ctx = createContext({ responses: [{ statusCode: 502, body: '' }, { body: { ok: true } }] });
	assert.deepEqual(await gf.dzengiApiRequest.call(ctx, 'GET', '/account'), { ok: true });
	assert.equal(ctx.requests.length, 2);
});

test('network errors: reads retry, undelivered orders retry, ambiguous orders do not', async () => {
	const read = createContext({ responses: [networkError('ECONNRESET'), { body: { ok: 1 } }] });
	assert.deepEqual(await gf.dzengiApiRequest.call(read, 'GET', '/account'), { ok: 1 });

	const refused = createContext({ responses: [networkError('ECONNREFUSED'), { body: { orderId: '9' } }] });
	assert.equal((await gf.dzengiApiRequest.call(refused, 'POST', '/order', { symbol: 'X' })).orderId, '9');

	const reset = createContext({ responses: [networkError('ECONNRESET'), { body: { orderId: 'never' } }] });
	await assert.rejects(gf.dzengiApiRequest.call(reset, 'POST', '/order', { symbol: 'X' }), /UNKNOWN/);
	assert.equal(reset.requests.length, 1);
});

// n8n's NodeApiError replaces messages that carry a Node.js network code with a generic
// text. These checks run against whichever n8n-workflow is installed, so they catch the
// "UNKNOWN outcome" warning being dropped.
for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE']) {
	test(`network error ${code} on an order keeps the UNKNOWN-outcome warning`, async () => {
		const ctx = createContext({ responses: [networkError(code)] });
		await assert.rejects(gf.dzengiApiRequest.call(ctx, 'POST', '/order', { symbol: 'X' }, {}, false, { itemIndex: 2 }), (error) => {
			assert.equal(error.name, 'NodeApiError');
			assert.match(error.message, /^Network error: .*Dzengi.*UNKNOWN/);
			assert.match(error.description, new RegExp(`Network error code: ${code}`));
			assert.match(error.description, /Request: POST \/order/);
			assert.equal(error.context.itemIndex, 2);
			return true;
		});
		assert.equal(ctx.requests.length, 1, 'an ambiguous order must not be re-sent');
	});
}

test('network errors after exhausted read retries keep a Dzengi-specific message', async () => {
	const ctx = createContext({ responses: () => networkError('ENOTFOUND') });
	await assert.rejects(gf.dzengiApiRequest.call(ctx, 'GET', '/account', {}, {}, false, { maxRetries: 0 }), (error) => {
		assert.equal(error.message, 'Network error: the Dzengi host name could not be resolved.');
		assert.doesNotMatch(error.message, /UNKNOWN/);
		assert.match(error.description, /ENOTFOUND/);
		return true;
	});
});

test('network error details never include a signed URL', async () => {
	const leaky = networkError('ECONNRESET');
	leaky.message = 'socket hang up https://api-adapter.dzengi.com/api/v1/order?symbol=X&signature=deadbeef';
	const ctx = createContext({ responses: [leaky] });
	await assert.rejects(gf.dzengiApiRequest.call(ctx, 'POST', '/order', { symbol: 'X' }), (error) => {
		assert.doesNotMatch(`${error.message} ${error.description}`, /signature/);
		return true;
	});
});

test('thrown HTTP errors (helpers that ignore ignoreHttpStatusErrors) are handled too', async () => {
	const axiosLike = Object.assign(new Error('Request failed with status code 400'), {
		response: { status: 400, data: { code: -1102, msg: 'Mandatory parameter quantity was not sent.' }, headers: {} },
	});
	const ctx = createContext({ responses: [axiosLike] });
	await assert.rejects(gf.dzengiApiRequest.call(ctx, 'POST', '/order', { symbol: 'X' }), /Mandatory parameter/);
});

test('signed POST parameters can be sent as a form-urlencoded body', async () => {
	const ctx = createContext({ responses: [{ body: { orderId: '1' } }] });
	await gf.dzengiApiRequest.call(ctx, 'POST', '/order', { symbol: 'LTC/BTC', side: 'BUY', type: 'LIMIT', quantity: 1, price: 0.1 }, {}, false, {
		sendParamsIn: 'body',
	});
	const [request] = ctx.requests;
	assert.equal(request.url, 'https://api-adapter.dzengi.com/api/v1/order');
	assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
	assert.ok(request.body.startsWith('symbol=LTC%2FBTC&side=BUY&type=LIMIT&quantity=1&price=0.1&recvWindow=5000&timestamp='));
	assert.ok(verifySignedUrl(`x?${request.body}`).valid);
});

test('requests are spaced to respect the 10 req/s limit', async () => {
	const ctx = createContext({ responses: () => ({ body: {} }) });
	const started = Date.now();
	await Promise.all([1, 2, 3, 4, 5].map(() => gf.dzengiApiRequest.call(ctx, 'GET', '/account')));
	assert.ok(Date.now() - started >= 380, 'five requests should take at least ~400 ms');
});

test('pagination walks backwards through time, de-duplicates and honours limit', async () => {
	// 1200 trades at t = 1000..2199; the fake API returns the newest `limit` trades with time <= endTime, oldest first.
	const trades = Array.from({ length: 1200 }, (_, i) => ({ id: String(i), orderId: `o${i}`, time: 1000 + i }));
	const responder = (request) => {
		const params = new URLSearchParams(request.url.split('?')[1]);
		const limit = Number(params.get('limit'));
		const endTime = params.has('endTime') ? Number(params.get('endTime')) : Infinity;
		const startTime = params.has('startTime') ? Number(params.get('startTime')) : -Infinity;
		const window = trades.filter((t) => t.time <= endTime && t.time >= startTime);
		return { body: window.slice(Math.max(0, window.length - limit)) };
	};
	const paging = {
		pageSize: 500,
		startParam: 'startTime',
		endParam: 'endTime',
		timeFields: ['time'],
		idFields: ['id'],
		listKeys: ['myTrades'],
	};

	const all = createContext({ responses: responder });
	const everything = await gf.dzengiApiRequestAllItems.call(all, '/myTrades', { symbol: 'BTC/USD' }, paging);
	assert.equal(everything.length, 1200);
	assert.equal(everything[0].time, 1000);
	assert.equal(everything[1199].time, 2199);

	const some = createContext({ responses: responder });
	const newest = await gf.dzengiApiRequestAllItems.call(some, '/myTrades', { symbol: 'BTC/USD' }, { ...paging, limit: 50 });
	assert.equal(newest.length, 50);
	assert.equal(newest[49].time, 2199);
	assert.equal(some.requests.length, 1);

	const bounded = createContext({ responses: responder });
	const fromStart = await gf.dzengiApiRequestAllItems.call(bounded, '/myTrades', { symbol: 'BTC/USD', startTime: 2000 }, paging);
	assert.equal(fromStart.length, 200);
});
