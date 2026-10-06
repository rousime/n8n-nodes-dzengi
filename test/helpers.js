'use strict';
// Shared fakes for n8n execution contexts. Tests run against the compiled output in dist/.
const crypto = require('crypto');

const API_KEY = 'vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A';
const API_SECRET = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';

function hmac(payload, secret = API_SECRET) {
	return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** Splits a signed URL and checks the signature independently of the code under test. */
function verifySignedUrl(url, secret = API_SECRET) {
	const query = url.split('?')[1] ?? '';
	const index = query.lastIndexOf('&signature=');
	if (index === -1) return { valid: false, params: new URLSearchParams(query) };
	const unsigned = query.slice(0, index);
	const signature = query.slice(index + '&signature='.length);
	return { valid: hmac(unsigned, secret) === signature, unsigned, params: new URLSearchParams(unsigned) };
}

/**
 * Fake n8n context. `responses` is a queue of { statusCode, body, headers } or Error objects
 * (or a function (request) => response) answered in order by helpers.httpRequest.
 */
function createContext({
	credentials = {
		apiKey: API_KEY,
		apiSecret: API_SECRET,
		environment: 'live',
		defaultApiVersion: 'v1',
		recvWindow: 5000,
	},
	parameters = {},
	responses = [],
	items = [{ json: {} }],
	continueOnFail = false,
	mode = 'trigger',
} = {}) {
	const requests = [];
	const emitted = [];
	const errors = [];
	const queue = Array.isArray(responses) ? [...responses] : null;
	const context = {
		requests,
		emitted,
		errors,
		getNode: () => ({ name: 'Dzengi', type: 'n8n-nodes-dzengi.dzengi', typeVersion: 1, parameters: {} }),
		getCredentials: async () => {
			if (!credentials) throw new Error('Node does not have any credentials set');
			return credentials;
		},
		getInputData: () => items,
		getNodeParameter: (name, itemIndexOrFallback, fallback) => {
			// Execute: (name, itemIndex, fallback); Trigger: (name, fallback)
			const fallbackValue = typeof itemIndexOrFallback === 'number' ? fallback : itemIndexOrFallback;
			return Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallbackValue;
		},
		getCurrentNodeParameter: (name) => parameters[name],
		continueOnFail: () => continueOnFail,
		getMode: () => mode,
		emit: (data) => emitted.push(data),
		emitError: (error) => errors.push(error),
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		helpers: {
			httpRequest: async (options) => {
				requests.push(options);
				const next = typeof responses === 'function' ? responses(options) : queue.shift();
				if (next === undefined) throw new Error(`Unexpected request: ${options.method} ${options.url}`);
				if (next instanceof Error) throw next;
				const full = { headers: {}, statusCode: 200, ...next };
				// Like n8n: only the body unless returnFullResponse is set; non-2xx throws unless ignored.
				if (!options.ignoreHttpStatusErrors && (full.statusCode < 200 || full.statusCode >= 300)) {
					throw Object.assign(new Error(`Request failed with status code ${full.statusCode}`), {
						response: { status: full.statusCode, data: full.body, headers: full.headers },
					});
				}
				return options.returnFullResponse ? full : full.body;
			},
			returnJsonArray: (data) => (Array.isArray(data) ? data : [data]).map((json) => ({ json })),
			constructExecutionMetaData: (data, { itemData }) => data.map((entry) => ({ ...entry, pairedItem: itemData })),
		},
	};
	return context;
}

function networkError(code) {
	const error = new Error(`connect ${code}`);
	error.code = code;
	return error;
}

module.exports = { API_KEY, API_SECRET, hmac, verifySignedUrl, createContext, networkError };
