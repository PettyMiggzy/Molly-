#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# MollyStaking — deploy + verify via sourcify
#
# What this does:
#   1. Compiles MollyStaking.sol with the audit-locked settings
#   2. Deploys to Monad mainnet via forge create
#   3. Verifies on Sourcify (deterministic, repo-pinned)
#
# Required env (in .env or exported):
#   DEPLOYER_KEY  — private key (with 0x prefix) of the deploying wallet
#   RPC           — Monad RPC URL (e.g. https://rpc.monad.xyz)
#
# Constructor args are hardcoded per audit:
#   mollyToken      = 0xB72e6262DAE53cAF167F0966421a0B9782977777
#   devWallet_      = 0xa424c64aa051cf75749b6377bfc86f20f212cb24
#   monorailRouter_ = 0x0  (compound disabled at deploy; enable via setMonorailRouter later)
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Load .env if present
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${DEPLOYER_KEY:?need DEPLOYER_KEY in env or .env (with 0x prefix)}"
: "${RPC:=https://rpc.monad.xyz}"

MOLLY_TOKEN="0xB72e6262DAE53cAF167F0966421a0B9782977777"
DEV_WALLET="0xa424c64aa051cf75749b6377bfc86f20f212cb24"
MONORAIL_ROUTER="0x0000000000000000000000000000000000000000"
CHAIN_ID=143

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " MollyStaking deploy → Monad mainnet (chain ${CHAIN_ID})"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  RPC:           ${RPC}"
echo "  MOLLY token:   ${MOLLY_TOKEN}"
echo "  Dev wallet:    ${DEV_WALLET}"
echo "  Monorail:      ${MONORAIL_ROUTER}  (compound disabled at deploy)"
echo "  Deployer addr: $(cast wallet address --private-key "${DEPLOYER_KEY}")"
echo "  Deployer bal:  $(cast balance --rpc-url "${RPC}" "$(cast wallet address --private-key "${DEPLOYER_KEY}")") wei"
echo ""

read -r -p "Confirm deploy? [y/N] " ans
case "${ans}" in
  y|Y|yes|YES) ;;
  *) echo "aborted."; exit 1 ;;
esac

# ──────── STEP 1: BUILD ────────
echo ""
echo "▸ Compiling..."
forge build --use 0.8.24

# ──────── STEP 2: DEPLOY ────────
echo ""
echo "▸ Deploying..."
DEPLOY_OUT=$(forge create \
  --rpc-url "${RPC}" \
  --private-key "${DEPLOYER_KEY}" \
  --constructor-args "${MOLLY_TOKEN}" "${DEV_WALLET}" "${MONORAIL_ROUTER}" \
  --broadcast \
  contracts/MollyStaking.sol:MollyStaking)

echo "${DEPLOY_OUT}"

CONTRACT_ADDR=$(echo "${DEPLOY_OUT}" | grep -oE "Deployed to: 0x[a-fA-F0-9]{40}" | awk '{print $3}')

if [ -z "${CONTRACT_ADDR}" ]; then
  echo "✗ couldn't parse deployed address from output"
  exit 1
fi

echo ""
echo "✓ Contract deployed at: ${CONTRACT_ADDR}"
echo "${CONTRACT_ADDR}" > .deployed-address

# ──────── STEP 3: VERIFY via SOURCIFY ────────
echo ""
echo "▸ Verifying on Sourcify..."
forge verify-contract \
  --chain-id ${CHAIN_ID} \
  --verifier sourcify \
  "${CONTRACT_ADDR}" \
  contracts/MollyStaking.sol:MollyStaking

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✅ DONE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  MollyStaking: ${CONTRACT_ADDR}"
echo "  Monadscan:    https://monadscan.com/address/${CONTRACT_ADDR}"
echo "  Sourcify:     https://sourcify.dev/#/lookup/${CONTRACT_ADDR}"
echo ""
echo "  Next steps:"
echo "    1. Send the deployed address to Claude → wire the staking frontend"
echo "    2. Test stake/unstake/claim with small amounts before announcing"
echo "    3. Fund the pool: cast send ${CONTRACT_ADDR} 'fundRewards()' --value 0.1ether --rpc-url ${RPC} --private-key \$DEPLOYER_KEY"
echo "    4. Later, set Monorail router to enable compound:"
echo "       cast send ${CONTRACT_ADDR} 'setMonorailRouter(address)' <router> --rpc-url ${RPC} --private-key \$DEPLOYER_KEY"
echo ""
