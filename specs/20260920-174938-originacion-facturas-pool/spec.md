# Feature Specification: Originación de Facturas y Tokenización de Fracciones de Pool

**Feature Branch**: `20260920-174938-originacion-facturas-pool`

**Created**: 2026-09-20

**Status**: Draft

**Input**: User description: "Especificar cómo los pools de inversión ya existentes quedan respaldados con facturas de pymes y cómo la participación de cada inversionista en esos pools queda representada de forma verificable en Stellar testnet. El inversionista nunca compra una factura directamente: aporta a un pool, y el pool es la entidad intermedia que financia varias facturas. Cada inversionista posee fracciones del pool/tramo, no de una factura concreta. Un operador de banco registra facturas de demostración (sin documento real), las valida por coherencia simple, y las asigna manualmente a un único pool; el fraccionamiento sigue una regla fija (monto del tramo ÷ unidad mínima del pool). Un contrato inteligente de Soroban en Stellar testnet emite y lleva el registro de las fracciones de cada pool/tramo y de quién las posee, y hace cumplir las reglas del pool (cupo, unidad mínima, solo el operador registra facturas), guardando únicamente una huella (hash) de cada factura, nunca sus datos. Antes de aportar, el inversionista puede ver, para cada pool, las facturas que lo respaldan en versión anonimizada (monto, plazo, vencimiento, sector y estado), sin nombres de proveedor ni de deudor, que solo ve el operador. Cada factura tiene un estado de cobro (pendiente, cobrada, en mora) que es solo un hecho informativo, sin calcular ni prometer ningún rendimiento, retorno o dividendo. Quedan fuera de alcance: distinguir factoring de confirming, pantallas o cuentas para proveedor/deudor, carga y lectura automática de documentos, verificación real contra entidades tributarias o de riesgo, cobro efectivo y liquidación al vencimiento, reparto entre tramos senior y junior, manejo de mora, mercado secundario, y cualquier pantalla (es solo capacidad de backend/contrato)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Registrar y validar una factura de demostración (Priority: P1)

Un operador de banco registra los datos de una factura ficticia (monto, moneda, proveedor,
deudor, sector, fecha de emisión y fecha de vencimiento) sin subir ningún documento real, y el
sistema la valida de inmediato por coherencia simple, dejándola aprobada y lista para asignarse a
un pool, o rechazada con un motivo claro.

**Why this priority**: Sin facturas aprobadas no existe nada que asignar a un pool ni que
tokenizar; es el punto de partida de todo el flujo de originación y puede demostrarse y probarse
de forma completamente aislada del resto de la feature.

**Independent Test**: Puede probarse de forma aislada registrando facturas con datos válidos e
inválidos (sin necesidad de que exista todavía ningún pool) y verificando que cada una queda
aprobada o rechazada con el motivo correcto, y que ningún rol distinto de operador de banco puede
registrar ni validar.

**Acceptance Scenarios**:

1. **Given** un operador de banco autenticado, **When** registra una factura con monto positivo,
   moneda soportada, fecha de vencimiento posterior a la de emisión y datos no duplicados, **Then**
   la factura queda en estado "aprobada" y disponible para asignarse a un pool.
2. **Given** un operador de banco autenticado, **When** registra una factura con monto cero o
   negativo, con fecha de vencimiento igual o anterior a la de emisión, o en una moneda no
   soportada, **Then** la factura queda en estado "rechazada" con un código de motivo específico y
   no puede asignarse a ningún pool.
3. **Given** una factura ya registrada y aprobada, **When** el operador intenta registrar otra
   factura con el mismo proveedor, deudor, monto y fechas, **Then** el sistema la rechaza por
   duplicada.
4. **Given** una cuenta con un rol distinto de operador de banco, **When** intenta registrar o
   validar una factura, **Then** el sistema rechaza la acción con un código de error y no crea
   ningún registro.

---

### User Story 2 - Asignar una factura aprobada a un pool y fraccionarla (Priority: P1)

