# Contrato: reloj de demo por pool (RPC)

Dos funciones RPC de Postgres (PostgREST), sin Edge Function: no mueven dinero on-chain. Ambas
`security definer`, `set search_path = ''`, con `revoke all` a `public`/`anon` y `grant execute`
a `authenticated`. Migración `0020_reloj_pool.sql`. Cubre la Historia 4 (FR-027 – FR-035) con el
alcance **por pool** decidido en el plan (ver `research.md` §3).

## `avanzar_reloj_pool`

```http
POST /rest/v1/rpc/avanzar_reloj_pool
Authorization: Bearer <jwt del operador de banco>

{ "p_pool_id": "uuid", "p_dias": 30, "p_horas": 0 }
```

- Solo `perfiles.rol = 'operador_banco'` → si no, `PA008`.
- `p_dias * 24 + p_horas` debe ser `> 0` y `<= 366 * 24` → si no, `PA037` (el reloj solo avanza).
- Pool inexistente → `PA012`.
- Crea la fila de `reloj_pool` si no existe; suma el avance; inserta la fila de historial en
  `reloj_pool_avances`. **No modifica ningún estado de negocio** (FR-034): no cobra, no marca mora,
  no reparte. Sí hace que las cotizaciones y reservas pendientes de ese pool caduquen si su
  ventana quedó atrás del nuevo reloj (se liberan en la siguiente llamada de `reservar_aporte`).

Respuesta `200`:

```json
{
  "pool_id": "uuid",
  "ahora_real": "2026-09-23T21:00:00Z",
  "ahora_efectivo": "2026-10-23T21:00:00Z",
  "desplazamiento_dias": 30,
  "adelantado": true
}
```

## `estado_reloj_pool`

```http
POST /rest/v1/rpc/estado_reloj_pool
{ "p_pool_id": "uuid" }
```

Devuelve el mismo objeto sin modificar nada (FR-031). Disponible para cualquier usuario
autenticado (un inversionista necesita saber contra qué fecha se evalúa lo que ve). Sin fila de
reloj → `desplazamiento_dias: 0`, `adelantado: false`, `ahora_efectivo = ahora_real` (FR-027).

## Efecto sobre otras funciones (contrato de comportamiento)

| Función | Comportamiento con reloj adelantado |
|---------|--------------------------------------|
| `cotizar_aporte` / `reservar_aporte` | ventanas de 5 min y 2 min medidas en tiempo efectivo **del pool de la cotización**; limpieza por fila contra el reloj de su pool |
| `detalle_pool` / `facturas_del_pool` | exponen `fecha_efectiva`, `vencida` (por factura) y `pool_vencido` |
| `registrar_factura`, `recargar-wallet`, aportes | siguen funcionando: `registrar_factura` no compara con "hoy"; las recargas usan reloj real; los aportes se evalúan contra el reloj de su pool |
| Cobro y reparto | guardan `*_efectivo_at` además del `*_at` real |

Un reloj adelantado en un pool **no** cambia nada en otro pool (`ahora_pool` es la única puerta
de lectura y recibe el `pool_id` explícito). El quickstart lo verifica con dos pools en paralelo.
