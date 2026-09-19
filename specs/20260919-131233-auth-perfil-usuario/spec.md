# Feature Specification: Registro, Inicio de Sesión y Perfil de Usuario

**Feature Branch**: `20260919-131233-auth-perfil-usuario`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Como inversionista o como operador de banco, quiero poder crear una cuenta, iniciar sesión, y ver y editar mi información de perfil, para poder empezar a usar la plataforma de fraccionamiento de activos financieros sobre Stellar."

## Clarifications

### Session 2026-09-19

- Q: ¿Quién debe tener el control operativo de la llave privada de la wallet de Stellar testnet que se genera automáticamente para cada inversionista? → A: Custodia total de la plataforma — la plataforma almacena la llave privada y firma automáticamente todas las transacciones del inversionista; el usuario nunca ve ni maneja la llave.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Registro de cuenta con rol y datos de perfil (Priority: P1)

Una persona nueva llega a la plataforma y decide registrarse. Elige explícitamente si va a
usar la plataforma como inversionista retail o como operador de banco/compliance, se registra
con email y contraseña, y completa los datos requeridos para su rol. Si se registra como
inversionista, al terminar el registro ya tiene una wallet de Stellar testnet asociada a su
cuenta sin haber tenido que hacer nada adicional.

**Why this priority**: Sin una cuenta con rol definido no existe ninguna otra funcionalidad
posible en la plataforma; es la puerta de entrada obligatoria tanto para inversionistas como
para operadores, y es el único momento en que se fija el rol de la cuenta.

**Independent Test**: Puede probarse de forma aislada enviando una solicitud de registro para
cada rol (inversionista y operador de banco) directamente contra la API de autenticación, y
verificando que la cuenta queda creada con el rol elegido, los datos capturados correctos, y —
solo para inversionista — una wallet de Stellar testnet asociada a la cuenta, consultable vía la
API de perfil. No requiere ninguna interfaz de usuario para validarse.

**Acceptance Scenarios**:

1. **Given** una persona sin cuenta en la plataforma, **When** se registra eligiendo el rol
   "inversionista", proporciona nombre completo y teléfono, y completa el registro con email y
   contraseña, **Then** la cuenta queda creada con rol "inversionista" fijo, los datos
   capturados guardados, y una wallet de Stellar testnet fondeada asociada a la cuenta.
2. **Given** una persona sin cuenta en la plataforma, **When** se registra eligiendo el rol
   "operador de banco" y proporciona su nombre completo con email y contraseña, **Then** la
   cuenta queda creada con rol "operador de banco" fijo, sin wallet asociada.
3. **Given** una solicitud de registro, **When** se envía sin especificar un rol, **Then** el
   sistema la rechaza e indica que el rol es obligatorio.
4. **Given** un email que ya tiene una cuenta registrada, **When** alguien intenta registrarse
   de nuevo con ese mismo email, **Then** el sistema rechaza el registro e informa que el email
   ya está en uso.

---

### User Story 2 - Inicio de sesión con rol de cuenta disponible para el frontend (Priority: P2)

Una persona que ya tiene cuenta se autentica con email y contraseña. El sistema valida las
credenciales y expone el rol fijo de la cuenta como parte de la respuesta de autenticación, de
modo que un frontend — a construirse en una feature separada — pueda decidir a qué experiencia
dirigir a la persona (app móvil para inversionistas, panel web para operadores de banco). La
navegación o redirección en sí no forma parte de esta especificación: aquí el sistema solo
garantiza que el rol de la cuenta esté disponible de forma confiable inmediatamente después de
autenticarse.

**Why this priority**: Es el segundo paso indispensable después del registro: sin una
autenticación que exponga el rol de forma confiable, ningún frontend podría decidir
correctamente a qué experiencia dirigir a una cuenta ya creada.

**Independent Test**: Puede probarse de forma aislada usando una cuenta ya existente de cada
rol, autenticándose con el método correspondiente directamente contra la API, y verificando que
la respuesta de autenticación incluye el rol correcto de la cuenta. No requiere ninguna interfaz
de usuario ni navegación real para validarse.

**Acceptance Scenarios**:

1. **Given** una cuenta de inversionista ya registrada con email/contraseña, **When** se
   autentica con esas credenciales, **Then** el sistema valida las credenciales exitosamente y
   la respuesta de autenticación incluye el rol "inversionista" asociado a la cuenta.
2. **Given** una cuenta de operador de banco ya registrada con email/contraseña, **When** se
   autentica con esas credenciales, **Then** el sistema valida las credenciales exitosamente y
   la respuesta de autenticación incluye el rol "operador de banco" asociado a la cuenta.
3. **Given** una persona sin cuenta registrada, **When** intenta autenticarse, **Then** el
   sistema rechaza el intento e indica que las credenciales no son válidas.

---

### User Story 3 - Ver y editar información de perfil (Priority: P3)

Una persona ya autenticada consulta su información de perfil (nombre, email, teléfono si
aplica, y — si es inversionista — la dirección pública de su wallet de Stellar testnet) y puede
editar los campos que son editables (nombre, teléfono, foto de perfil opcional). El email y el
rol se incluyen en la respuesta de consulta de perfil, pero no pueden modificarse mediante la
operación de edición de perfil.

**Why this priority**: Es una funcionalidad de valor pero no bloquea el resto del flujo de
demo; una cuenta puede registrarse e iniciar sesión de forma independiente de que la
funcionalidad de consulta/edición de perfil ya esté disponible.

**Independent Test**: Puede probarse de forma aislada autenticándose con una cuenta existente de
cada rol, consultando el perfil directamente contra la API, verificando que se devuelven los
datos correctos para ese rol, actualizando un campo editable vía la API y confirmando que el
cambio se persiste, e intentando actualizar el email o el rol vía la API y confirmando que la
plataforma lo rechaza. No requiere ninguna interfaz de usuario para validarse.

**Acceptance Scenarios**:

1. **Given** una persona autenticada con rol inversionista, **When** consulta su perfil,
   **Then** la respuesta incluye su nombre, email, teléfono y la dirección pública de su wallet
   de Stellar testnet.
2. **Given** una persona autenticada con rol operador de banco, **When** consulta su perfil,
   **Then** la respuesta incluye su nombre y email, sin ninguna dirección de wallet.
3. **Given** una persona autenticada, **When** actualiza su nombre o teléfono mediante la
   operación de edición de perfil, **Then** el sistema persiste el cambio y lo refleja de
   inmediato en la siguiente consulta de su perfil.
4. **Given** una persona autenticada, **When** intenta modificar su email o su rol mediante la
   operación de edición de perfil, **Then** el sistema rechaza el cambio porque esos campos no
   son editables.

---

### User Story 4 - Acceso mediante cuentas de demostración precargadas (Priority: P4)

Alguien que quiere probar la plataforma (por ejemplo, un evaluador del hackathon) se autentica
directamente con una de las cuentas de demostración precargadas con credenciales conocidas, sin
necesidad de registrarse desde cero, y al consultar su perfil obtiene datos de ejemplo ya
poblados.

**Why this priority**: No es una funcionalidad para el usuario final del producto, sino un
mecanismo de datos de prueba que facilita la demo; el flujo real de registro/login/perfil
(Historias 1-3) debe funcionar independientemente de que existan o no cuentas de demostración.

**Independent Test**: Puede probarse de forma aislada autenticándose con las credenciales de una
cuenta de demostración de cada rol directamente contra la API, y verificando — vía la API de
perfil — que los datos ya están poblados, sin haber pasado por el flujo de registro.

**Acceptance Scenarios**:

1. **Given** el conjunto de datos de prueba ha sido cargado, **When** alguien se autentica con
   las credenciales conocidas de una cuenta de demostración de inversionista, **Then** obtiene
   una sesión autenticada con rol "inversionista" y, al consultar su perfil, encuentra los datos
   y la wallet de Stellar testnet ya poblados.
2. **Given** el conjunto de datos de prueba ha sido cargado, **When** alguien se autentica con
   las credenciales conocidas de la cuenta de demostración de operador de banco, **Then** obtiene
   una sesión autenticada con rol "operador de banco" y, al consultar su perfil, encuentra los
   datos ya poblados.

---