Un operador de banco elige una factura aprobada, la asigna manualmente a un único pool y define
el anticipo (el monto que efectivamente financia de esa factura, no necesariamente su valor
nominal completo). El sistema suma ese anticipo al monto financiado acumulado del tramo
correspondiente, calcula cuántas fracciones completas resultan de ese acumulado según la unidad
mínima del pool, y dedica el residuo que no llega a completar una fracción adicional a la reserva
del pool, sin rechazar nunca una factura por ese residuo.

**Why this priority**: Es el paso que convierte una factura aislada en el respaldo real de un
pool; sin la asignación, un pool no tiene nada detrás y no puede fraccionarse ni tokenizarse.

**Independent Test**: Puede probarse de forma aislada con facturas aprobadas y pools de ejemplo ya
creados, asignando facturas con distintos anticipos a un pool y verificando que el monto
financiado acumulado, el número de fracciones disponibles y la reserva del tramo se actualizan
correctamente, que la factura queda bloqueada para cualquier otro pool, y que ningún rol distinto
de operador de banco puede asignar.

**Acceptance Scenarios**:

1. **Given** una factura aprobada y un pool con una unidad mínima de fracción definida, **When**
   el operador la asigna a ese pool definiendo su anticipo, **Then** el sistema suma ese anticipo
   al monto financiado acumulado del tramo, recalcula las fracciones disponibles como la parte
   entera de ese acumulado dividido entre la unidad mínima, y actualiza la reserva del tramo con el
   residuo restante.
2. **Given** una factura ya asignada a un pool, **When** el operador intenta asignarla a un segundo
   pool, **Then** el sistema rechaza la acción; una factura pertenece a un único pool.
3. **Given** una cuenta con un rol distinto de operador de banco, **When** intenta asignar una
   factura a un pool, **Then** el sistema rechaza la acción con un código de error.
4. **Given** un anticipo que, sumado al monto financiado ya acumulado del tramo, no alcanza a
   completar una fracción adicional completa, **When** el operador asigna la factura, **Then** el
   sistema no la rechaza: registra el excedente como reserva del pool sin fraccionarlo.
5. **Given** un anticipo mayor al valor nominal de la factura, **When** el operador intenta
   asignarla con ese anticipo, **Then** el sistema rechaza la asignación indicando el motivo.

---

### User Story 3 - Representar en cadena las fracciones del pool y las posiciones del inversionista (Priority: P1)

Un contrato inteligente de Soroban desplegado en Stellar testnet lleva el registro de cuántas
fracciones tiene cada pool/tramo y a nombre de qué cuenta están, y hace cumplir por sí mismo que
nunca se emitan más fracciones que el cupo disponible ni que nadie salvo el operador registre
facturas. Cuando un inversionista confirma un aporte (flujo ya existente), las fracciones
correspondientes quedan emitidas a su nombre en el contrato, verificables de forma independiente.

**Why this priority**: Es la evidencia on-chain verificable del proyecto y el requisito no
negociable de la plataforma: sin esto, el fraccionamiento y la propiedad de fracciones serían solo
un dato interno de la base de datos, sin respaldo real en la blockchain.

**Independent Test**: Puede probarse de forma aislada consultando directamente el contrato
desplegado en testnet (sin pasar por la plataforma) después de una asignación de factura y de un
aporte confirmado de ejemplo, y verificando que el cupo del tramo, las fracciones emitidas y su
propietario coinciden con lo esperado, y que un intento de registrar una factura u operación desde
una cuenta que no es la del operador es rechazado por el propio contrato.

**Acceptance Scenarios**:

1. **Given** una factura asignada a un tramo de un pool, **When** se consulta el contrato en
   Stellar testnet, **Then** el cupo total y disponible de fracciones de ese tramo reflejan
   exactamente el monto y la unidad mínima aplicados.
2. **Given** un inversionista que confirma un aporte a un tramo con cupo disponible, **When** la
   confirmación se completa, **Then** el contrato emite y registra a nombre de la cuenta del
   inversionista el número de fracciones correspondiente, verificable consultando el contrato de
   forma independiente a la plataforma.
3. **Given** un tramo con cupo disponible limitado, **When** dos aportes se confirman
   simultáneamente por un total que excede ese cupo, **Then** el contrato nunca emite más
   fracciones que las disponibles, aceptando solo hasta agotar el cupo.
