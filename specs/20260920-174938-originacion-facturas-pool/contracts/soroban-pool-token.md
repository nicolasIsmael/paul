# Contrato: `pool_fraction_token` (Soroban, Rust) — `contracts/soroban-pool`

Una instancia por tramo (`research.md` §1). Implementa la interfaz de token SEP-41 completa más
dos extensiones administrativas (`register_invoice`, `mint`) restringidas al `admin` de esa
instancia. `decimals = 0`: 1 unidad de token = 1 fracción = 1 `unidad_minima_aporte` del pool
(Postgres decide los montos monetarios; el contrato solo cuenta enteros).

## Tipos

```rust
#[contracttype]
pub enum DataKey {
    Admin,
    Decimals,
    Name,
    Symbol,
    Cap,
    TotalSupply,
    Balance(Address),
    Allowance(Address, Address),
    Factura(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    NotAuthorized = 3,
    CapExceeded = 4,
    CapCannotDecrease = 5,
    InvoiceAlreadyRegistered = 6,
    InsufficientBalance = 7,
    InsufficientAllowance = 8,
}
```

## Funciones

| Función | Autorización | Descripción |
|---|---|---|
| `initialize(admin: Address, pool_ref: String, tramo: Symbol)` | ninguna (solo una vez — falla con `AlreadyInitialized` si ya se llamó) | Fija `Admin`, `Decimals=0`, `Cap=0`, `TotalSupply=0`. `pool_ref`/`tramo` son metadata informativa (código del pool + `senior`/`junior`), no se usan en ninguna validación. |
| `set_admin(new_admin: Address)` | `admin.require_auth()` | Rotación de autoridad (`research.md` §5). |
| `register_invoice(invoice_hash: BytesN<32>, new_cap: i128)` | `admin.require_auth()` | Rechaza con `InvoiceAlreadyRegistered` si `invoice_hash` ya existe en `Factura(...)`. Rechaza con `CapCannotDecrease` si `new_cap < Cap` (el cupo solo crece — FR-012, una asignación confirmada es irreversible). Guarda `Factura(invoice_hash) = new_cap - Cap` (el incremento atribuido a esa factura) y actualiza `Cap = new_cap`. Emite el evento `("factura_registrada", invoice_hash, new_cap)`. Extiende el TTL de la instancia y de `Cap` al máximo permitido (`research.md` §3). |
| `mint(to: Address, amount: i128)` | `admin.require_auth()` | Rechaza con `CapExceeded` si `TotalSupply + amount > Cap`. Incrementa `Balance(to)` y `TotalSupply`. Emite `("fracciones_emitidas", to, amount)`. Extiende el TTL de `Balance(to)`. |
| `balance(id: Address) -> i128` | ninguna (lectura pública) | `Balance(id)` o `0` si no existe. |
| `decimals() -> u32` | ninguna | Siempre `0`. |
| `name() -> String` / `symbol() -> String` | ninguna | Fijados en `initialize` a partir de `pool_ref`/`tramo` (p. ej. `"POOL-PEN-001 · senior"` / `"PPS1S"`). |
| `cap() -> i128` / `total_supply() -> i128` | ninguna | Lectura directa de `Cap`/`TotalSupply` — extensiones propias, fuera del set mínimo de SEP-41 pero necesarias para que un tercero verifique el cupo sin conocer Postgres. |
| `transfer(from: Address, to: Address, amount: i128)` | `from.require_auth()` | SEP-41 estándar, incluido por completitud de interfaz (Principio VI — evidencia on-chain real y verificable con herramientas genéricas de Soroban). **No se invoca desde ningún flujo de este producto** — el mercado secundario está fuera de alcance de la spec. |
| `approve(from: Address, spender: Address, amount: i128, live_until_ledger: u32)` / `allowance(from: Address, spender: Address) -> i128` | `from.require_auth()` (solo `approve`) | SEP-41 estándar, mismo motivo que `transfer` — no usado por el producto. |
| `burn(from: Address, amount: i128)` | `from.require_auth()` | SEP-41 estándar — no usado por el producto en esta iteración. |

## Invariantes que el contrato garantiza por sí mismo (no solo Postgres)

- `TotalSupply` nunca excede `Cap` (`mint` es la única vía de incrementar `TotalSupply`, y siempre
  valida antes de escribir) — FR-014, cumplido incluso si Postgres tuviera un error, porque la
  validación vive dentro de la transacción del contrato, no antes de invocarlo.
- Ninguna operación administrativa (`register_invoice`, `mint`, `set_admin`) se ejecuta sin la
  firma del `admin` vigente — FR-015.
- El contrato nunca almacena `proveedor`/`deudor`/ningún dato identificable — únicamente
  `BytesN<32>` (huella) e importes enteros de fracciones — FR-016.
- `Cap` nunca decrece (`register_invoice` lo rechaza) — refuerza en la capa on-chain la
  irreversibilidad de una asignación confirmada (FR-012).

## Fuera de este contrato

- No calcula anticipos, montos monetarios, unidad mínima, ni ningún tipo de cambio — esa
  aritmética vive exclusivamente en Postgres (`research.md` §1).
- No implementa reparto entre tramos, cobro, liquidación ni cálculo de rendimiento — cada
  instancia solo conoce su propio tramo, nunca el otro tramo del mismo pool ni ninguna noción de
  pérdida o retorno (fuera de alcance de la spec).
- No impone ninguna restricción sobre `transfer`/`approve` más allá de la firma del dueño del
  balance — un mercado secundario, si se construyera a futuro, no necesitaría cambiar este
  contrato.
