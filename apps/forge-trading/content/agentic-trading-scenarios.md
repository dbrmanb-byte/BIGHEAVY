# Agentic Trading — Scenario Bank (90 scenarios, Draft 1)

**Format:** stem → four options → answer → rationale. Sections map to the term-bank sections and literacy modules. All scenarios assume a paper account. Educational content only; nothing here is a recommendation.

---

## A. Market structure and orders (10)

**A1.** A stock shows bid 41.20 / ask 41.28. You place a market order to buy 100 shares during regular hours. What is your most likely fill?
A. 41.20 B. 41.24 C. 41.28 D. The prior close
**Answer: C.** Market buys take the ask; market sells take the bid. The 8-cent spread is your cost.

**A2.** You place a limit buy at 41.00 while the ask is 41.28. Price drifts to 41.05 and then rallies to 44. What happened to your order?
A. Filled at 41.05 B. Filled at 41.28 C. Never filled D. Converted to a market order
**Answer: C.** A limit order only fills at its price or better. Price never reached 41.00.

**A3.** You own shares bought at 50 and place a stop order at 46. Overnight, bad news gaps the stock open at 40. Where does your stop fill?
A. 46 B. Approximately 40 C. It does not fill D. 43, the midpoint
**Answer: B.** A stop becomes a market order once 46 trades; the first trade is near 40, so that's where it executes.

**A4.** Same setup as A3, but you used a stop-limit with stop 46 and limit 45.50. What happens on the gap to 40?
A. Fills near 40 B. Fills at 45.50 C. Does not fill; you still hold D. Fills at 46
**Answer: C.** The stop triggers a limit at 45.50, but price is below that, so nothing executes. Stop-limits protect price, not exit.

**A5.** You submit a limit order at 3:58 p.m. with time in force "day." It's unfilled at the close. What is its status at 9:30 a.m. the next day?
A. Still open B. Canceled C. Converted to GTC D. Filled at the open
**Answer: B.** Day orders expire at session close.

**A6.** A thinly traded stock averages 30,000 shares a day. Your agent proposes a market order for 5,000 shares. What is the main risk?
A. Regulatory violation B. Slippage and moving the price C. Order rejection D. Wash sale
**Answer: B.** You are 17% of daily volume; the order will walk up the book. Use limits and scale in.

**A7.** You sold shares on Monday. When can you withdraw the cash?
A. Monday B. Tuesday C. Wednesday D. Friday
**Answer: B.** U.S. equity settlement is T+1.

**A8.** Your agent places a limit order for 500 shares; the fill report shows 300. What should the next step be?
A. Place another 500-share order B. Recognize a partial fill and decide whether to keep the remaining 200 working C. Cancel and re-enter at market D. Log it as complete
**Answer: B.** The remaining 200 are still resting. Duplicating the order overbuys.

**A9.** A trailing stop of 5% is set on a position bought at 100. Price rises to 120, then falls. Where does the stop trigger?
A. 95 B. 100 C. 114 D. 105
**Answer: C.** The stop ratchets up to 5% below the peak (120 × 0.95).

**A10.** At 7:15 a.m. your agent flags a pre-market gap and proposes a market buy. Why should the guardrail reject it?
A. Pre-market is illegal for retail B. Most platforms allow only limit orders in extended hours, and spreads are wide C. Market orders are always rejected D. The stop rule doesn't apply pre-market
**Answer: B.** Extended-hours liquidity is thin; a market order there is a slippage trap and usually not permitted anyway.

---

## B. Technical indicators (12)

**B1.** A 14-period RSI reads 26. What does this tell you on its own?
A. The stock will rise B. Momentum has been strongly negative recently C. The stock is undervalued D. Buy immediately
**Answer: B.** RSI measures recent momentum, not value or direction of the next move.

