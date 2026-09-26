# Feature Specification: Cobro de Facturas, Reparto de Retornos y Reloj de Demo

**Feature Branch**: `20260923-210731-cobro-reparto-retornos`

**Created**: 2026-09-23

**Status**: Draft

**Input**: User description: "Cerrar el ciclo completo del pool: hoy el inversionista aporta XLM real y el operador de banco registra y asigna facturas a un pool, pero ninguna factura se da por cobrada ni el dinero vuelve a los inversionistas. Se necesitan tres piezas conectadas: (1) Cobro de una factura como simulación del pago del deudor — acción exclusiva del operador de banco sobre una factura ya asignada a un pool, que genera una transacción real en Stellar testnet (XLM de una cuenta que representa al deudor hacia la cuenta de custodia del pool) y deja la factura en estado \"cobrada\"; también debe poder marcarse una factura como \"en mora\" para demostrar que el tramo junior absorbe la pérdida. (2) Reparto del pool a los inversionistas cuando todas las facturas de un tramo llegan a un estado final (cobrada o en mora), o cuando el operador lo fuerza manualmente: el rendimiento de cada factura cobrada es su monto nominal menos el anticipo financiado y se acumula a nivel del tramo; las pérdidas por mora se restan primero del capital del tramo junior y el senior solo se ve afectado si las pérdidas superan todo lo aportado por el junior; cada inversionista recibe en una sola transacción real en Stellar testnet, hacia su wallet de la plataforma, su capital aportado más (o menos) su parte proporcional del rendimiento o pérdida según sus fracciones; el reparto es un evento único, irreversible y deja el tramo cerrado. (3) Reloj simulado para la demo: toda regla de negocio que depende de la fecha/hora actual debe poder evaluarse contra una fecha simulada, con una acción para avanzarla hacia adelante, sin afectar el funcionamiento normal del resto del sistema. Solo backend/API. Fuera de alcance: deudores o proveedores reales, interfaz de usuario, quema (burn) de las fracciones on-chain tras el reparto."

## Clarifications

### Session 2026-09-23

- Q: Al repartir, ¿se devuelve a cada inversionista los XLM que pagó al aportar o su monto nominal convertido a XLM con el tipo de cambio del día del reparto? → A: Se devuelven los XLM originalmente pagados; el rendimiento y la pérdida (calculados en la moneda del pool) se convierten a XLM con el tipo de cambio vigente al momento del reparto. En la plataforma solo se mueve XLM; la equivalencia en soles o dólares es solo informativa.
- Q: El rendimiento de una factura cobrada, ¿se queda entero en el tramo de la factura o el junior recibe una ganancia mayor por asumir más riesgo? → A: Se queda entero en el tramo de la factura y se reparte solo entre sus inversionistas; no hay transferencia de rendimiento entre tramos. La mayor ganancia potencial del junior depende de las facturas y anticipos que el operador le asigna, no de una regla adicional de reparto.
- Ajuste de diseño (plan, 2026-09-23): el reloj simulado pasa de global a **por pool**, para poder mostrar varios pools en paralelo sin interferencia; se actualizaron Historia 4, FR-027 a FR-032, la entidad Reloj, SC-009 y Assumptions.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Simular el cobro de una factura por el deudor (Priority: P1)

Un operador de banco selecciona una factura ya asignada a un pool y simula que el deudor pagó su monto nominal completo. El sistema ejecuta una transferencia real en Stellar testnet desde una cuenta que representa al deudor hacia la cuenta de custodia del pool, y solo después de confirmarse esa transferencia la factura pasa a estado "cobrada", dejando un comprobante verificable. Alternativamente, el operador puede marcar la factura como "en mora", sin ningún movimiento de dinero.

**Why this priority**: Es el primer eslabón que hace que el dinero vuelva al pool; sin facturas cobradas (o en mora) no existe nada que repartir, y es la primera evidencia on-chain del retorno que el pitch necesita mostrar. Puede probarse de forma aislada, sin que exista todavía el reparto.

**Independent Test**: Con una factura asignada a un pool de ejemplo, simular su cobro y verificar en Stellar testnet que el monto nominal equivalente salió de la cuenta del deudor hacia la custodia del pool, que la factura quedó "cobrada", y que un rol distinto de operador de banco no puede ejecutar la acción. Repetir con otra factura marcándola "en mora" y verificar que no hubo movimiento de dinero.

**Acceptance Scenarios**:

