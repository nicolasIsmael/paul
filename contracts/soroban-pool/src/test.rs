//! Pruebas unitarias de `pool_fraction_token` (T031). Cubren exactamente los invariantes que la
//! spec exige que el contrato garantice por sí mismo (contracts/soroban-pool-token.md →
//! "Invariantes que el contrato garantiza por sí mismo"): cupo nunca excedido, huella nunca
//! duplicada, cupo nunca decrece, y ninguna operación administrativa sin la firma del admin
//! vigente.

#![cfg(test)]
extern crate std;

use super::{PoolFractionToken, PoolFractionTokenClient};
use soroban_sdk::{symbol_short, testutils::Address as _, Address, BytesN, Env, String};

fn crear_cliente(env: &Env) -> PoolFractionTokenClient<'_> {
    let contract_id = env.register(PoolFractionToken, ());
    PoolFractionTokenClient::new(env, &contract_id)
}

fn huella(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn initialize_fija_valores_por_defecto() {
    let env = Env::default();
    env.mock_all_auths();
    let client = crear_cliente(&env);
    let admin = Address::generate(&env);

    client.initialize(&admin, &String::from_str(&env, "POOL-PEN-001"), &symbol_short!("senior"));

    assert_eq!(client.decimals(), 0);
    assert_eq!(client.cap(), 0);
    assert_eq!(client.total_supply(), 0);
    assert_eq!(client.symbol(), symbol_short!("senior"));
}

#[test]
#[should_panic]
fn initialize_dos_veces_falla() {
    let env = Env::default();
    env.mock_all_auths();
    let client = crear_cliente(&env);
    let admin = Address::generate(&env);

    client.initialize(&admin, &String::from_str(&env, "POOL-PEN-001"), &symbol_short!("senior"));
    // AlreadyInitialized (Error #2).
    client.initialize(&admin, &String::from_str(&env, "POOL-PEN-001"), &symbol_short!("senior"));
}

#[test]
fn register_invoice_incrementa_cap_acumulativamente() {
    let env = Env::default();
    env.mock_all_auths();
    let client = crear_cliente(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &String::from_str(&env, "POOL-PEN-001"), &symbol_short!("senior"));

    client.register_invoice(&huella(&env, 1), &40);
    assert_eq!(client.cap(), 40);

    client.register_invoice(&huella(&env, 2), &65);
    assert_eq!(client.cap(), 65);
}

#[test]
#[should_panic]
fn register_invoice_huella_duplicada_falla() {
    let env = Env::default();
    env.mock_all_auths();
    let client = crear_cliente(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &String::from_str(&env, "POOL-PEN-001"), &symbol_short!("senior"));

    let h = huella(&env, 1);
    client.register_invoice(&h, &40);
    // InvoiceAlreadyRegistered (Error #6) — misma huella, aunque el cap propuesto sea distinto.
    client.register_invoice(&h, &80);
}

#[test]
#[should_panic]
fn register_invoice_no_puede_decrecer_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let client = crear_cliente(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &String::from_str(&env, "POOL-PEN-001"), &symbol_short!("senior"));

    client.register_invoice(&huella(&env, 1), &40);
    // CapCannotDecrease (Error #5) — refuerza FR-012 (irreversibilidad) en la capa on-chain.
    client.register_invoice(&huella(&env, 2), &10);
}

#[test]
fn mint_respeta_el_cap_exacto() {
    let env = Env::default();
    env.mock_all_auths();
    let client = crear_cliente(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &String::from_str(&env, "POOL-PEN-001"), &symbol_short!("senior"));
    client.register_invoice(&huella(&env, 1), &10);

    let inversionista = Address::generate(&env);
    client.mint(&inversionista, &10);

    assert_eq!(client.balance(&inversionista), 10);
    assert_eq!(client.total_supply(), 10);
}

#[test]
#[should_panic]
fn mint_mas_alla_del_cap_falla() {
    let env = Env::default();
    env.mock_all_auths();
    let client = crear_cliente(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &String::from_str(&env, "POOL-PEN-001"), &symbol_short!("senior"));
    client.register_invoice(&huella(&env, 1), &10);

    let inversionista = Address::generate(&env);
    // CapExceeded (Error #4) — el contrato lo rechaza aunque Postgres ya hubiera validado cupo
    // monetario equivalente (defensa en profundidad, research.md §2).
    client.mint(&inversionista, &11);
}

#[test]
#[should_panic]
fn mint_sin_firma_del_admin_falla() {
    let env = Env::default();
    // Sin `env.mock_all_auths()`: `initialize` no exige auth (solo se llama una vez, sin admin
    // previo que autenticar), pero `mint` sí — debe fallar por falta de autorización.
    let client = crear_cliente(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &String::from_str(&env, "POOL-PEN-001"), &symbol_short!("senior"));

    let inversionista = Address::generate(&env);
    client.mint(&inversionista, &1);
}

#[test]
fn transfer_mueve_balance_entre_direcciones() {
    let env = Env::default();
    env.mock_all_auths();
    let client = crear_cliente(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &String::from_str(&env, "POOL-PEN-001"), &symbol_short!("senior"));
    client.register_invoice(&huella(&env, 1), &10);

    let inversionista_a = Address::generate(&env);
    let inversionista_b = Address::generate(&env);
    client.mint(&inversionista_a, &10);

    client.transfer(&inversionista_a, &inversionista_b, &4);

    assert_eq!(client.balance(&inversionista_a), 6);
    assert_eq!(client.balance(&inversionista_b), 4);
}
