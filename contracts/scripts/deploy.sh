#!/usr/bin/env bash
# Feature: Originación de Facturas y Tokenización de Fracciones de Pool
# (specs/20260920-174938-originacion-facturas-pool)
# T002/T033/T034: script de despliegue inicial del contrato `pool_fraction_token` a Stellar
# testnet. Ver contracts/deploy-contrato.md para el detalle de cada paso.
#
# NOTA DE IMPLEMENTACIÓN: `stellar contract build` + `cargo test` (T032) ya se verificaron en vivo
# con `rustc`/`cargo` 1.98.1 (toolchain GNU vía rustup, targets `x86_64-pc-windows-gnu` +
# `wasm32v1-none`) y `stellar-cli` 28.0.0 — el contrato compila, sus 9 pruebas unitarias pasan y el
# WASM optimizado pesa 6996 bytes (hash `25af11fb4fc9febd1cf91991a8127e8f9d0b1d3b3467a6f39c8b69304
# b33f0ca`). Lo que falta ejecutar es este script contra testnet (T035): configurar la red testnet
# (`stellar network add testnet --rpc-url https://soroban-testnet.stellar.org --network-passphrase
# "Test SDF Network ; September 2015"`) y exportar SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY del
# proyecto (nunca el anon key — este script escribe en Vault).
#
# Uso: ./contracts/scripts/deploy.sh
# Idempotente donde es razonable: si contracts/deployments/testnet.json ya existe, reutiliza la
# autoridad y el wasm_hash ya publicados en vez de generarlos de nuevo; siempre reintenta la
# instanciación de tramos que todavía no tengan token_contract_id en Supabase.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/contracts/soroban-pool"
DEPLOYMENTS_FILE="$REPO_ROOT/contracts/deployments/testnet.json"
NETWORK="testnet"
AUTHORITY_KEY_NAME="operador-authority"

: "${SUPABASE_URL:?Falta SUPABASE_URL en el entorno}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Falta SUPABASE_SERVICE_ROLE_KEY en el entorno}"

command -v stellar >/dev/null || { echo "Falta stellar-cli — ver nota de implementación arriba." >&2; exit 1; }
command -v cargo >/dev/null || { echo "Falta cargo/Rust — ver nota de implementación arriba." >&2; exit 1; }
command -v jq >/dev/null || { echo "Falta jq (usado para parsear respuestas)." >&2; exit 1; }
command -v curl >/dev/null || { echo "Falta curl." >&2; exit 1; }

echo "== Paso 1: autoridad de plataforma =="
if ! stellar keys address "$AUTHORITY_KEY_NAME" >/dev/null 2>&1; then
  stellar keys generate "$AUTHORITY_KEY_NAME" --network "$NETWORK" --fund
fi
AUTHORITY_PUBLIC_KEY="$(stellar keys address "$AUTHORITY_KEY_NAME")"
AUTHORITY_SECRET_KEY="$(stellar keys show "$AUTHORITY_KEY_NAME")"
echo "Autoridad: $AUTHORITY_PUBLIC_KEY"

echo "== Paso 2: build + subir el WASM (una sola vez) =="
# soroban-sdk >=22 exige compilar con `stellar contract build` (no `cargo build` directo) y el
# target `wasm32v1-none` (Rust 1.82+); `wasm32-unknown-unknown` ya no es soportado por el SDK
# (verificado en vivo durante T032 con soroban-sdk 28.0.0 / stellar-cli 28.0.0).
(cd "$CONTRACT_DIR" && stellar contract build)
WASM_PATH="$CONTRACT_DIR/target/wasm32v1-none/release/soroban_pool.wasm"
WASM_HASH="$(stellar contract upload --wasm "$WASM_PATH" --source "$AUTHORITY_KEY_NAME" --network "$NETWORK")"
echo "wasm_hash: $WASM_HASH"

echo "== Paso 3: instanciar un contrato por cada tramo sin token_contract_id =="
TRAMOS_JSON="$(curl -sS "$SUPABASE_URL/rest/v1/tramos?select=id,tipo,pool_id,pools(codigo)&token_contract_id=is.null" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")"

echo "$TRAMOS_JSON" | jq -c '.[]' | while read -r tramo; do
  TRAMO_ID="$(echo "$tramo" | jq -r '.id')"
  TIPO="$(echo "$tramo" | jq -r '.tipo')"
  POOL_CODIGO="$(echo "$tramo" | jq -r '.pools.codigo')"

  CONTRACT_ID="$(stellar contract deploy --wasm-hash "$WASM_HASH" --source "$AUTHORITY_KEY_NAME" --network "$NETWORK")"
  stellar contract invoke --id "$CONTRACT_ID" --source "$AUTHORITY_KEY_NAME" --network "$NETWORK" -- \
    initialize --admin "$AUTHORITY_PUBLIC_KEY" --pool_ref "$POOL_CODIGO" --tramo "$TIPO"

  echo "Tramo $TRAMO_ID ($POOL_CODIGO/$TIPO) -> $CONTRACT_ID"

  curl -sS -X PATCH "$SUPABASE_URL/rest/v1/tramos?id=eq.$TRAMO_ID" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"token_contract_id\": \"$CONTRACT_ID\"}" >/dev/null

  jq -n --arg pool "$POOL_CODIGO" --arg tramo "$TIPO" --arg cid "$CONTRACT_ID" \
    '{pool_codigo: $pool, tramo: $tramo, contract_id: $cid}' >> "$REPO_ROOT/contracts/deployments/.tramos.ndjson"
done

echo "== Paso 4: registrar configuracion_red (una sola vez) =="
curl -sS -X POST "$SUPABASE_URL/rest/v1/rpc/registrar_configuracion_red" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"p_red\": \"$NETWORK\", \"p_operador_authority_public_key\": \"$AUTHORITY_PUBLIC_KEY\", \"p_operador_authority_secret\": \"$AUTHORITY_SECRET_KEY\", \"p_token_wasm_hash\": \"$WASM_HASH\"}" \
  >/dev/null

echo "== Paso 5: escribir contracts/deployments/testnet.json (sin secretos) =="
TRAMOS_ARRAY="[$(paste -sd, "$REPO_ROOT/contracts/deployments/.tramos.ndjson" 2>/dev/null || echo "")]"
jq -n \
  --arg red "$NETWORK" \
  --arg wasm_hash "$WASM_HASH" \
  --arg authority "$AUTHORITY_PUBLIC_KEY" \
  --arg fecha "$(date -u +%FT%TZ)" \
  --argjson tramos "$TRAMOS_ARRAY" \
  '{red: $red, wasm_hash: $wasm_hash, operador_authority_public_key: $authority, desplegado_at: $fecha, tramos: $tramos}' \
  > "$DEPLOYMENTS_FILE"
rm -f "$REPO_ROOT/contracts/deployments/.tramos.ndjson"

echo "Listo. Evidencia versionada en $DEPLOYMENTS_FILE"
