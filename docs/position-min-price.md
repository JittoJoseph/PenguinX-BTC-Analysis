# Minimum Price During Position

This is a reference for `min_price_during_position` in the `simulated_trades`
table. It gives a correctness pattern: take a live value at the correct instant,
then write an extreme value safely. The real-money execution system must use the
same pattern.

## Definition

> `min_price_during_position` is the lowest value of the same price metric that
> the stop-loss trigger uses. The engine measures it from the fill until the
> position closes.

In this engine that metric is the executable best bid. This is the price that a
market sell order hits. The value shows how far the position went below the
entry price. The value has a meaning only when it is the same quantity that the
stop-loss compares against.

There is one source of truth: `OpenPosition.minBid`. Its only input is the bid
that the stop-loss already uses. There is no second price calculation for this
metric, and nobody must add one.

## How it works

Two consumers read the same `bestBid` from the same book-update event. The
tracker runs first. Therefore the minimum can never miss a bid that the stop-loss
sees.

```ts
// onBookUpdate — one event, one value, two consumers
this.trackMinBid(tokenId, bestBid);
this.checkStopLoss(tokenId, bestBid);
```

| Step | Behaviour |
|---|---|
| Seed | `entryBid` is the best bid from the same book snapshot that the fill uses. The code takes it before any await. |
| Write the seed | The trade INSERT writes the seed to `min_price_during_position`. Therefore the column is never NULL. |
| Update | `trackMinBid` lowers `pos.minBid` in memory. Then it writes the value with a monotonic UPDATE. |
| Restart | `loadOpenPositions` reads `minBid` again from the column. |

`trackMinBid` has an in-memory guard, `bestBid >= pos.minBid → skip`. This guard
stops a database write on every tick for a position that the engine holds.
Correctness does not depend on this guard.

`trackMinBid` also stops at the window end, which is the same cutoff that
`checkStopLoss` uses. Both must use it. After the window closes the book is thin
and its quotes have no meaning. A tracker without this cutoff writes those
quotes, which gives records whose minimum is below the stop level on trades that
the stop could never have fired for.

### Monotonic write

The code does not await these writes, so the order of completion is not certain.
The UPDATE is therefore conditional. A higher value can never replace a lower
value, at any order of completion:

```sql
UPDATE simulated_trades
   SET min_price_during_position = $2
 WHERE id = $1
   AND (min_price_during_position IS NULL
        OR min_price_during_position > $2)
```

The column type is `decimal`, so this comparison is numeric. A test against real
records shows correct results for values such as `0.02` and `0.95`. A
comparison of strings cannot give this result.

## The two defects that this design replaces

Both defects are easy to add again, so this section stays.

**Defect 1. The code took the seed too late.** The initial value of `minBid` came
from a live `getBestBid()` call. That call was after three awaited database
operations: `deductCash`, `insertMarketIfNew`, and `createSimulatedTrade`. Near
the window end the bid of the favourite moves a large amount during those
operations. The seed was therefore a later and higher bid than the bid at the
fill.

The tracker writes only values below the seed. This gave records where
`recorded_min` is more than `entry_price`. A bid from the instant of the fill
cannot do this, because a bid is always below the ask that the engine paid.
**12 of 42** production trades had this fault. A further **7** records were
NULL, because the code never wrote the seed and the price only increased.

**Defect 2. Writes out of order can raise the minimum.** During a fast
decrease the code sends several UPDATE statements that it does not await. The
last statement to arrive wins. Therefore an earlier and higher value can
arrive after a lower value. One trade shows this: the entry was `0.71` and the
stop-loss exit was `0.27`. The trigger needs a bid of `0.61` or less. The record
kept `0.74`.

Neither defect changed the stop-loss. The stop-loss always read the correct live
bid. Only the recorded metric was wrong.

## Rules for the real execution system

| # | Rule |
|---|---|
| 1 | Write the same value that the stop-loss trigger or the exit trigger reads. Never calculate a second price for this metric. |
| 2 | Update the metric from the same event as the trigger, and before the trigger. Then no value is lost. |
| 3 | Take the seed at the instant of the fill, from the same book or quote that the fill uses. |
| 4 | Never take the seed after an await, a network call, or an order-confirmation message. |
| 5 | Write the seed together with the position record. Then the field is never NULL for an open position. |
| 6 | Write each extreme value with a monotonic conditional statement. Do not depend on the order of writes. Do not read the value and then write it. |
| 7 | Use the in-memory guard only to decrease the number of writes. Do not use it for correctness. |
| 8 | After a restart, read the extreme value from storage. Do not use the entry price again as the seed. |
| 9 | Stop tracking at the same instant the trigger stops. A quote that the trigger cannot act on must not enter the metric. |

### Other points for a real-money system

- Rule 3 is more difficult with a live venue. The fill price and the quote at
  the fill arrive from the venue at different times. Take the seed from the
  quote that arrives with the fill message. Do not make a new quote request
  after the order acknowledgement.
- Some systems track an extreme value that starts an action, for example a
  trailing stop. In that condition the in-memory value must be the source of
  truth. The database write must stay a side effect. Never read the value back
  to make a decision.
- The same pattern is correct for any other extreme value that is useful, for
  example the maximum favourable excursion or the worst mark-to-market. Use the
  same source as the decision, take the value at the instant of the decision,
  and write it with a monotonic statement.
