# n8n-nodes-dzengi

n8n community nodes for the [Dzengi.com](https://dzengi.com/api) trading API.

| Node | What it does |
| --- | --- |
| **Dzengi** | REST API v1/v2: place, read, update and cancel orders (exchange and leverage), read balances and trade history, manage leverage positions, read public market data |
| **Dzengi Trigger** | WebSocket trigger: real-time prices, order book, candles and market trades; order, balance and position changes |

> **Risk warning.** These nodes can place real orders with real money, including leveraged positions that can lose more than the margin committed. Build and test every workflow against a **Demo** account first. Nothing here is investment advice.

---

## Contents

1. [Installation](#installation)
2. [Credentials](#credentials)
3. [API versions and environments](#api-versions-and-environments)
4. [Dzengi node — resources and operations](#dzengi-node)
5. [Dzengi Trigger — WebSocket setup](#dzengi-trigger)
6. [Errors, rate limits and retries](#errors-rate-limits-and-retries)
7. [Example workflows](#example-workflows)
8. [Development and tests](#development-and-tests)
9. [Implementation notes and known limitations](#implementation-notes-and-known-limitations)

---

## Installation

Requires n8n 1.x or 2.x on Node.js ≥ 20.15. The package has one runtime dependency (`ws`).

### Community Nodes (GUI)

1. **Settings → Community Nodes → Install**.
2. Enter `n8n-nodes-dzengi` and confirm.

Community-node installation must be enabled on self-hosted n8n (`N8N_COMMUNITY_PACKAGES_ENABLED=true`, the default).

### From a local build (self-hosted / Docker)

```bash
git clone <this repository> n8n-nodes-dzengi
cd n8n-nodes-dzengi
npm install
npm run build          # compiles to dist/ and copies icons
npm pack               # creates n8n-nodes-dzengi-1.0.0.tgz
```

Then install the tarball into n8n's custom-extensions folder and restart n8n:

```bash
mkdir -p ~/.n8n/custom && cd ~/.n8n/custom
npm init -y >/dev/null 2>&1 || true
npm install /path/to/n8n-nodes-dzengi-1.0.0.tgz
```

For Docker, mount that folder (or set `N8N_CUSTOM_EXTENSIONS` to it) — for example `-v ~/.n8n/custom:/home/node/.n8n/custom`.

---

## Credentials

Create an API key in your Dzengi account (see [API Get Started](https://dzengi.com/api-get-started)), then in n8n add **Dzengi API** credentials:

| Field | Description |
| --- | --- |
| **API Key** | Sent as the `X-MBX-APIKEY` header. |
| **API Secret** | Signs every private request with HMAC-SHA256. Never sent to Dzengi. |
| **Environment** | `Live` (`api-adapter.dzengi.com`) or `Demo` (`demo-api-adapter.dzengi.com`). Keys only work in the environment they were created for. |
| **Default API Version** | `V1` or `V2`. Nodes can override it. Demo supports V1 only. |
| **Receive Window (ms)** | How long a signed request stays valid (default 5000, max 60000). |

The **Test** button performs a signed `GET /account`, so a green result means both the key and the secret are correct.

**Least privilege:** if you only need to read data, create a key without trading permission. Dzengi lets you scope keys (e.g. TRADE vs USER_DATA).

### How signing works

For private REST endpoints the node builds the query string, adds `recvWindow` and `timestamp`, and appends `signature = HMAC_SHA256(secret, queryString + body)`. The implementation reproduces both signed examples from Dzengi's documentation byte for byte (see `test/signing.test.js`). If Dzengi rejects a timestamp (`-1021`), the node fetches `/api/{v}/time`, corrects for the clock offset and retries once.

WebSocket requests are signed the way Dzengi's official client does it: payload keys sorted alphabetically, joined as raw `key=value` pairs.

---

## API versions and environments

| | v1 | v2 |
| --- | --- | --- |
| Crypto, tokenised shares, commodities, indices, FX | ✅ | ✅ |
| Hong Kong markets | — | ✅ |
| Full list of leverage instruments | partial | ✅ |
| Demo environment | ✅ | — |

Every Dzengi node has an **API Version** dropdown: *Use Credential Default*, *V1* or *V2*. Endpoints are identical in both versions (`/api/v1/order` ↔ `/api/v2/order`); responses are normalised so downstream nodes see the same field names. Choosing V2 with demo credentials fails fast with a clear message instead of an opaque HTTP error.

---

## Dzengi node

### Resource: Order

| Operation | Endpoint | Notes |
| --- | --- | --- |
| **Create** | `POST /api/{v}/order` | LIMIT, MARKET (exchange + leverage), STOP (leverage only) |
| **Cancel** | `DELETE /api/{v}/order` | needs Symbol + Order ID |
| **Get** | `GET /api/{v}/fetchOrder` | needs Symbol + Order ID |
| **Get Many** | `GET /api/{v}/openOrders` | open orders, filtered client-side |
| **Update** | `PUT /api/{v}/order` (exchange) · `POST /api/{v}/updateTradingOrder` (leverage) | price / expiry / TP / SL |

**Trading Mode** selects *Exchange* (spot) or *Leverage*. In leverage mode:

- The **Symbol** list shows leverage instruments from `exchangeInfo` (use V2 for the full list). Currency-pair symbols get the `_LEVERAGE` suffix automatically (`BTC/USD` → `BTC/USD_LEVERAGE`); asset-only symbols such as `Oil - Brent.` are used as-is. Turn this off under *Additional Fields → Auto-Format Leverage Symbol*.
- **Leverage Options**: Account ID, Leverage, Take Profit, Stop Loss, Profit/Stop Distance, Guaranteed Stop Loss, Trailing Stop Loss. Use *Account → Get Leverage Settings* to see which leverage values a symbol allows.

Example — buy 0.01 BTC at 60 000 USD (exchange):

```
Resource: Order · Operation: Create · Trading Mode: Exchange
Symbol: BTC/USD · Side: Buy · Order Type: Limit · Quantity: 0.01 · Price: 60000
```

Example — 5× leveraged market sell with TP/SL:

```
Trading Mode: Leverage · Symbol: BTC/USD (sent as BTC/USD_LEVERAGE)
Side: Sell · Order Type: Market · Quantity: 0.01
Leverage Options: Leverage 5, Take Profit 55000, Stop Loss 64000
```

**Get Many** filters: symbol, side, order type, status, trading mode, created after/before. *Return All* or *Limit*. Dzengi only exposes **open** orders; use *Account → Get Trade History* for fills and *Position → Get History* for closed leverage positions.

**Response type**: exchange MARKET orders accept `RESULT` or `FULL` (Dzengi defaults to FULL); LIMIT and all leverage orders only support `RESULT`.

### Resource: Account

| Operation | Endpoint | Notes |
| --- | --- | --- |
| **Get Balances** | `GET /api/{v}/account` (+ `/tradingPositions`) | *Account Summary* (one item, optional open positions) or *One Item per Balance*; filter by assets; show zero balances |
| **Get Trade History** | `GET /api/{v}/myTrades` | per symbol; pages backwards through time; Dzengi keeps only the last 1000 trades |
| **Get Leverage Settings** | `GET /api/{v}/leverageSettings` | allowed and default leverage for a symbol |

### Resource: Position (leverage)

Added beyond the original brief because leverage positions cannot otherwise be closed or adjusted from n8n.

| Operation | Endpoint |
| --- | --- |
| **Get Many** | `GET /api/{v}/tradingPositions` |
| **Get History** | `GET /api/{v}/tradingPositionsHistory` (paged by `from`/`to`) |
| **Update** | `POST /api/{v}/updateTradingPosition` (TP/SL, distances, guaranteed/trailing stop) |
| **Close** | `POST /api/{v}/closeTradingPosition` |

### Resource: Market Data (public — no credentials)

| Operation | Source | Notes |
| --- | --- | --- |
| **Get Tickers** | `https://marketcap.dzengi.com/api/v1/ticker` · `/token/ticker` · `/token_crypto/ticker`, or `GET /api/{v}/ticker/24hr` | marketcap returns an object keyed by symbol; the node turns it into one item per symbol. Filter by comma-separated symbols. |
| **Get Order Book** | `GET /api/{v}/depth` | *Simplify* (default) returns `{price, quantity}` levels plus `bestBid`, `bestAsk`, `spread` |
| **Get Symbol Info** | `GET /api/{v}/exchangeInfo` | trading rules, precision, filters (LOT_SIZE, MIN_NOTIONAL), fees, market type |
| **Get Candles** | `GET /api/{v}/klines` | 1m–1w, classic or Heikin-Ashi, bid or ask prices, start/end time |

Market Data hides the credential selector. To read the demo host, set *Options → Environment → Demo*.

### Dynamic symbol lists

| Loader | Source | Used by |
| --- | --- | --- |
| `getSymbols` | marketcap `/api/v1/ticker` (crypto pairs) | available for custom use |
| `getTradingSymbols` | `exchangeInfo`, filtered by the node's Trading Mode and API Version | Order create/cancel/get |
| `getAllTradingSymbols` | `exchangeInfo`, all instruments | everything else, trigger |

Every symbol field also accepts an expression.

---

## Dzengi Trigger

### Events

| Event | How it is produced | Credentials |
| --- | --- | --- |
| **Price Update** | `marketData.subscribe` push stream | optional |
| **Order Book Update** | `depthMarketData.subscribe` push stream | optional |
| **Candle Update** | `OHLCMarketData.subscribe` push stream (intervals 1m–1w, classic or Heikin-Ashi) | optional |
| **Market Trade** | `trades.subscribe` push stream | optional |
| **Order Update** | polls `/api/{v}/openOrders` over the socket and emits `created` / `updated` / `closed` (final FILLED/CANCELED status looked up via `fetchOrder`) | required |
| **Balance Update** | polls `/api/{v}/account`, emits changes with `freeDelta` / `lockedDelta` | required |
| **Position Update** | polls `/api/{v}/tradingPositions`, emits `opened` / `updated` / `closed` | required |

Dzengi's WebSocket API has no push channel for orders or balances, so those three events are detected by polling (default every 5 s, minimum 2 s) and emitting only differences. The first snapshot is a silent baseline unless *Emit Initial State* is on; manual test runs always emit it so you can see the data shape.

### Setup

1. Add **Dzengi Trigger**, select one or more **Events**.
2. For stream events pick **Symbols** (list from `exchangeInfo`, or an expression).
3. For order/balance/position events select credentials and a **Poll Interval**.
4. Optional **Options**:
   - *Min Price Interval (ms)* — at most one price update per symbol per window.
   - *Batch Window (ms)* — collect events and start one execution with all of them (recommended for busy streams; one execution per tick is expensive).
   - *Emit Initial State*, *Resolve Closed Orders*, *Include Raw Payload*.
   - *Max Reconnect Attempts* — 0 (default) retries forever.
   - *Environment (Without Credentials)* — live or demo for public streams.
5. Activate the workflow.

### Output examples

```json
{ "event": "priceUpdate", "symbol": "BTC/USD", "bid": 65000.5, "ask": 65001, "bidQty": 1, "askQty": 2,
  "spread": 0.5, "timestamp": 1700000000000, "receivedAt": 1700000000042 }

{ "event": "orderUpdate", "change": "closed", "orderId": "o1", "symbol": "BTC/USD", "status": "FILLED",
  "order": { "...": "final order from fetchOrder" }, "previous": { "...": "last open snapshot" } }

{ "event": "balanceUpdate", "change": "updated", "accountId": "a1", "asset": "USD",
  "free": 50, "locked": 25, "total": 75, "previousFree": 100, "freeDelta": -50, "lockedDelta": 25 }
```

### Connection handling

- Connects to `wss://api-adapter.dzengi.com/connect` (or the demo host) with per-message deflate.
- Sends a WebSocket ping every 10 s and an application `ping` every 20 s (Dzengi drops sockets not pinged within 30 s). If nothing arrives for 45 s the socket is recycled.
- Reconnects with exponential backoff (1 s → 60 s, with jitter) and re-subscribes; snapshots survive reconnects, so changes during an outage are still reported.
- On deactivation `closeFunction` clears every timer, rejects pending requests and closes the socket (code 1000).
- Rejected subscriptions or credentials are reported through `emitError` (n8n marks the trigger as failed and retries activation); transient polling errors are logged and retried.

---

## Errors, rate limits and retries

| Situation | Behaviour |
| --- | --- |
| HTTP 400 with `{code, msg}` | `NodeApiError` with Dzengi's code and message plus a hint for common codes (`-1013`, `-1021`, `-1022`, `-1121`, `-2010`, `-2015` …) |
| `{code, msg}` returned with HTTP 200 | treated as an error |
| `-1021` timestamp outside recvWindow | re-sync with server time, retry once |
| 401 / 403 | authentication or WAF/permission message |
| 404 | endpoint not available in the selected API version |
| 429 | retried up to 3 times, honouring `Retry-After`, else exponential backoff |
| 418 (IP auto-ban) | not retried; explains the ban |
| 5xx on reads | retried with backoff |
| 5xx / connection reset on **orders and other writes** | **not retried**; error says the outcome is UNKNOWN so you check open orders before retrying |
| Connection refused / DNS failure | retried (the request never reached Dzengi) |
| Client-side throttling | ≤ 10 req/s per host, ≤ 5 req/s for `/openOrders` |
| Validation before sending | quantity/price > 0, STOP only in leverage mode, at least one field for updates, demo + v2 blocked |

All operations support **Continue On Fail**: errors become items with `error` and `description` paired to the input item.

---

## Example workflows

Import from `examples/` (*Workflows → Import from File*):

| File | Shows |
| --- | --- |
| `01-market-data-public.json` | tickers (marketcap), order book, candles and symbol rules — no credentials |
| `02-demo-test-order.json` | **demo account**: reads symbol rules and the book, prices a BUY limit 20 % below the best bid so it rests unfilled, creates it, checks it, cancels it |
| `03-websocket-price-alert.json` | trigger streaming BTC/USD and ETH/USD with throttling + batching, and a threshold alert |
| `04-api-v1-vs-v2.json` | the same calls on v1 and v2: lists symbols only available in v2, balances via both versions |

Replace `REPLACE_WITH_YOUR_CREDENTIAL_ID` by selecting your credentials in each node after import.

---

## Development and tests

```bash
npm install
npm run build        # tsc + copy icons/codex files into dist/
npm run typecheck    # strict TypeScript, no emit
npm test             # build + node:test suites (no network access needed)
npm run dev          # tsc --watch
```

The test suite (60 tests) runs entirely offline:

- `signing.test.js` — both official Dzengi signature examples, encoding, number formatting, WebSocket signing against the official client's algorithm, response normalisation.
- `request.test.js` — URL/version/environment resolution, headers, signature verification, `-1021` clock re-sync, 429/418/5xx/network behaviour, form-body mode, throttling, time-based pagination.
- `node.test.js` — every resource/operation through `execute()`, input validation, Continue On Fail, symbol loaders, credential test.
- `websocket.test.js` — a local mock Dzengi WebSocket server: subscription format, quote normalisation, order/balance diffs, server-side signature verification, reconnect + re-subscribe (including a drop mid-poll), throttling/batching, trigger manual mode and validation.
- `examples.test.js` — every example workflow's parameters exist and are valid for the selected operation.

### Project structure

```
credentials/DzengiApi.credentials.ts
nodes/Dzengi/
  Dzengi.node.ts            main node (execute + loadOptions + credential test)
  DzengiTrigger.node.ts     WebSocket trigger
  DzengiWebSocketClient.ts  WebSocket client: heartbeat, reconnect, subscriptions, polling diffs
  GenericFunctions.ts       signing, requests, retries, errors, pagination, loaders
  types.ts                  shared types
  descriptions/             Order, Account, Position and Market Data parameters
  dzengi.svg                icon (generic glyph — swap in an official logo if you have the rights)
examples/                   importable workflows
test/                       node:test suites
```

---

## Implementation notes and known limitations

- **Not yet run against the live Dzengi API.** The code was built from Dzengi's documentation and Swagger specification and verified offline (signature vectors, mocked HTTP and a mock WebSocket server). Run the demo workflow (`02`) before trading live.
- **WebSocket event names.** Dzengi documents the stream payloads (`InternalQuote`, `OHLCBar`, `MarketDepthEvent`, `TradeEvent`) but not the `destination` names of pushed events, so the trigger recognises events by payload shape first and destination second. Turn on *Include Raw Payload* if you need the original message.
- **Heikin-Ashi naming.** The REST docs spell the klines type `heiken-ashi`, the WebSocket docs `heikin-ashi`; each is used for its own API.
- **Open orders only.** Dzengi has no "all orders" endpoint; *Get Many* returns open orders. Trade history is limited to the last 1000 trades.
- **Leverage symbols in v1.** v1 `exchangeInfo` may list few or no leverage instruments; the symbol list then tells you to switch to V2 (live) or type the symbol.
- **Verified community node status.** n8n's verified-node programme does not allow runtime dependencies; this package needs `ws`, so it installs as an unverified community node.
