import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { DzengiStreamClient } from './DzengiWebSocketClient';
import type { IDzengiStreamConfig, IDzengiStreamHandlers } from './DzengiWebSocketClient';
import {
	DZENGI_URLS,
	getAllTradingSymbols,
	getDzengiCredentials,
	resolveApiVersion,
	testDzengiCredentials,
	versionSupportError,
} from './GenericFunctions';
import { PRIVATE_POLLED_EVENTS, PUBLIC_STREAM_EVENTS } from './types';
import type { DzengiApiVersionSetting, DzengiEnvironment, DzengiTriggerEvent } from './types';

export class DzengiTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Dzengi Trigger',
		name: 'dzengiTrigger',
		icon: 'file:../../icons/dzengi.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow on Dzengi.com WebSocket events (prices, order book, candles, orders, balances)',
		defaults: { name: 'Dzengi Trigger' },
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'dzengiApi',
				required: false,
				testedBy: 'dzengiApiCredentialTest',
			},
		],
		properties: [
			{
				displayName:
					'Price, order book, candle and trade events are pushed by Dzengi. Dzengi has no push channel for orders, balances or positions, so those events are detected by polling over the authenticated WebSocket and require credentials.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: [
					{
						name: 'Balance Update',
						value: 'balanceUpdate',
						description: 'An asset balance changed (polled, needs credentials)',
					},
					{
						name: 'Candle Update',
						value: 'candleUpdate',
						description: 'OHLC candle updates for the selected symbols',
					},
					{
						name: 'Market Trade',
						value: 'marketTrade',
						description: 'Trades executed on the market for the selected symbols',
					},
					{
						name: 'Order Book Update',
						value: 'orderBookUpdate',
						description: 'Order book depth changes for the selected symbols',
					},
					{
						name: 'Order Update',
						value: 'orderUpdate',
						description: 'An order was created, changed, filled or cancelled (polled, needs credentials)',
					},
					{
						name: 'Position Update',
						value: 'positionUpdate',
						description: 'A leverage position was opened, modified or closed (polled, needs credentials)',
					},
					{
						name: 'Price Update',
						value: 'priceUpdate',
						description: 'Real-time bid/ask quotes for the selected symbols',
					},
				],
				default: ['priceUpdate'],
			},
			{
				displayName: 'API Version',
				name: 'apiVersion',
				type: 'options',
				options: [
					{ name: 'Use Credential Default', value: 'credentials' },
					{ name: 'V1', value: 'v1' },
					{ name: 'V2', value: 'v2', description: 'Live only' },
				],
				default: 'credentials',
			},
			{
				displayName: 'Symbol Names or IDs',
				name: 'symbols',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getAllTradingSymbols', loadOptionsDependsOn: ['apiVersion'] },
				default: [],
				required: true,
				displayOptions: {
					show: { events: ['priceUpdate', 'orderBookUpdate', 'candleUpdate', 'marketTrade'] },
				},
				description:
					'Symbols to stream. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Candle Intervals',
				name: 'candleIntervals',
				type: 'multiOptions',
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
				default: ['1m'],
				displayOptions: { show: { events: ['candleUpdate'] } },
			},
			{
				displayName: 'Candle Type',
				name: 'candleType',
				type: 'options',
				options: [
					{ name: 'Classic', value: 'classic' },
					{ name: 'Heikin-Ashi', value: 'heikin-ashi' },
				],
				default: 'classic',
				displayOptions: { show: { events: ['candleUpdate'] } },
			},
			{
				displayName: 'Poll Interval (Seconds)',
				name: 'pollInterval',
				type: 'number',
				typeOptions: { minValue: 2 },
				default: 5,
				displayOptions: { show: { events: ['orderUpdate', 'balanceUpdate', 'positionUpdate'] } },
				description: 'How often orders, balances and positions are checked for changes',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Batch Window (Ms)',
						name: 'batchWindowMs',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
						description:
							'Collect events for this long and start one execution with all of them. 0 starts one execution per message.',
					},
					{
						displayName: 'Emit Initial State',
						name: 'emitInitialState',
						type: 'boolean',
						default: false,
						description:
							'Whether to emit the current orders, balances and positions once on start (change = "snapshot")',
					},
					{
						displayName: 'Environment (Without Credentials)',
						name: 'environment',
						type: 'options',
						options: [
							{ name: 'Live', value: 'live' },
							{ name: 'Demo', value: 'demo' },
						],
						default: 'live',
						description: 'Used only when no credentials are selected; otherwise the credential environment applies',
					},
					{
						displayName: 'Include Raw Payload',
						name: 'includeRaw',
						type: 'boolean',
						default: false,
						description: 'Whether to attach the original Dzengi message to stream events',
					},
					{
						displayName: 'Max Reconnect Attempts',
						name: 'maxReconnectAttempts',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
						description:
							'Give up and report an error after this many failed reconnects in a row. 0 retries forever with backoff (max 60 s).',
					},
					{
						displayName: 'Min Price Interval (Ms)',
						name: 'minPriceIntervalMs',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
						description:
							'Emit at most one price update per symbol in this window; ticks in between are skipped. 0 emits every tick.',
					},
					{
						displayName: 'Resolve Closed Orders',
						name: 'resolveClosedOrders',
						type: 'boolean',
						default: true,
						description:
							'Whether to look up the final status (FILLED, CANCELED …) when an order leaves the open-orders list',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			getAllTradingSymbols,
		},
		credentialTest: {
			dzengiApiCredentialTest: testDzengiCredentials,
		},
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const events = this.getNodeParameter('events', []) as DzengiTriggerEvent[];
		if (!events.length) {
			throw new NodeOperationError(this.getNode(), 'Select at least one event');
		}
		const wantsPrivate = events.some((event) => PRIVATE_POLLED_EVENTS.includes(event));
		const wantsPublic = events.some((event) => PUBLIC_STREAM_EVENTS.includes(event));
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const isManual = this.getMode() === 'manual';

		const credentials = await getDzengiCredentials.call(this, wantsPrivate);
		const environment: DzengiEnvironment =
			credentials?.environment ?? (options.environment === 'demo' ? 'demo' : 'live');
		const apiVersion = resolveApiVersion(
			this.getNodeParameter('apiVersion', 'credentials') as DzengiApiVersionSetting,
			credentials,
		);
		const unsupported = versionSupportError(environment, apiVersion);
		if (unsupported) throw new NodeOperationError(this.getNode(), unsupported);

		const symbols = wantsPublic
			? ((this.getNodeParameter('symbols', []) as string[]) ?? []).map((symbol) => symbol.trim()).filter(Boolean)
			: [];
		if (wantsPublic && !symbols.length) {
			throw new NodeOperationError(
				this.getNode(),
				'Select at least one symbol for price, order book, candle or trade events',
			);
		}

		const config: IDzengiStreamConfig = {
			url: DZENGI_URLS[environment].ws,
			apiVersion,
			events,
			symbols,
			credentials: credentials ? { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret } : undefined,
			candleIntervals: events.includes('candleUpdate')
				? (this.getNodeParameter('candleIntervals', ['1m']) as string[])
				: undefined,
			candleType: events.includes('candleUpdate')
				? (this.getNodeParameter('candleType', 'classic') as string)
				: undefined,
			pollIntervalMs: wantsPrivate ? Number(this.getNodeParameter('pollInterval', 5)) * 1000 : undefined,
			// In manual test runs show the current state straight away so the user sees the data shape.
			emitInitialState: options.emitInitialState === true || isManual,
			resolveClosedOrders: options.resolveClosedOrders !== false,
			minPriceIntervalMs: Number(options.minPriceIntervalMs ?? 0),
			batchWindowMs: Number(options.batchWindowMs ?? 0),
			includeRaw: options.includeRaw === true,
			reconnect: { maxAttempts: Number(options.maxReconnectAttempts ?? 0) },
		};

		const node = this.getNode();
		const logger = this.logger;
		let client: DzengiStreamClient | undefined;

		const closeFunction = async () => {
			await client?.stop();
			client = undefined;
		};

		const baseHandlers = (onFatal: (error: Error) => void): IDzengiStreamHandlers => ({
			onEvents: (data) => this.emit([this.helpers.returnJsonArray(data)]),
			onError: (error, fatal) => {
				if (fatal) {
					onFatal(error);
				} else {
					logger.warn(`Dzengi Trigger: ${error.message}`);
				}
			},
			log: logger,
		});

		if (isManual) {
			// Test run: start streaming and finish as soon as the first batch of events arrives.
			const manualTriggerFunction = async () => {
				await new Promise<void>((resolve, reject) => {
					const handlers = baseHandlers((error) => reject(new NodeOperationError(node, error.message)));
					const onEvents = handlers.onEvents;
					handlers.onEvents = (data) => {
						onEvents(data);
						resolve();
					};
					client = new DzengiStreamClient(config, handlers);
					client.start();
				});
			};
			return { closeFunction, manualTriggerFunction };
		}

		client = new DzengiStreamClient(
			config,
			baseHandlers((error) => this.emitError(new NodeOperationError(node, error.message))),
		);
		client.start();
		return { closeFunction };
	}
}