4. **Given** cualquier intento de registrar una factura o su asignación a un pool/tramo
   directamente contra el contrato desde una cuenta que no es la del operador de banco, **When**
   se ejecuta esa operación, **Then** el contrato la rechaza.
5. **Given** el contrato desplegado, **When** se consulta cualquiera de sus datos públicos,
   **Then** nunca revela el nombre del proveedor, del deudor, ni ningún documento de una factura,
   únicamente su huella (hash).

---

### User Story 4 - Consultar las facturas anonimizadas que respaldan un pool (Priority: P2)

Un inversionista que está evaluando un pool consulta, antes de aportar, el listado de facturas que
lo respaldan en versión anonimizada: monto, plazo, fecha de vencimiento, sector y estado de cobro,
sin ver en ningún momento el nombre del proveedor ni del deudor. Con esa información puede evaluar
plazos y concentración antes de decidir cuánto aportar.

**Why this priority**: Es el requisito de transparencia que hace posible una decisión informada
del inversionista sobre un pool ya respaldado; depende de que existan facturas asignadas (Historia
2), pero puede entregarse y demostrarse justo después de esa capacidad.

**Independent Test**: Puede probarse de forma aislada abriendo el detalle de un pool de ejemplo ya
respaldado por varias facturas y verificando que el listado anonimizado muestra los campos
permitidos y en ningún caso los nombres de proveedor o deudor, sin necesidad de que el
inversionista llegue a aportar.

**Acceptance Scenarios**:

1. **Given** un pool respaldado por varias facturas asignadas, **When** un inversionista consulta
   su detalle, **Then** ve, por cada factura, el monto, el plazo, la fecha de vencimiento, el
   sector y el estado de cobro, sin el nombre del proveedor ni del deudor.
2. **Given** el listado de facturas anonimizadas de un pool, **When** el inversionista lo consulta,
   **Then** ve junto a él los agregados de concentración y las fracciones disponibles del tramo
   correspondiente, coherentes con el resto del detalle del pool.
3. **Given** una factura de cualquier pool, **When** un inversionista intenta acceder por
   cualquier vía al nombre de su proveedor o de su deudor, **Then** el sistema nunca expone ese
   dato a una cuenta de inversionista.

---

### User Story 5 - Ver el estado de cobro de las facturas de un pool como hecho, sin rendimiento (Priority: P3)

Un inversionista o el operador consultan el estado agregado de las facturas de un pool a lo largo
del tiempo: cuántas siguen pendientes, cuántas ya se cobraron y cuántas están en mora, y qué
porcentaje del pool ya se cobró. Esta información se presenta siempre como un hecho verificable,
nunca como un cálculo de rendimiento, retorno o dividendo esperado.

**Why this priority**: Aporta seguimiento y confianza sobre un pool ya respaldado y tokenizado,
pero no bloquea ni la originación de facturas ni el aporte del inversionista, por lo que puede
entregarse al final.

**Independent Test**: Puede probarse de forma aislada cambiando el estado de cobro de una o más
facturas de ejemplo (pendiente → cobrada o en mora) y verificando que los agregados del pool se
actualizan de inmediato, sin que en ningún punto se calcule o muestre una cifra de rendimiento.

**Acceptance Scenarios**:

1. **Given** un pool respaldado por facturas en distintos estados de cobro, **When** se consulta su
   detalle, **Then** se muestran los hechos agregados (facturas pendientes, cobradas, en mora y
   porcentaje cobrado) sin ninguna cifra de rendimiento, retorno o dividendo esperado.
2. **Given** una factura de un pool que cambia de "pendiente" a "cobrada" o a "en mora", **When** el
   cambio se registra, **Then** los agregados de estado del pool se actualizan de inmediato para
   reflejarlo.
3. **Given** el plazo propio de un pool y el margen que define respecto al vencimiento de sus
   facturas, **When** una factura individual se cobra unos días antes o después de su propio
   vencimiento dentro de ese margen, **Then** el pool no marca ninguna alerta ni incoherencia por
   esa diferencia.

---

### Edge Cases

- ¿Qué pasa si el operador registra una factura con monto cero, negativo, o con más decimales de
  los que la moneda admite? Se rechaza como dato inválido con un código de motivo.
