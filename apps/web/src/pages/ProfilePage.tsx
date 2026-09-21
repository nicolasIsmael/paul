import {
  CheckCircle2,
  Copy,
  ExternalLink,
  ImagePlus,
  KeyRound,
  Mail,
  Phone,
  Save,
  ShieldCheck,
  UserRound,
  Wallet,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Badge, Button, Notice, Panel } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { normalizeError } from "../lib/errors";
import { copyText, initials, roleLabel, shortKey } from "../lib/format";

function isValidPhotoUrl(value: string) {
  if (!value) return true;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function ProfilePage() {
  const { profile, user, refreshProfile, waitForWallet } = useAuth();
  const [name, setName] = useState(profile?.nombre_completo || "");
  const [phone, setPhone] = useState(profile?.telefono || "");
  const [photoUrl, setPhotoUrl] = useState(profile?.foto_url || "");
  const [editingPhoto, setEditingPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setName(profile?.nombre_completo || "");
    setPhone(profile?.telefono || "");
    setPhotoUrl(profile?.foto_url || "");
  }, [profile]);

  const normalizedName = name.trim();
  const normalizedPhone = phone.trim();
  const normalizedPhotoUrl = photoUrl.trim();
  const phoneDigits = normalizedPhone.replace(/\D/g, "");
  const nameValid = normalizedName.length >= 2;
  const phoneValid = !normalizedPhone || (phoneDigits.length >= 7 && phoneDigits.length <= 15);
  const photoValid = isValidPhotoUrl(normalizedPhotoUrl);
  const formValid = nameValid && phoneValid && photoValid;
  const isDirty = useMemo(() => {
    if (!profile) return false;
    return normalizedName !== profile.nombre_completo.trim()
      || normalizedPhone !== (profile.telefono || "").trim()
      || normalizedPhotoUrl !== (profile.foto_url || "").trim();
  }, [normalizedName, normalizedPhone, normalizedPhotoUrl, profile]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!user || !formValid || !isDirty) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.updateProfile(user.id, {
        nombre_completo: normalizedName,
        telefono: normalizedPhone || null,
        foto_url: normalizedPhotoUrl || null,
      });
      await refreshProfile();
      setEditingPhoto(false);
      setMessage("Tus datos se actualizaron correctamente.");
    } catch (cause) {
      setError(normalizeError(cause).message);
    } finally {
      setBusy(false);
    }
  }

  async function retryWallet() {
    setWalletBusy(true);
    setError("");
    try {
      const wallet = await waitForWallet();
      if (!wallet) setError("La wallet continúa en preparación. Vuelve a intentarlo en un momento.");
    } catch (cause) {
      setError(normalizeError(cause).message);
    } finally {
      setWalletBusy(false);
    }
  }

  async function copyWallet() {
    if (!profile?.wallet_public_key) return;
    try {
      await copyText(profile.wallet_public_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("No pudimos copiar la dirección. Puedes abrirla directamente en Stellar Expert.");
    }
  }

  if (!profile) return null;

  return (
    <div className="page-stack">
      <header className="page-heading"><div><p className="eyebrow">TU CUENTA</p><h1>Perfil y seguridad</h1><p>Administra tus datos y revisa la seguridad de tu cuenta.</p></div></header>
      <section className="profile-layout">
        <div className="profile-main">
          <Panel>
            <div className="profile-heading">
              <span className="profile-avatar">{normalizedPhotoUrl && photoValid ? <img src={normalizedPhotoUrl} alt={`Foto de ${profile.nombre_completo}`} /> : initials(profile.nombre_completo)}</span>
              <div><h2>{profile.nombre_completo}</h2><p>{user?.email}</p><div><Badge tone="blue">{roleLabel(profile.rol)}</Badge>{profile.es_cuenta_demo && <Badge tone="warning">Cuenta demo</Badge>}</div></div>
              <Button className="profile-photo-button" variant="secondary" size="sm" type="button" onClick={() => setEditingPhoto((current) => !current)}>{editingPhoto ? <X size={16} /> : <ImagePlus size={16} />} {editingPhoto ? "Cancelar" : "Cambiar foto"}</Button>
            </div>
            <form className="profile-form" onSubmit={submit} noValidate>
              <label className="field"><span>Nombre completo</span><div className="input-wrap"><UserRound size={18} /><input value={name} onChange={(event) => setName(event.target.value)} required aria-invalid={!nameValid} aria-describedby="name-help" /></div>{!nameValid && <small className="field-error" id="name-help">Escribe al menos 2 caracteres.</small>}</label>
              <label className="field"><span>Correo electrónico</span><div className="input-wrap input-wrap--disabled"><Mail size={18} /><input value={user?.email || ""} disabled /></div><small>El correo está vinculado a tu acceso.</small></label>
              <label className="field"><span>Teléfono</span><div className="input-wrap"><Phone size={18} /><input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+51 999 999 999" inputMode="tel" autoComplete="tel" aria-invalid={!phoneValid} aria-describedby="phone-help" /></div><small id="phone-help" className={!phoneValid ? "field-error" : ""}>{phoneValid ? "Incluye el código de país si corresponde." : "Ingresa entre 7 y 15 dígitos."}</small></label>
              {editingPhoto && <label className="field photo-url-field"><span>Enlace público de la imagen</span><div className="input-wrap"><ImagePlus size={18} /><input type="url" value={photoUrl} onChange={(event) => setPhotoUrl(event.target.value)} placeholder="https://..." aria-invalid={!photoValid} aria-describedby="photo-help" /></div><small id="photo-help" className={!photoValid ? "field-error" : ""}>{photoValid ? "La carga directa de archivos estará disponible próximamente." : "Ingresa un enlace http o https válido."}</small></label>}
              {message && <Notice tone="success">{message}</Notice>}
              {error && <Notice tone="warning">{error}</Notice>}
              <Button type="submit" disabled={busy || !isDirty || !formValid} aria-busy={busy}><Save size={17} /> {busy ? "Guardando..." : isDirty ? "Guardar cambios" : "Sin cambios pendientes"}</Button>
            </form>
          </Panel>
        </div>

        <aside className="profile-aside">
          {profile.rol === "inversionista" && (
            <Panel className="profile-wallet">
              <div className="panel-heading"><div><span className="panel-icon panel-icon--yellow"><Wallet size={20} /></span><div><p>Wallet Stellar</p><small>Cuenta de custodia personal</small></div></div><Badge tone={profile.wallet_public_key ? "success" : "warning"}>{profile.wallet_public_key ? "Activa" : "Preparando"}</Badge></div>
              {profile.wallet_public_key ? <>
                <div className="full-wallet-key"><span>Dirección pública</span><code>{shortKey(profile.wallet_public_key)}</code><button className="icon-button" onClick={() => void copyWallet()} aria-label="Copiar wallet">{copied ? <CheckCircle2 size={18} /> : <Copy size={18} />}</button></div>
                <a className="stellar-link" href={`https://stellar.expert/explorer/testnet/account/${profile.wallet_public_key}`} target="_blank" rel="noreferrer">Ver cuenta en Stellar Expert <ExternalLink size={16} /></a>
                <div className="security-point"><ShieldCheck size={18} /><p><strong>Custodia protegida</strong><span>La llave privada permanece cifrada en Supabase Vault.</span></p></div>
                <div className="security-point"><KeyRound size={18} /><p><strong>Stellar Testnet</strong><span>Los movimientos son demostrativos y verificables.</span></p></div>
              </> : <div className="wallet-empty"><span><Wallet size={24} /></span><h3>Tu wallet está en preparación</h3><p>El proceso suele tomar unos segundos después del registro.</p><Button variant="secondary" onClick={() => void retryWallet()} disabled={walletBusy} aria-busy={walletBusy}>{walletBusy ? "Consultando..." : "Comprobar estado"}</Button></div>}
            </Panel>
          )}
          <Panel className="security-card"><p className="eyebrow">SEGURIDAD</p><h3>Tu información está protegida</h3><p>El acceso a perfiles, aportes y posiciones se limita mediante políticas de seguridad por usuario.</p></Panel>
        </aside>
      </section>
    </div>
  );
}