**B2.** Price has been making higher highs for three weeks while RSI makes lower highs. Name the pattern.
A. Golden cross B. Bearish divergence C. Breakout D. Mean reversion
**Answer: B.** Price and indicator disagree; momentum is weakening under the rally.

**B3.** The 50-day SMA crosses above the 200-day SMA. Which is true?
A. Guaranteed uptrend B. Called a golden cross; a lagging trend signal C. A sell signal D. A volatility signal
**Answer: B.** Moving-average crosses confirm trends late; they don't predict.

**B4.** MACD line crosses above its signal line while the histogram flips positive. What is this generally read as?
A. Bearish B. Neutral C. Bullish momentum shift D. Overbought
**Answer: C.** The faster EMA is pulling ahead of the slower one.

**B5.** Bollinger Bands have narrowed to their tightest width in six months. What does that suggest?
A. Low volatility, often preceding an expansion B. An uptrend C. A downtrend D. Overbought
**Answer: A.** Band width measures volatility, not direction.

**B6.** ATR is 2.40 on a 60-dollar stock. Your rule sets stops at 2× ATR. Where is the initial stop for a long entry at 60?
A. 57.60 B. 55.20 C. 58.80 D. 50.40
**Answer: B.** 60 − (2 × 2.40).

**B7.** Price breaks above a resistance level that held four times, on volume 40% below average. How confident should the rule be?
A. High; resistance broke B. Low; breakouts without volume often fail C. Irrelevant; volume doesn't matter D. High; four tests means strong level
**Answer: B.** Volume is the confirmation for a breakout.

**B8.** Your agent uses a 5-period RSI instead of 14. What changes?
A. Nothing B. More signals, more noise C. Fewer signals D. RSI becomes a trend indicator
**Answer: B.** Shorter lookbacks react faster and whipsaw more.

**B9.** Price is trading well below VWAP all session. What does that describe?
A. Sellers have dominated intraday B. Buyers have dominated C. Low volatility D. A gap up
**Answer: A.** Average trade has printed above current price.

**B10.** A mean-reversion rule and a momentum rule both fire on the same stock, in opposite directions. What is the correct response?
A. Take both B. Take the momentum trade C. Take the mean-reversion trade D. Neither; the rules conflict, and the agent should log and skip
**Answer: D.** Conflicting signals are information; a supervised agent flags them rather than picking one arbitrarily.

**B11.** RSI has stayed above 70 for three weeks during a strong uptrend. What does that show?
A. RSI is broken B. Strong trends can pin oscillators at extremes C. A reversal is imminent D. The stock is overvalued
**Answer: B.** "Overbought" is a description, not a trigger.

**B12.** Your rule says "RSI below 30." The stock's RSI hits 30.4 at the close and 29.8 in after-hours. Should the rule fire?
A. Yes, after-hours counts B. Depends on how the rule defines the bar — the spec must say C. No, never D. Yes, round down
**Answer: B.** Ambiguous rules produce ambiguous agents. Define the session and bar type in the rule.

---

## C. Fundamentals and valuation (8)

**C1.** A company has 200 million shares at 45 dollars. Its market cap is:
A. 4.5 billion B. 9 billion C. 900 million D. 45 billion
**Answer: B.** 200M × 45.

**C2.** Trailing EPS is 3.00 and the stock trades at 60. Trailing P/E is:
A. 20 B. 30 C. 0.05 D. 180
**Answer: A.** 60 ÷ 3.

**C3.** Two companies both trade at 25× earnings. One grows earnings 5% a year, the other 25%. Which has the lower PEG?
A. The 5% grower B. The 25% grower C. Equal D. Cannot tell
**Answer: B.** PEG = P/E ÷ growth: 5 vs. 1.

**C4.** Earnings beat estimates but the stock falls 12%. Most likely cause?
A. Market manipulation B. Weak forward guidance C. A wash sale D. Ex-dividend
**Answer: B.** The market trades on the future; guidance beats the print.

