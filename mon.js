// mon.js

import { Connection, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { RPC } from "./config.js";
import { getPriceUsdMap, getUserTokenBalanceNative, autoUnwrapWsol } from "./utils.js";
import { getPriorityInstructions } from "./lib/fee.js";
import { autoSwap } from "./autoswap.js";
import { saveTrackedSwap } from "./swaptracker.js";
import dlmmPkg from "@meteora-ag/dlmm";
import BN from "bn.js";
import fs from "fs";
import axios from "axios";

const createDlmmPool = dlmmPkg.create || dlmmPkg.DLMM?.create || dlmmPkg.default?.create;
const connection = new Connection(RPC);
const pnlStorePath = "./pnl.json";
const pnlStore = fs.existsSync(pnlStorePath) ? JSON.parse(fs.readFileSync(pnlStorePath, "utf8")) : {};

const pendingRemove = new Set();
const pendingSwap = new Set();

export async function getPoolName(poolAddress) {
  try {
    const { data } = await axios.get(`https://dlmm-api.meteora.ag/pair/${poolAddress}`);
    return data.name || `UnknownPair(${poolAddress.slice(0, 4)})`;
  } catch (e) {
    console.warn(`${getTimestamp()} ⚠️ Gagal fetch pool name untuk ${poolAddress}:`, e.code || e.message);
    return `UnknownPair(${poolAddress.slice(0, 4)})`;
  }
}

export function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function getTimestamp() {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const time = wib.toISOString().split("T")[1].split(".")[0];
  return `[${time} WIB]`;
}

export async function monitorPnL(poolAddressStr, user, opts = {}) {
  const forceRemoveNow = opts.forceRemoveNow || false;
  const autoLoop = opts.autoLoop || false;
  const publicKey = user.publicKey;
  const poolAddress = new PublicKey(poolAddressStr);
  const dlmmPool = await createDlmmPool(connection, poolAddress);

  async function checkPnL() {
    let userPositions = [];
    let activeBin = null;
    
    // ⏳ New: Tunggu posisi sampai available
    for (let i = 0; i < 10; i++) {
      const res = await dlmmPool.getPositionsByUserAndLbPair(publicKey);
      userPositions = res.userPositions;
      activeBin = res.activeBin;
      if (userPositions?.length > 0) break;
    
      await delay(2000);
    }
    
    if (!userPositions || userPositions.length === 0) {
      console.log(`${getTimestamp()} 🏁 Posisi ${poolAddressStr.slice(0,6)} tidak ditemukan, berhenti monitor.`);
      return false;
    }

    const pairName = await getPoolName(poolAddressStr);
    const tokenX = dlmmPool.tokenX;
    const mintXStr = tokenX?.mint?.address?.toBase58();
    const decimalsX = tokenX?.mint?.decimals ?? 6;
    const mintYStr = dlmmPool.tokenY?.mint?.address?.toBase58();
    const decimalsY = dlmmPool.tokenY?.mint?.decimals ?? 6;
    const prices = await getPriceUsdMap([mintXStr, mintYStr]);
    const priceX = prices[mintXStr] || 0;
    const priceY = prices[mintYStr] || 0;
    const currentBinId = activeBin?.binId;

    for (const pos of userPositions) {
      const posKey = pos.publicKey.toBase58();
      const data = pos.positionData;

      if (pendingRemove.has(posKey)) continue;

      const toDecimal = (val, dec) => {
        if (!val) return 0;
        const bn = BN.isBN(val) ? val : new BN(val.toString());
        return Number(bn.toString()) / 10 ** dec;
      };
  
      const amountX = toDecimal(data.totalXAmount ?? data.amount_x, decimalsX);
      const amountY = toDecimal(data.totalYAmount ?? data.amount_y, decimalsY);
      const feeX = toDecimal(data.feeX ?? data.fees_x ?? 0, decimalsX);
      const feeY = toDecimal(data.feeY ?? data.fees_y ?? 0, decimalsY);
      const valueX = amountX * priceX;
      const valueY = amountY * priceY;
      const currentValue = valueX + valueY + feeX * priceX + feeY * priceY;
  
      if (!pnlStore[posKey]) {
        pnlStore[posKey] = { 
          startUsd: currentValue, 
          pool: poolAddressStr, 
          owner: publicKey.toBase58(), 
          createdAt: Date.now(), 
          mintX: mintXStr,
          takeProfit: globalThis.RUNTIME_CONFIG?.TAKE_PROFIT ?? 10,
          stopLoss: globalThis.RUNTIME_CONFIG?.STOP_LOSS ?? -5,
        };
      
        fs.writeFileSync(pnlStorePath, JSON.stringify(pnlStore, null, 2)); // <-- Save baru!
      }
  
      pnlStore[posKey].lastSeen = Date.now();
      pnlStore[posKey].isClosed = false;
      
  
      const startValue = pnlStore[posKey].startUsd;
      const profit = currentValue - startValue;
      let percent = startValue > 0 ? (profit / startValue) * 100 : 0;
      const inRange = currentBinId >= data.lowerBinId && currentBinId <= data.upperBinId;
      const now = Date.now();
      const feeUsd = feeX * priceX + feeY * priceY;
      const lpValue = amountX * priceX + amountY * priceY;
      const hodlValue = (amountX + feeX) * priceX + (amountY + feeY) * priceY;
      
      const IL = ((hodlValue - lpValue) / hodlValue) * 100;
      const IL_USD = hodlValue - lpValue;    
  
        console.log(
          `${getTimestamp()} [${publicKey.toBase58().slice(0, 6)}] [${poolAddressStr.slice(0, 6)}] [${posKey.slice(0, 6)}] (${pairName})` +
          `💰 $${startValue.toFixed(2)} → $${currentValue.toFixed(2)} | ` +
          `${inRange ? "🟢 In-Range" : "🔴 Out-Range"} | ` +
          `${profit >= 0 ? "🟢" : "🔴"} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} (${percent.toFixed(2)}%) | ` +
          `💸 Fee: $${feeUsd.toFixed(2)} | 📉 IL: $${IL_USD.toFixed(2)} (${IL.toFixed(2)}%)`
        );

        const TP = pnlStore[posKey]?.takeProfit ?? 10;
        const SL = pnlStore[posKey]?.stopLoss ?? -5;
        
        const MINIMAL_CHANGE = 0.01;
        
        const isTakeProfitTriggered = percent >= TP && Math.abs(percent) >= MINIMAL_CHANGE;
        const isStopLossTriggered = percent <= SL && percent < 0 && Math.abs(percent) >= MINIMAL_CHANGE;
        
        if (isTakeProfitTriggered) {
          console.log(`${getTimestamp()} 🎯 Trigger TP at ${percent.toFixed(2)}%`);
        }
        if (isStopLossTriggered) {
          console.log(`${getTimestamp()} ❗ Trigger SL at ${percent.toFixed(2)}%`);
        }
        
        if (isTakeProfitTriggered || isStopLossTriggered || forceRemoveNow) {
          pendingRemove.add(posKey);
        
          if (forceRemoveNow) {
            console.log(`${getTimestamp()} ⚡ Wallet Track Remove liquidity.`);
          }
        

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const tx = await dlmmPool.removeLiquidity({
              position: pos.publicKey,
              user: publicKey,
              fromBinId: data.lowerBinId,
              toBinId: data.upperBinId,
              bps: new BN(10_000),
              shouldClaimAndClose: true,
              extraComputeUnits: getPriorityInstructions("ultra"),
            });

            const sig = await sendAndConfirmTransaction(connection, tx, [user], { commitment: "confirmed" });
            console.log(`${getTimestamp()} ✅ TX Remove berhasil: ${sig}`);
            pnlStore[posKey].isClosed = true;
            pnlStore[posKey].removedAt = Date.now();
            fs.writeFileSync(pnlStorePath, JSON.stringify(pnlStore, null, 2));
            await delay(1000);

            // swap setelah remove
            const MIN_SWAP = 1000;
            let balanceX = 0;
            for (let i = 0; i < 10; i++) {
              await delay(2000);
              balanceX = await getUserTokenBalanceNative(connection, mintXStr, publicKey);
              if (balanceX > MIN_SWAP) break;
            }

            if (balanceX > MIN_SWAP && !pendingSwap.has(posKey)) {
              pendingSwap.add(posKey);
            
              let swapSig = "";
              let swapSuccess = false;
            
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  swapSig = await autoSwap({
                    inputMint: mintXStr,
                    outputMint: "So11111111111111111111111111111111111111112",
                    amountInLamports: balanceX,
                    signer: user,
                  });
            
                  if (!swapSig || typeof swapSig !== "string" || swapSig.length < 10) {
                    throw new Error("Swap gagal: signature tidak valid.");
                  }
            
                  console.log(`${getTimestamp()} 🔄 Swap success (attempt ${attempt}): ${swapSig}`);
                  swapSuccess = true;
                  break; // keluar loop kalau sukses
                } catch (e) {
                  console.warn(`${getTimestamp()} ❌ Swap gagal (attempt ${attempt}): ${e.message}`);
                  await delay(2000);
                }
              }
            
              if (!swapSuccess) {
                console.warn(`${getTimestamp()} ❌ Swap gagal total setelah 3x percobaan. Skip unwrap.`);
                saveTrackedSwap(mintXStr, user.publicKey.toBase58());
                pendingSwap.delete(posKey);
                continue; // lanjut posisi berikutnya
              }            

              const WSOL_MINT = "So11111111111111111111111111111111111111112";
              let wsolBalance = 0;
              
              // 🔍 Cek saldo WSOL masuk
              console.log(`${getTimestamp()} 🔍 Cek saldo WSOL sebelum unwrap...`);
              for (let i = 0; i < 10; i++) {
                await delay(2000);
                wsolBalance = await getUserTokenBalanceNative(connection, WSOL_MINT, publicKey);
                console.log(`${getTimestamp()} 🔁 Cek saldo WSOL #${i + 1}: ${wsolBalance}`);
                if (wsolBalance > 0) break;
              }
              
              if (wsolBalance > 0) {
                console.log(`${getTimestamp()} ⏳ Delay 5 detik sebelum mencoba unwrap WSOL...`);
                await delay(5000);
              
                let unwrapped = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                  unwrapped = await autoUnwrapWsol(user);
                  if (unwrapped) {
                    console.log(`${getTimestamp()} 💧 WSOL sukses di-unwrapped ke SOL`);
                    break;
                  } else {
                    console.warn(`${getTimestamp()} ⚠️ Gagal unwrap WSOL (attempt ${attempt})`);
                    await delay(3000);
                  }
                }
              
                if (!unwrapped) {
                  console.warn(`${getTimestamp()} ⚠️ Gagal unwrap WSOL setelah 3x percobaan`);
                }
              } else {
                console.warn(`${getTimestamp()} ⚠️ Tidak ada saldo WSOL untuk di-unwrapped`);
                await delay(2000);
              }              

              pendingSwap.delete(posKey);
            }

            pnlStore[posKey].isClosed = true;
            pnlStore[posKey].removedAt = Date.now();
            fs.writeFileSync(pnlStorePath, JSON.stringify(pnlStore, null, 2));

            pendingRemove.delete(posKey);
            return false;
          } catch (e) {
            console.warn(`${getTimestamp()} ⚠️ Gagal remove (attempt ${attempt}): ${e.message}`);
            await delay(2000);
          }
        }

        console.warn(`${getTimestamp()} ❌ Gagal remove posisi setelah 3x attempt`);
        pendingRemove.delete(posKey);
        return true;
      }
    }

    return true;
  }

  if (autoLoop) {
    while (await checkPnL()) {
      await delay(10000);
    }
  } else {
    return await checkPnL();
  }
}
