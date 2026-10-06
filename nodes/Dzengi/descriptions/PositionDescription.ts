import type { INodeProperties } from 'n8n-workflow';

/**
 * Position resource — leverage trading positions (signed, prefix /api/{v1|v2}):
 *   GET  /tradingPositions          open positions
 *   GET  /tradingPositionsHistory   position execution history
 *   POST /updateTradingPosition     change take-profit / stop-loss
 *   POST /closeTradingPosition      close a position
 */
export const positionOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['position'] } },
		options: [
			{
				name: 'Close',
				value: 'close',
				description: 'Close an open leverage position',
				action: 'Close a position',
			},
			{
				name: 'Get History',
				value: 'getHistory',
				description: 'Get the execution history of leverage positions',
				action: 'Get position history',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get open leverage positions',
				action: 'Get many positions',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Change the take-profit or stop-loss of a position',
				action: 'Update a position',
			},
		],
		default: 'getAll',
	},
];

export const positionFields: INodeProperties[] = [
	{
		displayName: 'Position ID',
		name: 'positionId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: { resource: ['position'], operation: ['close', 'update'] } },
		description: 'The position "ID" field from Position → Get Many',
	},
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['position'], operation: ['update'] } },
		options: [
			{
				displayName: 'Guaranteed Stop Loss',
				name: 'guaranteedStopLoss',
				type: 'boolean',
				default: false,
				description: 'Whether the stop loss is guaranteed',
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
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { resource: ['position'], operation: ['getAll', 'getHistory'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		displayOptions: {
			show: { resource: ['position'], operation: ['getAll', 'getHistory'], returnAll: [false] },
		},
		description: 'Max number of results to return',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['position'], operation: ['getAll', 'getHistory'] } },
		options: [
			{
				displayName: 'From',
				name: 'startTime',
				type: 'dateTime',
				default: '',
				displayOptions: { show: { '/operation': ['getHistory'] } },
			},
			{
				displayName: 'Symbol Name or ID',
				name: 'symbol',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getAllTradingSymbols', loadOptionsDependsOn: ['apiVersion'] },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'To',
				name: 'endTime',
				type: 'dateTime',
				default: '',
				displayOptions: { show: { '/operation': ['getHistory'] } },
			},
		],
	},
];