**C5.** A stock declares a 1-dollar dividend with ex-date Thursday. You buy Thursday morning. Do you receive it?
A. Yes B. No C. Half D. Only if held 60 days
**Answer: B.** Buyers on or after the ex-date do not receive the declared dividend.

**C6.** A Form 4 shows the CFO bought 50,000 shares on the open market. What is that?
A. Insider trading B. A legal, disclosed insider purchase C. A buyback D. A dividend reinvestment
**Answer: B.** Insiders may trade with disclosure and outside blackout windows.

**C7.** Operating cash flow is 800M; capex is 300M. Free cash flow is:
A. 1.1B B. 500M C. 300M D. 800M
**Answer: B.** OCF − capex.

**C8.** Your agent pulls an EPS figure from its own memory instead of a filing or data API. Why is this a problem?
A. It isn't B. The number may be hallucinated; every fact must come from a tool result C. EPS isn't important D. Memory is more current
**Answer: B.** Model recall is not a data source.

---

## D. Risk and position management (15)

**D1.** Account is 20,000. Risk per trade is 1%. Entry 50, stop 47. Position size?
A. 400 shares B. 200 shares C. 66 shares D. 67 shares
**Answer: C.** Risk 200 dollars ÷ 3 dollars stop distance = 66.7; round down.

**D2.** Same account, same risk. Entry 50, stop 49.50. Position size?
A. 400 B. 200 C. 40 D. 4,000
**Answer: A.** 200 ÷ 0.50. Tighter stops mean bigger size — and more whipsaw.

**D3.** A rule wins 40% of the time. Average win 300, average loss 100. Expectancy per trade?
A. −20 B. +60 C. +120 D. +200
**Answer: B.** (0.4 × 300) − (0.6 × 100).

**D4.** A rule wins 80% of the time. Average win 50, average loss 300. Expectancy?
A. +40 B. −20 C. +250 D. 0
**Answer: B.** (0.8 × 50) − (0.2 × 300). High win rate, losing rule.

**D5.** Account peaks at 25,000, falls to 20,000, recovers to 23,000. Max drawdown?
A. 8% B. 12% C. 20% D. 25%
**Answer: C.** 5,000 ÷ 25,000.

**D6.** You need what percent gain to recover from a 50% drawdown?
A. 50% B. 75% C. 100% D. 150%
**Answer: C.** Losses compound against you.

**D7.** Your agent holds five positions in five semiconductor stocks, each sized at 1% risk. Effective risk is closer to:
A. 1% B. 5% concentrated in one theme C. 0.2% D. Zero
**Answer: B.** Correlated positions are one big position.

**D8.** A cash account of 8,000 makes four day trades in a week. What happens?
A. Nothing; PDT applies to margin accounts B. Flagged as PDT C. Account frozen D. Fined
**Answer: A.** The PDT rule applies to margin accounts; cash accounts face settled-funds limits instead.

**D9.** A margin account with 20,000 equity makes four day trades in five business days. Result?
A. Nothing B. Flagged as pattern day trader; restricted until equity reaches 25,000 C. Account closed D. Converted to cash account
**Answer: B.** The 25,000 minimum is the PDT threshold.

**D10.** Position is up 15%. Your plan said take half at 10% and trail the rest. What is the correct action?
A. Hold everything B. Sell everything C. Follow the plan: scale out half, trail the remainder D. Add to the position
**Answer: C.** Plans exist to remove in-the-moment decisions.

**D11.** A trade thesis was "breakout above 80 on volume." Price broke 80 on low volume and reversed. The trade lost. What goes in the post-mortem?
A. Bad luck B. The rule was followed C. The volume condition was not met; entry violated the thesis D. Nothing
**Answer: C.** The post-mortem checks execution against the thesis, not outcome.

**D12.** A trade followed every rule and lost. What goes in the journal?
A. Change the rule B. Good process, bad outcome; no change from one trade C. Stop trading D. Double size next time
**Answer: B.** Rules are judged over samples, not single trades.

