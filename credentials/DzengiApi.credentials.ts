import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Credentials for the Dzengi.com trading API.
 *
 * Dzengi signs private requests with HMAC-SHA256: the API key travels in the
 * `X-MBX-APIKEY` header and the secret signs the exact query string/body that
 * is sent. Because the signature depends on every request's parameters and a
 * fresh timestamp, signing happens in `GenericFunctions.ts` rather than via a
 * declarative `authenticate` block. The credential is tested by the Dzengi node
 * (`testedBy: 'dzengiApiCredentialTest'`), which performs a signed `GET /account`.
 */
export class DzengiApi implements ICredentialType {
	name = 'dzengiApi';

	displayName = 'Dzengi API';

	documentationUrl = 'https://dzengi.com/api-get-started';

	icon = 'file:../icons/dzengi.svg' as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'API key generated in your Dzengi account settings (sent as the X-MBX-APIKEY header)',
		},
		{
			displayName: 'API Secret',
			name: 'apiSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Secret key used to sign requests with HMAC-SHA256. It is never sent to Dzengi.',
		},
		{
			displayName: 'Environment',
			name: 'environment',
			type: 'options',
			options: [
				{
					name: 'Live',
					value: 'live',
					description: 'Real account — https://api-adapter.dzengi.com',
				},
				{
					name: 'Demo',
					value: 'demo',
					description: 'Demo account — https://demo-api-adapter.dzengi.com (API v1 only)',
				},
			],
			default: 'live',
			description: 'Which Dzengi environment the key belongs to. Demo keys do not work on live and vice versa.',
		},
		{
			displayName: 'Default API Version',
			name: 'defaultApiVersion',
			type: 'options',
			options: [
				{
					name: 'V1',
					value: 'v1',
					description: 'Original API. Available on live and demo.',
				},
				{
					name: 'V2',
					value: 'v2',
					description: 'Adds Hong Kong markets and the full list of leverage instruments. Live only.',
				},
			],
			default: 'v1',
			description: 'API version used unless a node overrides it. Dzengi demo accounts only support v1.',
		},
		{
			displayName: 'Receive Window (Ms)',
			name: 'recvWindow',
			type: 'number',
			typeOptions: { minValue: 1000, maxValue: 60000 },
			default: 5000,
			description:
				'How long after its timestamp a signed request stays valid. Dzengi recommends 5000 or less; the maximum is 60000.',
		},
	];
}
