# Extensión: Edge Function `confirmar-aporte` (existente, spec previa)

Documenta únicamente el **delta** sobre `specs/20260920-113925-inversion-pools-aporte/contracts/
confirmar-aporte-function.md`, que sigue siendo la referencia completa de los pasos 1–2 (reserva)
y 4 (chequeo de reserva mínima XLM). No se edita ese archivo (spec ya cerrada); esta feature
modifica `supabase/functions/confirmar-aporte/index.ts` directamente. Cubre FR-017, FR-018, FR-027
de esta spec.

## Paso nuevo, insertado entre "pago XLM" y "confirmar" del flujo original

Orden completo tras esta extensión (ver `data-model.md` → ciclo de vida extendido del Aporte):

```
reservar (Postgres) → pagar XLM (Horizon) → EMITIR FRACCIONES (Soroban, nuevo) → confirmar (Postgres)
```

1. Tras someter el pago XLM con éxito (paso 5 del contrato original), antes de llamar a
   `confirmar_aporte`:
   - Si `aportes.fraccion_tx_hash` de este `aporte_id` **ya** está poblado (reintento de la propia
     solicitud tras una respuesta perdida — `research.md` §2), se omite este paso por completo y
     se salta directo a leer el aporte confirmado.
   - Si no, se lee `tramos.token_contract_id` del tramo del aporte y `obtener_secreto_autoridad_
     operador()` + `obtener_configuracion_red()`.
   - Se calcula `amount := monto_nominal / pools.unidad_minima_aporte` (siempre un entero exacto —
     ya garantizado por `PA001` en `cotizar_aporte`, que solo acepta montos múltiplos de la unidad
     mínima).
   - Se invoca `mint(investor_address, amount)` en el contrato del tramo
     (`_shared/stellar-soroban.ts`), con hasta 3 intentos y backoff corto.
2. **Mint exitoso**: se guarda `fraccion_tx_hash` y se procede a `confirmar_aporte` exactamente
   como antes (sin cambios en esa función de Postgres).
3. **Mint fallido tras 3 intentos** (o el contrato rechaza con `CapExceeded` — defensa en
   profundidad, no debería ocurrir dado que Postgres ya reservó el cupo monetario equivalente,
   `research.md` §2):
   - Se somete una transacción **compensatoria**: XLM desde `pools.custody_public_key` de vuelta a
     la wallet del inversionista, por el mismo `monto_xlm` ya pagado, firmada con el secreto de
     custodia del pool (nueva función de apoyo `obtener_secreto_custodia_pool(pool_id)`,
     `service_role`, mismo patrón que `obtener_secreto_wallet`).
   - Si la compensación se somete con éxito: `revertir_aporte(aporte_id, 'fallo_emision_
     fracciones')` (libera cupo y saldo demo) → responde `ok:false`, `PA019`, incluyendo el hash
     de la compensación (`reembolso.tx_hash`) para trazabilidad.
   - Si la propia compensación falla (Horizon no disponible dos veces seguidas): se responde
     `ok:false`, `PA013`, **sin** llamar a `revertir_aporte` — el aporte queda deliberadamente en
     `'reservado'` con el pago XLM ya hecho y sin fracciones emitidas, para que un operador lo
     reconcilie manualmente (límite conocido documentado en `plan.md` → Riesgos; el único caso en
     todo este diseño donde se acepta un estado que exige intervención humana, dado lo
     extremadamente improbable del escenario en testnet durante el plazo del hackatón).

## Salida (campos nuevos sobre el contrato original)

**Éxito** (`200`) — se agrega `comprobante.fraccion_tx_hash` y `comprobante.contrato`:

```json
{
  "ok": true,
  "aporte": { "...": "... (sin cambios) ..." },
  "comprobante": {
    "tx_hash": "abc123...",
    "fraccion_tx_hash": "ghi789...",
    "contrato": "C...",
    "red": "stellar-testnet",
    "simulado": false
  }
}
```

**Fallo por emisión de fracciones** (`400`):

```json
{
  "ok": false,
  "error": { "code": "PA019", "message": "No se pudieron emitir las fracciones on-chain; el pago se revirtió automáticamente." },
  "reembolso": { "tx_hash": "jkl012...", "red": "stellar-testnet" }
}
```

## Fuera de este contrato

- No cambia nada de los pasos 1–2 y 4 ya documentados en la spec previa (reserva, lectura de
  secretos, chequeo de reserva mínima XLM) — siguen exactamente igual.
- No reintenta el pago XLM si el mint falla — el pago ya se ejecutó; solo se compensa (nunca se
  "reintenta" un pago que ya tuvo éxito).