- ¿Qué pasa si el operador registra la misma factura dos veces (mismo proveedor, deudor, monto y
  fechas)? La segunda queda rechazada por duplicada.
- ¿Qué pasa si dos operadores intentan asignar simultáneamente la misma factura aprobada a dos
  pools distintos? Solo una asignación se completa; la otra se rechaza porque la factura ya
  pertenece a un pool.
- ¿Qué pasa si el anticipo de una factura, sumado al monto financiado acumulado del tramo, no
  completa una fracción adicional completa? El residuo se registra como reserva del pool sin
  rechazar la factura.
- ¿Qué pasa si el operador define un anticipo mayor al valor nominal de la factura? Se rechaza la
  asignación con un código de motivo.
- ¿Qué pasa si una cuenta de inversionista intenta consultar el nombre del proveedor o del deudor
  de una factura por cualquier vía? El sistema nunca expone ese dato fuera del rol operador de
  banco.
- ¿Qué pasa si dos inversionistas confirman aportes simultáneos que en conjunto exceden el último
  cupo disponible de un tramo? El contrato acepta únicamente hasta agotar el cupo y rechaza el
  excedente, igual que el flujo de aporte ya existente.
- ¿Qué pasa si se consulta directamente el contrato desplegado en Stellar testnet? No revela
  ningún dato de proveedor, deudor ni documento, solo huellas (hash) y balances de fracciones.
- ¿Qué pasa si una factura cambia a estado "en mora"? El pool refleja el hecho en sus agregados de
  estado, sin que se calcule ni se muestre ninguna cifra de rendimiento o pérdida esperada.
- ¿Qué pasa si se vuelve a ejecutar la carga de datos de ejemplo sobre un entorno que ya tiene
  facturas, asignaciones y fracciones on-chain existentes? Los datos existentes se conservan sin
  duplicarse ni corromperse.

## Requirements *(mandatory)*

### Functional Requirements

**Registro y validación de facturas**

- **FR-001**: El sistema MUST permitir a una cuenta con rol operador de banco registrar una
  factura de demostración con monto, moneda, nombre de proveedor, nombre de deudor, sector, fecha
  de emisión y fecha de vencimiento, sin requerir la carga de ningún documento real.
- **FR-002**: El sistema MUST rechazar el registro de una factura cuando el monto no sea positivo,
  cuando la fecha de vencimiento no sea posterior a la fecha de emisión, o cuando la moneda no esté
  entre las monedas soportadas por la plataforma, indicando en cada caso un código de motivo
  específico.
- **FR-003**: El sistema MUST rechazar el registro de una factura cuyo proveedor, deudor, monto y
  fechas coincidan exactamente con los de una factura ya registrada, marcándola como duplicada.
- **FR-004**: El sistema MUST dejar cada factura registrada en estado "aprobada" o "rechazada" de
  forma inmediata tras la validación, sin estados intermedios de revisión manual adicional.
- **FR-005**: El sistema MUST impedir que cualquier cuenta sin rol operador de banco registre o
  valide una factura, rechazando el intento con un código de error específico.

**Asignación a un pool y fraccionamiento**

- **FR-006**: El sistema MUST permitir a un operador de banco asignar manualmente una factura en
  estado "aprobada" a un único pool.
- **FR-007**: El sistema MUST impedir que una factura ya asignada a un pool se asigne a un segundo
  pool.
- **FR-008**: El sistema MUST impedir que cualquier cuenta sin rol operador de banco asigne una
  factura a un pool, rechazando el intento con un código de error específico.
- **FR-009**: Al asignar una factura a un pool, el operador de banco MUST definir el anticipo
  (monto financiado) de esa factura; el sistema MUST rechazar la asignación cuando ese anticipo sea
  menor o igual a cero o mayor que el valor nominal de la factura, indicando un código de motivo
  específico.
- **FR-010**: El sistema MUST calcular las fracciones disponibles de un tramo a partir de la suma
  acumulada de los anticipos de las facturas que tiene asignadas, tomando la parte entera de esa
  suma dividida entre la unidad mínima del pool; el residuo que no complete una fracción adicional
  MUST registrarse como reserva del pool, sin que ninguna factura sea rechazada por ese motivo. La
  unidad mínima del pool se aplica así al monto financiado acumulado del tramo (y, según el flujo
  de aporte ya existente, al monto que aporta cada inversionista), nunca al valor nominal
  individual de cada factura.
