# Feature Specification: Exploración de Pools y Primer Aporte del Inversionista

**Feature Branch**: `20260920-113925-inversion-pools-aporte`

**Created**: 2026-09-20

**Status**: Draft

**Input**: User description: "Especificar el primer paso del flujo del inversionista en una plataforma de inversión fraccionada sobre facturas de confirming: cargar saldo de demostración, explorar pools de inversión, elegir uno con información suficiente y aportar a uno de sus tramos (senior o junior). Esta feature también debe dejar creadas las entidades fundacionales del dominio (empresas, operaciones/facturas fraccionables, pools, tramos, cotizaciones, aportes y posiciones) y datos de ejemplo para poder demostrarla de punta a punta."

## Clarifications

### Session 2026-09-20

- Q: ¿Qué distingue exactamente el estado "fondeado" del estado "cerrado" de un pool? → A: "fondeado" = el pool alcanzó automáticamente el 100% de su capital objetivo (todos los tramos llenos); "cerrado" = el operador (fuera de alcance, ya reflejado en datos semilla) cerró el pool manualmente sin que llegara a fondearse por completo, p. ej. por vencimiento del plazo de captación. Ambos son estados terminales que bloquean aportes.
- Q: ¿Cuál es el límite máximo de recarga de saldo de demostración por inversionista? → A: S/1000 (o su equivalente en dólares al tipo de cambio de referencia vigente) acumulado por inversionista, por día natural en hora de Lima; el contador se reinicia a las 00:00 hora de Lima.
- Q: ¿Cuánto tiempo debe permanecer válida una cotización antes de expirar? → A: 5 minutos desde que se genera.
- Q: ¿Qué monto de reserva mínima se debe validar en la billetera del inversionista al aportar? → A: 2 XLM fijos como valor constante (cubre la reserva base de Stellar más margen para comisiones, sin recalcularse dinámicamente por subentradas); no se descuenta del saldo de demostración mostrado (que está en soles/dólares), sino que se valida contra el saldo real de XLM de la billetera en el momento del pago del aporte.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Explorar y comparar pools de inversión (Priority: P1)

Un inversionista que ya tiene cuenta entra a la plataforma y quiere ver en qué puede invertir.
Ve una lista de pools disponibles con lo esencial de cada uno, y puede filtrar y ordenar esa
lista por plazo, moneda, perfil de riesgo, sector de las empresas pagadoras, y tamaño/avance de
fondeo, para llegar rápido a las opciones que le interesan.

**Why this priority**: Sin poder explorar y comparar pools, el inversionista no tiene forma de
llegar a una decisión de inversión; es el punto de entrada de todo el flujo y puede demostrarse
y probarse de forma completamente aislada del resto de la feature.

**Independent Test**: Puede probarse de forma aislada consultando el listado de pools (con datos
de ejemplo ya cargados) y verificando que cada pool muestra su información esencial, y que los
filtros y el orden por plazo, moneda, perfil de riesgo, sector y avance de fondeo devuelven los
resultados esperados. No depende de que el usuario tenga saldo ni de que llegue a aportar.

**Acceptance Scenarios**:

1. **Given** un inversionista autenticado y al menos 5 pools de ejemplo cargados con distintos
   plazos, monedas, perfiles de riesgo y sectores, **When** consulta el listado de pools,
   **Then** ve cada pool con su nombre, moneda, plazo, perfil de riesgo y porcentaje de avance de
   fondeo.
2. **Given** el listado de pools, **When** el inversionista filtra por moneda "soles" y perfil de
   riesgo "conservador", **Then** solo ve pools que cumplen ambos criterios a la vez.
3. **Given** el listado de pools, **When** el inversionista ordena por avance de fondeo
   descendente, **Then** el pool más cerca de completar su capital objetivo aparece primero.
4. **Given** un pool que ya alcanzó el 100% de su capital objetivo y un pool que el operador cerró
   sin llegar a fondearse por completo, **When** el inversionista los ve en el listado, **Then**
   cada uno muestra su estado terminal correcto ("fondeado" o "cerrado" respectivamente) de forma
   clara y distinguible.

---

### User Story 2 - Ver el detalle de un pool para decidir (Priority: P1)

