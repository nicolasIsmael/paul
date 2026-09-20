# Contrato: Saldo de demostración (`mi_saldo_demostracion` / `recargar_saldo_demo`)

Dos funciones RPC `security definer`, expuestas vía `/rest/v1/rpc/...`. Cubren Historia 3 (FR-001
a FR-008). Restringidas a cuentas `authenticated` con `perfiles.rol = 'inversionista'` — una
cuenta de operador recibe `PA008` en `recargar_saldo_demo` (`mi_saldo_demostracion` puede
devolver simplemente un array vacío para un operador, ya que no tiene saldo, sin necesidad de
tratarlo como error).

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

## Recargar — `recargar_saldo_demo`

```ts
const { data, error } = await supabase.rpc("recargar_saldo_demo", {
  p_moneda: "PEN" | "USD",
  p_monto: 200.00,
});
```

**Respuesta (éxito)**:

```json
{
  "saldo_actualizado": 550.00,
  "moneda": "PEN",
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
- La recarga **no mueve XLM en la red** — es puramente contable (`saldos_demostracion.saldo +=
  p_monto`), y así se documenta explícitamente en cualquier superficie que la muestre (FR-008).

## Errores

| Código | Cuándo |
|---|---|
| `PA008` | La cuenta que llama no tiene `rol = 'inversionista'` |
| `PA007` | La billetera del inversionista todavía se está creando (`perfiles.wallet_public_key IS NULL`) — no puede recargar, sí puede seguir explorando pools |
| `PA011` | La recarga solicitada, sumada a lo ya recargado hoy (hora de Lima), excede el tope; el cuerpo del error incluye `disponible_para_recargar_hoy` y `se_reinicia_at` igual que en el éxito, para que el cliente pueda mostrar cuánto queda sin una segunda llamada |
| `PA010` | `p_moneda = 'USD'` y no hay tipo de cambio de referencia disponible para convertir al tope compartido en soles |