- **FR-011**: Al confirmarse la asignación de una factura, el sistema MUST actualizar de inmediato
  el monto financiado acumulado, las fracciones disponibles y la reserva del tramo del pool
  correspondiente.
- **FR-012**: El sistema MUST tratar toda asignación de una factura a un pool como definitiva e
  irreversible desde el momento en que se confirma, sin ofrecer ninguna vía para desasignarla.

**Representación en cadena (contrato Soroban)**

- **FR-013**: El sistema MUST representar en un contrato inteligente desplegado en Stellar testnet
  el número total de fracciones de cada pool/tramo y qué cuenta posee cada una, de forma
  consultable de manera independiente a la plataforma.
- **FR-014**: El contrato MUST impedir por sí mismo que se emitan más fracciones de un tramo que
  su cupo disponible, incluso ante múltiples solicitudes concurrentes.
- **FR-015**: El contrato MUST impedir por sí mismo que cualquier cuenta distinta de la del
  operador de banco registre facturas o su asignación a un pool/tramo en la representación
  on-chain.
- **FR-016**: El sistema MUST registrar en el contrato únicamente una huella (hash) de cada
  factura, nunca sus datos identificables (proveedor, deudor) ni ningún documento asociado.
- **FR-017**: Al confirmarse un aporte de un inversionista sobre un tramo con cupo disponible
  (flujo de cotización y confirmación ya existente), el sistema MUST reflejar en el contrato la
  emisión de las fracciones correspondientes a nombre de la cuenta de ese inversionista.
- **FR-018**: El sistema MUST permitir verificar, consultando el contrato directamente en Stellar
  testnet y sin depender de la plataforma, las fracciones que posee cualquier cuenta en cualquier
  pool/tramo.

**Transparencia hacia el inversionista**

- **FR-019**: El sistema MUST permitir a un inversionista consultar, para cualquier pool, el
  listado de facturas que lo respaldan en versión anonimizada, mostrando monto, plazo, fecha de
  vencimiento, sector y estado de cobro.
- **FR-020**: El sistema MUST excluir de la versión anonimizada de una factura, en cualquier
  circunstancia, el nombre de su proveedor y el de su deudor.
- **FR-021**: El sistema MUST restringir la visibilidad del nombre del proveedor y del deudor de
  una factura exclusivamente a cuentas con rol operador de banco.
- **FR-022**: El sistema MUST mostrar junto al listado de facturas anonimizadas de un pool los
  agregados de concentración y las fracciones disponibles del tramo correspondiente ya definidos
  para el detalle de pool.

**Plazos y estado de cobro de las facturas**

- **FR-023**: El sistema MUST mantener para cada factura un estado de cobro entre "pendiente",
  "cobrada" y "en mora", como dato informativo que no dispara ningún movimiento de dinero ni
  cálculo de rendimiento.
- **FR-024**: El sistema MUST permitir definir, para cada pool, un margen de plazo propio respecto
  a la fecha de vencimiento de sus facturas, de modo que diferencias razonables de plazo entre
  facturas individuales del mismo pool no se traten como una incoherencia.
- **FR-025**: El sistema MUST exponer, para cada pool, los hechos agregados de estado de sus
  facturas (número de facturas pendientes, cobradas y en mora, y porcentaje cobrado), sin calcular
  ni mostrar en ningún caso un rendimiento, retorno o dividendo esperado.
- **FR-026**: El sistema MUST actualizar los hechos agregados de estado de un pool inmediatamente
  después de que el estado de cobro de cualquiera de sus facturas cambie.

**Coherencia, idempotencia y consistencia**

- **FR-027**: El sistema MUST tratar el contrato Soroban como la fuente de verdad de las
  fracciones: cuando la confirmación de un aporte actualice el contrato pero falle en reflejarse en
  el registro interno de la plataforma (o viceversa), el sistema MUST reconciliar o reintentar el
  registro interno hasta que coincida con lo emitido en el contrato, sin dejar nunca una fracción
  registrada en el contrato sin su correspondiente reflejo en el registro interno de forma
  indefinida.