**D13.** Kelly says bet 20% of the account. Practitioners typically use:
A. Full Kelly B. A fraction, often a quarter to half C. Double Kelly D. Nothing
**Answer: B.** Full Kelly assumes perfect estimates and tolerates severe drawdowns.

**D14.** Your buying power reads 40,000 on 20,000 cash. What is that?
A. A bug B. 2:1 margin C. Free money D. Settled cash
**Answer: B.** Standard Reg T margin.

**D15.** Equity falls below maintenance and the broker issues a margin call. What are your options?
A. Ignore it B. Deposit cash or close positions; the broker may liquidate for you C. Wait for a rebound D. File a complaint
**Answer: B.** Margin calls are not optional.

---

## E. Tax and accounting (8)

**E1.** You bought 100 shares at 40 and 100 at 60. You sell 100 at 55 using FIFO. Taxable gain?
A. +1,500 B. −500 C. +500 D. 0
**Answer: A.** FIFO closes the 40-dollar lot: (55 − 40) × 100.

**E2.** Same lots, but you select the 60-dollar lot specifically. Result?
A. +1,500 gain B. −500 loss C. +500 gain D. Not allowed
**Answer: B.** Specific-ID lets you choose; (55 − 60) × 100.

**E3.** You sell at a loss on March 1 and buy the same stock on March 20. What happens to the loss?
A. Deducted normally B. Disallowed now and added to the new lot's basis (wash sale) C. Doubled D. Lost forever
**Answer: B.** 30-day window before and after.

**E4.** Shares bought June 10, 2025 and sold June 10, 2026. Holding period?
A. Long-term B. Short-term C. Exactly one year counts as long-term D. Depends on state
**Answer: B.** Long-term requires more than one year; sell June 11 or later.

**E5.** Net capital losses for the year are 9,000. What happens on the federal return?
A. All deducted B. 3,000 deducted against ordinary income; 6,000 carried forward C. None deducted D. Deducted against dividends only
**Answer: B.** Standard annual limit and carryforward.

**E6.** Your agent's journal records fills but not cost basis or lot dates. What does that break?
A. Nothing B. Tax reporting and lot selection C. RSI D. Order routing
**Answer: B.** Basis and dates are the tax record.

**E7.** A dividend on shares held 15 days around the ex-date is:
A. Qualified B. Non-qualified; taxed as ordinary income C. Tax-free D. A return of capital
**Answer: B.** Qualified status requires a 61-day holding window.

**E8.** A part-time trader with 40 trades a year wants trader tax status. Likelihood?
A. Automatic B. Low; TTS requires substantial, frequent, continuous activity C. Guaranteed with an LLC D. Only for crypto
**Answer: B.** Few retail traders qualify.

---

## F. Regulation and compliance (12)

**F1.** Your site publishes a weekly "what our agent flagged" newsletter to all subscribers with the same content. Is this investment advice requiring registration?
A. Yes B. Generally no; impersonal, general circulation fits the publisher's exclusion C. Only if free D. Only if profitable
**Answer: B.** Impersonal and regular is the key.

**F2.** A subscriber emails: "I have 30k and I'm 55 — should I buy CHRW?" You reply "yes, 20% of your account." What did you just do?
A. Customer service B. Gave individualized advice; RIA territory C. Marketing D. Nothing regulated
**Answer: B.** Tailoring to a person's situation triggers registration.

**F3.** You offer to run your agent on a subscriber's Robinhood account for 20% of profits. What's the issue?
A. None B. Managing others' accounts for compensation requires RIA registration; performance fees have their own limits C. Robinhood forbids it only D. Tax only
**Answer: B.** Discretionary management is the clearest RIA trigger.

**F4.** Your landing page says "Our agent returned 34% last quarter." What should compliance flag?
A. Nothing B. Performance claim: needs substantiation, disclosures, and invites scrutiny; better to show process C. Font size D. Only if untrue
**Answer: B.** Advertising rules and plain risk.

