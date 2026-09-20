import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

export function NotFoundPage() {
  return <main className="not-found"><span>404</span><h1>Esta ruta se perdió en el espacio</h1><p>No encontramos la pantalla que estás buscando.</p><Link className="button button--primary button--md" to="/"><ArrowLeft size={17} /> Volver al inicio</Link></main>;
}