1. **Given** un operador de banco autenticado y una factura en estado "pendiente" asignada a un pool, **When** simula el cobro, **Then** se ejecuta una transferencia real en Stellar testnet por el monto nominal completo de la factura desde la cuenta del deudor hacia la custodia del pool, y la factura pasa a "cobrada" con la referencia de la transacción registrada.
2. **Given** una factura "pendiente" asignada a un pool, **When** el operador la marca como "en mora", **Then** la factura pasa a "en mora" sin ningún movimiento de dinero y queda registrado quién y cuándo lo hizo.
3. **Given** una factura ya "cobrada" o "en mora", **When** el operador intenta cobrarla o marcarla de nuevo, **Then** el sistema rechaza la acción con un código de motivo y no genera ninguna transacción adicional.
4. **Given** una factura aprobada pero no asignada a ningún pool (o rechazada), **When** el operador intenta simular su cobro, **Then** el sistema rechaza la acción indicando que la factura no está asignada a un pool.
5. **Given** una cuenta con rol distinto de operador de banco, **When** intenta cobrar o marcar en mora una factura, **Then** el sistema rechaza la acción con un código de error y no cambia ningún estado.
6. **Given** que la transferencia on-chain falla (por ejemplo, saldo insuficiente en la cuenta del deudor o error de red), **When** el operador intenta simular el cobro, **Then** la factura permanece "pendiente", el sistema informa el motivo del fallo y el operador puede reintentar sin riesgo de un doble cobro.

---

### User Story 2 - Repartir el pool a los inversionistas de un tramo (Priority: P1)

Cuando todas las facturas del pool alcanzan un estado final (cobrada o en mora), el sistema calcula automáticamente el reparto y transfiere, en una sola transacción real en Stellar testnet por inversionista, el capital aportado más (o menos) su parte proporcional del rendimiento o de la pérdida del tramo, hacia la wallet de la plataforma de cada inversionista. Cada tramo (senior y junior) se reparte como un evento propio, único e irreversible, y queda cerrado. El inversionista no realiza ninguna acción. Se exige que todas las facturas del pool estén en estado final porque la pérdida de cualquier factura, de cualquier tramo, la absorbe primero el junior: sin conocer todas las pérdidas no se puede calcular con justicia el pago de ninguno de los dos tramos.

**Why this priority**: Es el argumento central del producto — que el inversionista recupera su dinero más un rendimiento — y cierra el ciclo aporte → cobro → reparto. Depende de la Historia 1 para tener facturas en estado final, pero puede probarse con datos de ejemplo que ya las tengan.

**Independent Test**: Con un tramo de ejemplo cuyas facturas están todas en estado final y con varios inversionistas con distinta cantidad de fracciones, ejecutar el reparto y verificar en Stellar testnet que cada inversionista recibió una única transacción con el monto esperado, que la suma de lo pagado no excede lo disponible en la custodia, y que un segundo intento de reparto sobre el mismo tramo es rechazado.

**Acceptance Scenarios**:

1. **Given** un pool cuyas facturas, en ambos tramos, están todas en estado final, **When** la última factura pasa a "cobrada" o "en mora", **Then** el sistema calcula el rendimiento de cada tramo como la suma de (monto nominal − anticipo financiado) de sus facturas cobradas y ejecuta automáticamente el reparto de cada tramo con inversionistas.
2. **Given** un tramo con rendimiento acumulado y varios inversionistas con fracciones, **When** se ejecuta el reparto, **Then** cada inversionista recibe una única transacción hacia su wallet por su capital aportado más su parte proporcional al número de fracciones que posee sobre el total de fracciones emitidas del tramo.
3. **Given** un pool donde una factura (de cualquier tramo) está "en mora" y las pérdidas no superan el capital aportado al tramo junior, **When** se ejecuta el reparto, **Then** las pérdidas se descuentan solo del capital de los inversionistas del tramo junior y los del tramo senior reciben su capital íntegro más el rendimiento de las facturas de su tramo.
4. **Given** un pool donde las pérdidas por mora superan todo lo aportado al tramo junior, **When** se ejecuta el reparto, **Then** el tramo junior recibe cero por su capital (conservando el rendimiento de las facturas cobradas de su tramo, si lo hubiera) y el exceso de pérdida reduce el capital del tramo senior de forma proporcional a sus fracciones.
5. **Given** un tramo cuyo reparto ya se ejecutó, **When** cualquier actor intenta ejecutarlo de nuevo o deshacerlo, **Then** el sistema lo rechaza con un código de motivo y no genera ninguna transacción; el tramo permanece "cerrado".
6. **Given** un reparto en curso en el que la transferencia a uno o más inversionistas falla, **When** el sistema reintenta, **Then** ningún inversionista recibe más de un pago, los ya pagados no se repiten, y el tramo solo se marca "cerrado" cuando todos los inversionistas del tramo fueron pagados.
7. **Given** que las fracciones on-chain de un tramo ya repartido, **When** se consultan en el contrato, **Then** siguen registradas a nombre de cada inversionista como historial de participación.