Un inversionista que encontró un pool que le interesa entra a su detalle para entender qué está
comprando y cuánto arriesga, sin necesitar conocimientos financieros previos: de qué se compone
el pool, qué rendimiento ilustrativo ofrece cada tramo, qué tan lleno está, y qué diferencia hay
entre aportar al tramo senior o al junior.

**Why this priority**: Es el requisito explícito del negocio ("antes de aportar, el inversionista
debe poder entender qué está comprando y cuánto arriesga") y es lo que hace posible una decisión
informada; sin este detalle, el aporte de la Historia 4 sería una acción a ciegas.

**Independent Test**: Puede probarse de forma aislada abriendo el detalle de cualquier pool de
ejemplo y verificando que toda la información agregada requerida está presente y es consistente
con los datos cargados, sin necesidad de que el usuario llegue a aportar.

**Acceptance Scenarios**:

1. **Given** un pool de ejemplo con operaciones y empresas pagadoras asociadas, **When** el
   inversionista abre su detalle, **Then** ve nombre, descripción en lenguaje simple, moneda,
   plazo, fecha esperada de vencimiento, perfil de riesgo con explicación breve, y estado (abierto,
   fondeado o cerrado).
2. **Given** el detalle de un pool, **When** el inversionista lo revisa, **Then** ve la
   composición agregada (número de operaciones, número de empresas pagadoras, sector o sectores, y
   concentración máxima de una sola operación) sin ver el detalle de ninguna factura o empresa
   individual.
3. **Given** el detalle de un pool, **When** el inversionista lo revisa, **Then** ve, para cada
   tramo (senior y junior), el rendimiento ilustrativo para el plazo del pool y su equivalente
   anualizado, el colchón de pérdidas del tramo junior, el capital objetivo, el capital
   comprometido, el porcentaje de avance y el cupo disponible.
4. **Given** el detalle de un pool, **When** el inversionista lo revisa, **Then** ve una
   comparación en lenguaje simple entre el tramo senior y el junior que explica qué pasa con cada
   uno si una empresa pagadora no paga.
5. **Given** el detalle de un pool, **When** el inversionista lo revisa, **Then** ve el aporte
   mínimo del pool en su moneda junto con su equivalente actual en XLM, y toda cifra de
   rendimiento aparece rotulada como ilustrativa, sin garantía y en red de pruebas.

---

### User Story 3 - Ver y recargar saldo de demostración (Priority: P1)

Un inversionista quiere tener saldo disponible para poder aportar. Consulta su saldo de
demostración vigente en soles y/o en dólares, y puede recargarlo dentro de un tope diario, de
forma que quede disponible de inmediato para invertir. La recarga es un crédito interno de la
plataforma: no mueve XLM en la red, solo acredita el saldo de demostración.

**Why this priority**: Es requisito previo indispensable para poder completar un aporte (Historia
4); sin saldo visible y recargable, el inversionista no puede llegar a su primera inversión
dentro de la demo.

**Independent Test**: Puede probarse de forma aislada consultando el saldo de una cuenta demo,
recargando un monto dentro del límite permitido, y verificando que el saldo aumenta y queda
disponible, sin necesidad de que el usuario explore pools ni aporte.

**Acceptance Scenarios**:

1. **Given** un inversionista autenticado con billetera activa, **When** consulta su saldo,
   **Then** ve su saldo de demostración vigente en cada moneda en la que tenga saldo (soles y/o
   dólares).
2. **Given** un inversionista autenticado, **When** solicita una recarga de saldo de demostración
   en soles o en dólares dentro del tope diario permitido, **Then** el saldo de demostración se
   actualiza de inmediato sin que se mueva ningún XLM en la red, y la recarga queda registrada con
   su monto, moneda, tipo de cambio aplicado y fecha.
3. **Given** un inversionista que ya alcanzó el tope de recarga del día natural (hora de Lima),
   **When** intenta recargar de nuevo, **Then** el sistema rechaza la recarga e informa cuánto
   puede recargar todavía ese día y cuándo se reinicia el conteo (00:00 hora de Lima).
4. **Given** un inversionista cuya billetera todavía se está creando, **When** consulta su saldo,
   **Then** el sistema le informa que su billetera está en proceso y aún no puede recargar ni
   aportar.
5. **Given** dos recargas del mismo inversionista enviadas casi al mismo tiempo que en conjunto
   exceden el tope diario, **When** ambas se procesan, **Then** el sistema acepta solo hasta
   completar el tope y rechaza el excedente, sin que el total recargado ese día supere nunca el
   tope vigente.

---

### User Story 4 - Aportar a un tramo de un pool (Priority: P1)

Un inversionista que ya eligió un pool y un tramo indica cuánto quiere aportar en la moneda del
pool, recibe una cotización con el equivalente en XLM, el tipo de cambio usado y el tiempo de
validez, y al confirmar el aporte el sistema descuenta su saldo de demostración, paga en XLM real
desde su billetera hacia la custodia del pool, y responde en la misma solicitud con el resultado
final (confirmado o fallido) junto con un comprobante verificable, sumándose de inmediato al
avance de fondeo del pool si se confirma.

**Why this priority**: Es la acción que materializa el valor de todo el flujo — sin ella, explorar
y ver el detalle no llevan a ningún resultado concreto — y es el criterio de éxito central del
negocio ("de tener cuenta a primer aporte confirmado en menos de 3 minutos").

**Independent Test**: Puede probarse de forma aislada (con saldo de demostración, billetera
fondeada con XLM de prueba y pool de ejemplo ya disponibles) solicitando una cotización para un
monto válido, confirmándola antes de que expire, y verificando que la solicitud de confirmación
devuelve el resultado final en la misma respuesta, el aporte queda registrado, el saldo de
demostración se descuenta, el pago en XLM llega a la custodia del pool, el avance de fondeo del
pool y del tramo se actualiza, y se genera un comprobante.

**Acceptance Scenarios**:

1. **Given** un inversionista con saldo suficiente y un pool abierto con cupo disponible en el
   tramo senior, **When** indica un monto múltiplo de la unidad mínima del pool en la moneda del
   pool, **Then** recibe una cotización con el equivalente en XLM, el tipo de cambio de referencia
   usado, su marca de tiempo, y el tiempo restante de validez.
2. **Given** una cotización vigente, **When** el inversionista la confirma antes de que expire,
   **Then** en la misma solicitud el sistema descuenta su saldo de demostración en la moneda del
   pool, transfiere en XLM desde su billetera hacia la custodia del pool por el monto exacto de la
   cotización, registra el aporte con pool, tramo, monto nominal, XLM pagados, tipo de cambio
   aplicado y fecha, actualiza el cupo disponible del tramo y el avance de fondeo del pool, y
   devuelve el resultado confirmado junto con un comprobante verificable en la red de pruebas (o,
   mientras ese mecanismo no esté disponible, un comprobante simulado claramente rotulado como
   tal).
3. **Given** un inversionista con saldo de demostración insuficiente en la moneda del pool para el
   monto indicado, **When** intenta obtener una cotización o confirmar un aporte, **Then** el
   sistema lo rechaza e informa que el saldo de demostración es insuficiente.
4. **Given** un monto que no es múltiplo de la unidad mínima del pool, **When** el inversionista
   lo indica, **Then** el sistema lo rechaza e indica cuál es la unidad mínima de aporte.
5. **Given** un monto que excede el cupo disponible del tramo elegido, **When** el inversionista
   intenta cotizar o confirmar, **Then** el sistema lo rechaza e informa cuánto cupo queda
   disponible en ese tramo.
6. **Given** una cotización que ya expiró o cuyo tipo de cambio ya no es válido, **When** el
   inversionista intenta confirmarla, **Then** el sistema la rechaza y le ofrece una cotización
   nueva antes de poder aportar.
7. **Given** un pool que se llena o se cierra mientras el inversionista tiene una cotización
   pendiente de confirmar, **When** intenta confirmar, **Then** el sistema rechaza el aporte e
   informa que el pool o el tramo ya no tiene cupo disponible.
8. **Given** un inversionista que hace doble clic o reintenta el envío de la misma confirmación de
   aporte, **When** el sistema procesa la solicitud, **Then** el aporte se registra una sola vez.
9. **Given** dos inversionistas que confirman al mismo tiempo aportes que en conjunto exceden el
   último cupo disponible de un tramo, **When** ambas confirmaciones se procesan, **Then** el
   sistema acepta únicamente hasta el cupo disponible y rechaza el excedente, sin que el tramo
   supere nunca su capital objetivo.
10. **Given** un inversionista cuya billetera todavía se está creando, **When** intenta cotizar o
    confirmar un aporte, **Then** el sistema lo rechaza e informa que debe esperar a que su
    billetera esté lista.
11. **Given** una cuenta con rol de operador de banco, **When** intenta cotizar o confirmar un
    aporte a cualquier pool, **Then** el sistema rechaza la acción por no tratarse de una cuenta
    de inversionista.
12. **Given** un inversionista cuya billetera, tras pagar el monto de la cotización, quedaría con
    menos de 2 XLM de reserva mínima, **When** intenta confirmar el aporte, **Then** el sistema lo
    rechaza e informa que la billetera no tiene XLM suficiente para cubrir el pago y la reserva
    mínima.
13. **Given** cualquier motivo de rechazo de un aporte (saldo de demostración insuficiente, XLM
    insuficiente en la billetera, cupo excedido, cotización vencida, pool o tramo ya no abierto),
    **When** el inversionista confirma, **Then** el sistema responde en la misma solicitud con el
    resultado fallido y un mensaje de error claro, sin dejar el aporte en un estado pendiente.

---

### User Story 5 - Ver mis posiciones (Priority: P2)

Un inversionista que ya hizo uno o más aportes quiere ver en un solo lugar todo lo que tiene
invertido: en qué pool y tramo, cuánto aportó en soles o dólares, cuántos XLM pagó, qué tipo de
cambio se aplicó, cuándo lo hizo y en qué estado está el pool.

**Why this priority**: Confirma al inversionista que su aporte quedó registrado correctamente y
cierra el ciclo de confianza de la primera inversión, pero no es indispensable para que el aporte
en sí (Historia 4) ocurra, por lo que puede entregarse inmediatamente después.

**Independent Test**: Puede probarse de forma aislada con datos de ejemplo que ya incluyen
posiciones previas, consultando el listado de posiciones de una cuenta demo y verificando que
cada posición muestra la información completa y que ningún inversionista ve posiciones de otra
cuenta.

**Acceptance Scenarios**:

1. **Given** un inversionista con al menos un aporte confirmado, **When** consulta sus posiciones,
   **Then** ve, por cada aporte, el pool, el tramo, el monto en la moneda del pool, los XLM
   pagados, el tipo de cambio aplicado, la fecha y el estado actual del pool.
2. **Given** dos inversionistas distintos con posiciones propias, **When** cada uno consulta sus
   posiciones, **Then** cada uno ve únicamente sus propios aportes y nunca los del otro.
3. **Given** un inversionista sin ningún aporte confirmado, **When** consulta sus posiciones,
   **Then** ve una lista vacía sin error.

---

### Edge Cases

- ¿Qué pasa si el inversionista indica un monto negativo, cero, o con más decimales de los que la
  moneda del pool admite? El sistema lo rechaza como monto inválido.
- ¿Qué pasa si el tipo de cambio de referencia no está disponible al momento de pedir una
  cotización? El sistema informa que no puede cotizar en ese momento y no permite aportar hasta
  que el tipo de cambio vuelva a estar disponible.
- ¿Qué pasa si dos aportes al mismo tramo se confirman casi simultáneamente y juntos exceden el
  cupo, pero por separado ambos caben? El sistema acepta los aportes en el orden en que se
  confirman hasta agotar el cupo, y rechaza el que ya no cabe.
- ¿Qué pasa si el inversionista intenta aportar a un pool que ya está en estado "fondeado" o
  "cerrado"? El sistema rechaza la solicitud e informa que el pool ya no admite aportes.
- ¿Qué pasa si se vuelve a ejecutar la carga de datos de ejemplo sobre un entorno que ya tiene
  cuentas demo con saldo y posiciones? Las cuentas demo, sus billeteras, saldos y posiciones
  existentes se conservan sin duplicarse ni borrarse.
- ¿Qué pasa si el inversionista recarga saldo repetidas veces en un mismo día natural (hora de
  Lima) tratando de superar el tope? El sistema aplica el tope de forma acumulada por día e
  informa cuánto puede recargar todavía ese día y cuándo se reinicia el conteo.
- ¿Qué pasa si el inversionista no tiene suficiente saldo de demostración en la moneda del pool
  para el monto indicado? El sistema rechaza la cotización o la confirmación e informa que el
  saldo de demostración es insuficiente.
- ¿Qué pasa si la billetera del inversionista no tiene suficientes XLM para cubrir el pago de la
  cotización más la reserva mínima de 2 XLM? El sistema rechaza el aporte e informa que la
  billetera no tiene XLM suficiente.

## Requirements *(mandatory)*

### Functional Requirements

**Saldo de demostración**

- **FR-001**: El sistema MUST mantener, para cada inversionista, un saldo de demostración en
  soles y otro en dólares, cada uno alimentado únicamente por recargas de demostración hechas en
  esa moneda.
- **FR-002**: El sistema MUST mostrar al inversionista su saldo de demostración vigente en cada
  moneda en la que tenga saldo.
- **FR-003**: El sistema MUST permitir al inversionista recargar su saldo de demostración en soles
  o en dólares sin que la recarga mueva XLM en la red: la recarga únicamente acredita el saldo de
  demostración.
- **FR-004**: El sistema MUST limitar el total recargado por un inversionista a un máximo
  acumulado de S/1000 (o su equivalente en dólares al tipo de cambio de referencia vigente) por
  día natural en hora de Lima, reiniciando el conteo a las 00:00 hora de Lima.
- **FR-005**: El sistema MUST rechazar una recarga que, sumada a lo ya recargado ese día natural
  (hora de Lima), exceda el tope vigente, informando cuánto puede recargar todavía ese día y
  cuándo se reinicia el conteo.
- **FR-006**: Al confirmar una recarga, el sistema MUST registrar su monto, su moneda, el tipo de
  cambio de referencia aplicado (para el cómputo del tope diario compartido entre monedas) y su
  fecha.
- **FR-007**: El sistema MUST impedir que un inversionista cuya billetera aún se está creando
  recargue saldo de demostración, y MUST informarle que puede seguir explorando pools mientras
  tanto.
- **FR-008**: El sistema MUST dejar explícito en toda presentación del saldo de demostración que
  no es dinero real y que no representa ni promete ningún valor.

**Exploración y comparación de pools**

- **FR-009**: El sistema MUST permitir al inversionista consultar el listado de pools disponibles
  con su información esencial (nombre, moneda, plazo, perfil de riesgo, avance de fondeo, estado).
- **FR-010**: El sistema MUST permitir filtrar el listado de pools por plazo, moneda, perfil de
  riesgo, sector de las empresas pagadoras, y tamaño/avance de fondeo, de forma combinable.
- **FR-011**: El sistema MUST permitir ordenar el listado de pools por al menos tamaño y avance de
  fondeo.
- **FR-012**: El sistema MUST permitir la exploración del listado y del detalle de pools a
  cualquier inversionista autenticado, incluido uno cuya billetera todavía se está creando.

**Detalle de un pool**

- **FR-013**: El sistema MUST mostrar en el detalle de un pool: nombre, descripción corta en
  lenguaje simple, moneda, plazo, fecha esperada de vencimiento, perfil de riesgo con una
  explicación de una o dos frases, y estado (abierto, fondeado o cerrado).
- **FR-014**: El sistema MUST mostrar la composición agregada del pool: número de operaciones,
  número de empresas pagadoras, sector o sectores, y concentración máxima de una sola operación
  sobre el total del pool, sin exponer el detalle individual de facturas ni de empresas.
- **FR-015**: El sistema MUST mostrar, por cada tramo del pool, el rendimiento ilustrativo para el
  plazo del pool y su equivalente anualizado, el capital objetivo, el capital comprometido, el
  porcentaje de avance y el cupo disponible.
- **FR-016**: El sistema MUST mostrar el colchón de pérdidas del tramo junior (qué porcentaje del
  pool absorbe pérdidas antes de afectar al tramo senior).
- **FR-017**: El sistema MUST mostrar el aporte mínimo del pool en su moneda junto con su
  equivalente actual en XLM.
- **FR-018**: El sistema MUST mostrar una comparación en lenguaje simple entre el tramo senior y
  el junior, incluyendo qué ocurre con cada uno si una empresa pagadora no paga.
- **FR-019**: El sistema MUST rotular toda cifra de rendimiento como ilustrativa, sin garantía y
  correspondiente a la red de pruebas.

**Cotización y aporte**

- **FR-020**: El sistema MUST permitir al inversionista solicitar una cotización para un pool,
  tramo y monto en la moneda del pool, y MUST devolver el equivalente en XLM, el tipo de cambio de
  referencia usado, su marca de tiempo, y su tiempo de validez, fijado en 5 minutos desde que se
  genera.
- **FR-021**: El sistema MUST rechazar un monto que no sea múltiplo de la unidad mínima de aporte
  definida por el pool, indicando cuál es esa unidad.
- **FR-022**: El sistema MUST rechazar una cotización o un aporte cuando el saldo de demostración
  del inversionista en la moneda del pool sea insuficiente para el monto indicado.
- **FR-023**: El sistema MUST rechazar una cotización o un aporte cuando el monto exceda el cupo
  disponible del tramo elegido, informando cuánto cupo queda disponible.
- **FR-024**: El sistema MUST aplicar al confirmar el aporte exactamente el tipo de cambio de la
  cotización vigente que el inversionista aceptó, nunca uno distinto.
- **FR-025**: El sistema MUST rechazar la confirmación de una cotización expirada o cuyo tipo de
  cambio ya no esté vigente, y MUST ofrecer obtener una cotización nueva.
- **FR-026**: El sistema MUST garantizar que el cupo disponible de un tramo y el capital objetivo
  de un pool nunca se superan, incluso ante múltiples solicitudes de aporte concurrentes sobre el
  mismo cupo.
- **FR-027**: El sistema MUST garantizar que una misma confirmación de aporte enviada más de una
  vez (doble clic, reintento) no genera más de un aporte registrado.
- **FR-028**: El sistema MUST rechazar un aporte dirigido a un pool o tramo que ya no está en
  estado "abierto" al momento de la confirmación.
- **FR-029**: El sistema MUST impedir que un inversionista cuya billetera aún se está creando
  obtenga una cotización o confirme un aporte.
- **FR-030**: El sistema MUST rechazar cualquier intento de cotizar o aportar realizado por una
  cuenta con rol de operador de banco.
- **FR-031**: El sistema MUST rechazar la confirmación de un aporte cuando, tras realizar el pago
  en XLM por el monto de la cotización, la billetera del inversionista quedaría con menos de 2 XLM
  de reserva mínima.
- **FR-032**: Al confirmar un aporte, el sistema MUST descontar el saldo de demostración del
  inversionista en la moneda del pool, transferir en XLM desde la billetera del inversionista
  hacia la custodia del pool por el monto exacto de la cotización aceptada, registrar el aporte
  (pool, tramo, inversionista, monto nominal, XLM pagados, tipo de cambio aplicado y fecha), y
  actualizar de inmediato el capital comprometido y el cupo disponible del tramo y del pool
  correspondientes.
- **FR-033**: Al confirmar un aporte, el sistema MUST generar un comprobante verificable de la
  transferencia en la red de pruebas; mientras ese mecanismo no esté disponible, MUST emitir en su
  lugar un comprobante simulado, rotulado de forma inequívoca como simulado y nunca presentado
  como evidencia real.
- **FR-034**: La operación de confirmar un aporte MUST devolver, en la misma solicitud, el
  resultado final (confirmado o fallido) sin dejarlo en un estado pendiente, incluyendo un mensaje
  de error claro cuando el resultado sea fallido.

**Posiciones**

- **FR-035**: El sistema MUST permitir a cada inversionista consultar el listado de sus propias
  posiciones, mostrando por cada una el pool, el tramo, el monto en la moneda del pool, los XLM
  pagados, el tipo de cambio aplicado, la fecha y el estado actual del pool.
- **FR-036**: El sistema MUST impedir que un inversionista consulte posiciones de otra cuenta.

**Moneda y tipo de cambio**

- **FR-037**: El sistema MUST mantener un tipo de cambio de referencia XLM↔soles y XLM↔dólares,
  visible y con marca de tiempo, rotulado explícitamente como parámetro de demostración sin valor
  de mercado real.
- **FR-038**: El sistema MUST acompañar todo monto de un pool, cotización, aporte o posición
  mostrado en XLM con su equivalente en soles o dólares, y todo monto de un pool, cotización,
  aporte o posición mostrado en soles o dólares con su equivalente en XLM; el saldo de
  demostración, al no estar denominado en XLM, queda exceptuado de este requisito y se muestra
  únicamente en la moneda en que fue acreditado.
- **FR-039**: El sistema MUST restringir cada pool a una única moneda (soles o dólares) y MUST
  agrupar en él únicamente operaciones de esa misma moneda.

**Datos de ejemplo**

- **FR-040**: El sistema MUST proveer un mecanismo de carga de datos de ejemplo que crea al menos 5
  pools ficticios, cubriendo entre ellos distintos plazos, monedas (mayoría en soles y al menos uno
  en dólares), perfiles de riesgo y sectores, con sus empresas pagadoras y operaciones asociadas.
- **FR-041**: Los datos de ejemplo MUST incluir pools en estados de avance de fondeo variados: al
  menos uno casi vacío, uno a medio fondear, uno casi lleno y uno completamente fondeado.
- **FR-042**: Los datos de ejemplo MUST incluir un tipo de cambio de referencia inicial y al menos 3
  cuentas demo de inversionista con saldo de demostración y billetera, con al menos una posición
  previa registrada entre ellas.
- **FR-043**: El mecanismo de carga de datos de ejemplo MUST poder ejecutarse repetidamente sin
  borrar ni duplicar las cuentas demo, sus billeteras, su saldo de demostración ni sus posiciones
  existentes.

### Key Entities

- **Empresa pagadora**: empresa ficticia cuyas facturas de confirming respaldan una o más
  operaciones; tiene un sector asociado. No se expone individualmente al inversionista en esta
  feature, solo de forma agregada dentro de un pool.
- **Operación (factura fraccionable)**: unidad de confirming aprobada que aporta su valor nominal
  (en soles o dólares) a un pool; pertenece a una empresa pagadora y a un solo pool.
- **Pool de inversión**: agrupa varias operaciones de una misma moneda; define plazo, perfil de
  riesgo, capital objetivo, unidad mínima de aporte y estado; se compone de un tramo senior y un
  tramo junior. Estados posibles: "abierto" (acepta aportes), "fondeado" (alcanzó automáticamente
  el 100% de su capital objetivo) y "cerrado" (cerrado administrativamente antes de fondearse por
  completo, p. ej. por vencimiento del plazo de captación — la acción de cierre en sí es del
  operador de banco y queda fuera de alcance de esta feature). "Fondeado" y "cerrado" son ambos
  estados terminales que bloquean nuevos aportes.
- **Tramo (senior/junior)**: subdivisión de un pool con su propio capital objetivo, capital
  comprometido, cupo disponible y rendimiento ilustrativo; el tramo junior define además el
  colchón de pérdidas que protege al senior.
- **Cotización**: propuesta de conversión de un monto en la moneda de un pool a XLM, con el tipo de
  cambio usado, su marca de tiempo y un tiempo de validez; es la base que se aplica si el
  inversionista confirma un aporte antes de que expire.
- **Aporte**: registro de la confirmación de una inversión de un inversionista en un tramo
  concreto; guarda el monto nominal, los XLM pagados, el tipo de cambio aplicado, la fecha y el
  comprobante de la transferencia en XLM desde la billetera del inversionista hacia la custodia
  del pool.
- **Posición**: vista de un aporte confirmado desde la perspectiva del inversionista, con el estado
  vigente del pool al que pertenece.
- **Saldo de demostración**: crédito interno de la plataforma en soles y/o en dólares que tiene un
  inversionista, alimentado exclusivamente por recargas de demostración en esa misma moneda y
  sujeto a un tope diario compartido entre monedas; no está denominado en XLM, no mueve XLM en la
  red al recargarse, y no representa dinero real ni promete ningún valor.
- **Recarga**: registro de un evento de acreditación de saldo de demostración; guarda el monto, la
  moneda, el tipo de cambio de referencia aplicado (para el cómputo del tope diario compartido
  entre monedas) y la fecha.
- **Tipo de cambio de referencia**: parámetro de demostración que define la equivalencia vigente
  entre XLM y cada moneda soportada (soles, dólares), con marca de tiempo.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un inversionista nuevo con cuenta ya creada puede pasar de no tener saldo a tener su
  primer aporte confirmado en menos de 3 minutos.
- **SC-002**: Ningún pool ni ningún tramo supera nunca su cupo disponible, incluso bajo 20
  solicitudes de aporte simultáneas dirigidas al mismo cupo.
- **SC-003**: El total acumulado de aportes confirmados de un pool coincide siempre con el capital
  comprometido mostrado en su avance de fondeo.
- **SC-004**: El 100% de los montos de pools, cotizaciones, aportes y posiciones visibles en la
  plataforma para el inversionista muestran su equivalente tanto en soles/dólares como en XLM (el
  saldo de demostración es la única excepción, al expresarse únicamente en soles y/o dólares).
- **SC-005**: Una persona sin conocimientos financieros previos, tras leer el detalle de un pool,
  puede describir correctamente la diferencia de riesgo entre el tramo senior y el junior (validado
  mediante prueba de usuario).
- **SC-006**: El sistema permite demostrar de punta a punta el flujo completo (saldo → explorar →
  detalle → aportar → posiciones) usando exclusivamente datos de ejemplo, sin necesitar acción
  previa del operador de banco.
- **SC-007**: El 100% de los aportes confirmados quedan con un comprobante asociado, real o
  simulado y claramente rotulado como tal.
- **SC-008**: El total recargado por un inversionista en un día natural (hora de Lima) nunca supera
  el tope vigente, incluso ante recargas simultáneas.

## Assumptions

- El registro, el inicio de sesión y la creación automática de la billetera de Stellar testnet ya
  existen (feature previa) y no se rehacen aquí; esta feature asume una cuenta de inversionista ya
  autenticada.
- El saldo de demostración es un crédito interno de la plataforma en soles y/o en dólares, sin
  respaldo 1:1 en XLM ni en dinero real. Recargarlo es una operación puramente contable de la
  plataforma que no genera ninguna transacción on-chain, a diferencia del pago del aporte, que sí
  se ejecuta en XLM real sobre la billetera del inversionista (ya fondeada con XLM de prueba desde
  su creación en la feature previa de registro).
- El límite de recarga de saldo de demostración es de S/1000 (o su equivalente en dólares al tipo
  de cambio de referencia vigente) acumulado por inversionista y por día natural en hora de Lima
  (UTC-5, sin cambios estacionales), reiniciándose a las 00:00 hora de Lima; el valor exacto queda
  como parámetro de configuración ajustable a futuro.
- La reserva mínima de 2 XLM por billetera (cubre la reserva base de Stellar más margen para
  comisiones, sin recalcularse dinámicamente por subentradas) ya no se descuenta del saldo de
  demostración mostrado, que está en soles/dólares y no en XLM; en su lugar, se valida en el
  momento del aporte contra el saldo real de XLM de la billetera del inversionista.
- Los rendimientos ilustrativos por tramo y por pool en los datos de ejemplo son valores
  razonables ilustrativos definidos por el equipo (p. ej. tramo senior con rendimiento anualizado
  menor de un dígito, tramo junior con rendimiento anualizado de dos dígitos), sin corresponder a
  ninguna operación real.
- El tipo de cambio de referencia XLM↔soles y XLM↔dólares es un valor de demostración configurado
  por el equipo, sin conexión a una fuente de mercado real, y puede actualizarse manualmente entre
  demos.
- El tiempo de validez de una cotización es de 5 minutos desde que se genera, para reflejar que el
  tipo de cambio de demostración puede cambiar, sin exigir a esta feature ningún mecanismo externo
  de precios en tiempo real.
- El comprobante verificable por aporte se apoya en la transacción de la red de pruebas de Stellar
  que transfiere los XLM desde la billetera del inversionista hacia la custodia del pool; mientras
  ese mecanismo no esté disponible, se acepta un comprobante simulado claramente marcado como tal,
  sin que sea nunca presentado como evidencia real.
- "Sector de las empresas pagadoras" se refiere a una clasificación simple y fija (p. ej. retail,
  manufactura, servicios, construcción, tecnología) usada únicamente para agregación y filtrado, sin
  requerir un catálogo externo de industrias.
- Las 3 cuentas demo de inversionista y sus billeteras se consideran datos persistentes del
  entorno de demostración; la carga de datos de ejemplo debe reconocerlas por un identificador
  estable (p. ej. email) para no duplicarlas en ejecuciones repetidas.