### Edge Cases

- ¿Qué pasa si el registro de un inversionista se completa pero la creación/fondeo de la wallet
  de Stellar testnet falla o se demora? El sistema debe evitar dejar la cuenta en un estado a
  medias sin explicación; se asume reintento automático o manual antes de considerar el registro
  completo (ver Assumptions).
- ¿Qué pasa si una solicitud autenticada con rol operador intenta acceder a datos o funciones
  reservadas a inversionista, o viceversa? El sistema debe autorizar siempre según el rol fijo
  almacenado en la cuenta, no según lo que la solicitud declare explícitamente.
- ¿Qué pasa si alguien manipula la solicitud para intentar editar el email o el rol de su
  cuenta? El sistema debe rechazar el cambio independientemente del origen de la solicitud.
- ¿Qué pasa si dos cuentas de demostración con el mismo rol se usan simultáneamente durante una
  demo? Cada una debe comportarse como una cuenta independiente con sus propios datos.
- ¿Qué pasa si un inversionista o cualquier tercero solicita ver o exportar la llave privada de
  su wallet? El sistema lo rechaza siempre; la llave privada es custodiada por la plataforma y
  nunca se expone, solo la dirección pública es visible.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: El sistema DEBE permitir que cualquier persona cree una cuenta usando email y
  contraseña.
- **FR-002**: El sistema DEBE requerir que toda solicitud de registro especifique explícitamente
  exactamente un rol: "inversionista" u "operador de banco".
- **FR-003**: El sistema DEBE fijar el rol de la cuenta de forma permanente desde el momento del
  registro; no existe ninguna función para cambiar el rol de una cuenta ya creada.
- **FR-004**: Para el registro de inversionista, el sistema DEBE capturar adicionalmente nombre
  completo y teléfono.
- **FR-005**: Para el registro de inversionista, el sistema DEBE crear automáticamente y
  asociar a la cuenta una wallet de Stellar testnet (par de llaves, cuenta fondeada en testnet),
  sin requerir que la persona aporte su propia wallet. La plataforma custodia la llave privada de
  forma segura en el backend y firma las transacciones en nombre del inversionista.
- **FR-006**: Para el registro de operador de banco, el sistema DEBE capturar el nombre
  completo; no se crea ninguna wallet para cuentas de operador.
- **FR-007**: El sistema DEBE permitir iniciar sesión usando email y contraseña.
- **FR-008**: Tras una autenticación exitosa, el sistema DEBE determinar y exponer el rol fijo de
  la cuenta como parte de la respuesta de autenticación, de forma que un frontend (fuera de
  alcance de este spec) pueda decidir a qué experiencia dirigir a la persona. La navegación o
  redirección en sí no es responsabilidad de este sistema.
- **FR-009**: El sistema DEBE permitir que una persona autenticada vea su información de
  perfil: nombre, email, teléfono (si aplica), y — para inversionistas — la dirección pública de
  su wallet de Stellar testnet.
- **FR-010**: El sistema DEBE permitir que una persona autenticada edite los campos editables de
  su perfil: nombre completo, teléfono y foto de perfil (opcional).
- **FR-011**: El sistema DEBE impedir que el email o el rol de una cuenta se modifiquen desde el
  flujo de perfil.
- **FR-012**: El sistema DEBE ofrecer un mecanismo de datos de prueba que precargue varias
  cuentas de ejemplo (múltiples inversionistas y al menos un operador de banco) con credenciales
  conocidas, utilizables para explorar la plataforma sin pasar por el registro.
- **FR-013**: El sistema DEBE rechazar el registro con un email que ya tiene una cuenta asociada
  e informar a la persona de la razón del rechazo.
- **FR-014**: El sistema NUNCA DEBE exponer, mostrar o permitir exportar la llave privada de la
  wallet de un inversionista; solo la dirección pública es visible para el usuario (ver perfil,
  FR-009).

### Key Entities *(include if feature involves data)*

- **Cuenta de Usuario**: identidad autenticable de la plataforma; tiene un email, un método de
  autenticación, y un rol fijo ("inversionista" u "operador de banco") asignado en el momento del
  registro y no editable después.
