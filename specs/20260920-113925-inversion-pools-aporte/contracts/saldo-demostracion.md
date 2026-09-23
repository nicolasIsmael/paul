# Contrato: saldo de demostración y recarga Stellar

La lectura se realiza mediante una RPC autenticada. La recarga pasa por la Edge Function
`recargar-wallet`, que envía XLM en Stellar Testnet antes de acreditar el saldo contable. Solo
las cuentas con `perfiles.rol = 'inversionista'` pueden recargar.

## Consultar saldo — `mi_saldo_demostracion`

```ts
const { data, error } = await supabase.rpc("mi_saldo_demostracion");
```

**Respuesta**:

```json
[
  { "moneda": "PEN", "saldo": 350.00 },
  { "moneda": "USD", "saldo": 0.00 }
]
```

Un array con, como máximo, una fila por moneda soportada (`PEN`, `USD`) en la que el inversionista
tenga saldo. Nunca incluye un equivalente en XLM (FR-038 de la spec: el saldo de demostración
queda exceptuado de mostrarse en XLM, al no estar denominado en XLM).

## Recargar — `recargar-wallet`

```ts
const response = await fetch(`${SUPABASE_URL}/functions/v1/recargar-wallet`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    moneda: "PEN",
    monto: 200,
    idempotency_key: crypto.randomUUID(),
  }),
});
```

**Respuesta (éxito)**:

```json
{
  "ok": true,
  "recarga_id": "5de5a746-8f0f-457b-b199-1ff086b2eb00",
  "saldo_actualizado": 550.00,
  "moneda": "PEN",
  "monto_xlm": 555.5555556,
  "tx_hash": "a73c...9fe1",
  "wallet_public_key": "GBID...Q3EO",
  "balance_xlm": 9166.3955323,
  "red": "stellar-testnet",
  "recargado_hoy_equivalente_soles": 550.00,
  "tope_diario_equivalente_soles": 1000.00,
  "disponible_para_recargar_hoy": 450.00,
  "se_reinicia_at": "2026-09-21T05:00:00Z"
}
```

- El tope es de **S/1000 (o su equivalente en dólares al tipo de cambio vigente) por día natural
  en hora de Lima**, compartido entre ambas monedas (recargar US$100 y luego S/500 el mismo día
  consume del mismo tope). `se_reinicia_at` es siempre las 00:00 hora de Lima del día siguiente,
  expresado en UTC.
- La misma `idempotency_key` siempre resuelve la misma recarga y el mismo hash; un reintento no
  puede enviar un segundo pago.
- El saldo contable se incrementa solo después de que Horizon acepta el pago. La respuesta incluye
  el hash para abrir el comprobante en Stellar Expert.
- El XLM es de **Testnet** y no tiene valor monetario real. El saldo PEN/USD sigue siendo crédito
  contable de demostración.

## Errores

| Código | Cuándo |
|---|---|
| `PA008` | La cuenta que llama no tiene `rol = 'inversionista'` |
| `PA007` | La billetera del inversionista todavía se está creando (`perfiles.wallet_public_key IS NULL`) — no puede recargar, sí puede seguir explorando pools |
| `PA011` | La recarga solicitada, sumada a lo ya recargado hoy (hora de Lima), excede el tope; el cuerpo del error incluye `disponible_para_recargar_hoy` y `se_reinicia_at` igual que en el éxito, para que el cliente pueda mostrar cuánto queda sin una segunda llamada |
| `PA010` | `p_moneda = 'USD'` y no hay tipo de cambio de referencia disponible para convertir al tope compartido en soles |
| `PA013` | Horizon, la tesorería de Testnet o la confirmación de la recarga no están disponibles |
