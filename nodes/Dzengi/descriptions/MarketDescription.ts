import type { INodeProperties } from 'n8n-workflow';

/**
 * Market Data resource — public, no credentials needed.
 *
 *   Get Tickers      marketcap  /api/v1/ticker | /token/ticker | /token_crypto/ticker
 *                    or api-adapter /api/{v}/ticker/24hr
 *   Get Order Book   api-adapter /api/{v}/depth
 *   Get Symbol Info  api-adapter /api/{v}/exchangeInfo
 *   Get Candles      api-adapter /api/{v}/klines
 */
export const marketOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['marketData'] } },
		options: [
			{
				name: 'Get Candles',
				value: 'getCandles',
				description: 'Get OHLC candlesticks for a symbol',
				action: 'Get candles',
			},
			{
				name: 'Get Order Book',
				value: 'getOrderBook',
				description: 'Get bids and asks for a symbol',
				action: 'Get order book',
			},
			{
				name: 'Get Symbol Info',
				value: 'getSymbolInfo',
				description: 'Get trading rules, precision and fees for a symbol',
				action: 'Get symbol info',
			},
			{
				name: 'Get Tickers',
				value: 'getTickers',
				description: 'Get prices and 24h statistics for trading pairs',
				action: 'Get tickers',
			},
		],
		default: 'getTickers',
	},
];

const environmentOption: INodeProperties = {
	displayName: 'Environment',
	name: 'environment',
	type: 'options',
	options: [
		{ name: 'Live', value: 'live' },
		{ name: 'Demo', value: 'demo' },
	],
	default: 'live',
	description:
		'Which api-adapter host serves the data. Demo supports API v1 only. Ignored for the marketcap source.',
};

const marketSymbolField = (operations: string[]): INodeProperties => ({
	displayName: 'Symbol Name or ID',
	name: 'symbol',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getAllTradingSymbols', loadOptionsDependsOn: ['apiVersion'] },
	required: true,
	default: '',
	displayOptions: { show: { resource: ['marketData'], operation: operations } },
	description:
		'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
});

export const marketFields: INodeProperties[] = [
	// ----------------------------------------------------------------------
	// marketData: getTickers
	// ----------------------------------------------------------------------
	{
		displayName: 'Source',
		name: 'source',
		type: 'options',
		options: [
			{
				name: 'Public Market Data API (Marketcap)',
				value: 'marketcap',
				description: 'https://marketcap.dzengi.com — 24h summary per pair, high rate limits',
			},
			{
				name: 'Trading API 24h Ticker',
				value: 'tradingApi',
				description: 'api-adapter /ticker/24hr — respects the API version (v2 adds Hong Kong markets)',
			},
		],
		default: 'marketcap',
		displayOptions: { show: { resource: ['marketData'], operation: ['getTickers'] } },
	},
	{
		displayName: 'Market',
		name: 'market',
		type: 'options',
		options: [
			{ name: 'Crypto', value: 'crypto', description: 'Cryptocurrency pairs (/ticker)' },
			{ name: 'Crypto and Tokens', value: 'tokenCrypto', description: 'Everything (/token_crypto/ticker)' },
			{ name: 'Tokens', value: 'token', description: 'Tokenised assets (/token/ticker)' },
		],
		default: 'crypto',
		displayOptions: { show: { resource: ['marketData'], operation: ['getTickers'], source: ['marketcap'] } },
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { resource: ['marketData'], operation: ['getTickers'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		displayOptions: { show: { resource: ['marketData'], operation: ['getTickers'], returnAll: [false] } },
		description: 'Max number of results to return',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['marketData'], operation: ['getTickers'] } },
		options: [
			environmentOption,
			{
				displayName: 'Symbols',
				name: 'symbols',
				type: 'string',
				default: '',
				placeholder: 'BTC/USD, ETH/USD',
				description: 'Comma-separated list of symbols to keep. Leave empty for all.',
			},
		],
	},

	// ----------------------------------------------------------------------
	// marketData: getOrderBook / getSymbolInfo / getCandles
	// ----------------------------------------------------------------------
	marketSymbolField(['getOrderBook', 'getSymbolInfo', 'getCandles']),
	{
		displayName: 'Depth',
		name: 'depth',
		type: 'options',
		options: [
			{ name: '5', value: 5 },
			{ name: '10', value: 10 },
			{ name: '20', value: 20 },
			{ name: '50', value: 50 },
			{ name: '100', value: 100 },
			{ name: '500', value: 500 },
			{ name: '1000', value: 1000 },
		],
		default: 100,
		displayOptions: { show: { resource: ['marketData'], operation: ['getOrderBook'] } },
		description: 'Number of price levels per side',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['marketData'], operation: ['getOrderBook'] } },
		options: [
			environmentOption,
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				description:
					'Whether to return levels as {price, quantity} objects with best bid/ask and spread instead of raw [price, qty] arrays',
			},
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['marketData'], operation: ['getSymbolInfo'] } },
		options: [environmentOption],
	},
	{
		displayName: 'Interval',
		name: 'interval',
		type: 'options',
		options: [
			{ name: '1 Minute', value: '1m' },
			{ name: '5 Minutes', value: '5m' },
			{ name: '15 Minutes', value: '15m' },
			{ name: '30 Minutes', value: '30m' },
			{ name: '1 Hour', value: '1h' },
			{ name: '4 Hours', value: '4h' },
			{ name: '1 Day', value: '1d' },
			{ name: '1 Week', value: '1w' },
		],
		default: '1h',
		displayOptions: { show: { resource: ['marketData'], operation: ['getCandles'] } },
	},
	{
		displayName: 'Limit',
		name: 'candleLimit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 1000 },
		default: 100,
		displayOptions: { show: { resource: ['marketData'], operation: ['getCandles'] } },
		description: 'Max number of candles to return',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['marketData'], operation: ['getCandles'] } },
		options: [
			{
				displayName: 'Candle Type',
				name: 'candleType',
				type: 'options',
				options: [
					{ name: 'Classic', value: 'classic' },
					{ name: 'Heikin-Ashi', value: 'heikinAshi' },
				],
				default: 'classic',
			},
			{
				displayName: 'End Time',
				name: 'endTime',
				type: 'dateTime',
				default: '',
			},
			environmentOption,
			{
				displayName: 'Price Type',
				name: 'priceType',
				type: 'options',
				options: [
					{ name: 'Ask', value: 'ask' },
					{ name: 'Bid', value: 'bid' },
				],
				default: 'bid',
			},
			{
				displayName: 'Start Time',
				name: 'startTime',
				type: 'dateTime',
				default: '',
			},
		],
	},
];
