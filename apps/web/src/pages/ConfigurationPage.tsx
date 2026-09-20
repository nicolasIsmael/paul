import { ArrowRight, KeyRound, TerminalSquare } from "lucide-react";
import { Brand } from "../components/Brand";
import { Notice, Panel } from "../components/ui";

export function ConfigurationPage() {
  return (
    <main className="configuration-page">
      <div className="configuration-page__inner">
        <Brand />
        <Panel className="configuration-card">
          <span className="configuration-card__icon"><KeyRound size={26} /></span>
          <p className="eyebrow">CONFIGURACIÓN INICIAL</p>
          <h1>Conecta el frontend con Supabase</h1>
          <p>La aplicación está lista. Falta agregar la clave pública del proyecto para habilitar el acceso y los datos reales.</p>
          <div className="code-instructions">
            <TerminalSquare size={19} />
            <code>apps/web/.env</code>
          </div>
          <pre><code>{`VITE_SUPABASE_URL=https://qqpozotcrxfukkwcoget.supabase.co\nVITE_SUPABASE_ANON_KEY=tu_clave_publica`}</code></pre>
          <Notice>Usa únicamente la clave <strong>anon/publishable</strong>. Nunca coloques la clave <strong>service_role</strong> en el frontend.</Notice>
          <a className="button button--secondary button--lg configuration-preview" href="/?preview=1">Explorar vista previa local <ArrowRight size={17} /></a>
        </Panel>
      </div>
    </main>
  );
}
