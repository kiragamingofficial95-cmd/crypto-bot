# Cross Engine

A paper-trading moving-average crossover bot for **BNB/USDT**, with a live dashboard.
Feed it prices from CoinGecko, or push your own feed straight in.

- **Recent average crosses above the longer average → buy**
- **Recent average crosses back below → sell**

Every order is simulated. No exchange keys, no real money, no order routing.

---

## Quick start

```bash
cd crypto-bot
npm install
copy .env.example .env      # Windows   (cp on macOS/Linux)
npm start
```

Open <http://localhost:3000>.

The public CoinGecko API works without a key, but it is rate-limited to roughly
5–15 calls per minute. If you have a **Demo** or **Pro** key, put it in `.env`:

```ini
COINGECKO_API_KEY=your_key_here
COINGECKO_KEY_TYPE=demo        # "demo" or "pro"
```

A Pro key lifts the rate limit and lets you shorten `POLL_MS`.

---

## The strategy

Two moving averages are tracked over the price series:

| Setting | Meaning | Default |
| --- | --- | --- |
| `SHORT_PERIOD` | The *recent* average | 10 ticks |
| `LONG_PERIOD` | The *longer* average | 30 ticks |
| `MA_TYPE` | `sma` or `ema` | `sma` |
| `POLL_MS` | How often a new tick arrives | 20000 ms |

One tick is one price sample. With the default 20 s poll, a 10-tick fast average
covers 3½ minutes and the 30-tick slow average covers 10 minutes.

**The cross is detected, not the state.** The bot compares the previous bar's
averages with the current bar's:

```
previous fast ≤ previous slow  AND  current fast > current slow   → BUY
previous fast ≥ previous slow  AND  current fast < current slow   → SELL
```

Without that check the bot would re-fire a buy on every single tick for as long
as the fast average stayed above the slow one. The previous averages are
recomputed from the price history rather than cached, so they can never drift
out of sync with the data.

The averages are also **stateless with respect to the period settings**: change
`SHORT_PERIOD` or `LONG_PERIOD` from the dashboard and the next tick is
evaluated against the new periods, with no spurious signal fired on the change
itself.

### Buying and selling

- **Buy** spends `BUY_FRACTION` (98%) of the free quote balance at the current
  price, leaving a little dust behind.
- **Sell** liquidates the entire base position back into quote currency.
- Fees are charged in the currency received, at `FEE_RATE` (0.1%) per side.
- The average cost basis includes the acquisition fee, so the P&L on the
  dashboard is what you would actually have made.

Signals smaller than `MIN_ORDER_QUOTE` are skipped, and a sell with no open
position is ignored rather than erroring.

---

## Feeding it live data

### Option 1 — CoinGecko polling (default)

The bot polls CoinGecko every `POLL_MS` and derives BNB/USDT as
`BNB price in USD ÷ USDT price in USD`, since CoinGecko has no native BNB/USDT
market. It handles `429` responses by backing off and surfacing a
*rate limited* status on the dashboard.

### Option 2 — push prices in yourself

Any price pushed to `/api/tick` enters the exact same pipeline as a polled
price: it updates the averages, can trigger a crossover, and can place a fill.

```bash
curl -X POST http://localhost:3000/api/tick \
  -H "Content-Type: application/json" \
  -d '{"price": 731.42}'
```

That is the hook for your own websocket feed, another exchange, or a backtest
replay. The dashboard's **Push price** field calls the same endpoint.

```js
// Example: bridging your own websocket into the bot
socket.on('trade', (msg) => {
  fetch('http://localhost:3000/api/tick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ price: Number(msg.p) }),
  });
});
```

### Replaying history

Pass an optional `t` (epoch milliseconds) and the tick is stamped with that
time instead of "now" — the fill, the equity point and the chart all line up
with the original clock. That is what makes replaying a past session produce a
chart with a meaningful time axis.

```bash
curl -X POST http://localhost:3000/api/tick \
  -H "Content-Type: application/json" \
  -d '{"price": 731.42, "t": 1730000000000}'
```

---

## Dashboard

| Panel | What it shows |
| --- | --- |
| Price | Live price, 24 h change, and the last two readings |
| Chart | Price with both averages, the gap between them shaded, a position strip, and a marker on every fill |
| Signal | `LONG` / `FLAT`, why the bot decided what it decided, the fast−slow gap, and the trigger price |
| Averages | Current fast and slow values and their percentage difference |
| Position | Base held, average cost, market value, unrealised P&L |
| Account | Equity, free quote balance, total P&L, fees paid |
| Fills | Every simulated order with size, value, fee and realised P&L |
| Equity | Account value over the session with drawdown shading and trade marks |

Everything updates live over a WebSocket. The strategy controls, a manual
buy/sell, and the price injector all live in the right-hand rail.

