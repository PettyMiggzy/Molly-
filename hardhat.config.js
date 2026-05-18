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
  // Sourcify supports Monad TESTNET only at this time. For mainnet, use Etherscan V2.
  sourcify: {
    enabled: false,
  },
  // Etherscan V2 unified API — single key from etherscan.io works across all
  // V2-supported chains including Monad (chain 143).
  // Get a free key at https://etherscan.io/myapikey
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || '',
    customChains: [
      {
        network: 'monad',
        chainId: 143,
        urls: {
          // V2 endpoint: single domain, chainid passed as query param
          apiURL: 'https://api.etherscan.io/v2/api',
          browserURL: 'https://monadscan.com',
        },
      },
    ],
  },
};
