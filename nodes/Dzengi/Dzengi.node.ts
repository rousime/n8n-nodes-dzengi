import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { accountFields, accountOperations } from './descriptions/AccountDescription';
import { marketFields, marketOperations } from './descriptions/MarketDescription';
import { orderFields, orderOperations } from './descriptions/OrderDescription';
import { positionFields, positionOperations } from './descriptions/PositionDescription';
import {
	cleanParams,
	dzengiApiRequest,
	dzengiApiRequestAllItems,
	extractList,
	formatLeverageSymbol,
	getAllTradingSymbols,
	getExchangeSymbols,
	getSymbols,
	getTradingSymbols,
	isRecord,
	simplifyKlines,
	simplifyOrderBookSide,
	testDzengiCredentials,
	tickerMapToList,
} from './GenericFunctions';
import type {
	DzengiApiVersionSetting,
	DzengiEnvironment,
	DzengiTradingMode,
	IDzengiRequestOptions,
} from './types';

/** Marketcap ticker endpoints per market. */
const MARKETCAP_TICKER_ENDPOINTS: Record<string, string> = {
	crypto: '/ticker',
	token: '/token/ticker',
	tokenCrypto: '/token_crypto/ticker',
};

/** Page size used when walking trade/position history. */
const HISTORY_PAGE_SIZE = 500;

