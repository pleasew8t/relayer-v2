import { expect, ethers, SignerWithAddress, createSpyLogger, winston, BigNumber, lastSpyLogIncludes } from "./utils";
import { toBN, toWei, randomAddress, spyLogIncludes } from "./utils";

import { InventoryConfig } from "../src/interfaces";
import { MockHubPoolClient, MockAdapterManager, MockTokenClient } from "./mocks/";
import { InventoryClient } from "../src/clients"; // Tested

const toMegaWei = (num: string | number | BigNumber) => ethers.utils.parseUnits(num.toString(), 6);

let hubPoolClient: MockHubPoolClient, adapterManager: MockAdapterManager, tokenClient: MockTokenClient;
let owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
let inventoryClient: InventoryClient; // tested

const enabledChainIds = [1, 10, 137, 42161];

const mainnetWeth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const mainnetUsdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// construct two mappings of chainId to token address. Set the l1 token address to the "real" token address.
let l2TokensForWeth = { 1: mainnetWeth };
let l2TokensForUsdc = { 1: mainnetUsdc };
enabledChainIds.slice(1).forEach((chainId) => {
  l2TokensForWeth[chainId] = randomAddress();
  l2TokensForUsdc[chainId] = randomAddress();
});

// Configure target percentages as 80% mainnet, 10% optimism, 5% polygon and 5% Arbitrum.
const inventoryConfig: InventoryConfig = {
  tokenConfig: {
    [mainnetWeth]: {
      10: { targetPct: toWei(0.12), thresholdPct: toWei(0.1) },
      137: { targetPct: toWei(0.07), thresholdPct: toWei(0.05) },
      42161: { targetPct: toWei(0.07), thresholdPct: toWei(0.05) },
    },

    [mainnetUsdc]: {
      10: { targetPct: toWei(0.12), thresholdPct: toWei(0.1) },
      137: { targetPct: toWei(0.07), thresholdPct: toWei(0.05) },
      42161: { targetPct: toWei(0.07), thresholdPct: toWei(0.05) },
    },
  },
  wrapEtherThreshold: toWei(1),
};

// Construct an initial distribution that keeps these values within the above thresholds.
const initialAllocation = {
  1: { [mainnetWeth]: toWei(100), [mainnetUsdc]: toMegaWei(10000) }, // seed 100 WETH and 10000 USDC on Mainnet
  10: { [mainnetWeth]: toWei(20), [mainnetUsdc]: toMegaWei(2000) }, // seed 20 WETH and 2000 USDC on Optimism
  137: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC on Polygon
  42161: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC on Arbitrum
};

const initialWethTotal = toWei(140); // Sum over all 4 chains is 140
const initialUsdcTotal = toMegaWei(14000); // Sum over all 4 chains is 14000
const initialTotals = { [mainnetWeth]: initialWethTotal, [mainnetUsdc]: initialUsdcTotal };

