// === copy.js (revisi lengkap) ===

import fetch from "node-fetch";
import inquirer from "inquirer";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getUserTokenBalanceNative, autoUnwrapWsol } from "./utils.js";
import fs from "fs";
import path from "path";
import bs58 from "bs58";
import BN from "bn.js";
import { RPC } from "./config.js";
import { autoAddLpSafe } from "./lib/prompt.js";
import { monitorPnL } from "./mon.js";
import { saveTrackedSwap, runSwapTracker } from "./swaptracker.js";
import { runHourlyCheck } from "./hourly.js";
import dlmmPkg from "@meteora-ag/dlmm";
const createDlmmPool = dlmmPkg.create || dlmmPkg.DLMM?.create || dlmmPkg.default?.create;

const connection = new Connection(RPC);
const HELIUS_API_KEY = "HELIUS API KEY"; 
const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const wallets = JSON.parse(fs.readFileSync("./wallets.json", "utf8"));
const signer = Keypair.fromSecretKey(bs58.decode(wallets[0]));
const processedPools = new Set();

const { targetAddress, modalSol, strategy, tpPercent, slPercent } = await inquirer.prompt([
  { type: "input", name: "targetAddress", message: "Masukkan wallet address yang ingin di-track:" },
  { type: "input", name: "modalSol", message: "Masukkan jumlah modal SOL:", validate: val => isNaN(val) ? "Harus angka" : true },
  { type: "list", name: "strategy", message: "Pilih strategi:", choices: ["Spot", "BidAsk"] },
  { type: "input", name: "tpPercent", message: "Take Profit (%):", validate: val => isNaN(val) ? "Harus angka" : true },
  {
    type: "input",
    name: "slPercent",
    message: "Stop Loss (%):",
    validate: (val) => isNaN(val) ? "Harus angka" : true,
    filter: (val) => -Math.abs(parseFloat(val)), // 🔥 ini penting untuk safety
  }
]);

const SETTINGS = {
  modalSol: parseFloat(modalSol),
  strategy,
  tpPercent: parseFloat(tpPercent),
  slPercent: parseFloat(slPercent),
};

let lastSeenSignature = null;

function formatTimestamp() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000); // Tambah 7 jam dari UTC
  const time = now.toISOString().split('T')[1].split('.')[0]; // Ambil HH:MM:SS dari ISO string
  return `${time} WIB`;
}


function log(msg) {
  console.log(`[${formatTimestamp()}] ${msg}`);
}

function savePosition(position) {
  const positionsPath = path.resolve("./positions.json");
  let positions = [];
  if (fs.existsSync(positionsPath)) {
    positions = JSON.parse(fs.readFileSync(positionsPath, "utf8"));
  }
  positions.push(position);
  fs.writeFileSync(positionsPath, JSON.stringify(positions, null, 2));
  // log(`💾 Posisi berhasil disimpan ke positions.json`);
}

async function fetchTransactions(address) {
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&limit=12&commitment=confirmed`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal fetch txs: ${res.statusText}`);
  return await res.json();
}

function isLikelyAddLiquidityByStrategy2(data) {
  return data?.length > 10;
}

async function handleAddLiquidity(poolAddress) {
  try {
    if (processedPools.has(poolAddress)) {
      log(`⚠️ Sudah LP di pool ${poolAddress}, skip.`);
      return;
    }

    log(`🚀 Mulai auto add LP di pool: ${poolAddress}`);
    const dlmmPool = await createDlmmPool(connection, new PublicKey(poolAddress));
    const lamports = Math.floor(SETTINGS.modalSol * 10 ** 9);

    const { skipSwap, positionPubkey } = await autoAddLpSafe({
      connection,
      dlmmPool,
      user: signer,
      poolAddress,
      mode: "One Side Tokens",
      strategyType: SETTINGS.strategy,
      anchorAmountLamports: new BN(lamports.toString()),
      slippageBps: 300,
      anchorSide: "Y",
    });

    if (skipSwap) {
      log(`Monitor Posisi dimulai...`);
    }

    const newPosition = {
      poolAddress,
      mintX: dlmmPool.tokenX.mint.address.toString(),
      mintY: dlmmPool.tokenY.mint.address.toString(),
      createdAt: Date.now(),
      positionPubkey: positionPubkey || null,
      takeProfit: SETTINGS.tpPercent,    // ⬅️ tambah ini
      stopLoss: SETTINGS.slPercent       // ⬅️ tambah ini
    };
    

    savePosition(newPosition);
    processedPools.add(poolAddress);

    // 🔥 SET RUNTIME_CONFIG dari SETTINGS user input
    globalThis.RUNTIME_CONFIG = {
      TAKE_PROFIT: SETTINGS.tpPercent,
      STOP_LOSS: SETTINGS.slPercent,
    };

    // Setelah Add LP → Mulai pantau PnL!
    monitorPnL(poolAddress, signer, { autoLoop: true, tpPercent: SETTINGS.tpPercent, slPercent: SETTINGS.slPercent });

  } catch (err) {
    log(`❌ Gagal auto add LP: ${err.message}`);
  }
}