**F5.** A subscriber posts screenshots of paper-trade results and calls them real. Your responsibility?
A. None B. Correct the record; your platform labels paper results clearly C. Ban them D. Report to SEC
**Answer: B.** Mislabeled simulated results are a misrepresentation risk for you.

**F6.** A friend at a company tells you earnings will miss; you sell before the announcement. This is:
A. Smart B. Insider trading C. Legal if under 10k D. Legal in a paper account only
**Answer: B.** Material non-public information, regardless of source.

**F7.** Placing and canceling large orders to move price without intending to fill is:
A. Hedging B. Spoofing — illegal manipulation C. Scaling D. Market making
**Answer: B.**

**F8.** Which body registers and examines broker-dealers?
A. SEC only B. FINRA, under SEC oversight C. IRS D. SIPC
**Answer: B.**

**F9.** A brokerage fails. SIPC covers:
A. Market losses B. Missing securities and cash up to limits C. Bad advice D. Nothing
**Answer: B.**

**F10.** Your app lets users write rules and run them on their own paper account. No recommendations are made. Which is the safest description of the product?
A. Advisory service B. Educational software and tooling C. Broker D. Fund
**Answer: B.** Keep the language matching the function.

**F11.** A credit-union prospect asks whether the Agent OS trading module can execute on member accounts. Correct answer?
A. Yes B. It can supervise and log; execution on customer accounts is a regulated activity the institution must own C. Only with a disclaimer D. Yes, for a fee
**Answer: B.** The institution is the registered party.

**F12.** Which disclaimer element is mandatory on every screen?
A. Past performance figures B. Plain statement that content is educational, not advice, and that trading involves risk C. Company address D. Logo
**Answer: B.**

---

## G. Agent and automation (25)

**G1.** An agent that fetches quotes, evaluates a rule, and sends an alert is:
A. An autotrader B. An observer-only agent; the lowest-risk design C. An RIA D. A broker
**Answer: B.**

**G2.** The agent reports "CHRW filled at 92.10." No fill exists in the broker. What happened?
A. Latency B. Hallucination; the agent stated a result without a tool result C. Broker error D. Correct
**Answer: B.** Every fact must trace to a tool call.

**G3.** Which check belongs outside the model, in code?
A. Reasoning about the trend B. Max position size C. Summarizing the news D. Writing the journal entry
**Answer: B.** Guardrails must not depend on the model obeying its prompt.

**G4.** The system prompt says "never place market orders." Is that a guardrail?
A. Yes B. No; it's an instruction the model could ignore, and must be enforced in the validation layer too C. Yes, if in caps D. Only for GPT models
**Answer: B.** Prompts are soft; code is hard.

**G5.** The agent proposes a trade in JSON with symbol, action, size, reasoning, and invalidation. The invalidation field is empty. Correct response?
A. Execute B. Reject; a proposal without an invalidation condition is incomplete C. Fill it in yourself D. Ask the model to guess
**Answer: B.** Invalidation forces a falsifiable thesis.

**G6.** Your scheduler fires the loop every minute during market hours. The rule uses daily bars. What is the problem?
A. None B. Wasted calls and repeated alerts on the same daily signal C. Rate limits only D. Wrong indicator
**Answer: B.** Match cadence to bar timeframe.

**G7.** The execution step crashed after submitting an order but before logging it. On restart, the agent resubmits. What was missing?
A. Retry logic B. Idempotency via client order ID and a duplicate check C. A faster server D. A bigger model
**Answer: B.**

**G8.** Which should the agent call before proposing any order?
A. place_order B. preview/review order C. cancel_order D. get_watchlists
**Answer: B.** Dry run shows cost, fees, and buying-power impact.

