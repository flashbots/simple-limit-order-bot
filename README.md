# Simple Limit Order Bot

Client library for a limit order bot that uses `[MEV-share](https://docs.flashbots.net/flashbots-mev-share/overview)`.

## limit orders

Limit orders are a common feature on exchanges which let you fill an order when the price of a trading pair (e.g. ETH/DAI) reaches a target that you specify. For example, if I wanted to buy DAI when the price reaches 1800 DAI/ETH, I could place a limit order for to buy 1800 DAI for 1 ETH, and the trade would automatically execute when the price reached 1800. If the price was over 1800, then we’d want to fill our order at the higher price — since we’re buying DAI, we want more DAI out for a fixed amount of ETH in.

## MEV-Share bot

This bot watches the MEV-Share event stream for pending transactions that change the price of a desired trading pair. Then it backruns each of those transactions with our ideal trade. When a transaction sufficiently shifts the price in our favor, our backrun will be first in line to buy the tokens at a discounted rate.

Our backrun transaction will specify an exact price at which the order can be filled, otherwise the transaction reverts. Because we’re sending to Flashbots, reverted transactions won’t land on chain and we won’t pay any fees for failed attempts.

## quickstart

Install from npm:

```sh
yarn add @flashbots/mev-share-buyer
# or
npm i @flashbots/mev-share-buyer
```

## guide

You can find a longer guide for how to use this bot, and MEV-Share, on the [Flashbots docs](https://docs.flashbots.net/flashbots-mev-share/searchers/tutorials/limit-order/introduction).

## Environment variables

- BUNDLE_SIMULATION - set to `1` to add simulation to every bundle submission (must wait until user transaction lands on-chain)
- RPC_URL = Ethereum JSONRPC endpoint 
- EXECUTOR_KEY = Private key of Ethereum account containing the asset you wish to sell on Uniswap V2
- FB_REPUTATION_PRIVATE_KEY - Private key used for Flashbots submission reputation. Recommend using a brand new private key with no funds
