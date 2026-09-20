import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, Phone, UserRound } from "lucide-react";
import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { Brand } from "../components/Brand";
import { Button, Notice } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { normalizeError } from "../lib/errors";
import type { Role } from "../types/domain";

type Mode = "login" | "register";

export function AuthPage() {
  const { session, signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<Role>("inversionista");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  if (session) return <Navigate to="/" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "login") {
        await signIn(email, password);
      } else {
        const result = await signUp({ email, password, name, phone, role });
        if (result.needsEmailConfirmation) {
          setMessage("Revisa tu correo para confirmar la cuenta y luego inicia sesión.");
          setMode("login");
        }
      }
    } catch (cause) {
      setError(normalizeError(cause).message);
    } finally {
      setBusy(false);
    }
  }

  function useDemoAccount() {
    setEmail("inversionista.demo1@paul.test");
    setPassword("DemoStellar2026!");
    setMode("login");
    setError("");
  }

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <div className="auth-brand-panel__top"><Brand inverse /></div>
        <div className="auth-brand-panel__content">
          <p className="eyebrow eyebrow--yellow">INVERSIÓN FRACCIONADA</p>
          <h1>Invierte en oportunidades reales, desde un solo lugar.</h1>
          <p>Explora pools de factoring, compara riesgo y rendimiento, y registra tus aportes en Stellar Testnet.</p>
          <div className="auth-brand-panel__proof">
            <div><strong>100%</strong><span>Trazable en testnet</span></div>
            <div><strong>2</strong><span>Perfiles de riesgo</span></div>
            <div><strong>24/7</strong><span>Acceso a tu portafolio</span></div>
          </div>
        </div>
        <p className="auth-brand-panel__foot">Stellar Odyssey Perú 2026</p>
      </section>

      <section className="auth-form-panel">
        <div className="auth-form-wrap">
          <div className="auth-mobile-brand"><Brand /></div>
          <p className="eyebrow">BIENVENIDO A PAUL</p>
          <h2>{mode === "login" ? "Accede a tu cuenta" : "Crea tu cuenta"}</h2>
          <p className="auth-form-wrap__intro">{mode === "login" ? "Continúa construyendo tu portafolio." : "Comienza a explorar oportunidades de inversión."}</p>

          <div className="segmented-control" aria-label="Modo de acceso">
            <button className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); }}>Ingresar</button>
            <button className={mode === "register" ? "active" : ""} onClick={() => { setMode("register"); setError(""); }}>Crear cuenta</button>
          </div>

          <form className="auth-form" onSubmit={submit}>
            {mode === "register" && (
              <>
                <fieldset className="role-picker">
                  <legend>Quiero ingresar como</legend>
                  <label className={role === "inversionista" ? "selected" : ""}><input type="radio" name="role" value="inversionista" checked={role === "inversionista"} onChange={() => setRole("inversionista")} /><span><strong>Inversionista</strong><small>Explorar y aportar</small></span></label>
                  <label className={role === "operador_banco" ? "selected" : ""}><input type="radio" name="role" value="operador_banco" checked={role === "operador_banco"} onChange={() => setRole("operador_banco")} /><span><strong>Operador</strong><small>Supervisar pools</small></span></label>
                </fieldset>
                <label className="field"><span>Nombre completo</span><div className="input-wrap"><UserRound size={18} /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Tu nombre y apellido" required /></div></label>
                <label className="field"><span>Teléfono <small>Opcional</small></span><div className="input-wrap"><Phone size={18} /><input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+51 999 999 999" inputMode="tel" /></div></label>
              </>
            )}
            <label className="field"><span>Correo electrónico</span><div className="input-wrap"><Mail size={18} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nombre@correo.com" autoComplete="email" required /></div></label>
            <label className="field"><span>Contraseña</span><div className="input-wrap"><LockKeyhole size={18} /><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Mínimo 8 caracteres" minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} required /><button type="button" className="input-action" onClick={() => setShowPassword((show) => !show)} aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
            {error && <Notice tone="warning">{error}</Notice>}
            {message && <Notice tone="success">{message}</Notice>}
            <Button type="submit" size="lg" disabled={busy}>{busy ? "Procesando..." : mode === "login" ? <>Ingresar <ArrowRight size={18} /></> : <>Crear cuenta <ArrowRight size={18} /></>}</Button>
          </form>

          {mode === "login" && <button className="demo-access" type="button" onClick={useDemoAccount}>Usar cuenta de demostración</button>}
          <p className="auth-legal">Al continuar aceptas que esta es una experiencia demostrativa en Stellar Testnet, sin dinero real.</p>
        </div>
      </section>
    </main>
  );
}