---

### User Story 3 - Forzar el reparto de un tramo antes de tiempo (Priority: P2)

Un operador de banco puede ejecutar manualmente el reparto de un tramo aunque no todas las facturas de su pool hayan llegado a un estado final, por ejemplo para no esperar en una demo. En el mundo real una factura vencida que el deudor no paga termina clasificada como mora; el cierre forzado aplica ese mismo criterio: todas las facturas aún pendientes del pool se marcan "en mora" (cierre forzado) en ese instante, sus anticipos se toman como pérdida absorbida primero por el junior, y el reparto sigue las mismas reglas que cualquier otro.

**Why this priority**: Da control al operador durante la demo y cubre el caso de facturas que no se cobran; no bloquea el flujo principal, que puede completarse marcando cada factura como cobrada o en mora.

**Independent Test**: Con un tramo que tiene al menos una factura pendiente, forzar el reparto como operador y verificar que se ejecuta con las reglas acordadas, que un rol distinto de operador no puede forzarlo, y que el tramo queda cerrado.

**Acceptance Scenarios**:

1. **Given** un pool con al menos una factura "pendiente" y un operador de banco autenticado, **When** fuerza el reparto de uno de sus tramos, **Then** todas las facturas pendientes del pool pasan a "en mora" con la marca de cierre forzado, se calcula la pérdida resultante y se ejecuta el reparto de ese tramo, que queda cerrado.
2. **Given** una cuenta con rol distinto de operador de banco, **When** intenta forzar el reparto, **Then** el sistema lo rechaza con un código de error y no genera ninguna transacción.
3. **Given** un tramo sin ninguna inversión (sin fracciones emitidas), **When** el operador fuerza el reparto, **Then** el sistema rechaza la acción indicando que no hay inversionistas a quienes repartir.
4. **Given** un operador que fuerza el reparto de un tramo, **When** el reparto se completa, **Then** queda registrado que fue forzado, por quién y cuándo, y qué facturas estaban pendientes y se marcaron en mora por ese cierre.
5. **Given** un reparto forzado que dejó todas las facturas del pool en estado final, **When** se completa, **Then** el otro tramo del pool pasa a ser repartible automáticamente con las mismas cifras de pérdida, sin recalcularse.

---

### User Story 4 - Adelantar el reloj del sistema para la demo (Priority: P2)

Un operador de banco puede avanzar la fecha simulada de un pool para mostrar el ciclo completo sin esperar tiempos reales de vencimiento. Cada pool tiene su propia fecha simulada, independiente de la de los demás, de modo que se pueden mostrar varios pools en paralelo sin que el adelanto de uno afecte a otro. Toda regla de negocio de un pool que depende de la fecha o la hora actual (vencimiento de sus facturas, vencimiento del pool, ventanas de validez de sus cotizaciones y reservas) se evalúa contra la fecha simulada de ese pool, mientras el resto de las operaciones (registro de facturas, aportes, recargas) sigue funcionando con normalidad.

**Why this priority**: Es lo que hace demostrable el ciclo en una demo en vivo de pocos minutos, pero el cobro y el reparto (Historias 1–3) pueden ejecutarse sin adelantar el reloj, por lo que no bloquea la entrega de valor principal.

**Independent Test**: Consultar la fecha simulada de dos pools, avanzar solo la de uno varios días y verificar que una factura de ese pool con vencimiento dentro del intervalo se evalúa como vencida, que el vencimiento del pool y las ventanas de validez usan la nueva fecha, que el otro pool no cambia, y que registrar una factura, aportar o recargar saldo siguen funcionando.

**Acceptance Scenarios**:

1. **Given** un pool sin reloj adelantado, **When** se consulta su fecha efectiva, **Then** coincide con la fecha real.
2. **Given** un operador de banco autenticado, **When** avanza el reloj de un pool una cantidad de tiempo positiva, **Then** la fecha simulada de ese pool aumenta exactamente en esa cantidad y la nueva fecha queda disponible para consulta.
3. **Given** el reloj de un pool adelantado, **When** se evalúan el vencimiento de una de sus facturas, el vencimiento del pool o una ventana de validez de ese pool, **Then** las tres reglas usan la fecha simulada de ese pool y no la real.
4. **Given** un operador que intenta retroceder o dejar igual el reloj de un pool, **When** envía la solicitud, **Then** el sistema la rechaza; el reloj solo avanza.
5. **Given** el reloj de un pool adelantado, **When** un operador registra una factura, un inversionista aporta a ese pool o a otro, o recarga saldo, **Then** cada operación se completa con normalidad; las reglas de fecha de un pool se evalúan contra su propia fecha simulada y las de otro pool no cambian.
6. **Given** una cuenta con rol distinto de operador de banco, **When** intenta avanzar el reloj de un pool, **Then** el sistema lo rechaza con un código de error.
7. **Given** dos pools mostrándose en paralelo, **When** se adelanta el reloj de uno, **Then** el vencimiento de facturas, el vencimiento y las ventanas de validez del otro pool no cambian.

---

### Edge Cases

- ¿Qué pasa si la cuenta que representa al deudor no tiene saldo suficiente para pagar el monto nominal? La transferencia falla, la factura permanece "pendiente" y el sistema informa el motivo; no se marca "cobrada".
- ¿Qué pasa si el operador pulsa dos veces "cobrar" o reintenta tras un error de red? Solo puede existir un cobro por factura; el reintento no genera un segundo pago ni una segunda transacción.
- ¿Qué pasa si la transacción de cobro se confirma en Stellar pero el sistema falla antes de registrarlo? El sistema reconcilia el estado contra la cadena en el siguiente intento, sin cobrar dos veces ni dejar la factura "pendiente" con dinero ya movido.
- ¿Qué pasa si dos facturas del mismo pool se cobran casi al mismo tiempo y ambas completan el pool? El reparto de cada tramo se dispara una sola vez.
- ¿Qué pasa si el operador fuerza el reparto a la vez que se dispara el reparto automático del mismo tramo? Solo uno se ejecuta; el otro se rechaza por tramo ya cerrado.
- ¿Qué pasa si una factura se cobra o se marca en mora después de que su tramo ya fue repartido? Tras un reparto forzado todas las facturas del pool ya están en estado final, por lo que cualquier cobro tardío se rechaza; el reparto es definitivo.
- ¿Qué pasa si las pérdidas superan el capital del tramo junior y del senior juntos? Ningún tramo puede pagar menos de cero; ambos reciben cero por su capital y el sistema registra la pérdida total.
- ¿Qué pasa si una factura de un tramo senior entra en mora? Su pérdida la absorbe primero el tramo junior, aunque la factura no sea de su tramo; el senior conserva íntegro su capital mientras la pérdida no supere el capital junior.
- ¿Qué pasa si el rendimiento no divide exactamente entre las fracciones (montos con más decimales de los que admite XLM)? Cada pago se redondea hacia abajo a la precisión de XLM y la suma de pagos nunca excede lo disponible en la custodia; el resto por redondeo se conserva en la custodia.
- ¿Qué pasa si la custodia del pool no tiene fondos suficientes para cubrir el reparto calculado (considerando lo que corresponde al otro tramo)? El sistema no ejecuta ningún pago, informa el faltante y el tramo permanece abierto.
- ¿Qué pasa si un pool no tiene ninguna factura asignada? No cumple "todas las facturas en estado final" por cumplimiento vacío; el reparto automático no se dispara y solo el operador puede forzarlo (sin nada que marcar en mora, el reparto devuelve el capital sin rendimiento ni pérdida).
- ¿Qué pasa si un tramo no tiene inversionistas? No hay pagos que ejecutar; el sistema lo cierra sin transacciones cuando el pool alcanza estado final.
- ¿Qué pasa si el reloj simulado avanza más allá del vencimiento de las facturas? Las facturas siguen "pendientes" hasta que el operador las cobre o marque en mora; el reloj por sí solo no cambia su estado.
- ¿Qué pasa si se avanza el reloj de un pool y luego se registra una factura con fecha de emisión "hoy"? El registro de una factura no está ligado a ningún pool todavía, así que usa la fecha real; la fecha simulada de un pool aplica a las reglas de ese pool (facturas asignadas, cotizaciones, reservas, cobro y reparto).

