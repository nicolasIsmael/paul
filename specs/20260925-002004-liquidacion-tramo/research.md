# Research: Liquidación de Tramo (Cobro Simulado, Camino Feliz)

El Technical Context del plan no dejó ningún `NEEDS CLARIFICATION` — las decisiones de diseño ya
venían resueltas en el feature description original. Este documento consolida el razonamiento
detrás de las decisiones no triviales, para que quien lea el código después entienda el porqué, no
solo el qué.

## 1. Fuente de verdad del monto a pagar: `balance()` on-chain, nunca `aportes` de Postgres

**Decisión**: antes de pagarle a un inversionista, la Edge Function llama
`consultarSoloLectura(tokenContractId, "balance", [investorAddress])` y usa ese número — nunca
`sum(monto_nominal) / unidad_minima_aporte` calculado solo desde `public.aportes`.

**Rationale**: esta misma sesión de trabajo encontró un caso real (pool "Retail Norte") donde
Postgres decía `fracciones_totales > 0` pero el contrato real tenía `cap`/`total_supply` en 0 —
una desincronización causada por datos de seed con hashes de transacción falsos. Si la liquidación
hubiera confiado en Postgres, habría pagado dinero real a inversionistas que on-chain no tenían
ninguna fracción. Leer el contrato directamente es la única fuente que no puede mentir sobre cuánto
tiene cada quien — es la aplicación directa del Principio VI (evidencia on-chain real) al momento
de pagar, no solo al momento de emitir.

**Alternativas consideradas**: mantener un contador de fracciones espejado en `aportes` y confiar
en él. Se descartó porque reintroduce exactamente el mismo riesgo de desincronización ya vivido, y
porque no existe hoy (agregarlo sería una migración adicional no justificada solo para esta
feature).

## 2. Firmar `burn` con el secreto del inversionista, reutilizando `invocarContratoAdmin` tal cual

**Decisión**: no se escribe una función nueva. `invocarContratoAdmin`/
`invocarContratoAdminConReintentos` (`_shared/stellar-soroban.ts`) reciben el secreto a usar como
parámetro (`secretoAdmin` es solo un nombre de variable, no una validación de que sea
específicamente la cuenta admin) — se les pasa el secreto del inversionista (obtenido de Vault,
mismo mecanismo ya usado por `confirmar-aporte` para pagar su aporte) en vez del secreto de
`operador_authority`.

**Rationale**: el contrato exige `from.require_auth()` en `burn` (`lib.rs:278-292`) — es decir,
solo el dueño de las fracciones puede quemarlas, ni siquiera el admin de la plataforma puede
forzarlo. Como las llaves de los inversionistas ya viven en Vault (mismo patrón que la llave
admin), la Edge Function puede firmar en su nombre sin pedirles ninguna acción manual. Reutilizar
la función existente evita duplicar la lógica de simulación/envío/confirmación/reintentos que ya
está probada en producción (validada durante la spec de originación de facturas).

**Efecto colateral favorable**: `conLockFirma` (`_shared/lock-firma.ts`) usa la clave pública del
firmante como llave del lock — como cada inversionista firma con su propia cuenta (a diferencia de
`operador_authority`, que es una sola cuenta compartida por toda la plataforma), **no hay riesgo de
la condición de carrera** que motivó `0016_lock_firma_stellar.sql`. Cada quema de cada inversionista
usa su propio lock, naturalmente aislado.

## 3. Compensación por inversionista, nunca todo-o-nada para el tramo completo

**Decisión**: la Edge Function procesa a cada inversionista en su propia unidad de trabajo. Si el
pago o la quema de una persona falla tras 3 reintentos, se compensa solo a ella (revirtiendo el
pago ya hecho, si lo hubo) y el bucle continúa con el resto — el tramo puede terminar `liquidado`
con algunos inversionistas `pagado` y otros `compensado`.

**Rationale**: la propia feature description lo exige explícitamente (regla de negocio, no una
decisión técnica libre). Además, con N inversionistas por tramo, exigir que los N pagos salgan
perfectos para poder cerrar el tramo aumentaría la probabilidad de que un solo problema de red
transitorio bloquee a todo el mundo — el mismo espíritu de resiliencia que ya usa
`confirmar-aporte` (compensación individual por aporte, no un lote).

**Alternativas consideradas**: liquidación transaccional todo-o-nada (si un inversionista falla,
se revierte todo el tramo). Se descartó por la razón anterior y porque no la pide la spec.

## 4. Alcance de la liquidación: por tramo completo, nunca por factura individual

**Decisión**: no existe un "cobrar esta factura y pagar la porción correspondiente" — la
liquidación siempre paga el 100% de las fracciones reales de cada inversionista del tramo, una
sola vez, cuando el operador confirma que **todas** las facturas que lo respaldan ya se cobraron.

**Rationale**: un tramo puede estar respaldado por varias facturas (el cupo se acumula por cada
`register_invoice`). Prorratear un pago parcial factura-por-factura exigiría saber qué porción del
balance de cada inversionista "pertenece" a cada factura específica — un problema que empieza a
parecerse al reparto real de pérdidas entre tranches (waterfall) que la constitución del proyecto y
la spec de originación dejaron fuera de alcance a propósito. Limitar la liquidación al tramo
completo mantiene la feature dentro del tiempo disponible sin reabrir esa complejidad.

## 5. Sin cambios al contrato Soroban

**Decisión**: `burn` ya existe con la interfaz necesaria (`lib.rs:278-292`) — no se toca
`contracts/soroban-pool`.

**Rationale**: cualquier cambio al contrato implica un nuevo despliegue por cada una de las 12
instancias ya activas (una por tramo), con el riesgo operativo que eso implica a días de la
entrega. Como la funcionalidad necesaria ya existe, tocar el contrato sería trabajo — y riesgo —
no solicitado.
