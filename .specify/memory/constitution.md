<!--
Sync Impact Report
- Version change: 1.0.0 → 1.1.0
- Ratification type: Amendment (MINOR — new principle added, no existing principle redefined or removed)
- Modified principles: none (Principles I-VI unchanged, carried over verbatim)
- Added principles:
  - VII. Toda la Infraestructura de Supabase Vive Versionada en el Repositorio (NON-NEGOTIABLE)
- Added sections: none (only the new principle within Core Principles)
- Removed sections: none
- Amended sections:
  - Flujo de Trabajo de Desarrollo — updated principle count reference (6 → 7) and added
    Principle VII to the self-check priority list
  - Governance > Revisión de cumplimiento — added schema-drift check (changes applied only via
    the Supabase dashboard, without a matching versioned file in /supabase) to the list of
    deviations to catch
- Templates requiring updates:
  - .specify/templates/plan-template.md — ⚠ pending manual check (Constitution Check gate should
    now also verify that any Supabase schema/function change in the plan is expressed as a file
    under /supabase, not a manual dashboard step)
  - .specify/templates/tasks-template.md — ⚠ pending manual check (tasks that create/modify
    Supabase tables, RLS policies, triggers, or Edge Functions should explicitly produce a file
    under /supabase/migrations or /supabase/functions, never a "configure in dashboard" task)
- Follow-up TODOs: none
-->

# Paul Constitution

## Core Principles

### I. Velocidad sobre Perfección, sin Sacrificar Estructura Básica

Entregar una demo funcional dentro de una semana tiene prioridad sobre cobertura de tests
automatizados o procesos formales de code review; el equipo NO escribe tests automatizados durante
el desarrollo del hackathon. Sin embargo, todo código DEBE respetar el principio de responsabilidad
única (single responsibility) por archivo, módulo y función; la estructura de carpetas DEBE
mantenerse clara y predecible; y ningún archivo puede crecer hasta convertirse en un archivo de
cientos de líneas — cuando esto ocurre, DEBE dividirse antes de seguir añadiendo lógica.

**Rationale**: en una semana con un equipo de 3 personas, la deuda técnica estructural (archivos
gigantes, funciones que hacen de todo, carpetas caóticas) es lo único que puede frenar la velocidad
de forma irreversible a mitad de sprint. Los tests y el code review formal son sacrificables porque
su ausencia es reversible después del hackathon; una base de código desorganizada no lo es dentro
del tiempo disponible.

### II. Stack Flexible, Decisión de Equipo sobre Dogma de Herramientas

El stack inicial es Supabase (backend, base de datos Postgres, Auth, Edge Functions), Expo/React
Native (app móvil, prioridad), Next.js (panel web para operador de banco/compliance), y Soroban/Rust
(smart contract on-chain en Stellar testnet). Cualquier parte de este stack PUEDE recortarse o
cambiarse a mitad de semana si el equipo lo considera necesario para avanzar más rápido. Ninguna
herramienta es sagrada.

**Rationale**: el objetivo final es la demo funcionando, no la fidelidad a una elección de stack
tomada antes de conocer los obstáculos reales de la semana.

### III. Arquitectura Pragmática entre Apps

La relación entre la app móvil y el panel web — cuánto código o lógica comparten, si viven en
monorepo o no — se decide sobre la marcha según lo que sea más rápido de construir en el momento.
No existe una regla arquitectónica fija de antemano que dicte esta relación.

**Rationale**: fijar de antemano una arquitectura de compartición de código entre dos apps con
audiencias distintas (usuario móvil vs. operador de banco/compliance) arriesga optimizar para un
problema que puede no materializarse, a costa de tiempo de desarrollo.

### IV. Un Solo Modelo de Datos Genérico

El dominio se modela alrededor de un concepto único de "activo fraccionable", con el tipo de activo
representado como metadata — no como flujos de datos o UI separados por tipo de activo. Toda
decisión de modelado de datos o de interfaz DEBE evaluarse contra si mantiene este flujo único:
catálogo → detalle → compra de fracción → portafolio. Una decisión que introduce una ramificación
especial por tipo de activo viola este principio salvo que sea estrictamente necesaria para el caso
de uso de confirming (Principio V).

**Rationale**: un modelo genérico permite añadir o quitar tipos de activo (facturas de confirming,
u otros a futuro) sin reescribir pantallas ni tablas, lo cual es crítico cuando el alcance puede
ajustarse en tiempo real durante la semana.

### V. Enfoque en el Caso de Uso Principal: Confirming con Pool y Tranches

El producto demuestra un pool de liquidez que fracciona el riesgo entre múltiples facturas/PYMEs
pequeñas mediante tranches senior/junior, aplicado al caso de confirming. Cualquier feature que no
sirva directamente a mostrar el flujo completo — emisión → fraccionamiento → compra → pago →
distribución — en una demo de 3 minutos se considera fuera de alcance y NO DEBE construirse durante
el hackathon.

**Rationale**: en una semana, cada hora dedicada a una feature fuera de este flujo demo-céntrico es
una hora restada al único camino que el jurado evaluará. El scope se define por lo que se puede
mostrar, no por lo que sería interesante construir.

