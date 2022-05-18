import { differenceInWeeks } from 'date-fns';

import { isStable } from '@/composables/usePool';
import { oneSecondInMs } from '@/composables/useTime';
import { FiatCurrency } from '@/constants/currency';
import { bnum, isSameAddress } from '@/lib/utils';
import { LinearPool, Pool, PoolAPRs, PoolToken } from '@/services/pool/types';

import { balancerSubgraphService } from '../balancer/subgraph/balancer-subgraph.service';
import { TokenPrices } from '../coingecko/api/price.service';
import { GaugeBalApr } from '../staking/staking-rewards.service';
import { AprConcern } from './concerns/apr/apr.concern';
import LiquidityConcern from './concerns/liquidity.concern';

export default class PoolService {
  constructor(
    public pool: Pool,
    public liquidity = LiquidityConcern,
    public apr = AprConcern
  ) {
    this.format();
  }

  /**
   * @summary Statically format various pool attributes.
   */
  public format(): Pool {
    this.pool.isNew = this.isNew;
    this.formatPoolTokens();
    return this.pool;
  }

  public get bptPrice(): string {
    return bnum(this.pool.totalLiquidity)
      .div(this.pool.totalShares)
      .toString();
  }

  /**
   * @summary Calculates and sets total liquidity of pool.
   */
  public setTotalLiquidity(
    prices: TokenPrices,
    currency: FiatCurrency
  ): string {
    const liquidityConcern = new this.liquidity(this.pool);
    const totalLiquidity = liquidityConcern.calcTotal(prices, currency);
    return (this.pool.totalLiquidity = totalLiquidity);
  }

  /**
   * @summary Calculates APRs for pool.
   */
  public async setAPR(
    poolSnapshot: Pool | undefined,
    prices: TokenPrices,
    currency: FiatCurrency,
    protocolFeePercentage: number,
    stakingBalApr: GaugeBalApr,
    stakingRewardApr = '0'
  ): Promise<PoolAPRs> {
    const aprConcern = new this.apr(this.pool);
    const apr = await aprConcern.calc(
      poolSnapshot,
      prices,
      currency,
      protocolFeePercentage,
      stakingBalApr,
      stakingRewardApr
    );

    return (this.pool.apr = apr);
  }

  /**
   * fetches StablePhantom linear pools and extracts
   * required attributes.
   */
  public async setLinearPools(): Promise<Record<string, PoolToken>> {
    // Fetch linear pools from subgraph
    const linearPools = (await balancerSubgraphService.pools.get(
      {
        where: {
          address_in: this.pool.tokensList,
          totalShares_gt: -1 // Avoid the filtering for low liquidity pools
        }
      },
      { mainIndex: true, wrappedIndex: true }
    )) as LinearPool[];

    const linearPoolTokensMap: Pool['linearPoolTokensMap'] = {};

    // Inject main/wrapped tokens into pool schema
    linearPools.forEach(linearPool => {
      if (!this.pool.mainTokens) this.pool.mainTokens = [];
      if (!this.pool.wrappedTokens) this.pool.wrappedTokens = [];

      const index = this.pool.tokensList.indexOf(
        linearPool.address.toLowerCase()
      );

      this.pool.mainTokens[index] = linearPool.tokensList[linearPool.mainIndex];
      this.pool.wrappedTokens[index] =
        linearPool.tokensList[linearPool.wrappedIndex];

      linearPool.tokens
        .filter(token => !isSameAddress(token.address, linearPool.address))
        .forEach(token => {
          linearPoolTokensMap[token.address] = token;
        });
    });

    return (this.pool.linearPoolTokensMap = linearPoolTokensMap);
  }

  removePreMintedBPT(): string[] {
    return (this.pool.tokensList = this.pool.tokensList.filter(
      address => !isSameAddress(address, this.pool.address)
    ));
  }

  formatPoolTokens(): PoolToken[] {
    if (isStable(this.pool.poolType)) return this.pool.tokens;

    return (this.pool.tokens = this.pool.tokens.sort(
      (a, b) => parseFloat(b.weight) - parseFloat(a.weight)
    ));
  }

  public setFeesSnapshot(poolSnapshot: Pool | undefined): string {
    if (!poolSnapshot) return '0';

    const feesSnapshot = bnum(this.pool.totalSwapFee)
      .minus(poolSnapshot.totalSwapFee)
      .toString();

    return (this.pool.feesSnapshot = feesSnapshot);
  }

  public setVolumeSnapshot(poolSnapshot: Pool | undefined): string {
    if (!poolSnapshot) return '0';

    const volumeSnapshot = bnum(this.pool.totalSwapVolume)
      .minus(poolSnapshot.totalSwapVolume)
      .toString();

    return (this.pool.volumeSnapshot = volumeSnapshot);
  }

  public get isNew(): boolean {
    return (
      differenceInWeeks(Date.now(), this.pool.createTime * oneSecondInMs) < 1
    );
  }

  /**
   * fetches StablePhantom linear pools and extracts
   * required attributes.
   */
  public async decorateWithLinearPoolAttrs(): Promise<AnyPool> {
    // Fetch linear pools from subgraph
    const linearPools = (await balancerSubgraphService.pools.get(
      {
        where: {
          address_in: this.pool.tokensList,
          totalShares_gt: -1 // Avoid the filtering for low liquidity pools
        }
      },
      { mainIndex: true, wrappedIndex: true }
    )) as LinearPool[];

    const linearPoolTokensMap: Pool['linearPoolTokensMap'] = {};

    // Inject main/wrapped tokens into pool schema
    linearPools.forEach(linearPool => {
      if (!this.pool.mainTokens) this.pool.mainTokens = [];
      if (!this.pool.wrappedTokens) this.pool.wrappedTokens = [];

      const index = this.pool.tokensList.indexOf(
        linearPool.address.toLowerCase()
      );

      this.pool.mainTokens[index] = getAddress(
        linearPool.tokensList[linearPool.mainIndex]
      );
      this.pool.wrappedTokens[index] = getAddress(
        linearPool.tokensList[linearPool.wrappedIndex]
      );

      linearPool.tokens
        .filter(token => token.address !== linearPool.address)
        .forEach(token => {
          const address = getAddress(token.address);

          linearPoolTokensMap[address] = {
            ...token,
            address
          };
        });
    });

    this.pool.linearPoolTokensMap = linearPoolTokensMap;
    return this.pool;
  }

  removePreMintedBPT(): AnyPool {
    const poolAddress = balancerSubgraphService.pools.addressFor(this.pool.id);
    // Remove pre-minted BPT token if exits
    this.pool.tokensList = this.pool.tokensList.filter(
      address => address !== poolAddress.toLowerCase()
    );
    return this.pool;
  }

  formatPoolTokens(): PoolToken[] {
    const tokens = this.pool.tokens.map(token => ({
      ...token,
      address: getAddress(token.address)
    }));

    if (isStable(this.pool.poolType)) return tokens;

    return tokens.sort((a, b) => parseFloat(b.weight) - parseFloat(a.weight));
  }

  removeExcludedAddressesFromTotalLiquidity(
    totalLiquidityString: string,
    excludedAddresses: ExcludedAddresses
  ) {
    return removeAddressesFromTotalLiquidity(
      excludedAddresses,
      this.pool,
      totalLiquidityString
    );
  }

  calcFees(pastPool: Pool | undefined): string {
    if (!pastPool) return this.pool.totalSwapFee;

    return bnum(this.pool.totalSwapFee)
      .minus(pastPool.totalSwapFee)
      .toString();
  }
}
