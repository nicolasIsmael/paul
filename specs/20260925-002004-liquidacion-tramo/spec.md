# Feature Specification: Liquidación de tramo (cobro simulado, camino feliz)

**Feature Branch**: `20260925-002004-liquidacion-tramo`

**Created**: 2026-09-25

**Status**: Draft

**Input**: User description: "Liquidación de tramo (cobro simulado, camino feliz): cuando todas
las facturas que respaldan un tramo de un pool ya fueron marcadas como cobradas por el operador de
banco, ese mismo operador puede liquidar el tramo completo. Al liquidar, el sistema le paga a cada
inversionista que tiene fracciones confirmadas en ese tramo su capital más el rendimiento
ilustrativo del tramo (rendimiento_ilustrativo_plazo_pct), en XLM real sobre Stellar testnet,
calculado sobre las fracciones que ese inversionista realmente tiene on-chain (balance real en el
contrato del tramo, no un cálculo derivado solo de Postgres). Después de pagarle, se queman (burn)
esas fracciones en el contrato del tramo, firmando con la propia llave del inversionista (ya
custodiada en Vault, mismo patrón que la llave admin). El tramo pasa a un estado terminal
'liquidado'. Si el pago o la quema de un inversionista particular falla tras reintentos, se
compensa solo a esa persona (se revierte lo que se le haya alcanzado a cobrar/pagar) y el resto de
los inversionistas del tramo se sigue procesando con normalidad — no es todo o nada para el tramo
completo. Explícitamente fuera de alcance: manejo de mora o pago parcial del deudor, reparto real
de pérdidas entre tramo senior y junior (waterfall), liquidación a nivel de una sola factura
individual (la liquidación es siempre del tramo completo), y cualquier cálculo de rendimiento
distinto al ya sembrado. Reglas: (1) solo un operador de banco puede iniciar la liquidación de un
tramo; (2) el sistema debe exigir que el 100% de las facturas asignadas a ese tramo estén en
estado_cobro='cobrada' antes de permitir liquidar; (3) un tramo sin ningún aporte confirmado
también debe poder liquidarse; (4) una vez liquidado, un tramo nunca vuelve a un estado anterior."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Liquidar un tramo con inversionistas reales (Priority: P1)

Un operador de banco, después de haber marcado como "cobrada" cada una de las facturas que
respaldan un tramo, decide liquidarlo. El sistema le paga a cada inversionista que aportó a ese
tramo su capital más el rendimiento ilustrativo, en XLM real, y quema sus fracciones. El tramo
queda cerrado para siempre.

**Why this priority**: Es el cierre del ciclo completo de inversión (aportar → recibir fracciones
→ cobrar) que hoy no existe en el sistema. Sin esta historia, el producto nunca le devuelve dinero
a nadie — es el hueco de alcance más importante detectado.

**Independent Test**: Se puede probar liquidando un tramo real (ej. Manufactura Sur, tramo senior)
que ya tenga al menos un aporte confirmado, y verificando de forma independiente (Horizon +
`stellar contract invoke`) que el inversionista recibió el pago real y que su `balance()` on-chain
bajó a 0.

**Acceptance Scenarios**:

1. **Given** un tramo con todas sus facturas asignadas en `estado_cobro='cobrada'` y con
   inversionistas con aportes confirmados, **When** el operador de banco liquida el tramo,
   **Then** cada inversionista recibe en su wallet el pago correspondiente (capital + rendimiento
   ilustrativo) en una transacción real de Stellar testnet, sus fracciones quedan en 0 en el
   contrato, y el tramo queda en estado `liquidado`.
2. **Given** un tramo ya liquidado, **When** alguien intenta liquidarlo de nuevo, **Then** el
   sistema rechaza la operación (estado terminal).

---

### User Story 2 - Rechazar la liquidación si falta cobrar una factura (Priority: P2)

Un operador de banco intenta liquidar un tramo, pero todavía hay al menos una factura asignada a
ese tramo que no fue marcada como "cobrada". El sistema no permite liquidar y explica por qué.

**Why this priority**: Evita el error más costoso posible de esta feature — pagarle de más (o
antes de tiempo) a un inversionista con dinero que en la realidad todavía no entró.

**Independent Test**: Se puede probar intentando liquidar un tramo con una factura en estado
`pendiente` o `en_mora`, y confirmando que la operación se rechaza sin mover ni un XLM.

**Acceptance Scenarios**:

1. **Given** un tramo con al menos una factura asignada cuyo `estado_cobro` no es `cobrada`,
   **When** el operador intenta liquidar el tramo, **Then** el sistema rechaza la operación,
   indica cuál factura falta, y no se mueve dinero ni se quema ninguna fracción.

---

### User Story 3 - Liquidar un tramo sin ningún aporte confirmado (Priority: P3)

Un tramo nunca recibió un aporte real de ningún inversionista. El operador igual puede liquidarlo,
para cerrarlo administrativamente.

**Why this priority**: Caso de borde real (varios de los tramos sembrados hoy no tienen aportes
todavía) — sin esta historia, esos tramos quedarían imposibles de cerrar.

**Independent Test**: Se puede probar liquidando un tramo sembrado sin aportes y confirmando que
queda en `liquidado` sin generar ningún pago ni error.

**Acceptance Scenarios**:

1. **Given** un tramo con todas sus facturas (si tiene alguna) en `cobrada` y sin ningún aporte
   confirmado, **When** el operador lo liquida, **Then** el tramo pasa a `liquidado` sin generar
   pagos ni quemas, y sin error.

---

### Edge Cases

- ¿Qué pasa si el pago o la quema de un inversionista falla después de agotar los reintentos? El
  sistema compensa solo a esa persona (revierte lo ya ejecutado para ella) y sigue liquidando al
  resto del tramo con normalidad — un fallo individual no bloquea a los demás inversionistas.
- ¿Qué pasa si un inversionista tiene un aporte confirmado en Postgres pero su balance real
  on-chain es 0 (por ejemplo, por una inconsistencia previa)? El sistema paga y quema en base al
  balance real on-chain, nunca en base a lo que diga Postgres por sí solo — si el balance real es
  0, no se le genera ningún pago a esa persona.
- ¿Qué pasa si se intenta iniciar una segunda liquidación sobre un tramo que ya está en proceso de
  liquidarse? Se rechaza — solo puede haber una liquidación en curso por tramo a la vez.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: El sistema MUST permitir a una cuenta con rol operador de banco iniciar la
  liquidación de un tramo específico.
- **FR-002**: El sistema MUST impedir que cualquier cuenta sin rol operador de banco liquide un
  tramo.
- **FR-003**: El sistema MUST rechazar la liquidación de un tramo si existe al menos una factura
  asignada a ese tramo cuyo `estado_cobro` no sea `cobrada`.
- **FR-004**: El sistema MUST calcular el pago de cada inversionista con aportes confirmados en
  ese tramo a partir de sus fracciones reales verificadas on-chain (`balance()` del contrato del
  tramo), nunca a partir de un valor derivado únicamente de Postgres.
- **FR-005**: El sistema MUST calcular el monto a pagar a cada inversionista como: fracciones
  reales on-chain × `unidad_minima_aporte` del pool × (1 + `rendimiento_ilustrativo_plazo_pct` del
  tramo / 100).
- **FR-006**: El sistema MUST pagar ese monto en XLM real, en Stellar testnet, desde la wallet de
  custodia del pool hacia la wallet del inversionista.
- **FR-007**: Tras un pago exitoso, el sistema MUST quemar (`burn`) las fracciones correspondientes
  de ese inversionista en el contrato del tramo, firmando la operación con la llave propia del
  inversionista.
- **FR-008**: Si el pago o la quema de un inversionista particular falla tras agotar los
  reintentos, el sistema MUST compensar solo a ese inversionista (revirtiendo lo que ya se le haya
  ejecutado) sin afectar el procesamiento del resto de los inversionistas del mismo tramo.
- **FR-009**: El sistema MUST permitir liquidar un tramo que no tiene ningún aporte confirmado,
  dejándolo en estado `liquidado` sin generar pagos.
- **FR-010**: El sistema MUST marcar el tramo como `liquidado` de forma terminal una vez completado
  el proceso, sin permitir que vuelva a un estado anterior.
- **FR-011**: El sistema MUST impedir iniciar una nueva liquidación sobre un tramo que ya está
  `liquidado` o que ya tiene una liquidación en curso.

### Key Entities

- **Tramo**: entidad ya existente; incorpora un estado terminal de liquidación
  (activo / liquidando / liquidado) además de sus atributos actuales (cupo, rendimiento
  ilustrativo, moneda).
- **Liquidación de tramo**: el proceso de cierre en sí — quién lo inició, cuándo, y el resultado
  agregado (cuántos inversionistas se pagaron, cuántos quedaron compensados por fallo).
- **Pago de liquidación por inversionista**: el detalle por persona — monto pagado, fracciones
  quemadas, hash de la transacción de pago, hash de la transacción de quema, y si terminó pagado o
  compensado (revertido).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un operador de banco puede liquidar un tramo real con inversionistas y confirmar,
  para el 100% de ellos, que recibieron su pago correspondiente en una sola operación.
- **SC-002**: El 100% de los pagos generados por una liquidación son verificables de forma
  independiente (fuera del propio sistema) sin depender de lo que el sistema reporte.
- **SC-003**: Si el pago de un inversionista específico falla, el resto de los inversionistas del
  mismo tramo terminan liquidados igual, sin intervención manual adicional.
- **SC-004**: Un tramo sin ningún aporte se puede liquidar sin generar ningún error.

## Assumptions

- El rendimiento a pagar es el ya sembrado en el tramo (`rendimiento_ilustrativo_plazo_pct`); esta
  feature no introduce ningún cálculo financiero nuevo.
- Manejo de mora, pago parcial del deudor, y reparto real de pérdidas entre tramo senior y junior
  (waterfall) quedan fuera de alcance — se documentan como limitación conocida, no se resuelven
  acá.
- La liquidación es siempre a nivel de tramo completo; no existe una liquidación parcial a nivel de
  una sola factura individual.
- El operador de banco es responsable de confirmar manualmente (marcando cada factura como
  `cobrada`, función ya existente) que el cobro real ya ocurrió fuera del sistema — esta feature no
  verifica el cobro real por sí misma, solo exige que ese paso ya se haya hecho.
- Las llaves privadas de los inversionistas ya están custodiadas por el sistema (mismo mecanismo
  usado hoy para la llave del administrador), lo que permite firmar la quema de fracciones en su
  nombre sin pedirles una acción manual.