### VI. Evidencia On-Chain Real, No Simulada (NON-NEGOTIABLE)

La lógica de pool y distribución de tranches DEBE ejecutarse realmente en un smart contract Soroban
desplegado en Stellar testnet. Está prohibido simular esta lógica del lado del backend (Supabase/
Edge Functions) y presentarla como si fuera on-chain.

**Rationale**: este es el requisito técnico central de la propuesta para Stellar Odyssey Perú 2026 —
es la prueba de que el proyecto usa la blockchain como algo más que un adorno. A diferencia de los
demás principios, este NO es recortable a mitad de semana; si el tiempo aprieta, se recorta alcance
de features (Principio V) antes que la autenticidad on-chain.

### VII. Toda la Infraestructura de Supabase Vive Versionada en el Repositorio (NON-NEGOTIABLE)

Está prohibido crear o modificar tablas, columnas, políticas de RLS, funciones (Edge Functions),
triggers, o cualquier otro objeto de base de datos directamente desde la interfaz web (dashboard)
de Supabase como fuente de verdad. Todo cambio de esquema o de lógica DEBE expresarse como un
archivo versionado dentro de `/supabase` del repositorio (migraciones SQL en
`/supabase/migrations`, funciones en `/supabase/functions`) y aplicarse mediante el Supabase CLI
(`supabase db push`, `supabase functions deploy`). El dashboard de Supabase PUEDE usarse para
inspeccionar o depurar datos, pero NUNCA como el lugar donde se define la estructura del sistema.

**Rationale**: garantiza trazabilidad en Git de cada decisión de esquema o de lógica, y permite que
el README del proyecto (requisito de las bases de la hackatón, sección 07) explique la
arquitectura completa a partir del propio repositorio, sin depender de configuración invisible
hecha manualmente en una plataforma externa. A diferencia de los principios recortables a mitad de
semana (Principio I), este es NON-NEGOTIABLE: una vez que el esquema real diverge de lo que hay en
el repositorio, la trazabilidad se pierde de forma irreversible para el resto del proyecto — no es
un costo que se pueda recuperar recortando alcance después.

## Restricciones del Producto y Entregable

Contexto fijo del proyecto: hackathon Stellar Odyssey Perú 2026, equipo de 3 personas, una semana
de desarrollo, demo objetivo de 3 minutos. Toda planificación (specs, plans, tasks) DEBE dimensionarse
para ser ejecutable por 3 personas dentro de ese plazo. Cuando una tarea o feature no quepa
razonablemente en el tiempo restante de la semana, se recorta alcance (ver Principio V) antes que
comprometer la fecha de entrega.

## Flujo de Trabajo de Desarrollo

No existe gate formal de code review ni pipeline de CI con tests antes de integrar cambios a `main`
(consistente con el Principio I). Cada integrante autoevalúa su propio código contra los 7 principios
antes de integrarlo, priorizando especialmente el Principio I (estructura básica), el Principio V
(que la feature sirva al flujo de demo), el Principio VI (que la evidencia on-chain sea real cuando
aplique), y el Principio VII (que cualquier cambio de esquema, política RLS, trigger o Edge Function
de Supabase exista como archivo versionado en `/supabase`, no solo aplicado desde el dashboard).

Los cambios de stack o de arquitectura entre apps (Principios II y III) pueden decidirse y aplicarse
a mitad de semana mediante acuerdo rápido del equipo — no requieren un proceso formal de propuesta
(ADR); basta con dejar constancia breve en el mensaje de commit o en el README para que el resto del
equipo entienda el cambio.

## Governance

Esta constitución tiene precedencia sobre cualquier otra práctica, preferencia individual o
convención no escrita del equipo durante el desarrollo del proyecto.

**Enmiendas**: cualquier integrante del equipo puede proponer una modificación a esta constitución
cuando un principio esté bloqueando el avance real del proyecto. La enmienda se adopta con el
acuerdo de al menos 2 de los 3 integrantes del equipo (mayoría simple) y se refleja incrementando
la versión de este documento según la política de versionado semántico siguiente:

- **MAJOR**: eliminación o redefinición incompatible de un principio existente (p. ej., abandonar
  el requisito de on-chain real del Principio VI).
- **MINOR**: adición de un nuevo principio o sección, o expansión material de guía existente.
- **PATCH**: aclaraciones de redacción, correcciones tipográficas o refinamientos no semánticos.

**Revisión de cumplimiento**: dado que el Principio I elimina el gate formal de code review, el
cumplimiento se verifica por autoevaluación de cada integrante antes de integrar código a `main`,
y opcionalmente mediante una revisión conjunta rápida del equipo al cierre de cada día de la semana
de hackathon para detectar desviaciones tempranas (archivos creciendo demasiado, features fuera de
alcance, lógica on-chain simulada en vez de real, o cambios de esquema/políticas/Edge Functions de
Supabase aplicados solo desde el dashboard sin el archivo versionado correspondiente en
`/supabase`).

**Version**: 1.1.0 | **Ratified**: 2026-09-19 | **Last Amended**: 2026-09-19