### Reading the chart

- **The shaded gap between the two averages is the signal.** Teal means the
  recent average is above the longer one (long bias); oxide means it is below.
  The ribbon pinches to nothing exactly where a crossover happened.
- **`H` and `L` lines** mark the session high and low.
- **The `BUY above` / `SELL below` line** is the trigger: the price the next
  tick has to reach for the recent average to cross the longer one. If the
  market reaches it, the bot trades on that tick.
- **The strip along the bottom** shows when the bot actually held a position,
  which is not always the same as the bias in the ribbon.
- **Triangles** mark fills: up and teal for a buy, down and oxide for a sell.
- **Hovering** gives a crosshair with axis chips and a readout of the price,
  both averages, and the gap between them.

### The trigger level

The dashboard does not just say *whether* the bot would trade, it says where.
Both averages are linear in the next price, so the level at which they cross
can be solved for exactly:

```
fast_next = (sumFast + P) / k        slow_next = (sumSlow + P) / m
fast_next = slow_next  =>  P = (sumSlow*k - sumFast*m) / (m - k)
```

The same trick works for an exponential average, where the final EMA value is
`P * alpha + ema_prev * (1 - alpha)`.

So the trigger is not an estimate. Pushing a price of exactly the trigger
through `/api/tick` makes the two averages meet, and a hair above it the bot
buys. The signal panel shows the level and how far the market still has to
travel to reach it.

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Full bot state as JSON |
| `POST` | `/api/tick` | Push a price in — `{ "price": 731.42, "t": 1730000000000 }` |
| `POST` | `/api/settings` | Change periods, MA type, poll interval, fee, buy fraction |
| `POST` | `/api/trade` | Manual fill — `{ "side": "BUY" \| "SELL" }` |
| `POST` | `/api/poll` | Force an immediate CoinGecko poll |
| `POST` | `/api/reset` | Clear the paper account and the price history |
| `GET` | `/health` | Liveness probe |
| `WS` | `/ws` | Live state and trade broadcasts |

---

## Deployment

The bot runs as a plain long-running Node server, so it deploys unchanged to
anything that keeps a process alive: Railway, Render, Fly.io, or a VPS.
**Vercel is a poor fit** — its functions are stateless with an ephemeral disk,
its Hobby cron runs once per day, and WebSocket connections are pinned to one
instance, so the bot state cannot be broadcast to every connected dashboard.

### Railway

The repo contains a `Dockerfile` and a `.railway/railway.ts` authoring file, so
Railway builds the image and keeps its infrastructure in source control.

1. Push the project to GitHub and create a Railway project from the repo.
2. Railway builds the `Dockerfile` and serves on the port it assigns.
3. Add these variables under **Variables**:

   | Variable | Value |
   | --- | --- |
   | `COINGECKO_API_KEY` | your CoinGecko demo or pro key |
   | `COINGECKO_KEY_TYPE` | `demo` or `pro` |
   | `AUTH_USER` | a username for the dashboard |
   | `AUTH_PASSWORD` | a long password — **the dashboard is open without it** |
   | `DATA_DIR` | `/data` |

4. The volume is declared in `.railway/railway.ts` and mounted at `/data`.
   Without it the bot loses its history and positions on every redeploy.
5. Deploy. Railway gives you a `*.up.railway.app` URL; the browser will ask
   for the Basic credentials you set.

The `/health` route is used as the health check and deliberately stays
unauthenticated so Railway can reach it.

Variables are marked **unmanaged** in the IaC file on purpose — the CoinGecko
key and the dashboard password stay in Railway's variable store and are never
written into the repository.

#### Working with the IaC file

```bash
npm install            # installs the railway SDK used to evaluate the file
railway config plan    # preview what would change
railway config apply   # apply it
```

The `railway` package is a **dev** dependency; the container image installs
production dependencies only.

### Authentication

`AUTH_PASSWORD` turns on HTTP Basic auth for the dashboard, the REST API and
the WebSocket handshake. The browser prompts natively, and a successful login
also mints a signed session cookie — browsers are inconsistent about
replaying cached Basic credentials on a socket request, and cookies are
always sent, so the live connection stays reliable.

Health checks are exempt so the platform can still probe the service.

### Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Railway, Render and Fly all set this for you |
| `DATA_DIR` | `./data` | Point this at your volume mount |
| `LOG_DIR` | `./logs` | |
| `AUTH_USER` | `admin` | |
| `AUTH_PASSWORD` | *(empty)* | Empty means no login at all |
| `AUTH_SECRET` | *(derived)* | Fixed secret for the session cookie |

### Feed latency — measured, not assumed

