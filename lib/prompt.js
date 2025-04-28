import BN from "bn.js";
import { StrategyType, autoFillYByStrategy } from "@meteora-ag/dlmm";
import { getTokenInfo, getUserTokenBalanceNative, getTokenDecimals } from "./helpers.js";
import { sendTx } from "./tx.js";

export async function autoAddLpSafe({
  connection,
  dlmmPool,
  user,
  poolAddress,
  mode,
  strategyType,
  anchorAmountLamports,
  anchorSide,
  slippageBps
}) {
  const publicKey = user.publicKey;
  const activeBin = await dlmmPool.getActiveBin();
  const { tokenXSymbol, tokenYSymbol } = await getTokenInfo(poolAddress);

  const decimalsX = dlmmPool.tokenX?.mint?.decimals ?? 6;
  const decimalsY = dlmmPool.tokenY?.mint?.decimals ?? 6;

  const strategyEnum = {
    Spot: StrategyType.Spot,
    BidAsk: StrategyType.BidAsk,
    Curve: StrategyType.Curve,
  }[strategyType];

  let modalLamports = anchorAmountLamports;
  if (!modalLamports || modalLamports.toString() === "0") {
    console.warn("❌ Nilai modal 0 lamports. Batalkan.");
    return { skipSwap: false };
  }

  let totalXAmount = new BN(0);
  let totalYAmount = new BN(0);
  let minBinId = 0;
  let maxBinId = 0;

  if (mode === "One Side Tokens") {
    const isX = anchorSide === "X";
    if (isX) {
      totalXAmount = modalLamports;
      totalYAmount = autoFillYByStrategy(
        activeBin.binId,
        dlmmPool.lbPair.binStep,
        totalXAmount,
        new BN(activeBin.xAmount.toString()),
        new BN(activeBin.yAmount.toString()),
        activeBin.binId,
        activeBin.binId + 68,
        strategyEnum
      );
      minBinId = activeBin.binId;
      maxBinId = activeBin.binId + 68;
    } else {
      totalYAmount = modalLamports;
      totalXAmount = autoFillYByStrategy(
        activeBin.binId,
        dlmmPool.lbPair.binStep,
        totalYAmount,
        new BN(activeBin.yAmount.toString()),
        new BN(activeBin.xAmount.toString()),
        activeBin.binId - 68,
        activeBin.binId,
        strategyEnum
      );
      minBinId = activeBin.binId - 68;
      maxBinId = activeBin.binId;
    }
  }

  const sig = await sendTx(
    connection,
    dlmmPool,
    user,
    totalXAmount,
    totalYAmount,
    minBinId,
    maxBinId,
    strategyEnum,
    slippageBps
  );

  console.log(`✅ Add liquidity sukses! Signature: ${sig}`);

  return {
    skipSwap: mode === "One Side Tokens" && anchorSide === "Y",
  };
}

export async function isSafeBinRange(dlmmPool, minBinId, maxBinId) {
  try {
    const { bins } = await dlmmPool.getBinsBetweenLowerAndUpperBound(minBinId, maxBinId);

    const expectedCount = maxBinId - minBinId + 1;
    const actualCount = bins.filter(bin => typeof bin?.binId === "number").length;

    if (actualCount >= expectedCount) {
      console.log(`✅ Semua ${actualCount} bin aktif dalam range [${minBinId} - ${maxBinId}]`);
      return true;
    } else {
      console.warn(`⛔ Hanya ${actualCount}/${expectedCount} bin aktif dalam range [${minBinId} - ${maxBinId}]`);
      return false;
    }
  } catch (err) {
    console.warn("⛔ Gagal ambil bin range:", err.message || err);
    return false;
  }
}