## Requirements *(mandatory)*

### Functional Requirements

**Cobro de facturas (simulación del pago del deudor)**

- **FR-001**: El sistema MUST permitir a una cuenta con rol operador de banco simular el cobro de una factura en estado "pendiente" que esté asignada a un pool.
- **FR-002**: El sistema MUST ejecutar el cobro como una transferencia real en Stellar testnet por el monto nominal completo de la factura (convertido a XLM según el tipo de cambio de demostración vigente), desde una cuenta que representa al deudor hacia la cuenta de custodia del pool de esa factura.
- **FR-003**: El sistema MUST marcar la factura como "cobrada" únicamente después de que la transferencia esté confirmada en Stellar testnet, y MUST registrar la referencia de la transacción, el monto en la moneda de la factura, los XLM movidos, el tipo de cambio aplicado, quién lo ejecutó y cuándo.
- **FR-004**: El sistema MUST permitir a un operador de banco marcar como "en mora" una factura "pendiente" asignada a un pool, sin ningún movimiento de dinero, registrando quién lo hizo y cuándo.
- **FR-005**: El sistema MUST rechazar el cobro o la mora de una factura que no esté asignada a un pool, que esté rechazada, o que ya esté en un estado final ("cobrada" o "en mora"), con un código de motivo específico y sin generar ninguna transacción.
- **FR-006**: El sistema MUST rechazar con un código de error específico cualquier intento de cobrar o marcar en mora una factura realizado por una cuenta sin rol operador de banco.
- **FR-007**: El sistema MUST garantizar que a una factura se le cobra como máximo una vez: cualquier reintento, doble solicitud o solicitud concurrente para la misma factura no produce un segundo pago.
- **FR-008**: El sistema MUST dejar la factura en "pendiente" y devolver un motivo claro cuando la transferencia falle (saldo insuficiente, error de red u otro), permitiendo reintentar sin riesgo de doble cobro.
- **FR-009**: El sistema MUST reconciliar el estado de una factura contra Stellar testnet cuando el cobro se haya confirmado on-chain pero no se haya reflejado internamente, sin volver a mover dinero.
- **FR-010**: El sistema MUST proveer una cuenta que representa al deudor con fondos suficientes para cubrir los cobros de la demostración, y MUST informar de forma explícita al operador cuando esa cuenta no tenga fondos suficientes para un cobro.

**Cálculo del reparto**

- **FR-011**: El sistema MUST calcular el rendimiento de cada factura cobrada como su monto nominal menos el anticipo efectivamente financiado, y MUST acumular ese rendimiento en el tramo al que la factura fue asignada; ese rendimiento se reparte solo entre los inversionistas de ese tramo, sin transferirse al otro tramo. Ejemplo: factura de S/20,000 con anticipo financiado de S/18,000 aporta S/2,000 de rendimiento a su tramo.
- **FR-012**: El sistema MUST calcular la pérdida de cada factura "en mora" como su anticipo financiado (no recuperado), y MUST acumularla a nivel del pool, sin importar a qué tramo pertenezca la factura.
- **FR-013**: El sistema MUST aplicar la pérdida acumulada del pool primero contra el capital aportado al tramo junior, y MUST afectar al tramo senior únicamente por el exceso que supere todo lo aportado al junior; ningún tramo puede recibir menos de cero por su capital. La pérdida absorbida por el junior se reparte entre sus inversionistas de forma proporcional a sus fracciones, y la que llegue al senior, entre los suyos.
- **FR-014**: El sistema MUST calcular el pago de cada inversionista, en XLM, como los XLM que efectivamente pagó al aportar a ese tramo (su capital aportado, sin reconversión por tipo de cambio), más su parte proporcional (según fracciones que posee sobre el total de fracciones emitidas del tramo) del rendimiento atribuido al tramo, menos su parte proporcional de la pérdida absorbida por el tramo; el rendimiento y la pérdida, calculados en la moneda del pool, se convierten a XLM con el tipo de cambio de demostración vigente al momento del reparto. El sistema MUST registrar en cada pago el tipo de cambio aplicado para que la equivalencia en soles o dólares pueda mostrarse después de forma informativa.
- **FR-015**: El sistema MUST redondear cada pago hacia abajo a la precisión de XLM y MUST garantizar que la suma de todos los pagos de un tramo no excede lo disponible en la custodia del pool para ese tramo.
- **FR-016**: El sistema MUST rechazar la ejecución del reparto, sin mover dinero ni cerrar el tramo, cuando la custodia del pool no tenga fondos suficientes para cubrir la suma de los pagos calculados (incluyendo lo comprometido al otro tramo), informando el faltante.