- **FR-028**: Toda operación de registro, validación o asignación de facturas que modifique estado
  MUST ser idempotente: repetir la misma solicitud (p. ej. por reintento o doble clic) no produce un
  segundo registro ni una segunda asignación.
- **FR-029**: El sistema MUST rechazar con un código de error específico cualquier intento de
  registrar, validar o asignar una factura realizado por una cuenta sin rol operador de banco,
  tanto en la plataforma como en el contrato.

**Datos de ejemplo**

- **FR-030**: El sistema MUST proveer un mecanismo de carga de datos de ejemplo que crea facturas
  ficticias cubriendo, entre ellas, los estados "pendiente", "cobrada", "en mora", "rechazada" y
  "asignada", con proveedores, deudores y sectores variados.
- **FR-031**: Los datos de ejemplo MUST incluir al menos un pool completamente respaldado por
  facturas asignadas, con sus fracciones ya reflejadas en el contrato desplegado en Stellar
  testnet, listo para demostrarse de punta a punta.
- **FR-032**: El mecanismo de carga de datos de ejemplo MUST poder ejecutarse repetidamente sin
  duplicar ni corromper las facturas, asignaciones ni fracciones on-chain ya existentes.

### Key Entities

- **Proveedor**: empresa ficticia titular de una factura por cobrar, que necesita liquidez antes
  de su vencimiento. Es solo un dato de la factura; no tiene cuenta, login ni pantalla propia. Su
  nombre solo es visible para el operador de banco.
- **Deudor**: empresa ficticia obligada a pagar una factura en su fecha de vencimiento; equivale al
  concepto de "empresa pagadora" ya definido en la exploración de pools, con terminología alineada
  para esta feature. Es solo un dato de la factura; su nombre solo es visible para el operador de
  banco.
- **Factura**: unidad de originación con monto nominal, moneda, proveedor, deudor, sector, fecha
  de emisión, fecha de vencimiento, resultado de validación (aprobada/rechazada con motivo) y
  estado de cobro (pendiente/cobrada/en mora); corresponde a la "Operación (factura fraccionable)"
  ya definida para la exploración de pools, extendida aquí con su ciclo de originación completo
  antes de quedar asignada a un pool. Pertenece a un único pool tras su asignación, momento en el
  que además queda ligada a su anticipo.
- **Pool/Tramo**: entidad ya existente que agrupa facturas asignadas de una misma moneda; define
  una unidad mínima de fracción y expone, por tramo, el monto financiado acumulado, el número de
  fracciones disponibles y la reserva que resultan de los anticipos de las facturas que tiene
  asignadas.
- **Anticipo**: monto que el operador de banco decide financiar de una factura al asignarla a un
  pool; puede ser menor que el valor nominal de la factura, pero nunca mayor. Es el monto que
  efectivamente cuenta para el fraccionamiento del tramo, no el valor nominal completo de la
  factura.
- **Reserva del pool**: parte del monto financiado acumulado de un tramo que, tras dividirlo entre
  la unidad mínima, no alcanza a completar una fracción adicional; se acumula conforme se asignan
  facturas y nunca bloquea ni rechaza una asignación.
- **Fracción**: unidad de participación de un inversionista en un pool/tramo, emitida y registrada
  en el contrato on-chain; el número de fracciones disponibles de un tramo surge de dividir la
  suma acumulada de los anticipos de sus facturas asignadas entre la unidad mínima del pool.
- **Contrato de fracciones (Soroban)**: contrato inteligente desplegado en Stellar testnet que es
  la fuente de evidencia on-chain: registra cuántas fracciones tiene cada pool/tramo y quién las
  posee, hace cumplir el cupo por tramo y que solo el operador registre facturas, y guarda
  únicamente la huella de cada factura, nunca sus datos identificables ni el documento.
- **Huella de factura**: valor (hash) derivado de los datos de una factura que se guarda en el
  contrato en lugar de sus datos reales, permitiendo asociar una factura registrada en la
  plataforma con su representación on-chain sin exponer información identificable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100% de las facturas registradas por un operador quedan en estado "aprobada" o
  "rechazada" de forma inmediata, sin quedar nunca en un estado de revisión pendiente.
