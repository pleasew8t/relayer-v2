import { BigNumber, toBNWei, assert, toBN, replaceAddressCase } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import { InventoryConfig } from "../interfaces";

export class RelayerConfig extends CommonConfig {
  readonly inventoryConfig: InventoryConfig;
  readonly relayerDiscount: BigNumber;
  readonly sendingRelaysEnabled: boolean;
  readonly sendingSlowRelaysEnabled: boolean;
  readonly relayerTokens: string[];
  readonly relayerDestinationChains: number[];
  readonly minRelayerFeePct: BigNumber;

  constructor(env: ProcessEnv) {
    const {
      RELAYER_DESTINATION_CHAINS,
      RELAYER_DISCOUNT,
      RELAYER_INVENTORY_CONFIG,
      RELAYER_TOKENS,
      SEND_RELAYS,
      SEND_SLOW_RELAYS,
      MIN_RELAYER_FEE_PCT,
    } = env;
    super(env);

    // Empty means all chains.
    this.relayerDestinationChains = RELAYER_DESTINATION_CHAINS ? JSON.parse(RELAYER_DESTINATION_CHAINS) : [];
    // Empty means all tokens.
    this.relayerTokens = RELAYER_TOKENS ? JSON.parse(RELAYER_TOKENS) : [];
    this.inventoryConfig = RELAYER_INVENTORY_CONFIG ? JSON.parse(RELAYER_INVENTORY_CONFIG) : {};
    this.minRelayerFeePct = MIN_RELAYER_FEE_PCT ? toBNWei(MIN_RELAYER_FEE_PCT) : toBN(0);

    if (Object.keys(this.inventoryConfig).length > 0) {
      this.inventoryConfig = replaceAddressCase(this.inventoryConfig); // Cast any non-address case addresses.
      this.inventoryConfig.wrapEtherThreshold = this.inventoryConfig.wrapEtherThreshold
        ? toBNWei(this.inventoryConfig.wrapEtherThreshold)
        : toBNWei(1); // default to keeping 2 Eth on the target chains and wrapping the rest to WETH.

      Object.keys(this.inventoryConfig.tokenConfig).forEach((l1Token) => {
        Object.keys(this.inventoryConfig.tokenConfig[l1Token]).forEach((chainId) => {
          const { targetPct, thresholdPct, unwrapWethThreshold, unwrapWethTarget } =
            this.inventoryConfig.tokenConfig[l1Token][chainId];
          assert(
            targetPct !== undefined && thresholdPct !== undefined,
            `Bad config. Must specify targetPct, thresholdPct for ${l1Token} on ${chainId}`
          );
          assert(
            toBN(thresholdPct).lte(toBN(targetPct)),
            `Bad config. thresholdPct<=targetPct for ${l1Token} on ${chainId}`
          );
          this.inventoryConfig.tokenConfig[l1Token][chainId].targetPct = toBNWei(targetPct).div(100);
          this.inventoryConfig.tokenConfig[l1Token][chainId].thresholdPct = toBNWei(thresholdPct).div(100);
          if (unwrapWethThreshold !== undefined)
            this.inventoryConfig.tokenConfig[l1Token][chainId].unwrapWethThreshold = toBNWei(unwrapWethThreshold);
          this.inventoryConfig.tokenConfig[l1Token][chainId].unwrapWethTarget = unwrapWethTarget
            ? toBNWei(unwrapWethTarget)
            : toBNWei(2);
        });
      });
    }
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
    this.sendingSlowRelaysEnabled = SEND_SLOW_RELAYS === "true";
  }
}