The default feed is CoinGecko's Demo tier, which is **not** a real-time
market data source. Measured against Binance US and Coinbase with
`npm run measure-delay` (cross-correlation of the price-change series):

| Measure | Value |
| --- | --- |
| CoinGecko returns a genuinely new price | once every **60–80 s** |
| Lag behind the live market | **~130 s** (correlation 0.63 vs Coinbase) |
| Ticks that are byte-identical to the previous tick | **66%** at a 20 s poll |

Two consequences worth knowing:

1. Polling faster than the cache changes nothing — two polls out of three
   return the same number.
2. The averages are computed over *ticks*, so a "10-tick fast average" is
   really averaging three or four distinct prices, and a crossover fires up
   to a couple of minutes after the market actually crossed. That step-like
   behaviour is also what drives the whipsaws.

If you want real-time behaviour, point the bot at a live exchange feed
instead. The `POST /api/tick` hook already accepts any price source, so it
only needs a small bridge:

```js
// bridge.mjs - Binance public WebSocket, no API key required
const ws = new WebSocket('wss://stream.binance.com:9443/ws/bnbusdt@bookTicker');
ws.on('message', async (raw) => {
  const { a, b } = JSON.parse(raw);          // best ask, best bid
  const price = (Number(a) + Number(b)) / 2;
  await fetch('http://localhost:3000/api/tick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ price, t: Date.now() }),
  });
});
```

`@bookTicker` pushes on every price change rather than only on trades, which
suits this bot better than `@trade`.

---

## Configuration

All settings live in `.env` (see `.env.example`). Everything except the
credentials can also be changed live from the dashboard.

| Variable | Default | Notes |
| --- | --- | --- |
| `COINGECKO_API_KEY` | *(empty)* | Demo or Pro key |
| `COINGECKO_KEY_TYPE` | `demo` | `demo` or `pro` |
| `PAIR` | `BNB/USDT` | Display symbol |
| `BASE_ID` | `binancecoin` | CoinGecko id of the base asset |
| `QUOTE_ID` | `tether` | CoinGecko id of the quote asset |
| `SHORT_PERIOD` | `10` | Recent average, in ticks |
| `LONG_PERIOD` | `30` | Longer average, in ticks |
| `MA_TYPE` | `sma` | `sma` or `ema` |
| `POLL_MS` | `20000` | Poll interval |
| `MAX_HISTORY` | `2000` | Ticks retained in memory |
| `INITIAL_QUOTE` | `10000` | Starting paper balance |
| `FEE_RATE` | `0.001` | Fee per side |
| `BUY_FRACTION` | `0.98` | Share of free quote used per buy |
| `MIN_ORDER_QUOTE` | `10` | Skip signals below this size |
| `PORT` | `3000` | Dashboard port |

Trading a different pair only needs the ids changed, for example
`BASE_ID=ethereum`, `QUOTE_ID=tether`.

---

## Persistence

State is written to `data/state.json` — price history, balances, fills, equity
curve and settings. The bot restores that session on restart, so a crash does
not wipe your run. Writes are atomic, so an interrupted write cannot corrupt
the file.

Logs go to `logs/bot.log`.

---

## Tests

```bash
npm test
```

Covers the moving-average maths, the crossover detection (including the
"must not re-fire" case), the trigger price (that it really does predict the
next signal, for both SMA and EMA), fee handling, cost basis, realised P&L,
fill timestamps, and the account round-trip through JSON.

To fill the dashboard with a realistic series for a look around:

```bash
npm run seed                    # against localhost:3000
npm run seed -- http://host:port
```

---

## Layout

```
src/
  server.js      HTTP routes + WebSocket
  engine.js      feed → strategy → broker pipeline, state broadcast
  strategy.js    crossover detection
  indicators.js  SMA / EMA maths, trigger price
  broker.js      paper trading account, fees, P&L
  coingecko.js   CoinGecko client with key headers and backoff
  auth.js        HTTP Basic + signed session cookie
  store.js       atomic JSON persistence
  config.js      environment configuration
.railway/
  railway.ts     Railway infrastructure as code
public/
  index.html     dashboard markup
  css/app.css    styles
  js/chart.js    canvas price + equity charts
  js/app.js      client state, rendering, controls
test/            node:test suites
scripts/         demo data seeder
```

---

## Notes and limits

- This is a paper-trading teaching tool, not investment advice. A crossover
  strategy whipsaws in a sideways market and the fees add up.
- The averages are computed over **ticks**, not exchange candles. With a 20 s
  poll they approximate 1-minute candles.
- The public CoinGecko tier will rate-limit you if you poll faster than about
  3 s. The bot backs off automatically, but a key is the real fix.
- Nothing here places a real order. Adding live trading would mean a
  broker adapter, order-size risk limits, and API key handling — a deliberate
  second step.