**G9.** The approval gate sends a Slack message. A subscriber's teenager taps "approve." What's the design flaw?
A. None B. Approval must be authenticated, not just clickable C. Slack is wrong tool D. Should be email
**Answer: B.**

**G10.** The agent's reasoning says "RSI is 28, strong buy." RSI from the tool result is 41. Diagnosis?
A. Tool bug B. The model reasoned from stale or invented data; reject and log C. Both right D. Rounding
**Answer: B.** Compare reasoning against the actual tool output.

**G11.** You backtest a rule and it returns 60% a year over five years after tuning eight parameters. What should you suspect?
A. Genius B. Overfitting C. Low volatility D. Data error only
**Answer: B.** Many parameters, one dataset.

**G12.** Best practice for backtesting a rule?
A. Tune on all data B. Tune on one period, test on a later unseen period C. Skip it D. Tune per ticker
**Answer: B.** Out-of-sample testing.

**G13.** The kill switch halts the loop but leaves open limit orders resting. Complete?
A. Yes B. No; kill must also cancel open orders C. Yes, limits are safe D. Only for market orders
**Answer: B.**

**G14.** Audit log entries can be edited by the agent. Problem?
A. None B. Logs must be append-only; a mutable log isn't an audit trail C. Storage only D. Speed
**Answer: B.**

**G15.** Which is the correct order of steps in the loop?
A. Act → observe → reason B. Observe → reason → propose → approve → act → log C. Propose → act → observe D. Log → act
**Answer: B.**

**G16.** The agent is given the broker's full tool set including place_order, but the spec says observer-only. Fix?
A. Trust the prompt B. Expose only the read tools; capability should match the spec C. Add a warning D. Lower temperature
**Answer: B.** Least privilege.

**G17.** A rule file says: `flag when RSI < 35`. What's missing for it to be executable?
A. Nothing B. Symbol universe, bar timeframe, session, and RSI period C. A model name D. A stop
**Answer: B.**

**G18.** Two agents — proposer and compliance checker — disagree. Who wins?
A. Proposer B. Compliance checker; it exists to veto C. Coin flip D. Larger model
**Answer: B.**

**G19.** The model returns prose instead of the JSON schema. Correct handling?
A. Parse with regex B. Reject, retry with schema enforcement, log the failure C. Execute anyway D. Ignore
**Answer: B.**

**G20.** The agent's weekly review shows three alerts fired correctly, one fired on a bad-data bar (a zero-volume print). Action?
A. Ignore B. Add a data-quality guard (minimum volume, sanity bounds) C. Change the RSI period D. Stop the agent
**Answer: B.** Fix the cause, not the symptom.

**G21.** Rate limit hit mid-loop; quotes are missing for two symbols. The agent proposes trades on all five. Flaw?
A. None B. Proposals on symbols with no fresh data must be blocked C. Retry later only D. Reduce symbols
**Answer: B.**

**G22.** Which belongs in the system prompt?
A. API keys B. Role, allowed actions, forbidden actions, output schema C. Today's prices D. Account balance
**Answer: B.** Secrets never go in prompts; live data comes from tools.

**G23.** A subscriber's agent has run 300 paper round trips with positive expectancy. What can you claim on the site?
A. "Proven 300-trade system" B. Nothing performance-related; you can teach the method C. "Guaranteed" D. "SEC approved"
**Answer: B.**

**G24.** The agent suggests adding a news-sentiment tool. What's the first guardrail question?
A. Cost B. Can the source be logged and verified, and can the model be forced to cite it rather than paraphrase from memory? C. Speed D. Language
**Answer: B.**

**G25.** Capstone: what is the minimum artifact set to prove a supervised round trip?
A. A screenshot B. Rule file, audit log with trigger and approval, broker fill records, journal entry, post-mortem C. A P&L number D. A video
**Answer: B.**

---

*Educational content only. Not investment advice. All exercises use simulated accounts. BIGHEAVYINK is not a broker-dealer or investment adviser.*
