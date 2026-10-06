import type { INodeProperties } from 'n8n-workflow';

/**
 * Account resource (signed USER_DATA endpoints, prefix /api/{v1|v2}):
 *   GET /account           balances (+ optional leverage positions from /tradingPositions)
 *   GET /myTrades          trade history for a symbol (Dzengi keeps the last 1000 trades)
 *   GET /leverageSettings  allowed leverage values for a symbol
 */
export const accountOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['account'] } },
		options: [
			{
				name: 'Get Balances',
				value: 'getBalances',
				description: 'Get account balances, optionally with open leverage positions',
				action: 'Get account balances',
			},
			{
				name: 'Get Leverage Settings',
				value: 'getLeverageSettings',
				description: 'Get the allowed and default leverage for a symbol',
				action: 'Get leverage settings',
			},
			{
				name: 'Get Trade History',
				value: 'getTradeHistory',
				description: 'Get your executed trades for a symbol',
				action: 'Get trade history',
			},
		],
		default: 'getBalances',
	},
];

export const accountFields: INodeProperties[] = [
	// ----------------------------------------------------------------------
	// account: getBalances
	// ----------------------------------------------------------------------
	{
		displayName: 'Output',
		name: 'output',
		type: 'options',
		options: [
			{
				name: 'Account Summary',
				value: 'summary',
				description: 'One item with account flags, a balances array and optional positions array',
			},
			{
				name: 'One Item per Balance',
				value: 'balances',
				description: 'One item per asset balance',
			},
		],
		default: 'summary',
		displayOptions: { show: { resource: ['account'], operation: ['getBalances'] } },
	},
	{
		displayName: 'Options',
		name: 'balanceOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['account'], operation: ['getBalances'] } },
		options: [
			{
				displayName: 'Assets',
				name: 'assets',
				type: 'string',
				default: '',
				placeholder: 'USD, BTC',
				description: 'Comma-separated list of assets to keep. Leave empty for all.',
			},
			{
				displayName: 'Include Leverage Positions',
				name: 'includePositions',
				type: 'boolean',
				default: false,
				description:
					'Whether to also fetch open leverage positions (Account Summary output only)',
			},
			{
				displayName: 'Show Zero Balances',
				name: 'showZeroBalance',
				type: 'boolean',
				default: false,
				description: 'Whether to include assets with a zero balance',
			},
		],
	},

	// ----------------------------------------------------------------------
	// account: getTradeHistory / getLeverageSettings
	// ----------------------------------------------------------------------
	{
		displayName: 'Symbol Name or ID',
		name: 'symbol',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getAllTradingSymbols', loadOptionsDependsOn: ['apiVersion'] },
		required: true,
		default: '',
		displayOptions: {
			show: { resource: ['account'], operation: ['getTradeHistory', 'getLeverageSettings'] },
		},
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { resource: ['account'], operation: ['getTradeHistory'] } },
		description:
			'Whether to return all results or only up to a given limit. Dzengi keeps only the last 1000 trades.',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 1000 },
		default: 50,
		displayOptions: {
			show: { resource: ['account'], operation: ['getTradeHistory'], returnAll: [false] },
		},
		description: 'Max number of results to return',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['account'], operation: ['getTradeHistory'] } },
		options: [
			{
				displayName: 'From',
				name: 'startTime',
				type: 'dateTime',
				default: '',
			},
			{
				displayName: 'To',
				name: 'endTime',
				type: 'dateTime',
				default: '',
			},
		],
	},
];