**Ejecución del reparto**

- **FR-017**: El sistema MUST ejecutar automáticamente el reparto de cada tramo cuando todas las facturas asignadas al pool alcancen un estado final ("cobrada" o "en mora"), el pool tenga al menos una factura asignada y el tramo tenga al menos un inversionista con fracciones. La pérdida de todo el pool debe ser conocida antes de pagar a cualquier tramo.
- **FR-018**: El sistema MUST permitir a un operador de banco forzar manualmente el reparto de un tramo antes de que todas las facturas del pool estén en estado final. Al forzarlo, el sistema MUST marcar como "en mora" (con marca de cierre forzado) todas las facturas aún pendientes del pool, tomar sus anticipos como pérdida, y ejecutar el reparto con las mismas reglas de cálculo. Una vez forzado, el otro tramo del pool sigue las reglas automáticas de FR-017.
- **FR-019**: El sistema MUST rechazar con un código de error específico cualquier intento de forzar el reparto realizado por una cuenta sin rol operador de banco.
- **FR-020**: El sistema MUST ejecutar el pago a cada inversionista como una única transacción real en Stellar testnet desde la custodia del pool hacia la wallet de la plataforma de ese inversionista, sin requerir ninguna acción del inversionista.
- **FR-021**: El sistema MUST tratar el reparto como un evento único e irreversible por tramo: una vez cerrado, MUST rechazar cualquier intento de repetirlo, deshacerlo o modificar el estado de cobro de las facturas de ese tramo.
- **FR-022**: El sistema MUST marcar el tramo como "cerrado" solo cuando todos sus inversionistas hayan recibido su pago; si algún pago falla, MUST reintentar únicamente los pagos pendientes, garantizando que ningún inversionista reciba más de un pago por tramo.
- **FR-023**: El sistema MUST garantizar que el reparto de un tramo se dispare una sola vez aun cuando coincidan el disparo automático, un reparto forzado o varias solicitudes simultáneas.
- **FR-024**: El sistema MUST registrar para cada reparto: tramo, si fue automático o forzado y por quién, el rendimiento acumulado, la pérdida absorbida, el pago calculado por inversionista, la referencia de cada transacción on-chain y la fecha.
- **FR-025**: El sistema MUST conservar sin modificar, tras el reparto, el registro on-chain de las fracciones de cada inversionista como historial de participación; no se queman ni se transfieren.
- **FR-026**: El sistema MUST permitir a un inversionista consultar, para cada una de sus posiciones, si el tramo fue repartido y, de ser así, cuánto recibió, con la referencia de la transacción on-chain que lo respalda.

**Reloj simulado**

- **FR-027**: El sistema MUST mantener una fecha simulada independiente por pool que, mientras no se haya adelantado, coincide con la fecha real. Adelantar el reloj de un pool MUST NOT afectar a ningún otro pool.
- **FR-028**: El sistema MUST evaluar contra la fecha efectiva de un pool (simulada cuando exista adelanto, real en caso contrario) toda regla de negocio de ese pool que depende de la fecha u hora actual, incluyendo al menos el vencimiento de sus facturas, el vencimiento del pool, las ventanas de validez de cotizaciones y reservas de aporte, y la fecha efectiva registrada en cobros y repartos.
- **FR-029**: El sistema MUST permitir a un operador de banco avanzar la fecha simulada de un pool una cantidad de tiempo positiva (con un tope por solicitud), y MUST rechazar cualquier solicitud que la retroceda o la deje igual.
- **FR-030**: El sistema MUST rechazar con un código de error específico cualquier intento de avanzar el reloj por una cuenta sin rol operador de banco.
- **FR-031**: El sistema MUST exponer, por pool, la fecha efectiva vigente y si su reloj está adelantado, de modo que cualquier consulta indique con claridad contra qué fecha se está evaluando.
- **FR-032**: El sistema MUST mantener el funcionamiento normal del registro de facturas, los aportes y las recargas mientras el reloj de algún pool está adelantado; las recargas, que no pertenecen a ningún pool, usan siempre la fecha real.
- **FR-033**: El sistema MUST registrar cada avance del reloj (quién, cuándo, fecha anterior y nueva).
- **FR-034**: El reloj simulado MUST NOT modificar por sí solo ningún estado de negocio (no cobra ni marca en mora facturas, ni reparte tramos); únicamente cambia la fecha contra la que se evalúan las reglas.
- **FR-035**: El sistema MUST usar la fecha real, nunca la simulada, para el registro de auditoría técnico (fechas de creación de registros y de transacciones on-chain), de modo que la evidencia de auditoría refleje siempre el momento real de cada evento.

