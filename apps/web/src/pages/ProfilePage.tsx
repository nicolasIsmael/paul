import { CheckCircle2, Copy, KeyRound, Mail, Phone, Save, ShieldCheck, UserRound, Wallet } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Badge, Button, Notice, Panel } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { normalizeError } from "../lib/errors";
import { copyText, initials, roleLabel, shortKey } from "../lib/format";

export function ProfilePage() {
  const { profile, user, refreshProfile, waitForWallet } = useAuth();
  const [name, setName] = useState(profile?.nombre_completo || "");
  const [phone, setPhone] = useState(profile?.telefono || "");
  const [photoUrl, setPhotoUrl] = useState(profile?.foto_url || "");
  const [busy, setBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => { setName(profile?.nombre_completo || ""); setPhone(profile?.telefono || ""); setPhotoUrl(profile?.foto_url || ""); }, [profile]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try { if (!user) return; await api.updateProfile(user.id, { nombre_completo: name, telefono: phone || null, foto_url: photoUrl || null }); await refreshProfile(); setMessage("Tus datos se actualizaron correctamente."); }
    catch (cause) { setError(normalizeError(cause).message); }
    finally { setBusy(false); }
  }

  async function retryWallet() { setWalletBusy(true); setError(""); const wallet = await waitForWallet(); if (!wallet) setError("La wallet continúa en preparación. Vuelve a intentarlo en un momento."); setWalletBusy(false); }
  async function copyWallet() { if (!profile?.wallet_public_key) return; await copyText(profile.wallet_public_key); setCopied(true); setTimeout(() => setCopied(false), 1600); }

  if (!profile) return null;

  return <div className="page-stack"><header className="page-heading"><div><p className="eyebrow">TU CUENTA</p><h1>Perfil y seguridad</h1><p>Administra tus datos y consulta la wallet vinculada a tu cuenta.</p></div></header>
    <section className="profile-layout"><div className="profile-main"><Panel><div className="profile-heading"><span className="profile-avatar">{profile.foto_url ? <img src={profile.foto_url} alt="" /> : initials(profile.nombre_completo)}</span><div><h2>{profile.nombre_completo}</h2><p>{user?.email}</p><div><Badge tone="blue">{roleLabel(profile.rol)}</Badge>{profile.es_cuenta_demo && <Badge tone="warning">Cuenta demo</Badge>}</div></div></div><form className="profile-form" onSubmit={submit}><label className="field"><span>Nombre completo</span><div className="input-wrap"><UserRound size={18} /><input value={name} onChange={(event) => setName(event.target.value)} required /></div></label><label className="field"><span>Correo electrónico</span><div className="input-wrap input-wrap--disabled"><Mail size={18} /><input value={user?.email || ""} disabled /></div><small>El correo está vinculado a tu acceso.</small></label><label className="field"><span>Teléfono</span><div className="input-wrap"><Phone size={18} /><input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+51 999 999 999" /></div></label><label className="field"><span>URL de foto</span><div className="input-wrap"><UserRound size={18} /><input type="url" value={photoUrl} onChange={(event) => setPhotoUrl(event.target.value)} placeholder="https://..." /></div></label>{message && <Notice tone="success">{message}</Notice>}{error && <Notice tone="warning">{error}</Notice>}<Button type="submit" disabled={busy}><Save size={17} /> {busy ? "Guardando..." : "Guardar cambios"}</Button></form></Panel></div>
      <aside className="profile-aside">{profile.rol === "inversionista" && <Panel className="profile-wallet"><div className="panel-heading"><div><span className="panel-icon panel-icon--yellow"><Wallet size={20} /></span><div><p>Wallet Stellar</p><small>Cuenta de custodia personal</small></div></div><Badge tone={profile.wallet_public_key ? "success" : "warning"}>{profile.wallet_public_key ? "Activa" : "Preparando"}</Badge></div>{profile.wallet_public_key ? <><div className="full-wallet-key"><span>Dirección pública</span><code>{shortKey(profile.wallet_public_key)}</code><button className="icon-button" onClick={() => void copyWallet()} aria-label="Copiar wallet">{copied ? <CheckCircle2 size={18} /> : <Copy size={18} />}</button></div><div className="security-point"><ShieldCheck size={18} /><p><strong>Custodia protegida</strong><span>La llave privada permanece cifrada en Supabase Vault.</span></p></div><div className="security-point"><KeyRound size={18} /><p><strong>Stellar Testnet</strong><span>Los movimientos son demostrativos y verificables.</span></p></div></> : <div className="wallet-empty"><span><Wallet size={24} /></span><h3>Tu wallet está en preparación</h3><p>El proceso suele tomar unos segundos después del registro.</p><Button variant="secondary" onClick={() => void retryWallet()} disabled={walletBusy}>{walletBusy ? "Consultando..." : "Comprobar estado"}</Button></div>}</Panel>}<Panel className="security-card"><p className="eyebrow">SEGURIDAD</p><h3>Tu información está protegida</h3><p>El acceso a perfiles, aportes y posiciones se limita mediante políticas de seguridad por usuario.</p></Panel></aside>
    </section>
  </div>;
}
