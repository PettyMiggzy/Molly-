require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PK = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

// Etherscan V2 unified API for Monad — same pattern as MollyStaking
const ETHERSCAN_V2_KEY = process.env.ETHERSCAN_API_KEY || "";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },

  networks: {
    monadTestnet: {
      url: process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts: PK,
    },
    monad: {
      url: process.env.MONAD_RPC || "https://rpc.monad.xyz",
      chainId: 143,
      accounts: PK,
    },
  },

  etherscan: {
    apiKey: {
      monadTestnet: ETHERSCAN_V2_KEY,
      monad:        ETHERSCAN_V2_KEY,
    },
    customChains: [
      {
        network: "monadTestnet",
        chainId: 10143,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=10143",
          browserURL: "https://testnet.monadscan.com",
        },
      },
      {
        network: "monad",
        chainId: 143,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=143",
          browserURL: "https://monadscan.com",
        },
      },
    ],
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