**Datos de ejemplo**

- **FR-036**: El sistema MUST proveer datos de ejemplo que permitan demostrar de punta a punta, sin pasos manuales adicionales del operador más allá de las acciones de la demo, un pool con facturas asignadas, inversionistas con fracciones en ambos tramos, y la cuenta del deudor con fondos suficientes.
- **FR-037**: El mecanismo de carga de datos de ejemplo MUST poder ejecutarse repetidamente sin duplicar ni corromper cobros, repartos, ni el estado del reloj ya existentes.

### Key Entities

- **Cobro de factura**: registro del pago simulado de una factura por su deudor; asocia la factura, el monto nominal, los XLM movidos, el tipo de cambio aplicado, la referencia de la transacción on-chain, el operador que lo ejecutó y la fecha. Existe como máximo uno por factura.
- **Cuenta del deudor (simulada)**: cuenta de Stellar testnet controlada por el sistema que representa al deudor pagador en la demostración; origen de los fondos de los cobros. No tiene login ni pantalla propia.
- **Estado final de factura**: "cobrada" o "en mora"; ambos son definitivos y habilitan el reparto del tramo al que pertenece la factura.
- **Rendimiento del tramo**: suma de (monto nominal − anticipo financiado) de las facturas cobradas asignadas a ese tramo; se reparte solo entre los inversionistas de ese tramo.
- **Pérdida del pool**: suma de los anticipos de las facturas en mora (de cualquier tramo, incluidas las marcadas por cierre forzado); se absorbe primero por el tramo junior y, solo por el exceso, por el senior.
- **Reparto del tramo**: evento único e irreversible que calcula y paga a cada inversionista de un tramo; registra su origen (automático o forzado), los totales de rendimiento y pérdida, y su estado (en curso, completado). Al completarse deja el tramo "cerrado".
- **Pago de reparto**: registro por inversionista y tramo con las fracciones que poseía, el capital aportado, el ajuste de rendimiento o pérdida, el monto total pagado y la referencia de su transacción on-chain. Existe como máximo uno por inversionista y tramo.
- **Tramo cerrado**: estado terminal de un tramo tras su reparto; bloquea cualquier nuevo cobro, mora o reparto sobre él. Sus fracciones on-chain permanecen como historial.
- **Reloj de demostración (por pool)**: desplazamiento de tiempo simulado propio de cada pool, con historial de avances; define la "fecha efectiva" de ese pool contra la que se evalúan sus reglas de negocio basadas en tiempo. Cada pool es independiente de los demás.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100% de las facturas en estado "cobrada" tienen una transacción confirmada en Stellar testnet, verificable de forma independiente a la plataforma, por su monto nominal completo entre la cuenta del deudor y la custodia del pool.
- **SC-002**: El 100% de los inversionistas con fracciones en un tramo repartido reciben exactamente un pago, verificable en Stellar testnet, por el monto calculado según su número de fracciones.
- **SC-003**: Un tramo repartido no puede repartirse una segunda vez: 0 pagos adicionales tras el primer reparto, incluso bajo 20 solicitudes simultáneas de reparto o cobro sobre el mismo tramo.
- **SC-004**: En un escenario de demostración con una factura en mora cuya pérdida es menor que el capital junior, el capital recuperado por los inversionistas del tramo senior es el 100% de lo aportado, y toda la pérdida se refleja en el tramo junior.
- **SC-005**: En un escenario donde las pérdidas superan el capital junior, el tramo junior recibe cero y el capital senior recuperado es igual a su capital menos exactamente el exceso de pérdida.
- **SC-006**: La suma de todos los pagos de un tramo nunca excede el saldo de su custodia disponible para ese tramo, en el 100% de los repartos, incluyendo casos con redondeo.
- **SC-007**: Un operador puede completar el ciclo de demostración (avanzar el reloj, cobrar todas las facturas de un tramo y ver el reparto pagado a los inversionistas) en menos de 3 minutos de acciones, sin esperar tiempos reales de vencimiento.
- **SC-008**: Tras el reparto, un inversionista puede ver en el 100% de los casos cuánto recibió y con qué transacción on-chain, sin que su intervención sea necesaria.
- **SC-009**: Con el reloj de un pool adelantado, el 100% de las reglas basadas en fecha de ese pool (vencimiento de facturas, vencimiento del pool, ventanas de validez) se evalúan contra su fecha simulada, 0 reglas de otro pool cambian, y 0 operaciones de registro, aporte o recarga fallan por causa del adelanto.
- **SC-010**: Ante cualquier fallo intermedio de un cobro o de un reparto, 0 casos de doble pago y 0 casos de dinero movido sin su registro interno correspondiente tras la reconciliación.