describe("InventoryClient: Rebalancing inventory", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());

    hubPoolClient = new MockHubPoolClient(null, null);
    adapterManager = new MockAdapterManager(null, null, null, null);
    tokenClient = new MockTokenClient(null, null, null, null);

    inventoryClient = new InventoryClient(
      spyLogger,
      inventoryConfig,
      tokenClient,
      enabledChainIds,
      hubPoolClient,
      adapterManager
    );

    seedMocks(initialAllocation);
  });

  it("Accessors work as expected", async function () {
    expect(inventoryClient.getEnabledChains()).to.deep.equal(enabledChainIds);
    expect(inventoryClient.getL1Tokens()).to.deep.equal(Object.keys(inventoryConfig.tokenConfig));
    expect(inventoryClient.getEnabledL2Chains()).to.deep.equal([10, 137, 42161]);

    expect(inventoryClient.getCumulativeBalance(mainnetWeth)).to.equal(initialWethTotal);
    expect(inventoryClient.getCumulativeBalance(mainnetUsdc)).to.equal(initialUsdcTotal);

    // Check the allocation matches to what is expected in the seed state of the mock. Check more complex matchers.
    const tokenDistribution = inventoryClient.getTokenDistributionPerL1Token();
    for (const chainId of enabledChainIds) {
      for (const l1Token of inventoryClient.getL1Tokens()) {
        expect(inventoryClient.getBalanceOnChainForL1Token(chainId, l1Token)).to.equal(
          initialAllocation[chainId][l1Token]
        );
        expect(inventoryClient.getOutstandingCrossChainTransferAmount(chainId, l1Token)).to.equal(toBN(0)); // For now no cross-chain transfers

        const expectedShare = initialAllocation[chainId][l1Token].mul(toWei(1)).div(initialTotals[l1Token]);
        expect(tokenDistribution[l1Token][chainId]).to.equal(expectedShare);
      }
    }
  });
  it("Correctly decides when to execute rebalances: allocation too low", async function () {
    // Test the case where the ratio on a given chain is two low and the bot needs to rebalance.
    // As each chain is at the expected amounts there should be no rebalance.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `No rebalances required`)).to.be.true;

    // Now, simulate the re-allocation of funds. Say that the USDC on arbitrum is half used up. This will leave arbitrum
    // with 500 USDC, giving a percentage of 500/14000 = 0.035. This is below the threshold of 0.5 so we should see
    // a re-balance executed in size of the target allocation + overshoot percentage.
    const initialBalance = initialAllocation[42161][mainnetUsdc];
    expect(tokenClient.getBalance(42161, l2TokensForUsdc[42161])).to.equal(initialBalance);
    const withdrawAmount = toMegaWei(500);
    tokenClient.decrementLocalBalance(42161, l2TokensForUsdc[42161], withdrawAmount);
    expect(tokenClient.getBalance(42161, l2TokensForUsdc[42161])).to.equal(withdrawAmount);

    // The allocation of this should now be below the threshold of 5% so the inventory client should instruct a rebalance.
    const expectedAlloc = withdrawAmount.mul(toWei(1)).div(initialUsdcTotal.sub(withdrawAmount));
    expect(inventoryClient.getCurrentAllocationPctConsideringShortfall(mainnetUsdc, 42161)).to.equal(expectedAlloc);

    // Execute rebalance. Check logs and enqueued transaction in Adapter manager. Given the total amount over all chains
    // and the amount still on arbitrum we would expect the module to instruct the relayer to send over:
    // (0.05 + 0.02) * (14000 - 500) - 500 = 445. Note the -500 component is there as arbitrum already has 500. our left
    // post previous relay.
    const expectedBridgedAmount = toMegaWei(445);
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `Executed Inventory rebalances`)).to.be.true;
    expect(lastSpyLogIncludes(spy, `Rebalances sent to Arbitrum`)).to.be.true;
    expect(lastSpyLogIncludes(spy, `445.00 USDC rebalanced`)).to.be.true; // cast to formatting expected by client.
    expect(lastSpyLogIncludes(spy, `This meets target allocation of 7.00%`)).to.be.true; // config from client.

    // The mock adapter manager should have been called with the expected transaction.
    expect(adapterManager.tokensSentCrossChain[42161][mainnetUsdc].amount).to.equal(expectedBridgedAmount);

    // Now, mock these funds having entered the canonical bridge.
    adapterManager.setMockedOutstandingCrossChainTransfers(42161, mainnetUsdc, expectedBridgedAmount);

    // Now that funds are "in the bridge" re-running the rebalance should not execute any transactions.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `No rebalances required`)).to.be.true;
    expect(spyLogIncludes(spy, -2, `"outstandingTransfers":"445.00"`)).to.be.true;

    // Now mock that funds have finished coming over the bridge and check behavior is as expected.
    adapterManager.setMockedOutstandingCrossChainTransfers(42161, mainnetUsdc, toBN(0)); // zero the transfer. mock conclusion.
    // Balance after the relay concludes should be initial - withdrawn + bridged as 1000-500+445=945
    const expectedPostRelayBalance = initialBalance.sub(withdrawAmount).add(expectedBridgedAmount);
    tokenClient.setTokenData(42161, l2TokensForUsdc[42161], expectedPostRelayBalance, toBN(0));

    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `No rebalances required`)).to.be.true;
    // We should see a log for chain 42161 that shows the actual balance after the relay concluded and the share.
    // actual balance should be listed above at 945. share should be 945/(13500) =0.7 (initial total - withdrawAmount).
    expect(spyLogIncludes(spy, -2, `"42161":{"actualBalanceOnChain":"945.00"`)).to.be.true;
    expect(spyLogIncludes(spy, -2, `"proRataShare":"7.00%"`)).to.be.true;
  });

  it("Correctly decides when to execute rebalances: token shortfall", async function () {
    // Test the case where the funds on a particular chain are too low to meet a relay (shortfall) and the bot rebalances.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();

    expect(tokenClient.getBalance(137, l2TokensForWeth[137])).to.equal(toWei(10)); // Starting balance.

    // Construct a token shortfall of 18. This means that the bot is short of 8 WETH on the chain 137 (it has 10). Recall
    // that a shortfall fully represents the required amount to fill a relay, ignoring the balance. I.e we need to send
    // a total of 8 WETH to fill the shortfall (have 10 need 18) and the shortfall covers the full amount of the relay.
    const shortfallAmount = toWei(18);
    tokenClient.setTokenShortFallData(137, l2TokensForWeth[137], [6969], shortfallAmount);
    await inventoryClient.update();

    // After updating the shortfall the allocation percent, considering the shortfall, should be: (10 - 18) / 140
    // = -0.057142857142857142. Note this equation means we are subtracting the balance to 0 (10-10) then simply taking
    // -1*shortfall/totalBalance. This makes sense as if you factor in the shortfall into the effective balance we have
    // a negative balance with "virtual" account of -8.
    const expectedAllocPct = toBN("-57142857142857142");
    expect(inventoryClient.getCurrentAllocationPctConsideringShortfall(mainnetWeth, 137)).to.equal(expectedAllocPct);

    // If we now consider how much should be sent over the bridge. The spoke pool, considering the shortfall, has an
    // allocation of -5.7%. The target is, however, 5% of the total supply. factoring in the overshoot parameter we
    // should see a transfer of 5 + 2 - (-5.7)=12.714% of total inventory. This should be an amount of 0.127*140=17.79.
    const expectedBridgedAmount = toBN("17799999999999999880");
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `Executed Inventory rebalances`)).to.be.true;
    expect(lastSpyLogIncludes(spy, `Rebalances sent to Polygon-matic`)).to.be.true;
    expect(lastSpyLogIncludes(spy, `17.79 WETH rebalanced`)).to.be.true; // expected bridge amount rounded for logs.
    expect(lastSpyLogIncludes(spy, `This meets target allocation of 7.00%`)).to.be.true; // config from client.

    //Note that there should be some additional state updates that we should check. In particular the token balance
    // on L1 should have been decremented by the amount sent over the bridge and the Inventory client should be tracking
    // the cross-chain transfers.
    expect(tokenClient.getBalance(1, mainnetWeth)).to.equal(toWei(100).sub(expectedBridgedAmount));
    expect(inventoryClient.getOutstandingCrossChainTransferAmount(137, mainnetWeth)).to.equal(expectedBridgedAmount);

    // // The mock adapter manager should have been called with the expected transaction.
    expect(adapterManager.tokensSentCrossChain[137][mainnetWeth].amount).to.equal(expectedBridgedAmount);

    // // Now, mock these funds having entered the canonical bridge.
    adapterManager.setMockedOutstandingCrossChainTransfers(137, mainnetWeth, expectedBridgedAmount);

    // Now that funds are "in the bridge" re-running the rebalance should not execute any transactions as the util should
    // consider the funds in transit as part of the balance and therefore should not send more.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `No rebalances required`)).to.be.true;
    expect(spyLogIncludes(spy, -2, `"outstandingTransfers":"17.79"`)).to.be.true;
    expect(spyLogIncludes(spy, -2, `"actualBalanceOnChain":"10.00"`)).to.be.true;
    expect(spyLogIncludes(spy, -2, `"virtualBalanceOnChain":"27.79"`)).to.be.true;

    // Now mock that funds have finished coming over the bridge and check behavior is as expected.
    adapterManager.setMockedOutstandingCrossChainTransfers(137, mainnetWeth, toBN(0)); // zero the transfer. mock conclusion.
    // Balance after the relay concludes should be initial + bridged amount as 10+17.9=27.9
    const expectedPostRelayBalance = toWei(10).add(expectedBridgedAmount);
    tokenClient.setTokenData(137, l2TokensForWeth[137], expectedPostRelayBalance, toBN(0));
    // The token shortfall should now no longer be an issue. This means we can fill the relay of 18 size now.
    tokenClient.setTokenShortFallData(137, l2TokensForWeth[137], [6969], toBN(0));
    tokenClient.decrementLocalBalance(137, l2TokensForWeth[137], shortfallAmount); // mock the relay actually filling.

    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `No rebalances required`)).to.be.true;
    // We should see a log for chain 42161 that shows the actual balance after the relay concluded and the share.
    // actual balance should be listed above at 945. share should be 945/(13500) =0.7 (initial total - withdrawAmount).
    // expect(spyLogIncludes(spy, -2, `"42161":{"actualBalanceOnChain":"945.00"`)).to.be.true;
    // expect(spyLogIncludes(spy, -2, `"proRataShare":"7.00%"`)).to.be.true;
  });
});

function seedMocks(seedBalances: { [chainId: string]: { [token: string]: BigNumber } }) {
  hubPoolClient.addL1Token({ address: mainnetWeth, decimals: 18, symbol: "WETH" });
  hubPoolClient.addL1Token({ address: mainnetUsdc, decimals: 6, symbol: "USDC" });
  enabledChainIds.forEach((chainId) => {
    adapterManager.setMockedOutstandingCrossChainTransfers(chainId, mainnetWeth, toBN(0));
    adapterManager.setMockedOutstandingCrossChainTransfers(chainId, mainnetUsdc, toBN(0));
    tokenClient.setTokenData(chainId, l2TokensForWeth[chainId], seedBalances[chainId][mainnetWeth], toBN(0));
    tokenClient.setTokenData(chainId, l2TokensForUsdc[chainId], seedBalances[chainId][mainnetUsdc], toBN(0));
  });

  hubPoolClient.setL1TokensToDestinationTokens({ [mainnetWeth]: l2TokensForWeth, [mainnetUsdc]: l2TokensForUsdc });
}
