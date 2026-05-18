// hardhat.config.js — MollyStaking deploy + verify config
//
// Network name must be `monadMainnet` so the etherscan apiKey lookup works.
// Verify command:
//   $env:ETHERSCAN_API_KEY = "your-key-from-etherscan.io"
//   npx hardhat verify --network monadMainnet 0xFa45c43d74382D99649ecE4CFD2823148A17C912 0xB72e6262DAE53cAF167F0966421a0B9782977777 0xa424c64aa051cf75749b6377bfc86f20f212cb24 0x0000000000000000000000000000000000000000

require('@nomicfoundation/hardhat-toolbox');
require('@nomicfoundation/hardhat-verify');
require('dotenv').config();

const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const RPC = process.env.RPC || 'https://rpc.monad.xyz';

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
    monadMainnet: {
      url: RPC,
      chainId: 143,
      accounts: normalizeKey(DEPLOYER_KEY),
    },
    // Legacy alias — keeps old --network monad commands working
    monad: {
      url: RPC,
      chainId: 143,
      accounts: normalizeKey(DEPLOYER_KEY),
    },
    hardhat: {
      chainId: 31337,
    },
  },
  // Sourcify doesn't have Monad mainnet (chain 143) — disable to silence errors
  sourcify: {
    enabled: false,
  },
  // Etherscan V2 unified API. Single key from etherscan.io covers Monad + 60+ chains.
  // Get key at: https://etherscan.io/myapikey (must be etherscan.io, NOT bscscan.com etc.)
  etherscan: {
    apiKey: {
      monadMainnet: process.env.ETHERSCAN_API_KEY || '',
    },
    customChains: [
      {
        network: 'monadMainnet',
        chainId: 143,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=143',
          browserURL: 'https://monadscan.com',
        },
      },
    ],
  },
};
