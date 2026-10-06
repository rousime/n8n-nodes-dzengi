import type { INodeProperties } from 'n8n-workflow';

/**
 * Order resource: create / cancel / get / get many / update.
 *
 * Endpoints (prefix /api/{v1|v2}):
 *   POST   /order               create (exchange + leverage)
 *   DELETE /order               cancel
 *   GET    /fetchOrder          get
 *   GET    /openOrders          get many (Dzengi only exposes open orders)
 *   PUT    /order               update an exchange limit order
 *   POST   /updateTradingOrder  update a leverage order
 */
export const orderOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['order'] } },
		options: [
			{
				name: 'Cancel',
				value: 'cancel',
				description: 'Cancel an open order',
				action: 'Cancel an order',
			},
			{
				name: 'Create',
				value: 'create',
				description: 'Place a limit, market or stop order',
				action: 'Create an order',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get the details of an order',
				action: 'Get an order',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get open orders, optionally filtered',
				action: 'Get many orders',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Change the price, expiry or take-profit/stop-loss of an open order',
				action: 'Update an order',
			},
		],
		default: 'create',
	},
];

const tradingModeField: INodeProperties = {
	displayName: 'Trading Mode',
	name: 'tradingMode',
	type: 'options',
	options: [
		{
			name: 'Exchange',
			value: 'EXCHANGE',
			description: 'Spot trading of tokens and crypto pairs',
		},
		{
			name: 'Leverage',
			value: 'LEVERAGE',
			description: 'Margin trading with leverage, take-profit and stop-loss',
		},
	],
	default: 'EXCHANGE',
	displayOptions: { show: { resource: ['order'], operation: ['create', 'cancel', 'get', 'update'] } },
	description: 'Dzengi trading mode. Leverage symbols use the _LEVERAGE suffix (e.g. BTC/USD_LEVERAGE).',
};

const symbolDescription =
	'Choose from the list, or specify a symbol using an <a href="https://docs.n8n.io/code/expressions/">expression</a>. In leverage mode a missing _LEVERAGE suffix is added to currency pairs automatically.';

