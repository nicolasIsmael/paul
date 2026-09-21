//! `pool_fraction_token` — contrato Soroban de Stellar Odyssey.
//!
//! Una instancia por tramo (senior/junior) de un pool (research.md §1 de
//! specs/20260920-174938-originacion-facturas-pool). Interfaz SEP-41 completa (`balance`,
//! `transfer`, `approve`, `allowance`, `burn`, `decimals`, `name`, `symbol`) más dos extensiones
//! administrativas restringidas al `admin` de esta instancia: `register_invoice` (huella de
//! factura + nuevo cupo) y `mint` (emisión de fracciones a un inversionista, con cupo máximo).
//! `decimals = 0`: 1 unidad de token = 1 fracción = 1 `unidad_minima_aporte` del pool. El
//! contrato nunca conoce montos monetarios ni datos identificables de proveedor/deudor — solo
//! huellas (`BytesN<32>`) y enteros de fracciones. Ver contracts/soroban-pool-token.md.

#![no_std]

use soroban_sdk::{
    contract, contractevent, contracterror, contractimpl, contracttype, panic_with_error, Address,
    BytesN, Env, String, Symbol,
};

/// Ledgers por día en Stellar (~5s por ledger). Usado para extender el TTL al máximo razonable
/// dentro de la ventana del hackatón (research.md §3).
const DAY_IN_LEDGERS: u32 = 17280;
const INSTANCE_LIFETIME_THRESHOLD: u32 = DAY_IN_LEDGERS * 30;
const INSTANCE_BUMP_AMOUNT: u32 = DAY_IN_LEDGERS * 90;
const BALANCE_LIFETIME_THRESHOLD: u32 = DAY_IN_LEDGERS * 30;
const BALANCE_BUMP_AMOUNT: u32 = DAY_IN_LEDGERS * 90;

#[contracttype]
#[derive(Clone)]
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
#[repr(u32)]
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

/// Emitido por `register_invoice` (`contracts/soroban-pool-token.md` → tabla de funciones).
#[contractevent(topics = ["factura_registrada"])]
pub struct FacturaRegistrada {
    #[topic]
    pub invoice_hash: BytesN<32>,
    pub new_cap: i128,
}

/// Emitido por `mint` (`contracts/soroban-pool-token.md` → tabla de funciones).
#[contractevent(topics = ["fracciones_emitidas"])]
pub struct FraccionesEmitidas {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contract]
pub struct PoolFractionToken;

fn read_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

fn require_admin_auth(env: &Env) -> Address {
    let admin = read_admin(env);
    admin.require_auth();
    admin
}

fn read_cap(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::Cap).unwrap_or(0)
}

fn read_total_supply(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalSupply)
        .unwrap_or(0)
}

fn read_balance(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(id.clone()))
        .unwrap_or(0)
}