- **Perfil de Inversionista**: datos asociados 1:1 a una Cuenta de Usuario con rol inversionista —
  nombre completo, teléfono, foto de perfil opcional, y la dirección pública de la wallet de
  Stellar testnet asociada.
- **Perfil de Operador de Banco**: datos asociados 1:1 a una Cuenta de Usuario con rol operador
  de banco — nombre completo y foto de perfil opcional.
- **Wallet de Stellar Testnet**: par de llaves y cuenta fondeada en la red de prueba de Stellar,
  creada automáticamente y asociada exclusivamente a cuentas con rol inversionista. La llave
  privada queda bajo custodia exclusiva de la plataforma (modelo custodial); el inversionista
  solo ve y comparte la dirección pública, nunca la llave privada.
- **Cuenta de Demostración**: Cuenta de Usuario marcada como dato de prueba, con credenciales
  conocidas y datos de perfil precargados, usada solo para fines de demo y no como funcionalidad
  de producto para el usuario final.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Una persona nueva puede completar el registro (proveer rol y datos requeridos) en
  menos de 2 minutos.
- **SC-002**: El 100% de las cuentas de inversionista creadas tienen una dirección de wallet de
  Stellar testnet válida y consultable inmediatamente después de completar el registro.
- **SC-003**: Una persona con cuenta existente puede autenticarse y obtener el rol de su cuenta
  en menos de 15 segundos.
- **SC-004**: El 100% de los intentos de editar el email o el rol de una cuenta son bloqueados
  por el sistema, sin excepciones.
- **SC-005**: Un evaluador puede autenticarse con una cuenta de demostración precargada y obtener
  sus datos de perfil completos (incluida la wallet, si aplica) en menos de 1 minuto, sin haberse
  registrado.
- **SC-006**: Al menos el 95% de las solicitudes de registro con datos completos y válidos son
  aceptadas y procesadas exitosamente en el primer intento, sin errores ambiguos.

## Fuera de Alcance

- **Cualquier interfaz de usuario, pantalla, navegación o código de frontend** (app móvil
  Expo/React Native, panel web Next.js, o cualquier otro cliente) queda fuera de esta
  especificación. Esta spec cubre exclusivamente la capa de backend: autenticación, tablas,
  funciones/Edge Functions y las políticas de acceso expuestas como API. Cómo un frontend
  consume esa API, construye pantallas, maneja formularios o implementa la navegación entre
  experiencias según el rol se especificará en una feature separada.
- Login social / OAuth (Google u otro proveedor) — decisión explícita del equipo, no una
  limitación técnica; el registro y login se hacen exclusivamente con email y contraseña.
- Recuperación de contraseña / flujos de "olvidé mi contraseña".
- Verificación de identidad o KYC real.
- Compra de fracciones, lógica de pools, y el panel de aprobación de confirming del operador de
  banco.
- Cambiar el rol de una cuenta ya creada.

## Assumptions

- El registro y el login se hacen exclusivamente con email y contraseña — es la forma nativa y
  más simple que ofrece Supabase Auth, consistente con el Principio I (velocidad) de la
  constitución del proyecto. El equipo decidió explícitamente no incorporar login social
  (Google u otro proveedor OAuth) en esta versión.
- Las cuentas de "operador de banco" se crean mediante el mismo flujo de registro abierto que las
  de inversionista para efectos de la demo; un sistema real probablemente restringiría la
  creación de cuentas de operador a un proceso de invitación o aprobación administrativa, pero
  eso queda fuera de alcance de este spec (no hay verificación de identidad ni KYC real).
- La creación y fondeo de la wallet de Stellar testnet puede reintentarse si falla por una
  interrupción transitoria de red; una falla temporal no debe dejar la cuenta en un estado
  parcialmente creado sin posibilidad de completar el registro.
- La foto de perfil es un campo opcional simple (subida de imagen básica); no se requiere
  moderación ni validación de contenido más allá de tipo y tamaño de archivo razonables.
- Las credenciales de las cuentas de demostración se documentan junto con el mecanismo de seed
  (por ejemplo, en el README del proyecto), no se tratan como secretas ni se exponen mediante
  ningún endpoint de la API.
