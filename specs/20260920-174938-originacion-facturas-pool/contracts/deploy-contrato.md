# Contrato: script de despliegue `contracts/scripts/deploy.sh`

Único punto de entrada humano de todo el flujo on-chain — se ejecuta una vez por red (`testnet`)
para dejar el proyecto listo, y de nuevo solo si se necesita redesplegar el WASM (cambio de
código del contrato). Usa `stellar-cli` (herramienta oficial de Soroban) en vez de escribir
transacciones a mano — más simple y estándar para un script de un solo uso.

## Prerrequisitos

- `stellar-cli` instalado, red `testnet` configurada (`stellar network add testnet ...` con el RPC
  público de testnet).
- `contracts/soroban-pool` compila a WASM (`stellar contract build`).

## Pasos (idempotentes donde es posible — ver salida)

1. **Genera y funda la autoridad de plataforma** (si `contracts/deployments/testnet.json` no
   existe todavía): `stellar keys generate operador-authority --network testnet --fund` (usa
   Friendbot internamente). Guarda la clave secreta **solo** en la salida de este paso — el script
   nunca la escribe en el repositorio; el operador humano la copia a Supabase Vault en el paso 4.
2. **Sube el WASM una sola vez**: `stellar contract upload --wasm target/.../soroban_pool.wasm
   --source operador-authority --network testnet` → devuelve el `wasm_hash`.
3. **Instancia el contrato para cada tramo ya sembrado** (los 10 tramos de los ≥5 pools de
   ejemplo de la spec previa, que nacieron sin `token_contract_id`): por cada tramo, `stellar
   contract deploy --wasm-hash <wasm_hash> --source operador-authority --network testnet` →
   `contract_id`, seguido de `stellar contract invoke --id <contract_id> --source
   operador-authority --network testnet -- initialize --admin <authority_public_key> --pool_ref
   <codigo_pool> --tramo <senior|junior>`.
4. **Publica la configuración en Supabase** (dos escrituras, ambas versionadas en el sentido de
   que este mismo script las hace explícitas, nunca "a mano" en el Dashboard):
   - `insert into configuracion_red (...) values ('testnet', <authority_public_key>, <secret_id
     recién creado en Vault vía el service_role client>, <wasm_hash>)`.
   - `update tramos set token_contract_id = <contract_id> where id = <tramo_id>` por cada tramo
     del paso 3.
5. **Escribe el archivo versionado** `contracts/deployments/testnet.json`:

   ```json
   {
     "red": "testnet",
     "wasm_hash": "abcd...",
     "operador_authority_public_key": "GA...",
     "desplegado_at": "2026-09-2xT..:..Z",
     "tramos": [
       { "pool_codigo": "POOL-PEN-001", "tramo": "senior", "contract_id": "C..." },
       { "pool_codigo": "POOL-PEN-001", "tramo": "junior", "contract_id": "C..." }
     ]
   }
   ```

   Este archivo es la evidencia versionada que el `README` cita (requisito de la hackatón: "un
   contrato desplegado y/o transacción comprobable en testnet, con su ID/hash incluible en el
   README") — nunca contiene ninguna llave secreta, solo IDs y llaves públicas.

## Orden de despliegue global (repite lo ya dicho en `plan.md`, aquí en detalle de este script)

Este script se ejecuta **antes** de aplicar las migraciones que dependen de `configuracion_red`
teniendo datos reales (aunque la tabla en sí la crea una migración vacía primero — `research.md`
"Cómo se entera el sistema del ID del contrato" del prompt del usuario): la migración crea la
tabla, este script la puebla, y solo entonces las Edge Functions que la leen (`asignar-factura`,
`confirmar-aporte`, `provision-pool-tramo-token`) pueden invocar contratos con éxito.

## Fuera de este contrato

- No instancia contratos para pools/tramos creados **después** de la primera ejecución — eso lo
  hace `provision-pool-tramo-token` (webhook automático) de forma continua.
- No decide cuándo redesplegar el WASM — un cambio de código del contrato es una decisión manual
  del equipo, documentada en el mensaje de commit correspondiente (Principio III/constitución:
  cambios de stack/arquitectura no requieren proceso formal, basta con dejar constancia).