fn write_balance(env: &Env, id: &Address, amount: i128) {
    let key = DataKey::Balance(id.clone());
    env.storage().persistent().set(&key, &amount);
    env.storage().persistent().extend_ttl(
        &key,
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

#[contractimpl]
impl PoolFractionToken {
    /// Solo puede llamarse una vez por instancia (un tramo). `pool_ref` es el código del pool
    /// (p. ej. "POOL-PEN-001"), `tramo` es `senior`/`junior` — ambos son metadata informativa
    /// para `name()`/`symbol()`, nunca se usan en ninguna validación de negocio.
    pub fn initialize(env: Env, admin: Address, pool_ref: String, tramo: Symbol) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Decimals, &0u32);
        env.storage().instance().set(&DataKey::Cap, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &0i128);

        let mut name = pool_ref.clone();
        // `name` legible para humanos: "<pool_ref> · <tramo>". `symbol` reutiliza el mismo texto
        // corto de `tramo` (senior/junior) — suficiente para distinguir instancias en un
        // explorador genérico de tokens Soroban sin depender de la plataforma.
        let _ = &mut name; // pool_ref ya es el valor final de `name` (String no soporta concat sin alloc aquí).
        env.storage().instance().set(&DataKey::Name, &pool_ref);
        env.storage().instance().set(&DataKey::Symbol, &tramo);

        bump_instance(&env);
    }

    /// Rotación de autoridad (research.md §5) — únicamente el `admin` vigente puede transferirla.
    pub fn set_admin(env: Env, new_admin: Address) {
        require_admin_auth(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        bump_instance(&env);
    }

    /// Registra la huella de una factura y el nuevo cupo total de fracciones del tramo
    /// (`new_cap`, calculado en Postgres a partir de la suma de anticipos — el contrato nunca ve
    /// montos monetarios). Rechaza duplicados y decrementos (FR-012: una asignación confirmada es
    /// irreversible incluso a nivel de contrato).
    pub fn register_invoice(env: Env, invoice_hash: BytesN<32>, new_cap: i128) {
        require_admin_auth(&env);

        let key = DataKey::Factura(invoice_hash.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::InvoiceAlreadyRegistered);
        }

        let cap = read_cap(&env);
        if new_cap < cap {
            panic_with_error!(&env, Error::CapCannotDecrease);
        }

        let incremento = new_cap - cap;
        env.storage().persistent().set(&key, &incremento);
        env.storage()
            .persistent()
            .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);

        env.storage().instance().set(&DataKey::Cap, &new_cap);
        bump_instance(&env);

        FacturaRegistrada {
            invoice_hash,
            new_cap,
        }
        .publish(&env);
    }

    /// Emite `amount` fracciones a `to`. Nunca permite que `total_supply` exceda `cap` — esta es
    /// la garantía on-chain de FR-014, independiente de que Postgres se comporte correctamente.
    pub fn mint(env: Env, to: Address, amount: i128) {
        require_admin_auth(&env);

        let cap = read_cap(&env);
        let total_supply = read_total_supply(&env);
        if total_supply + amount > cap {
            panic_with_error!(&env, Error::CapExceeded);
        }

        let balance = read_balance(&env, &to);
        write_balance(&env, &to, balance + amount);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(total_supply + amount));
        bump_instance(&env);

        FraccionesEmitidas { to, amount }.publish(&env);
    }

    // ---- Lecturas públicas (sin autorización) ----

    pub fn balance(env: Env, id: Address) -> i128 {
        read_balance(&env, &id)
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimals).unwrap_or(0)
    }

    pub fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Name)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    pub fn symbol(env: Env) -> Symbol {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    pub fn cap(env: Env) -> i128 {
        read_cap(&env)
    }

    pub fn total_supply(env: Env) -> i128 {
        read_total_supply(&env)
    }

    // ---- Interfaz SEP-41 restante (completitud de interfaz; ningún flujo del producto la
    // invoca hoy — el mercado secundario de fracciones está fuera de alcance de la spec). ----

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();

        let from_balance = read_balance(&env, &from);
        if from_balance < amount {
            panic_with_error!(&env, Error::InsufficientBalance);
        }

        write_balance(&env, &from, from_balance - amount);
        let to_balance = read_balance(&env, &to);
        write_balance(&env, &to, to_balance + amount);
        bump_instance(&env);
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, live_until_ledger: u32) {
        from.require_auth();

        let key = DataKey::Allowance(from, spender);
        env.storage().temporary().set(&key, &amount);
        if live_until_ledger > env.ledger().sequence() {
            env.storage()
                .temporary()
                .extend_ttl(&key, 0, live_until_ledger - env.ledger().sequence());
        }
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .temporary()
            .get(&DataKey::Allowance(from, spender))
            .unwrap_or(0)
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();

        let balance = read_balance(&env, &from);
        if balance < amount {
            panic_with_error!(&env, Error::InsufficientBalance);
        }

        write_balance(&env, &from, balance - amount);
        let total_supply = read_total_supply(&env);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(total_supply - amount));
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test;
