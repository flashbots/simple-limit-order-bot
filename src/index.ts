import MevShareClient, { IPendingTransaction } from '@flashbots/mev-share-client'
import { Contract, JsonRpcProvider, Wallet } from 'ethers'
import { ERC20_ABI, UNISWAP_FACTORY_ABI, UNISWAP_V2_ABI } from './abi'

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545'
const EXECUTOR_KEY = process.env.EXECUTOR_KEY || Wallet.createRandom().privateKey
const FB_REPUTATION_PRIVATE_KEY = process.env.FB_REPUTATION_KEY || Wallet.createRandom().privateKey

const SELL_TOKEN_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const SELL_TOKEN_AMOUNT = 100000000n

const BUY_TOKEN_ADDRESS = '0x6b175474e89094c44da98b954eedeac495271d0f'
const BUY_TOKEN_AMOUNT_CUTOFF = SELL_TOKEN_AMOUNT * 1800n

const UNISWAP_V2_ADDRESS = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d'
const UNISWAP_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'

const DISCOUNT_IN_BPS = 40n
const TX_GAS_LIMIT = 400000
const BLOCKS_TO_TRY = 24

const MAX_GAS_PRICE = 40n
const MAX_PRIORITY_FEE = 0n

const GWEI = 10n ** 9n

const provider = new JsonRpcProvider(RPC_URL)

const executorWallet = new Wallet(EXECUTOR_KEY, provider)
const authSigner = new Wallet(FB_REPUTATION_PRIVATE_KEY, provider)

const uniswapRouterContract = new Contract(UNISWAP_V2_ADDRESS, UNISWAP_V2_ABI, executorWallet)
const uniswapFactoryContract = new Contract(UNISWAP_FACTORY_ADDRESS, UNISWAP_FACTORY_ABI, provider)

const mevShareClient = MevShareClient.useEthereumMainnet(authSigner)

async function getBuyTokenAmountWithExtra() {
    const resultCallResult = await uniswapRouterContract.swapExactTokensForTokens.staticCallResult(SELL_TOKEN_AMOUNT, 1n, [SELL_TOKEN_ADDRESS, BUY_TOKEN_ADDRESS], executorWallet.address, 9999999999n)
    const normalOutputAmount = resultCallResult[0][1]
    const extraOutputAmount = normalOutputAmount * (10000n + DISCOUNT_IN_BPS) / 10000n
    console.log(`Normally ${ SELL_TOKEN_AMOUNT.toString() } of ${ SELL_TOKEN_ADDRESS }
   normally gets you ${ normalOutputAmount.toString() } of ${ BUY_TOKEN_ADDRESS }
   let's try for ${ extraOutputAmount.toString() }`)
    return extraOutputAmount
}

async function getSignedBackrunTx( outputAmount: bigint, nonce: number ) {
    const backrunTx = await uniswapRouterContract.swapExactTokensForTokens.populateTransaction(SELL_TOKEN_AMOUNT, outputAmount, [SELL_TOKEN_ADDRESS, BUY_TOKEN_ADDRESS], executorWallet.address, 9999999999n)
    const backrunTxFull = {
        ...backrunTx,
        chainId: 1,
        maxFeePerGas: MAX_GAS_PRICE * GWEI,
        maxPriorityFeePerGas: MAX_PRIORITY_FEE * GWEI,
        gasLimit: TX_GAS_LIMIT,
        nonce: nonce
    }
    return executorWallet.signTransaction(backrunTxFull)
}

function bigintJsonEncoder ( key: any, value: any )  {
    return typeof value === 'bigint'
        ? value.toString()
        : value
}

async function backrunAttempt( currentBlockNumber: number, nonce: number, pendingTxHash: string ) {
    let extraOutputAmount = await getBuyTokenAmountWithExtra()
    if (extraOutputAmount < BUY_TOKEN_AMOUNT_CUTOFF) {
        console.log(`Even with extra amount, not enough BUY token: ${ extraOutputAmount.toString() }. Setting to amount cut-off`)
        extraOutputAmount = BUY_TOKEN_AMOUNT_CUTOFF
    }
    const backrunSignedTx = await getSignedBackrunTx(extraOutputAmount, nonce)
    try {
        const mevShareBundle = {
            inclusion: { block: currentBlockNumber + 1 },
            body: [
                { hash: pendingTxHash },
                { tx: backrunSignedTx, canRevert: false }
            ]
        }
        const sendBundleResult = await mevShareClient.sendBundle(mevShareBundle)
        console.log('Bundle Hash: ' + sendBundleResult.bundleHash)
        if (process.env.BUNDLE_SIMULATION !== undefined) {
            mevShareClient.simulateBundle(mevShareBundle).then(simResult => {
                console.log(`Simulation result for bundle hash: ${ sendBundleResult.bundleHash }`)
                console.log(JSON.stringify(simResult, bigintJsonEncoder))
            }).catch(error => {
                console.log(`Simulation error for bundle hash: ${ sendBundleResult.bundleHash }`)
                console.warn(error);
            })
        }
    } catch (e) {
        console.log('err', e)
    }
}

function transactionIsRelatedToPair( pendingTx: IPendingTransaction, PAIR_ADDRESS: string ) {
    return pendingTx.to === PAIR_ADDRESS ||
        ((pendingTx.logs || []).some(log => log.address === PAIR_ADDRESS))
}

async function approveTokenToRouter( tokenAddress: string, routerAddress: string ) {
    const tokenContract = new Contract(tokenAddress, ERC20_ABI, executorWallet)
    const allowance = await tokenContract.allowance(executorWallet.address, routerAddress)
    const balance = await tokenContract.balanceOf(executorWallet.address)
    if (balance == 0n) {
        console.error("No token balance for " + tokenAddress)
        process.exit(1)
    }
    if (allowance >= balance) {
        console.log("Token already approved")
        return
    }
    await tokenContract.approve(routerAddress, 2n**256n - 1n)
}

async function main() {
    console.log('mev-share auth address: ' + authSigner.address)
    console.log('executor address: ' + executorWallet.address)
    const PAIR_ADDRESS = (await uniswapFactoryContract.getPair(SELL_TOKEN_ADDRESS, BUY_TOKEN_ADDRESS)).toLowerCase()

    await approveTokenToRouter(SELL_TOKEN_ADDRESS, UNISWAP_V2_ADDRESS)
    const nonce = await executorWallet.getNonce('latest')
    let recentPendingTxHashes: Array<{ txHash: string, blockNumber: number }> = []

    mevShareClient.on('transaction', async ( pendingTx: IPendingTransaction ) => {
        if (!transactionIsRelatedToPair(pendingTx, PAIR_ADDRESS)) {
            console.log('skipping tx: ' + pendingTx.hash)
            return
        }
        console.log(`It's a match: ${ pendingTx.hash }`)
        const currentBlockNumber = await provider.getBlockNumber()
        backrunAttempt(currentBlockNumber, nonce, pendingTx.hash)
        recentPendingTxHashes.push({ txHash: pendingTx.hash, blockNumber: currentBlockNumber })
    })
    provider.on('block', ( blockNumber ) => {
        for (const recentPendingTxHash of recentPendingTxHashes) {
            console.log(recentPendingTxHash)
            backrunAttempt(blockNumber, nonce, recentPendingTxHash.txHash)
        }
        // Cleanup old pendingTxHashes
        recentPendingTxHashes = recentPendingTxHashes.filter(( recentPendingTxHash ) =>
            blockNumber > recentPendingTxHash.blockNumber + BLOCKS_TO_TRY)
    })
}

main()