export class Dzengi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Dzengi',
		name: 'dzengi',
		icon: 'file:../../icons/dzengi.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Trade and read market data on Dzengi.com (REST API v1 and v2)',
		defaults: { name: 'Dzengi' },
		inputs: ['main'],
		outputs: ['main'],
		usableAsTool: true,
		credentials: [
			{
				name: 'dzengiApi',
				required: true,
				testedBy: 'dzengiApiCredentialTest',
				displayOptions: { hide: { resource: ['marketData'] } },
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Market Data', value: 'marketData' },
					{ name: 'Order', value: 'order' },
					{ name: 'Position', value: 'position' },
				],
				default: 'order',
			},
			{
				displayName: 'API Version',
				name: 'apiVersion',
				type: 'options',
				options: [
					{
						name: 'Use Credential Default',
						value: 'credentials',
						description: 'Use the default version from the credentials (V1 when no credentials are set)',
					},
					{ name: 'V1', value: 'v1', description: 'Available on live and demo' },
					{ name: 'V2', value: 'v2', description: 'Adds Hong Kong markets and all leverage instruments (live only)' },
				],
				default: 'credentials',
				description:
					'Dzengi API version for this node. The public marketcap source is always v1.',
			},
			...orderOperations,
			...orderFields,
			...accountOperations,
			...accountFields,
			...positionOperations,
			...positionFields,
			...marketOperations,
			...marketFields,
		],
	};

	methods = {
		loadOptions: {
			getSymbols,
			getTradingSymbols,
			getAllTradingSymbols,
		},
		credentialTest: {
			dzengiApiCredentialTest: testDzengiCredentials,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const apiVersion = this.getNodeParameter('apiVersion', i, 'credentials') as DzengiApiVersionSetting;
				const requestOptions: IDzengiRequestOptions = { apiVersion, itemIndex: i };

				let result: IDataObject | IDataObject[];
				if (resource === 'order') {
					result = await executeOrder.call(this, operation, i, requestOptions);
				} else if (resource === 'account') {
					result = await executeAccount.call(this, operation, i, requestOptions);
				} else if (resource === 'position') {
					result = await executePosition.call(this, operation, i, requestOptions);
				} else if (resource === 'marketData') {
					result = await executeMarketData.call(this, operation, i, requestOptions);
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown resource "${resource}"`, { itemIndex: i });
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(result),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					const message = error instanceof Error ? error.message : String(error);
					const description =
						isRecord(error) && typeof error.description === 'string' ? error.description : undefined;
					returnData.push({
						json: { error: message, ...(description ? { description } : {}) },
						pairedItem: { item: i },
					});
					continue;
				}
				if (error instanceof NodeApiError || error instanceof NodeOperationError) throw error;
				throw new NodeApiError(this.getNode(), (isRecord(error) ? error : {}) as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

// ---------------------------------------------------------------------------
// Parameter helpers
// ---------------------------------------------------------------------------

/** Converts an n8n dateTime value (ISO string, ms or s) to epoch milliseconds. */
function toTimestamp(this: IExecuteFunctions, value: unknown, field: string, itemIndex: number): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value === 'number') return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
	const text = String(value).trim();
	if (/^\d+$/.test(text)) {
		const numeric = Number(text);
		return numeric < 1e12 ? numeric * 1000 : numeric;
	}
	const parsed = Date.parse(text);
	if (Number.isNaN(parsed)) {
		throw new NodeOperationError(this.getNode(), `"${field}" is not a valid date: ${text}`, { itemIndex });
	}
	return parsed;
}

/** Copies positive numbers and booleans from a collection, skipping unset values. */
function pickTradingFields(source: IDataObject, numericKeys: string[], booleanKeys: string[]): IDataObject {
	const target: IDataObject = {};
	for (const key of numericKeys) {
		const value = Number(source[key]);
		if (source[key] !== undefined && source[key] !== '' && Number.isFinite(value) && value > 0) {
			target[key] = value;
		}
	}
	for (const key of booleanKeys) {
		if (typeof source[key] === 'boolean') target[key] = source[key];
	}
	return target;
}

function requirePositive(
	this: IExecuteFunctions,
	value: number,
	field: string,
	itemIndex: number,
): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new NodeOperationError(this.getNode(), `${field} must be greater than 0`, { itemIndex });
	}
	return value;
}

function parseList(value: unknown): string[] {
	if (typeof value !== 'string') return [];
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function applyLimit(
	this: IExecuteFunctions,
	list: IDataObject[],
	itemIndex: number,
	limitParameter = 'limit',
): IDataObject[] {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	if (returnAll) return list;
	const limit = this.getNodeParameter(limitParameter, itemIndex, 50) as number;
	return list.slice(0, limit);
}

function resolveSymbol(
	this: IExecuteFunctions,
	itemIndex: number,
	tradingMode: DzengiTradingMode,
	autoFormat = true,
): string {
	const symbol = String(this.getNodeParameter('symbol', itemIndex) ?? '').trim();
	if (!symbol) {
		throw new NodeOperationError(this.getNode(), 'Symbol is required', { itemIndex });
	}
	return tradingMode === 'LEVERAGE' && autoFormat ? formatLeverageSymbol(symbol) : symbol;
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

async function executeOrder(
	this: IExecuteFunctions,
	operation: string,
	i: number,
	requestOptions: IDzengiRequestOptions,
): Promise<IDataObject | IDataObject[]> {
	if (operation === 'create') {
		const tradingMode = this.getNodeParameter('tradingMode', i) as DzengiTradingMode;
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		const symbol = resolveSymbol.call(this, i, tradingMode, additional.autoFormatSymbol !== false);
		const side = this.getNodeParameter('side', i) as string;
		const orderType = this.getNodeParameter('orderType', i) as string;
		const quantity = requirePositive.call(this, this.getNodeParameter('quantity', i) as number, 'Quantity', i);

		if (orderType === 'STOP' && tradingMode !== 'LEVERAGE') {
			throw new NodeOperationError(this.getNode(), 'STOP orders are only available in leverage trading mode', {
				itemIndex: i,
			});
		}

		const params: IDataObject = { symbol, side, type: orderType, quantity };
		if (orderType === 'LIMIT' || orderType === 'STOP') {
			params.price = requirePositive.call(this, this.getNodeParameter('price', i) as number, 'Price', i);
		}
		if (additional.newOrderRespType) params.newOrderRespType = additional.newOrderRespType;
		const expireTimestamp = toTimestamp.call(this, additional.expireTimestamp, 'Expire Time', i);
		if (expireTimestamp !== undefined) params.expireTimestamp = expireTimestamp;

		if (tradingMode === 'LEVERAGE') {
			const leverageOptions = this.getNodeParameter('leverageOptions', i, {}) as IDataObject;
			Object.assign(
				params,
				pickTradingFields(
					leverageOptions,
					['leverage', 'takeProfit', 'stopLoss', 'profitDistance', 'stopDistance'],
					['guaranteedStopLoss', 'trailingStopLoss'],
				),
			);
			if (typeof leverageOptions.accountId === 'string' && leverageOptions.accountId.trim()) {
				params.accountId = leverageOptions.accountId.trim();
			}
		}

		const response = await dzengiApiRequest.call(this, 'POST', '/order', params, {}, false, requestOptions);
		return isRecord(response) ? { tradingMode, ...response } : { tradingMode, response };
	}

	if (operation === 'cancel') {
		const tradingMode = this.getNodeParameter('tradingMode', i) as DzengiTradingMode;
		const symbol = resolveSymbol.call(this, i, tradingMode);
		const orderId = String(this.getNodeParameter('orderId', i)).trim();
		return (await dzengiApiRequest.call(
			this,
			'DELETE',
			'/order',
			{},
			{ symbol, orderId },
			false,
			requestOptions,
		)) as IDataObject;
	}

	if (operation === 'get') {
		const tradingMode = this.getNodeParameter('tradingMode', i) as DzengiTradingMode;
		const symbol = resolveSymbol.call(this, i, tradingMode);
		const orderId = String(this.getNodeParameter('orderId', i)).trim();
		return (await dzengiApiRequest.call(
			this,
			'GET',
			'/fetchOrder',
			{},
			{ symbol, orderId },
			false,
			requestOptions,
		)) as IDataObject;
	}

	if (operation === 'getAll') {
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const query = cleanParams({ symbol: filters.symbol as string });
		const response = await dzengiApiRequest.call(this, 'GET', '/openOrders', {}, query, false, requestOptions);
		let orders = extractList(response, ['openOrders']);

		const startTime = toTimestamp.call(this, filters.startTime, 'Created After', i);
		const endTime = toTimestamp.call(this, filters.endTime, 'Created Before', i);
		const statuses = (filters.status as string[] | undefined) ?? [];
		const types = (filters.orderType as string[] | undefined) ?? [];
		orders = orders.filter((order) => {
			if (filters.side && order.side !== filters.side) return false;
			if (statuses.length && !statuses.includes(String(order.status))) return false;
			if (types.length && !types.includes(String(order.type))) return false;
			if (filters.tradingMode === 'LEVERAGE' && order.leverage !== true) return false;
			if (filters.tradingMode === 'EXCHANGE' && order.leverage === true) return false;
			const time = Number(order.time);
			if (startTime !== undefined && Number.isFinite(time) && time < startTime) return false;
			if (endTime !== undefined && Number.isFinite(time) && time > endTime) return false;
			return true;
		});
		return applyLimit.call(this, orders, i);
	}

	if (operation === 'update') {
		const tradingMode = this.getNodeParameter('tradingMode', i) as DzengiTradingMode;
		const orderId = String(this.getNodeParameter('orderId', i)).trim();

		if (tradingMode === 'EXCHANGE') {
			const fields = this.getNodeParameter('exchangeUpdateFields', i, {}) as IDataObject;
			const params: IDataObject = { orderId, ...pickTradingFields(fields, ['price'], []) };
			const expireTimestamp = toTimestamp.call(this, fields.expireTimestamp, 'Expire Time', i);
			if (expireTimestamp !== undefined) params.expireTimestamp = expireTimestamp;
			if (Object.keys(params).length === 1) {
				throw new NodeOperationError(this.getNode(), 'Add at least one field to update (price or expire time)', {
					itemIndex: i,
				});
			}
			return (await dzengiApiRequest.call(this, 'PUT', '/order', params, {}, false, requestOptions)) as IDataObject;
		}

		const fields = this.getNodeParameter('leverageUpdateFields', i, {}) as IDataObject;
		const params: IDataObject = {
			orderId,
			...pickTradingFields(
				fields,
				['newPrice', 'takeProfit', 'stopLoss', 'profitDistance', 'stopDistance'],
				['guaranteedStopLoss', 'trailingStopLoss'],
			),
		};
		const expireTimestamp = toTimestamp.call(this, fields.expireTimestamp, 'Expire Time', i);
		if (expireTimestamp !== undefined) params.expireTimestamp = expireTimestamp;
		if (Object.keys(params).length === 1) {
			throw new NodeOperationError(this.getNode(), 'Add at least one field to update', { itemIndex: i });
		}
		return (await dzengiApiRequest.call(
			this,
			'POST',
			'/updateTradingOrder',
			params,
			{},
			false,
			requestOptions,
		)) as IDataObject;
	}

	throw new NodeOperationError(this.getNode(), `Unknown order operation "${operation}"`, { itemIndex: i });
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

async function executeAccount(
	this: IExecuteFunctions,
	operation: string,
	i: number,
	requestOptions: IDzengiRequestOptions,
): Promise<IDataObject | IDataObject[]> {
	if (operation === 'getBalances') {
		const output = this.getNodeParameter('output', i, 'summary') as string;
		const options = this.getNodeParameter('balanceOptions', i, {}) as IDataObject;
		const account = (await dzengiApiRequest.call(
			this,
			'GET',
			'/account',
			{},
			{ showZeroBalance: options.showZeroBalance === true },
			false,
			requestOptions,
		)) as IDataObject;

		const wantedAssets = parseList(options.assets).map((asset) => asset.toUpperCase());
		let balances = extractList(account?.balances ?? []);
		if (wantedAssets.length) {
			balances = balances.filter((balance) => wantedAssets.includes(String(balance.asset).toUpperCase()));
		}

		if (output === 'balances') return balances;

		const summary: IDataObject = { ...account, balances };
		if (options.includePositions === true) {
			const positions = await dzengiApiRequest.call(this, 'GET', '/tradingPositions', {}, {}, false, requestOptions);
			summary.positions = extractList(positions, ['positions']);
		}
		return summary;
	}

	if (operation === 'getTradeHistory') {
		const symbol = String(this.getNodeParameter('symbol', i)).trim();
		const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
		const limit = returnAll ? undefined : (this.getNodeParameter('limit', i, 50) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const query = cleanParams({
			symbol,
			startTime: toTimestamp.call(this, filters.startTime, 'From', i),
			endTime: toTimestamp.call(this, filters.endTime, 'To', i),
		});
		return await dzengiApiRequestAllItems.call(
			this,
			'/myTrades',
			query,
			{
				limit,
				pageSize: HISTORY_PAGE_SIZE,
				startParam: 'startTime',
				endParam: 'endTime',
				timeFields: ['time'],
				idFields: ['id', 'orderId'],
				listKeys: ['myTrades'],
			},
			requestOptions,
		);
	}

	if (operation === 'getLeverageSettings') {
		const symbol = String(this.getNodeParameter('symbol', i)).trim();
		const response = await dzengiApiRequest.call(this, 'GET', '/leverageSettings', {}, { symbol }, false, requestOptions);
		return isRecord(response) ? { symbol, ...response } : { symbol, response };
	}

	throw new NodeOperationError(this.getNode(), `Unknown account operation "${operation}"`, { itemIndex: i });
}

// ---------------------------------------------------------------------------
// Position (leverage)
// ---------------------------------------------------------------------------

async function executePosition(
	this: IExecuteFunctions,
	operation: string,
	i: number,
	requestOptions: IDzengiRequestOptions,
): Promise<IDataObject | IDataObject[]> {
	if (operation === 'getAll') {
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const response = await dzengiApiRequest.call(this, 'GET', '/tradingPositions', {}, {}, false, requestOptions);
		let positions = extractList(response, ['positions']);
		if (filters.symbol) {
			const wanted = String(filters.symbol);
			const wantedLeverage = formatLeverageSymbol(wanted);
			positions = positions.filter((position) => position.symbol === wanted || position.symbol === wantedLeverage);
		}
		return applyLimit.call(this, positions, i);
	}

	if (operation === 'getHistory') {
		const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
		const limit = returnAll ? undefined : (this.getNodeParameter('limit', i, 50) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const query = cleanParams({
			symbol: filters.symbol as string,
			from: toTimestamp.call(this, filters.startTime, 'From', i),
			to: toTimestamp.call(this, filters.endTime, 'To', i),
		});
		return await dzengiApiRequestAllItems.call(
			this,
			'/tradingPositionsHistory',
			query,
			{
				limit,
				pageSize: HISTORY_PAGE_SIZE,
				startParam: 'from',
				endParam: 'to',
				timeFields: ['execTimestamp', 'createdTimestamp'],
				idFields: ['execId', 'positionId'],
				listKeys: ['history'],
			},
			requestOptions,
		);
	}

	if (operation === 'update') {
		const positionId = String(this.getNodeParameter('positionId', i)).trim();
		const fields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
		const params: IDataObject = {
			positionId,
			...pickTradingFields(
				fields,
				['takeProfit', 'stopLoss', 'profitDistance', 'stopDistance'],
				['guaranteedStopLoss', 'trailingStopLoss'],
			),
		};
		if (Object.keys(params).length === 1) {
			throw new NodeOperationError(this.getNode(), 'Add at least one field to update', { itemIndex: i });
		}
		return (await dzengiApiRequest.call(
			this,
			'POST',
			'/updateTradingPosition',
			params,
			{},
			false,
			requestOptions,
		)) as IDataObject;
	}

	if (operation === 'close') {
		const positionId = String(this.getNodeParameter('positionId', i)).trim();
		const response = await dzengiApiRequest.call(
			this,
			'POST',
			'/closeTradingPosition',
			{ positionId },
			{},
			false,
			requestOptions,
		);
		const requests = extractList(response, ['request']);
		return { positionId, requests };
	}

	throw new NodeOperationError(this.getNode(), `Unknown position operation "${operation}"`, { itemIndex: i });
}

// ---------------------------------------------------------------------------
// Market data (public)
// ---------------------------------------------------------------------------

async function executeMarketData(
	this: IExecuteFunctions,
	operation: string,
	i: number,
	requestOptions: IDzengiRequestOptions,
): Promise<IDataObject | IDataObject[]> {
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	const environment = (options.environment as DzengiEnvironment | undefined) ?? undefined;
	const publicAdapter: IDzengiRequestOptions = { ...requestOptions, target: 'adapter', environment };

	if (operation === 'getTickers') {
		const source = this.getNodeParameter('source', i, 'marketcap') as string;
		const wanted = parseList(options.symbols).map((symbol) => symbol.toUpperCase());
		let tickers: IDataObject[];

		if (source === 'tradingApi') {
			const query = wanted.length === 1 ? { symbol: wanted[0] } : {};
			const response = await dzengiApiRequest.call(this, 'GET', '/ticker/24hr', {}, query, true, publicAdapter);
			tickers = extractList(response);
		} else {
			const market = this.getNodeParameter('market', i, 'crypto') as string;
			const endpoint = MARKETCAP_TICKER_ENDPOINTS[market] ?? MARKETCAP_TICKER_ENDPOINTS.crypto;
			const response = await dzengiApiRequest.call(this, 'GET', endpoint, {}, {}, true, {
				...requestOptions,
				target: 'marketcap',
			});
			tickers = tickerMapToList(response);
		}

		if (wanted.length) {
			tickers = tickers.filter((ticker) => wanted.includes(String(ticker.symbol).toUpperCase()));
		}
		return applyLimit.call(this, tickers, i);
	}

	if (operation === 'getOrderBook') {
		const symbol = String(this.getNodeParameter('symbol', i)).trim();
		const depth = Number(this.getNodeParameter('depth', i, 100));
		const response = (await dzengiApiRequest.call(
			this,
			'GET',
			'/depth',
			{},
			{ symbol, limit: depth },
			true,
			publicAdapter,
		)) as IDataObject;
		if (options.simplify === false) return { symbol, ...response };

		const bids = simplifyOrderBookSide(response?.bids);
		const asks = simplifyOrderBookSide(response?.asks);
		const bestBid = bids.length ? Number(bids[0].price) : undefined;
		const bestAsk = asks.length ? Number(asks[0].price) : undefined;
		return {
			symbol,
			lastUpdateId: response?.lastUpdateId,
			bestBid,
			bestAsk,
			spread: bestBid !== undefined && bestAsk !== undefined ? Number((bestAsk - bestBid).toPrecision(12)) : undefined,
			bids,
			asks,
		};
	}

	if (operation === 'getSymbolInfo') {
		const symbol = String(this.getNodeParameter('symbol', i)).trim();
		const symbols = await getExchangeSymbols.call(this, requestOptions.apiVersion, environment);
		const match =
			symbols.find((entry) => entry.symbol === symbol) ??
			symbols.find((entry) => entry.symbol.toUpperCase() === symbol.toUpperCase());
		if (!match) {
			throw new NodeOperationError(this.getNode(), `Symbol "${symbol}" was not found in Dzengi exchangeInfo`, {
				itemIndex: i,
				description:
					'Check the spelling and the API version: Hong Kong markets and the full leverage list are only in API v2.',
			});
		}
		return match;
	}

	if (operation === 'getCandles') {
		const symbol = String(this.getNodeParameter('symbol', i)).trim();
		const interval = this.getNodeParameter('interval', i) as string;
		const limit = this.getNodeParameter('candleLimit', i, 100) as number;
		// The REST docs name the Heikin-Ashi type "heiken-ashi" (the WebSocket docs use "heikin-ashi").
		const type = options.candleType === 'heikinAshi' ? 'heiken-ashi' : undefined;
		const query = cleanParams({
			symbol,
			interval,
			limit,
			type,
			priceType: options.priceType as string,
			startTime: toTimestamp.call(this, options.startTime, 'Start Time', i),
			endTime: toTimestamp.call(this, options.endTime, 'End Time', i),
		});
		const response = await dzengiApiRequest.call(this, 'GET', '/klines', {}, query, true, publicAdapter);
		return simplifyKlines(response).map((candle) => ({ symbol, interval, ...candle }));
	}

	throw new NodeOperationError(this.getNode(), `Unknown market data operation "${operation}"`, { itemIndex: i });
}