async function mainLoop() {
  log("🔄 Mulai monitoring transaksi...");

  const initTxs = await fetchTransactions(targetAddress);
  if (initTxs.length > 0) {
    lastSeenSignature = initTxs[0].signature;
    log(`⏳ Start monitoring dari signature: ${lastSeenSignature}`);
  }

  while (true) {
    try {
      const txs = await fetchTransactions(targetAddress);

      if (txs.length === 0) {
        await new Promise(res => setTimeout(res, 5000));
        continue;
      }

      for (const tx of txs) {
        if (tx.signature === lastSeenSignature) break;

        const instructions = tx.instructions ?? [];

        for (const ix of instructions) {
          if (ix.programId === DLMM_PROGRAM_ID && (ix.accounts?.length || 0) >= 6) {
            const candidate = ix.accounts[2];
            if (candidate !== targetAddress && candidate !== DLMM_PROGRAM_ID && isLikelyAddLiquidityByStrategy2(ix.data)) {
              if (!processedPools.has(candidate)) {
                log(`✅ Ditemukan AddLiquidityByStrategy2`);
                log(`➡️ Pool Address: ${candidate}`);
                await handleAddLiquidity(candidate);
              }
            }
          }
        }

        const isRemoveLiquidity = tx.source === "METEORA" &&
          tx.instructions.some(ix => ix.programId === DLMM_PROGRAM_ID);

        if (isRemoveLiquidity) {
          log(`🛑 Wallet target melakukan remove liquidity.`);
          if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
            for (const transfer of tx.tokenTransfers) {
              if (transfer.fromUserAccount && transfer.toUserAccount === targetAddress) {
                const poolAddr = transfer.fromUserAccount;
                if (processedPools.has(poolAddr)) {
                  log(`⚡ Kita punya posisi di pool ${poolAddr}, paksa monitor force remove.`);
                  const success = await monitorPnL(poolAddr, signer, { forceRemoveNow: true });
                  if (success === false) {
                    processedPools.delete(poolAddr);
                  }                  
                }
              }
            }
          }
        }
      }

      if (txs[0]?.signature) {
        lastSeenSignature = txs[0].signature;
      }

    } catch (err) {
      log(`❌ Error: ${err.message}`);
    }

    await new Promise(res => setTimeout(res, 5000));
  }
}

setInterval(() => {
  runSwapTracker(connection, [{ keypair: signer }]);
}, 3 * 60 * 1000);

setInterval(() => {
  runHourlyCheck([{ keypair: signer }]);
}, 5 * 60 * 1000);

setInterval(async () => {
  const pubkey = signer.publicKey;
  const short = pubkey.toBase58().slice(0, 6);
  try {
    const bal = await getUserTokenBalanceNative(connection, "So11111111111111111111111111111111111111112", pubkey);
    if (bal <= 0) return;

    const unwrapped = await autoUnwrapWsol(signer);
    if (unwrapped) {
      log(`💧 [${short}] WSOL ${bal} berhasil di-unwrapped ke SOL`);
    } else {
     //  log(`⚠️ [${short}] Gagal unwrap WSOL`);
    }
  } catch (e) {
    if (!e.message?.includes("Associated Token Account does not exist")) {
      log(`⚠️ [${short}] Error saat cek WSOL: ${e.message || e}`);
    }
  }
}, 60_000);


mainLoop().catch(console.error);
