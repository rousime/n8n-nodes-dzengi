# n8n-nodes-dzengi

Community nodes for the [Dzengi.com](https://dzengi.com/api) trading API.

This package adds two nodes to n8n:

| Node | What it does |
|---|---|
| **Dzengi** | REST API: create/read/update/cancel orders, read balances and trade history, manage leverage positions, read public market data |
| **Dzengi Trigger** | WebSocket trigger: real-time prices, order book, candles, market trades, plus order/balance/position changes |

> ⚠️ **Risk warning**
>
> These nodes can place real orders with real money, including leveraged positions that can lose more than the margin committed. Test everything on a **Demo** account first. Nothing here is investment advice.

---

## Requirements

- n8n `1.x` or `2.x`
- Node.js `>= 20.15`
- Runtime dependency: `ws`

---

## Installation

### From n8n Community Nodes

1. Open **Settings → Community Nodes → Install**
2. Enter `n8n-nodes-dzengi`
3. Confirm and restart n8n if required

Community-node installation must be enabled on self-hosted n8n:

```bash
N8N_COMMUNITY_PACKAGES_ENABLED=true
```

### From a local build

```bash
git clone https://github.com/rousime/n8n-nodes-dzengi
cd n8n-nodes-dzengi
npm install
npm run build
npm pack
```

Then install the generated tarball into n8n's custom-extensions folder:

```bash
mkdir -p ~/.n8n/custom
cd ~/.n8n/custom
npm init -y
npm install /path/to/n8n-nodes-dzengi-1.0.0.tgz
```

For Docker, mount that folder or set `N8N_CUSTOM_EXTENSIONS` to it:

```bash
-v ~/.n8n/custom:/home/node/.n8n/custom
```

---

## Credentials

Create an API key in your Dzengi account: [Dzengi API Get Started](https://dzengi.com/api-get-started)

Then add **Dzengi API** credentials in n8n.

| Field | Description |
|---|---|
| API Key | Sent as `X-MBX-APIKEY` |
| API Secret | Used to sign private requests with HMAC-SHA256 |
| Environment | `Live` or `Demo` |
| Default API Version | `V1` or `V2` |
| Receive Window | Signed-request validity in ms, default `5000` |

The **Test** button performs a signed `GET /account` request.

If you only need read-only data, create a key without trading permissions.

---

## Dzengi node

The main Dzengi node supports these resources:

| Resource | Operations |
|---|---|
| Order | Create, cancel, get, get open orders, update |
| Account | Get balances, trade history, leverage settings |
| Position | Get positions, position history, update TP/SL, close |
| Market Data | Tickers, order book, candles, symbol/exchange info |

### Order examples

Exchange limit buy:

```text
Resource: Order
Operation: Create
Trading Mode: Exchange
Symbol: BTC/USD
Side: Buy
Order Type: Limit
Quantity: 0.01
Price: 60000
```

Leverage market sell with TP/SL:

```text
Resource: Order
Operation: Create
Trading Mode: Leverage
Symbol: BTC/USD
Side: Sell
Order Type: Market
Quantity: 0.01
Leverage Options:
  Leverage: 5
  Take Profit: 55000
  Stop Loss: 64000
```

For leverage symbols, currency pairs are automatically formatted:

```text
BTC/USD -> BTC/USD_LEVERAGE
```

You can disable this under **Additional Fields → Auto-Format Leverage Symbol**.

---

## Dzengi Trigger

The trigger node can emit events for:

- Price updates
- Order book updates
- Candle updates
- Market trades
- Order updates
- Balance updates
- Position updates

Market-data events are received over WebSocket streams.

Dzengi does not currently provide push events for orders, balances, or positions, so those are detected by polling:

- Default poll interval: `5s`
- Minimum poll interval: `2s`
- Only changes are emitted
- The first snapshot is silent unless **Emit Initial State** is enabled

For busy streams, use **Batch Window** to reduce workflow executions.

---

## API versions

| Environment | V1 | V2 |
|---|---:|---:|
| Live | ✅ | ✅ |
| Demo | ✅ | ❌ |

Notes:

- Demo supports **V1 only**.
- V2 provides a fuller list of leverage instruments.
- Hong Kong markets require V2.
- Each node can override the credential's default API version.

---

## Error handling

The node handles common API issues:

- `-1021` timestamp errors: resyncs with server time and retries once
- `429` rate-limit errors: retries with backoff
- `418` IP ban errors: not retried
- Read errors: retried with backoff
- Failed order writes: not retried automatically, because the order state may be unknown

All operations support **Continue On Fail**.

---

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
npm run dev
```

Tests run offline and do not call the real Dzengi API.

---

## Known limitations

- Built from Dzengi documentation and Swagger specs.
- Not yet verified against the live trading API.
- Demo environment supports V1 only.
- Dzengi only exposes open orders; there is no full order-history endpoint.
- Trade history is limited to the last 1000 trades.
- V1 may return a limited leverage instrument list.
- This package uses the `ws` dependency, so it installs as an unverified community node.

---

## License

MIT — see [LICENSE](LICENSE).