## Assumptions

- Todo lo definido en las especificaciones previas se conserva sin cambios: roles (operador de banco, inversionista), pools con tramos senior y junior, facturas con anticipo, fracciones on-chain, custodia por pool y wallet de plataforma por inversionista.
- La cuenta que representa al deudor es una cuenta de Stellar testnet única, controlada por el sistema y fondeada con XLM de prueba; representa a cualquier deudor de la demostración y no distingue entre deudores individuales.
- Los cobros y repartos se liquidan siempre en XLM; en la plataforma solo se mueve XLM, y los soles o dólares son únicamente la moneda en que se expresan facturas, anticipos y la equivalencia informativa. El capital que se devuelve a un inversionista son los XLM que pagó al aportar; el rendimiento y la pérdida (calculados en la moneda del pool) se convierten a XLM con el tipo de cambio vigente al momento del reparto. Los detalles exactos de redondeo se resuelven en la fase de planeación.
- El "capital aportado" de un inversionista es la cantidad de XLM que pagó por sus aportes al tramo; su participación en rendimiento o pérdida es proporcional a sus fracciones sobre el total emitido del tramo.
- Cada factura pertenece a un único tramo (el que se definió al asignarla); el rendimiento de sus cobros se queda en ese tramo, pero la pérdida por mora se acumula a nivel del pool y la absorbe primero el junior. Por eso el reparto automático espera a que todas las facturas del pool (no solo las de un tramo) estén en estado final, aun cuando cada tramo se paga y se cierra como evento propio.
- En el mundo real, una factura vencida sin pago se clasifica como mora tras un periodo de gracia y luego se recupera o se castiga; en la demostración no hay recuperación posterior. El cierre forzado clasifica de inmediato como mora a las facturas pendientes y toma su anticipo como pérdida, lo que hace visible el riesgo del junior; es una convención de demostración, no un criterio de riesgo real.
- Los mínimos para un reparto automático son: al menos una factura asignada al pool y, por tramo, al menos un inversionista con fracciones; un tramo sin inversionistas se cierra sin pagos.
- La reserva del tramo (residuo que no completa una fracción) permanece en la custodia y no forma parte de los pagos de inversionistas; su destino final queda fuera de alcance de esta especificación.
- La fecha simulada es independiente por pool (decisión de diseño posterior a la clarificación inicial, que asumía un reloj global), solo puede avanzar y no incluye una acción para retroceder o reiniciarla; el reinicio del entorno de demostración queda fuera de alcance.
- El reloj simulado nunca modifica registros de auditoría técnica ni las fechas de las transacciones on-chain, que siempre reflejan el momento real.
- Esta especificación es solo capacidad de backend/API, igual que las anteriores; no incluye ninguna pantalla ni flujo de interfaz de usuario para el cobro, el reparto ni el reloj.
- Fuera de alcance: conexión con deudores o proveedores reales, mercado secundario, quema (burn) de fracciones tras el reparto, y cualquier interfaz de usuario.
- **Decisión de alcance del 2026-09-25 (demo el 2026-09-26)**: la cascada senior/junior y la regla de "un reparto por tramo" se calculan y garantizan en el backend (base de datos), no en un contrato inteligente; los cobros y cada pago siguen siendo transacciones reales verificables en Stellar testnet, y las fracciones siguen registradas on-chain. El resultado de la cascada no es verificable on-chain y debe presentarse como cálculo de la plataforma.
- Existe una funcionalidad paralela ya implementada, `liquidacion-tramo` (pago de capital + rendimiento ilustrativo con quema de fracciones, sin mora). Un tramo solo puede cerrarse por uno de los dos mecanismos; el sistema impide que se ejecuten ambos sobre el mismo tramo. La forma de marcar una factura como cobrada de esa funcionalidad (manual, sin transferencia) se conserva como camino legado.