export const orderFields: INodeProperties[] = [
	tradingModeField,

	// ----------------------------------------------------------------------
	// order: create / cancel / get — symbol
	// ----------------------------------------------------------------------
	{
		displayName: 'Symbol Name or ID',
		name: 'symbol',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getTradingSymbols',
			loadOptionsDependsOn: ['tradingMode', 'apiVersion'],
		},
		required: true,
		default: '',
		displayOptions: { show: { resource: ['order'], operation: ['create', 'cancel', 'get'] } },
		description: symbolDescription,
	},

	// ----------------------------------------------------------------------
	// order: create
	// ----------------------------------------------------------------------
	{
		displayName: 'Side',
		name: 'side',
		type: 'options',
		options: [
			{ name: 'Buy', value: 'BUY' },
			{ name: 'Sell', value: 'SELL' },
		],
		default: 'BUY',
		displayOptions: { show: { resource: ['order'], operation: ['create'] } },
	},
	{
		displayName: 'Order Type',
		name: 'orderType',
		type: 'options',
		options: [
			{ name: 'Limit', value: 'LIMIT', description: 'Execute at the given price or better' },
			{ name: 'Market', value: 'MARKET', description: 'Execute immediately at the best available price' },
			{ name: 'Stop', value: 'STOP', description: 'Leverage mode only: open when the price reaches the stop price' },
		],
		default: 'LIMIT',
		displayOptions: { show: { resource: ['order'], operation: ['create'] } },
	},
	{
		displayName: 'Quantity',
		name: 'quantity',
		type: 'number',
		typeOptions: { minValue: 0, numberPrecision: 8 },
		required: true,
		default: 0,
		displayOptions: { show: { resource: ['order'], operation: ['create'] } },
		description:
			'Amount of the base asset. Extra decimals beyond the symbol precision are rounded down by Dzengi.',
	},
	{
		displayName: 'Price',
		name: 'price',
		type: 'number',
		typeOptions: { minValue: 0, numberPrecision: 8 },
		required: true,
		default: 0,
		displayOptions: { show: { resource: ['order'], operation: ['create'], orderType: ['LIMIT', 'STOP'] } },
		description: 'Limit price (LIMIT) or trigger price (STOP), in the quote asset',
	},
	{
		displayName: 'Leverage Options',
		name: 'leverageOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['order'], operation: ['create'], tradingMode: ['LEVERAGE'] } },
		options: [
			{
				displayName: 'Account ID',
				name: 'accountId',
				type: 'string',
				default: '',
				description:
					'Leverage account to trade from (see Account → Get Balances). Dzengi uses your default account if empty.',
			},
			{
				displayName: 'Guaranteed Stop Loss',
				name: 'guaranteedStopLoss',
				type: 'boolean',
				default: false,
				description: 'Whether the stop loss is guaranteed (may incur an extra fee)',
			},
			{
				displayName: 'Leverage',
				name: 'leverage',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 500 },
				default: 2,
				description:
					'Leverage multiplier. Allowed values per symbol are returned by Account → Get Leverage Settings. Dzengi uses its default when omitted.',
			},
			{
				displayName: 'Profit Distance',
				name: 'profitDistance',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 8 },
				default: 0,
				description: 'Take-profit as a distance from the open price instead of an absolute price',
			},
			{
				displayName: 'Stop Distance',
				name: 'stopDistance',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 8 },
				default: 0,
				description: 'Stop-loss as a distance from the open price instead of an absolute price',
			},
			{
				displayName: 'Stop Loss',
				name: 'stopLoss',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 8 },
				default: 0,
				description: 'Absolute stop-loss price',
			},
			{
				displayName: 'Take Profit',
				name: 'takeProfit',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 8 },
				default: 0,
				description: 'Absolute take-profit price',
			},
			{
				displayName: 'Trailing Stop Loss',
				name: 'trailingStopLoss',
				type: 'boolean',
				default: false,
				description: 'Whether the stop loss trails the market price',
			},
		],
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['order'], operation: ['create'] } },
		options: [
			{
				displayName: 'Auto-Format Leverage Symbol',
				name: 'autoFormatSymbol',
				type: 'boolean',
				default: true,
				description:
					'Whether to append _LEVERAGE to currency-pair symbols in leverage mode (BTC/USD → BTC/USD_LEVERAGE)',
			},
			{
				displayName: 'Expire Time',
				name: 'expireTimestamp',
				type: 'dateTime',
				default: '',
				description: 'When an unfilled limit or stop order should expire',
			},
			{
				displayName: 'Response Type',
				name: 'newOrderRespType',
				type: 'options',
				options: [
					{ name: 'FULL', value: 'FULL', description: 'Result plus fills — exchange MARKET orders only' },
					{ name: 'RESULT', value: 'RESULT', description: 'Order status and quantities' },
				],
				default: 'RESULT',
				description:
					'Level of detail Dzengi returns. Exchange MARKET orders accept RESULT or FULL (Dzengi defaults to FULL); LIMIT and all leverage orders only support RESULT.',
			},
		],
	},

	// ----------------------------------------------------------------------
	// order: cancel / get / update
	// ----------------------------------------------------------------------
	{
		displayName: 'Order ID',
		name: 'orderId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: { resource: ['order'], operation: ['cancel', 'get', 'update'] } },
		description: 'The orderId returned when the order was created',
	},

	// ----------------------------------------------------------------------
	// order: update
	// ----------------------------------------------------------------------
	{
		displayName: 'Update Fields',
		name: 'exchangeUpdateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['order'], operation: ['update'], tradingMode: ['EXCHANGE'] } },
		options: [
			{
				displayName: 'Expire Time',
				name: 'expireTimestamp',
				type: 'dateTime',
				default: '',
			},
			{
				displayName: 'Price',
				name: 'price',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 8 },
				default: 0,
				description: 'New limit price',
			},
		],
	},
	{
		displayName: 'Update Fields',
		name: 'leverageUpdateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['order'], operation: ['update'], tradingMode: ['LEVERAGE'] } },
		options: [
			{
				displayName: 'Expire Time',
				name: 'expireTimestamp',
				type: 'dateTime',
				default: '',
			},
			{
				displayName: 'Guaranteed Stop Loss',
				name: 'guaranteedStopLoss',
				type: 'boolean',
				default: false,
				description: 'Whether the stop loss is guaranteed',
			},
			{
				displayName: 'New Price',
				name: 'newPrice',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 8 },
				default: 0,
			},
			{
				displayName: 'Profit Distance',
				name: 'profitDistance',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 8 },
				default: 0,
			},
			{
				displayName: 'Stop Distance',
				name: 'stopDistance',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 8 },
				default: 0,
			},
			{
				displayName: 'Stop Loss',
				name: 'stopLoss',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 8 },
				default: 0,
			},
			{
				displayName: 'Take Profit',
				name: 'takeProfit',
				type: 'number',
				typeOptions: { minValue: 0, numberPrecision: 8 },
				default: 0,
			},
			{
				displayName: 'Trailing Stop Loss',
				name: 'trailingStopLoss',
				type: 'boolean',
				default: false,
				description: 'Whether the stop loss trails the market price',
			},
		],
	},

	// ----------------------------------------------------------------------
	// order: getAll
	// ----------------------------------------------------------------------
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { resource: ['order'], operation: ['getAll'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		displayOptions: { show: { resource: ['order'], operation: ['getAll'], returnAll: [false] } },
		description: 'Max number of results to return',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['order'], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Created After',
				name: 'startTime',
				type: 'dateTime',
				default: '',
			},
			{
				displayName: 'Created Before',
				name: 'endTime',
				type: 'dateTime',
				default: '',
			},
			{
				displayName: 'Order Type',
				name: 'orderType',
				type: 'multiOptions',
				options: [
					{ name: 'Limit', value: 'LIMIT' },
					{ name: 'Market', value: 'MARKET' },
					{ name: 'Stop', value: 'STOP' },
					{ name: 'Trailing Stop', value: 'TRAILING_STOP' },
				],
				default: [],
			},
			{
				displayName: 'Side',
				name: 'side',
				type: 'options',
				options: [
					{ name: 'Any', value: '' },
					{ name: 'Buy', value: 'BUY' },
					{ name: 'Sell', value: 'SELL' },
				],
				default: '',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'multiOptions',
				options: [
					{ name: 'Canceled', value: 'CANCELED' },
					{ name: 'Expired', value: 'EXPIRED' },
					{ name: 'Filled', value: 'FILLED' },
					{ name: 'New', value: 'NEW' },
					{ name: 'Partially Filled', value: 'PARTIALLY_FILLED' },
					{ name: 'Pending Cancel', value: 'PENDING_CANCEL' },
					{ name: 'Rejected', value: 'REJECTED' },
				],
				default: [],
			},
			{
				displayName: 'Symbol Name or ID',
				name: 'symbol',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getAllTradingSymbols', loadOptionsDependsOn: ['apiVersion'] },
				default: '',
				description:
					'Only orders for this symbol. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Trading Mode',
				name: 'tradingMode',
				type: 'options',
				options: [
					{ name: 'Any', value: '' },
					{ name: 'Exchange', value: 'EXCHANGE' },
					{ name: 'Leverage', value: 'LEVERAGE' },
				],
				default: '',
			},
		],
	},
];