- **SC-002**: El 100% de las facturas asignadas a un pool corresponden, en cualquier momento
  posterior, a exactamente un único pool.
- **SC-003**: El contrato on-chain nunca emite más fracciones que el cupo disponible de un tramo,
  incluso bajo 20 confirmaciones de aporte simultáneas dirigidas al mismo cupo.
- **SC-004**: Un inversionista puede revisar la composición de facturas de cualquier pool sin
  encontrar en ningún campo visible el nombre de un proveedor o de un deudor.
- **SC-005**: El 100% de las fracciones registradas a nombre de un inversionista tras un aporte
  confirmado pueden verificarse consultando directamente el contrato en Stellar testnet, sin pasar
  por la plataforma.
- **SC-006**: Un cambio de estado de cobro de una factura se refleja en los agregados de su pool en
  menos de 5 segundos.
- **SC-007**: Al finalizar la carga de datos de ejemplo, existe al menos un pool demostrable de
  punta a punta (factura registrada → factura asignada → fracción on-chain → posición del
  inversionista) sin requerir ninguna acción manual adicional del operador durante la demo.
- **SC-008**: Ninguna pantalla, mensaje ni pieza de documentación del producto presenta el plazo o
  el estado de cobro de una factura como una promesa de rendimiento, retorno o dividendo (0
  menciones encontradas en una revisión de contenido).
- **SC-009**: La reserva acumulada de cualquier tramo nunca alcanza por sí sola el valor de una
  unidad mínima adicional, evidenciando que toda fracción completa ya disponible fue contabilizada
  correctamente a partir de los anticipos asignados.

## Assumptions

- "Empresa pagadora", ya definida en la exploración de pools, y "Deudor", introducido en esta
  feature, se refieren al mismo concepto; esta especificación adopta "Deudor" para nombrar
  explícitamente su rol frente al "Proveedor" dentro de una factura.
- La distinción entre factoring y confirming no es relevante para esta especificación: el pool es
  siempre la entidad que financia las facturas, sin flujos separados por tipo de operación.
- La forma exacta en que el contrato representa una fracción (por ejemplo, como un token fungible
  por tramo o como un registro interno de saldos del propio contrato) es una decisión de
  implementación que se resuelve en la fase de planeación; el único requisito de esta
  especificación es que el balance de fracciones por cuenta y por pool/tramo sea consultable de
  forma independiente en Stellar testnet.
- El margen de plazo de un pool respecto al vencimiento de sus facturas es un parámetro propio de
  cada pool, definido por el operador al crearlo o editarlo, sin un valor fijo global para todos
  los pools.
- La validación de una factura es una verificación simulada de coherencia de datos (monto, fechas,
  moneda, duplicados); no implica ninguna conexión con entidades tributarias, centrales de riesgo
  ni verificación de documentos reales.
- El reparto del monto de una factura entre el tramo senior y el junior de un pool, el cobro
  efectivo al vencimiento, la liquidación al inversionista y el manejo de mora quedan fuera de
  alcance de esta especificación y se abordan en una especificación posterior.
- El anticipo de cada factura es un dato que el operador de banco ingresa manualmente al momento
  de asignarla a un pool, sin un porcentaje o valor por defecto; el destino final de la reserva
  acumulada de un tramo (si se usa para financiar facturas futuras, se devuelve, o se trata de otra
  forma) queda fuera de alcance de esta especificación y se define en la especificación posterior
  que cubra cobro y liquidación.
- El mercado secundario (reventa de fracciones entre inversionistas) queda fuera de alcance de
  esta especificación.
- Ni el proveedor ni el deudor de una factura tienen cuenta, login ni pantalla propia en esta
  iteración; son exclusivamente datos de la factura que gestiona el operador de banco.
- El catálogo de pools ya existente se extiende para exponer, además de sus agregados actuales, el
  listado de facturas anonimizadas que lo respaldan, sin modificar los campos agregados ya
  definidos para el detalle de un pool.
- Todos los nombres de proveedor y deudor usados en los datos de ejemplo son ficticios y no
  corresponden a empresas reales.
