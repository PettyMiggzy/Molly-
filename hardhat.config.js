// hardhat.config.js — MollyStaking deploy config
//
// Settings here MUST match the audit-locked compile settings:
//   solc 0.8.24, optimizer enabled, runs 200, viaIR off, EVM 'paris'
//
// Sources live in contracts/ (not the default src/ — overridden below).

require('@nomicfoundation/hardhat-toolbox');
require('@nomicfoundation/hardhat-verify');
require('dotenv').config();

const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const RPC = process.env.RPC || 'https://rpc.monad.xyz';

// Defensive: pad key with 0x if user pasted without it
function normalizeKey(k) {
  if (!k) return [];
  if (k.startsWith('0x')) return [k];
  return ['0x' + k];
}

module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
      evmVersion: 'paris',
    },
  },
  paths: {
    sources: './contracts',
    artifacts: './artifacts',
    cache: './cache',
  },
  networks: {
    monad: {
      url: RPC,
      chainId: 143,
      accounts: normalizeKey(DEPLOYER_KEY),
    },
    hardhat: {
      chainId: 31337,
    },
  },
  // Sourcify supports Monad mainnet (chain 143) — preferred verifier
  sourcify: {
    enabled: true,
  },
  // Etherscan-compatible block explorer config (monadscan can also pick up
  // verifications from sourcify automatically, but having both is harmless)
  etherscan: {
    apiKey: {
      monad: process.env.MONADSCAN_API_KEY || 'placeholder',
    },
    customChains: [
      {
        network: 'monad',
        chainId: 143,
        urls: {
          apiURL: 'https://api.monadscan.com/api',
          browserURL: 'https://monadscan.com',
        },
      },
    ],
  },
};
