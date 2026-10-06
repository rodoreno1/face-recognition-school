/* ==========================================================================
   Control de acceso CBTis 002 — interfaz.

   Una sola página. Al entrar, Supabase (o el modo demo) dice qué rol tiene
   la cuenta:
     admin   Panel, Kiosco, Alumnos, Registros y Configuración
     kiosco  solo el kiosco (la caseta): reconoce y registra

   Vistas por hash en la URL: #panel #kiosco #alumnos #registros #config.
   Depende de api.js / demo.js (datos) y face.js (reconocimiento).
   ========================================================================== */

/* ---------- Utilidades ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const fechaISO = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hora = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const horaSeg = ts => { const d = new Date(ts); return `${hora(ts)}:${pad(d.getSeconds())}`; };
const fechaLarga = iso => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
};
const iniciales = nombre => String(nombre || "").trim().split(/\s+/).slice(0, 2).map(p => p[0] || "").join("").toUpperCase();
const primerNombre = nombre => String(nombre || "").trim().split(/\s+/)[0] || "";
const descargar = (nombre, contenido, tipo) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
const aCSV = filas => "﻿" + filas.map(f => f.map(v => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(",")).join("\r\n");
const fotoDe = (a, foto = a && a.foto) => foto ? `<img src="${foto}" alt="">` : `<span class="avatar">${esc(iniciales(a ? a.nombre : ""))}</span>`;

let toastTimer = null;
function toast(msg, tipo = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast on " + tipo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 3400);
}

/* Modal genérico: devuelve el nodo del cuerpo y una función para cerrar. */
function modal(html, { ancho = 560, alCerrar = null, fijo = false } = {}) {
  const capa = document.createElement("div");
  capa.className = "capa";
  capa.innerHTML = `<div class="modal" style="max-width:${ancho}px" role="dialog" aria-modal="true">
      ${fijo ? "" : '<button class="cerrar" aria-label="Cerrar">✕</button>'}${html}</div>`;
  document.body.appendChild(capa);
  requestAnimationFrame(() => capa.classList.add("on"));
  let cerrado = false;
  const cerrar = () => {
    if (cerrado) return;
    cerrado = true;
    capa.classList.remove("on");
    setTimeout(() => capa.remove(), 220);
    document.removeEventListener("keydown", escK);
    if (alCerrar) alCerrar();
  };
  const escK = e => { if (e.key === "Escape" && !fijo) cerrar(); };
  document.addEventListener("keydown", escK);
  if (!fijo) {
    capa.addEventListener("click", e => { if (e.target === capa) cerrar(); });
    $(".cerrar", capa).addEventListener("click", cerrar);
  }
  return { nodo: $(".modal", capa), cerrar };
}

function confirmar(titulo, texto, { peligro = false, ok = "Confirmar" } = {}) {
  return new Promise(res => {
    const m = modal(`<h3>${esc(titulo)}</h3><p class="muted">${texto}</p>
      <div class="acciones"><button class="btn ghost" data-no>Cancelar</button>
      <button class="btn ${peligro ? "peligro" : ""}" data-si>${esc(ok)}</button></div>`, { ancho: 440, alCerrar: () => res(false) });
    $("[data-no]", m.nodo).onclick = () => m.cerrar();
    $("[data-si]", m.nodo).onclick = () => { res(true); m.cerrar(); };
  });
}

/* Liga un formulario a una tarea asíncrona que devuelve el texto de error o "". */
function alEnviar(form, tarea, { ocupado = "Un momento…" } = {}) {
  const boton = $("button[type=submit], button:not([type])", form), error = $(".error", form);
  const texto = boton.textContent;
  form.onsubmit = async e => {
    e.preventDefault();
    if (boton.disabled) return;
    boton.disabled = true; boton.textContent = ocupado;
    if (error) error.hidden = true;
    let msj;
    try { msj = await tarea(Object.fromEntries(new FormData(form))); }
    catch (err) { console.error(err); msj = err.message || String(err); }
    if (!form.isConnected) return;
    boton.disabled = false; boton.textContent = texto;
    if (msj) {
      if (error) { error.textContent = msj; error.hidden = false; } else toast(msj, "mal");
      form.classList.add("shake"); setTimeout(() => form.classList.remove("shake"), 400);
      Sonido.tocar("error");
    }
  };
}

/* Cuenta de un número a otro con suavizado; para los contadores del panel. */
function animarNumero(el, hasta, dur = 700) {
  if (!el) return;
  const desde = Number(el.dataset.v || 0);
  el.dataset.v = hasta;
  if (desde === hasta) { el.textContent = hasta; return; }
  const t0 = performance.now();
  (function paso(t) {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(desde + (hasta - desde) * e);
    if (p < 1) requestAnimationFrame(paso);
  })(t0);
}

/* Sonidos cortos con Web Audio: no hay archivos que cargar. */
const Sonido = (() => {
  let ctx = null;
  function tono(f, dur, t0, tipo = "sine", vol = 0.18) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = tipo; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function tocar(clase) {
    if (Estado.cfg && Estado.cfg.sonido === false) return;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      const t = ctx.currentTime;
      if (clase === "entrada") { tono(660, 0.12, t); tono(990, 0.18, t + 0.12); }
      else if (clase === "salida") { tono(880, 0.12, t); tono(587, 0.2, t + 0.12); }
      else if (clase === "error") { tono(220, 0.25, t, "square", 0.08); }
      else if (clase === "paso") { tono(1046, 0.09, t, "sine", 0.12); }
      else { tono(440, 0.08, t); }
    } catch { /* sin audio no pasa nada */ }
  }
  return { tocar };
})();

/* ---------- Estado global ---------- */
const API = APISupabase.disponible() ? APISupabase : APIDemo;
const Estado = {
  cfg: null, perfil: null, alumnos: [], vista: null,
  limpiarVista: null,     // apaga cámara, temporizadores y suscripciones al salir de una vista
  hoy: [], hoyFecha: "",  // registros del día en memoria (kiosco y panel)
};
const esAdmin = () => !!Estado.perfil && Estado.perfil.rol === "admin";
const GRUPOS_BASE = ["1A", "1B", "2A", "2B", "3A", "3B", "4A", "4B", "5A", "5B", "6A", "6B"];
const gruposDisponibles = () => {
  const set = new Set([...GRUPOS_BASE, ...Estado.alumnos.map(a => a.grupo).filter(Boolean)]);
  return [...set].sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
};
const Local = {
  get: () => { try { return JSON.parse(localStorage.getItem("cbtis:local") || "{}"); } catch { return {}; } },
  set: p => localStorage.setItem("cbtis:local", JSON.stringify({ ...Local.get(), ...p })),
};

async function recargarAlumnos(conFoto = false) {
  Estado.alumnos = (await API.alumnos.todos({ conFoto })).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  return Estado.alumnos;
}
async function cargarHoy() {
  const f = fechaISO();
  Estado.hoy = await API.registros.porFecha(f);
  Estado.hoyFecha = f;
  return Estado.hoy;
}

/* ---------- Lógica de registro (kiosco y registro manual) ---------- */
/* Decide el tipo (entrada/salida), aplica la espera y guarda.
   Devuelve { registro } o { duplicado, ultimo }. */
async function registrarAsistencia(alumno, modo, origen, distancia = null) {
  const cfg = Estado.cfg;
  const ahora = Date.now();
  const fecha = fechaISO(new Date(ahora));
  if (Estado.hoyFecha !== fecha) await cargarHoy();
  const deHoy = Estado.hoy.filter(r => r.alumnoId === alumno.id).sort((a, b) => a.ts - b.ts);
  const ultimo = deHoy[deHoy.length - 1];
  if (ultimo && origen === "facial" && ahora - ultimo.ts < cfg.cooldownSeg * 1000) return { duplicado: true, ultimo };
  const tipo = modo === "auto" ? (ultimo && ultimo.tipo === "entrada" ? "salida" : "entrada") : modo;
  const registro = await API.registros.agregarConCola({
    alumnoId: alumno.id, nombre: alumno.nombre, matricula: alumno.matricula, grupo: alumno.grupo, turno: alumno.turno,
    tipo, ts: ahora, fecha,
    origen, distancia: distancia == null ? null : Math.round(distancia * 1000) / 1000,
  });
  Estado.hoy.push(registro);
  return { registro };
}

/* Resumen del día a partir de Estado.hoy. */
function resumenHoy() {
  const regs = [...Estado.hoy].sort((a, b) => a.ts - b.ts);
  const entradas = regs.filter(r => r.tipo === "entrada"), salidas = regs.filter(r => r.tipo === "salida");
  const dentro = new Set();
  regs.forEach(r => r.tipo === "entrada" ? dentro.add(r.alumnoId) : dentro.delete(r.alumnoId));
  return { regs, entradas, salidas, dentro: dentro.size, conEntrada: new Set(entradas.map(r => r.alumnoId)).size };
}

/* ==========================================================================
   ARRANQUE Y ACCESO
   ========================================================================== */
function reloj() {
  const d = new Date();
  const h = $("#reloj-h"), f = $("#reloj-f");
  if (h) h.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (f) f.textContent = d.toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short" });
  $$("[data-reloj-grande]").forEach(el => { el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`; });
  $$("[data-reloj-seg]").forEach(el => { el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; });
  $$("[data-fecha-larga]").forEach(el => { el.textContent = d.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" }); });
}

function cerrarVista() {
  if (Estado.limpiarVista) { try { Estado.limpiarVista(); } catch (e) { console.error(e); } Estado.limpiarVista = null; }
  Estado.vista = null;
  document.body.classList.remove("en-kiosco", "kiosco-full");
}

async function mostrarLogin() {
  cerrarVista();
  document.body.classList.add("en-login");
  document.body.classList.remove("en-kiosco");
  const app = $("#app");
  app.innerHTML = `
  <div class="login">
    <div class="login-fondo"><i></i><i></i><i></i></div>
    <section class="login-izq">
      <img class="login-logo" src="img/logo.png" alt="Escudo DGETI">
      <h1><small>DGETI · Plantel</small>CBTis 002</h1>
      <p class="login-sub">Control de entradas y salidas por reconocimiento facial.</p>
      <ul class="login-puntos">
        <li>Reconoce al alumno en segundos, sin credencial</li>
        <li>Registra entradas y salidas al instante</li>
        <li>Cuentas con permisos: administración y caseta</li>
      </ul>
    </section>
    <section class="login-der"><div class="login-form" id="login-caja"><div class="cargando"><div class="anillo"></div></div></div></section>
  </div>`;

  const caja = $("#login-caja");
  let primerAdmin = false;
  if (!API.modoDemo) {
    try { primerAdmin = !(await API.auth.hayAdmin()); }
    catch (e) {
      caja.innerHTML = `<h2>No hay conexión con Supabase</h2><p class="muted">${esc(e.message)}</p>
        <p class="muted chico">Revisa js/config.js y que supabase/schema.sql se haya ejecutado en tu proyecto.</p>`;
      return;
    }
  }
  if (primerAdmin) {
    caja.innerHTML = `<h2>Configuración inicial</h2>
      <p class="muted">Todavía no hay cuentas. Crea la del administrador del plantel.</p>
      <form class="form">
        <label>Correo<input class="input" type="email" name="correo" autocomplete="username" required></label>
        <label>Contraseña<input class="input" type="password" name="clave" autocomplete="new-password" minlength="8" required></label>
        <label>Repetir contraseña<input class="input" type="password" name="repetir" autocomplete="new-password" required></label>
        <p class="muted chico">Mínimo 8 caracteres. Esta cuenta podrá crear las demás desde Configuración.</p>
        <p class="error" hidden></p>
        <button class="btn grande">Crear administrador</button>
      </form>`;
    alEnviar($("form", caja), async d => {
      if (d.clave.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
      if (d.clave !== d.repetir) return "Las contraseñas no coinciden.";
      await API.auth.crearPrimerAdmin(d.correo, d.clave);
      await entrarApp();
      return "";
    }, { ocupado: "Creando…" });
    return;
  }
  caja.innerHTML = `<h2>Iniciar sesión</h2>
    <p class="muted">Usa la cuenta que te asignó el plantel.</p>
    <form class="form">
      <label>Correo<input class="input" type="email" name="correo" autocomplete="username" required autofocus></label>
      <label>Contraseña<input class="input" type="password" name="clave" autocomplete="current-password" required></label>
      <p class="error" hidden></p>
      <button class="btn grande">Entrar</button>
    </form>
    ${API.modoDemo ? `<div class="demo-cuentas"><span>Modo demostración: los datos viven solo en este navegador. Prueba con una cuenta:</span>
      <div class="fila"><button type="button" class="btn ghost chico" data-demo="admin@demo">Administrador</button>
      <button type="button" class="btn ghost chico" data-demo="caseta@demo">Kiosco (caseta)</button></div></div>` : ""}`;
  const form = $("form", caja);
  alEnviar(form, async d => { await API.auth.entrar(d.correo, d.clave); await entrarApp(); return ""; }, { ocupado: "Entrando…" });
  $$("[data-demo]", caja).forEach(b => b.onclick = () => {
    form.correo.value = b.dataset.demo; form.clave.value = "demo1234"; form.requestSubmit();
  });
  setTimeout(() => form.correo.focus(), 100);
}

async function entrarApp() {
  Estado.perfil = await API.miPerfil();
  if (!Estado.perfil) return mostrarLogin();
  if (Estado.perfil.rol !== "admin" && Estado.perfil.rol !== "kiosco") {
    document.body.classList.add("en-login");
    $("#app").innerHTML = `<div class="login"><div class="login-fondo"><i></i><i></i><i></i></div>
      <section class="login-der" style="grid-column:1/-1"><div class="login-form">
        <h2>Cuenta sin acceso</h2>
        <p class="muted">La cuenta <b>${esc(Estado.perfil.correo)}</b> existe, pero todavía no tiene permisos. Pide al administrador que le asigne un rol en Configuración → Cuentas.</p>
        <button class="btn ghost" id="btn-salir">Salir</button></div></section></div>`;
    $("#btn-salir").onclick = () => API.auth.salir();
    return;
  }
  Estado.cfg = await API.config.get(true);
  document.body.classList.remove("en-login");
  pintarArmazon();
  if (!esAdmin()) { if (location.hash !== "#kiosco") { location.hash = "#kiosco"; return; } }
  else if (!VISTAS[(location.hash || "").slice(1)]) { location.hash = "#panel"; return; }
  navegar();
}

function pintarArmazon() {
  const app = $("#app");
  if (!esAdmin()) { app.innerHTML = `<main class="vista solo-kiosco" id="vista"></main>`; return; }
  app.innerHTML = `
    ${API.modoDemo ? `<div class="demo-banda">Modo demostración: los datos viven solo en este navegador. Conecta Supabase en js/config.js para usarlo en el plantel.</div>` : ""}
    <header class="cab">
      <a class="marca" href="#panel"><img src="img/logo.png" alt=""><span><b>${esc(Estado.cfg.plantel)}</b><small>Control de acceso</small></span></a>
      <nav class="nav">
        <a href="#panel" data-v="panel">Panel</a>
        <a href="#kiosco" data-v="kiosco">Kiosco</a>
        <a href="#alumnos" data-v="alumnos">Alumnos</a>
        <a href="#registros" data-v="registros">Registros</a>
        <a href="#config" data-v="config">Configuración</a>
      </nav>
      <div class="cab-der">
        <div class="reloj"><b id="reloj-h">--:--:--</b><small id="reloj-f"></small></div>
        <div class="usuario"><b title="${esc(Estado.perfil.correo)}">${esc(Estado.perfil.correo)}</b><small>Administrador</small></div>
        <button class="btn ghost chico" id="btn-salir">Salir</button>
      </div>
    </header>
    <main class="vista" id="vista"></main>`;
  $("#btn-salir").onclick = async () => { cerrarVista(); await API.auth.salir(); };
  reloj();
}
function marcarNav() { $$(".nav a").forEach(a => a.classList.toggle("activo", a.dataset.v === Estado.vista)); }

/* ==========================================================================
   VISTA: PANEL (inicio del administrador)
   ========================================================================== */
async function vistaPanel(root) {
  await Promise.all([recargarAlumnos(), cargarHoy()]);
  root.innerHTML = `
  <section class="panel">
    <div class="panel-cab">
      <div><span class="eyebrow">Hoy</span><h2 data-fecha-larga>${esc(fechaLarga(fechaISO()))}</h2></div>
      <span class="vivo"><i></i> En vivo</span>
    </div>
    <div class="stats" id="pn-stats"></div>
    <div class="panel-grid">
      <div class="tarjeta feed">
        <div class="feed-cab"><h4>Actividad reciente</h4><a class="btn ghost chico" href="#registros">Ver todo</a></div>
        <ul id="pn-feed"></ul>
      </div>
      <div>
        <div id="pn-aviso"></div>
        <div class="tarjeta grafica-card" style="margin-top:0">
          <div class="feed-cab"><h4>Entradas por hora</h4><small class="muted" id="pn-gr-sub"></small></div>
          <div class="grafica" id="pn-grafica"></div>
        </div>
        <div class="tarjeta">
          <h4>Acciones rápidas</h4>
          <div class="rapidos">
            <a href="#kiosco"><i>📷</i>Abrir kiosco</a>
            <button id="pn-nuevo"><i>➕</i>Nuevo alumno</button>
            <button id="pn-csv"><i>📄</i>Exportar hoy (CSV)</button>
            <a href="#config"><i>⚙️</i>Configuración</a>
          </div>
        </div>
      </div>
    </div>
  </section>`;

  function pintar(nuevo = null) {
    const r = resumenHoy();
    const activos = Estado.alumnos.filter(a => a.activo !== false).length;
    const sinRostro = Estado.alumnos.filter(a => !(a.descriptores || []).length).length;
    const stats = $("#pn-stats");
    if (!stats.children.length) {
      stats.innerHTML = [["dentro", "Dentro del plantel", "ok"], ["entradas", "Entradas"], ["salidas", "Salidas", "info"],
        ["ausentes", "Sin entrada hoy", "mal"], ["alumnos", "Alumnos activos"]]
        .map(([k, t, c = ""]) => `<div class="stat ${c}"><b data-k="${k}">0</b><span>${t}</span></div>`).join("");
    }
    const valores = { dentro: r.dentro, entradas: r.entradas.length, salidas: r.salidas.length,
      ausentes: Math.max(0, activos - r.conEntrada), alumnos: activos };
    for (const [k, v] of Object.entries(valores)) animarNumero($(`[data-k="${k}"]`, stats), v);

    const regs = [...r.regs].reverse().slice(0, 14);
    $("#pn-feed").innerHTML = regs.length ? regs.map(x => `
      <li class="${x.tipo}${nuevo && nuevo.id === x.id ? " nuevo" : ""}">
        <span class="hora">${hora(x.ts)}</span>
        <span class="quien"><b>${esc(x.nombre)}</b><small>${esc(x.grupo || "")} · ${esc(x.matricula)} · ${x.origen === "manual" ? "manual" : "facial"}</small></span>
        <span class="chip ${x.tipo}">${x.tipo === "entrada" ? "Entrada" : "Salida"}</span>
      </li>`).join("") : `<li class="vacio muted">Todavía no hay registros hoy.</li>`;

    $("#pn-aviso").innerHTML = sinRostro
      ? `<div class="callout warn"><span style="font-size:1.6rem">👤</span><div><b>${sinRostro} alumno${sinRostro === 1 ? "" : "s"} sin rostro registrado</b><small>No podrán entrar por cámara hasta escanearlos.</small></div><a class="btn chico" href="#alumnos">Ir a alumnos</a></div>`
      : (Estado.alumnos.length ? "" : `<div class="callout"><span style="font-size:1.6rem">🚀</span><div><b>Empieza dando de alta a los alumnos</b><small>Importa la lista por CSV y escanea sus rostros.</small></div><a class="btn oro chico" href="#alumnos">Alumnos</a></div>`);
    pintarGrafica($("#pn-grafica"), $("#pn-gr-sub"), r.entradas);
  }
  pintar();
  $("#pn-nuevo").onclick = () => asistenteAlumno(null, () => recargarAlumnos().then(() => pintar()));
  $("#pn-csv").onclick = () => exportarCSV(resumenHoy().regs.slice().reverse(), `asistencia_${fechaISO()}.csv`);

  const dejar = API.registros.suscribir(r => {
    if (r.fecha !== Estado.hoyFecha || Estado.hoy.some(x => x.id === r.id)) return;
    Estado.hoy.push(r);
    pintar(r);
  });
  Estado.limpiarVista = () => dejar();
}

function pintarGrafica(nodo, sub, entradas) {
  const porHora = Array.from({ length: 24 }, () => 0);
  entradas.forEach(r => porHora[new Date(r.ts).getHours()]++);
  const activas = porHora.map((v, h) => [h, v]).filter(([, v]) => v > 0);
  const hMin = activas.length ? Math.max(0, activas[0][0] - 1) : 6;
  const hMax = activas.length ? Math.min(23, activas[activas.length - 1][0] + 1) : 20;
  const max = Math.max(...porHora, 1);
  if (sub) sub.textContent = entradas.length ? `${entradas.length} entrada${entradas.length === 1 ? "" : "s"}` : "Sin entradas";
  nodo.innerHTML = `<div class="gr-barras">${porHora.slice(hMin, hMax + 1).map((v, i) => {
    const h = hMin + i;
    return `<div class="gr-col" title="${pad(h)}:00 — ${v} entrada${v === 1 ? "" : "s"}">
      <div class="gr-pista"><i style="height:${Math.round(v / max * 100)}%"></i></div>
      <small>${pad(h)}</small>${v ? `<b class="gr-val">${v}</b>` : ""}</div>`;
  }).join("")}</div>`;
}

function exportarCSV(regs, nombre) {
  const filas = [["Fecha", "Hora", "Nombre", "Matrícula", "Grupo", "Turno", "Tipo", "Origen"],
    ...regs.map(r => [r.fecha, horaSeg(r.ts), r.nombre, r.matricula, r.grupo, r.turno, r.tipo, r.origen])];
  descargar(nombre, aCSV(filas), "text/csv;charset=utf-8");
  toast("CSV descargado");
}

/* ==========================================================================
   VISTA: KIOSCO
   ========================================================================== */
async function vistaKiosco(root) {
  document.body.classList.add("en-kiosco");
  const cfg = Estado.cfg;
  const modoGuardado = Local.get().modo || "auto";
  root.innerHTML = `
  <section class="kiosco" id="kiosco">
    <div class="k-cam buscando" id="k-cam">
      <video id="cam" autoplay muted playsinline></video>
      <canvas id="cam-canvas"></canvas>
      <div class="k-scan"></div>
      <div class="k-estado" id="k-estado"><span class="punto"></span><span id="k-estado-txt">Cargando modelos…</span></div>
      <div class="k-carga" id="k-carga">
        <div class="anillo"></div>
        <p id="k-carga-txt">Preparando el reconocimiento facial…</p>
        <div class="barra"><i id="k-carga-barra"></i></div>
      </div>
      <div class="k-reloj-cam" data-reloj-seg>--:--:--</div>
    </div>
    <aside class="k-lado">
      <div class="k-marca"><img src="img/logo.png" alt=""><div><b>${esc(cfg.plantel)}</b><small>Control de acceso</small></div></div>
      <div class="k-reloj"><b data-reloj-grande>--:--</b><small data-fecha-larga></small></div>
      <div class="k-res vacio" id="k-res"></div>
      <div class="k-stats" id="k-stats"></div>
      <ul class="k-feed" id="k-feed"></ul>
      <div class="k-barra">
        <div class="segmento" role="radiogroup" aria-label="Tipo de registro">
          ${[["auto", "Automático"], ["entrada", "Entrada"], ["salida", "Salida"]].map(([v, t]) =>
            `<button data-modo="${v}" class="${v === modoGuardado ? "on" : ""}" role="radio" aria-checked="${v === modoGuardado}">${t}</button>`).join("")}
        </div>
        <div class="k-acciones">
          ${esAdmin() ? `<button class="btn ghost" id="btn-manual">Registro manual</button>` : ""}
          <button class="btn ghost icono" id="btn-full" title="Pantalla completa">⛶</button>
        </div>
      </div>
    </aside>
    <div class="k-flot">
      ${esAdmin() ? `<a class="btn ghost chico" href="#panel">← Panel</a>` : `<button class="btn ghost chico" id="btn-salir-k">Cerrar sesión</button>`}
    </div>
  </section>`;
  reloj();

  const video = $("#cam"), canvas = $("#cam-canvas"), cam = $("#k-cam");
  const estadoTxt = $("#k-estado-txt"), estadoBox = $("#k-estado");
  let modo = modoGuardado, activo = true, comparador = null, timerResultado = null;
  let racha = { id: null, n: 0, descs: [] }, desconocidos = 0;
  const fotos = {};
  const dejar = [];

  /* Ritmo del kiosco. Leer la cámara sin parar satura el equipo y hace que los
     mensajes parpadeen; se lee con calma y, tras cada resultado, se hace una
     pausa antes de buscar al siguiente alumno. */
  const RITMO = { sinRostro: 500, conRostro: 240, confirmando: 170, enPausa: 250 };
  const PAUSA = { registro: 4000, repetido: 3000, desconocido: 2500 };
  let pausa = { hasta: 0, texto: "", clase: "" };
  const pausar = (ms, texto, clase) => { pausa = { hasta: Date.now() + ms, texto, clase }; racha = { id: null, n: 0, descs: [] }; desconocidos = 0; };

  const setEstado = (txt, clase = "") => {
    if (estadoTxt.textContent !== txt) estadoTxt.textContent = txt;
    estadoBox.className = "k-estado " + clase;
    cam.classList.toggle("buscando", clase === "");
  };
  /* Los estados "flojos" (buscando, analizando, acércate) solo se muestran
     cuando se repiten dos lecturas seguidas: evita el parpadeo entre cuadros. */
  let propuesto = { txt: "", n: 0 };
  const proponerEstado = (txt, clase = "") => {
    if (estadoTxt.textContent === txt) { propuesto = { txt, n: 0 }; return; }
    propuesto = propuesto.txt === txt ? { txt, n: propuesto.n + 1 } : { txt, n: 1 };
    if (propuesto.n >= 2) setEstado(txt, clase);
  };
  const vacio = () => `<div class="res-vacio"><div class="res-ico"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>
    <h3>Mira a la cámara</h3><p>Tu ${modo === "salida" ? "salida" : modo === "entrada" ? "entrada" : "entrada o salida"} se registra sola.</p></div>`;
  $("#k-res").innerHTML = vacio();

  $$("[data-modo]", root).forEach(b => b.onclick = () => {
    modo = b.dataset.modo;
    Local.set({ modo });
    $$("[data-modo]", root).forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    if ($("#k-res").classList.contains("vacio")) $("#k-res").innerHTML = vacio();
    toast(`Modo: ${b.textContent}`);
  });
  $("#btn-full").onclick = () => {
    const full = document.body.classList.toggle("kiosco-full");
    if (full && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    if (!full && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  const alCambiarFull = () => { if (!document.fullscreenElement) document.body.classList.remove("kiosco-full"); };
  document.addEventListener("fullscreenchange", alCambiarFull);
  if ($("#btn-manual")) $("#btn-manual").onclick = () => abrirRegistroManual(modo, () => refrescarPanel());
  if ($("#btn-salir-k")) $("#btn-salir-k").onclick = async () => {
    if (await confirmar("Cerrar sesión", "El kiosco dejará de reconocer hasta que alguien vuelva a entrar con una cuenta.")) { cerrarVista(); await API.auth.salir(); }
  };

  /* ----- panel derecho ----- */
  function refrescarPanel(nuevo = null) {
    const r = resumenHoy();
    const stats = $("#k-stats");
    if (!stats.children.length) {
      stats.innerHTML = [["dentro", "Dentro", "ok"], ["entradas", "Entradas"], ["salidas", "Salidas"]]
        .map(([k, t, c = ""]) => `<div class="stat ${c}"><b data-k="${k}">0</b><span>${t}</span></div>`).join("");
    }
    const v = { dentro: r.dentro, entradas: r.entradas.length, salidas: r.salidas.length };
    for (const [k, n] of Object.entries(v)) animarNumero($(`[data-k="${k}"]`, stats), n);
    const regs = [...r.regs].reverse().slice(0, 6);
    $("#k-feed").innerHTML = regs.length ? regs.map(x => `
      <li class="${x.tipo}${nuevo && nuevo.id === x.id ? " nuevo" : ""}">
        <span class="hora">${hora(x.ts)}</span>
        <span class="quien"><b>${esc(x.nombre)}</b><small>${esc(x.grupo || "")} · ${esc(x.matricula)}</small></span>
        <span class="chip">${x.tipo === "entrada" ? "Entrada" : "Salida"}</span>
      </li>`).join("") : `<li class="vacio">Todavía no hay registros hoy.</li>`;
  }

  function mostrarResultado(html, clase, ms = 6000) {
    const res = $("#k-res");
    res.className = "k-res " + clase;
    res.innerHTML = html;
    clearTimeout(timerResultado);
    timerResultado = setTimeout(() => { res.className = "k-res vacio"; res.innerHTML = vacio(); }, ms);
  }
  async function fotoAlumno(a) {
    if (!(a.id in fotos)) { try { fotos[a.id] = await API.alumnos.foto(a.id); } catch { fotos[a.id] = null; } }
    return fotos[a.id];
  }

  async function alReconocer(alumno, distancia) {
    const r = await registrarAsistencia(alumno, modo, "facial", distancia);
    const foto = await fotoAlumno(alumno);
    if (r.duplicado) {
      const hace = Math.round((Date.now() - r.ultimo.ts) / 1000);
      mostrarResultado(`<div class="res-foto">${fotoDe(alumno, foto)}</div>
        <div class="res-info"><small class="eyebrow">Ya registrado</small><h3>${esc(alumno.nombre)}</h3>
        <p>${r.ultimo.tipo === "entrada" ? "Entrada" : "Salida"} a las ${hora(r.ultimo.ts)} (hace ${hace} s)</p></div>`, "repetido", PAUSA.repetido);
      pausar(PAUSA.repetido, `${primerNombre(alumno.nombre)} ya estaba registrado`, "aviso");
      return;
    }
    const reg = r.registro;
    const clase = reg.tipo;
    Sonido.tocar(clase);
    const k = $("#kiosco");
    k.classList.remove("flash-entrada", "flash-salida");
    void k.offsetWidth;
    k.classList.add("flash-" + clase);
    mostrarResultado(`
      <div class="res-foto">${fotoDe(alumno, foto)}</div>
      <div class="res-info">
        <small class="eyebrow">${reg.tipo === "entrada" ? "Entrada registrada" : "Salida registrada"}${reg.pendiente ? " · se enviará al reconectar" : ""}</small>
        <h3>${esc(alumno.nombre)}</h3>
        <p>${esc(alumno.grupo || "")} · ${esc(alumno.matricula)} · ${esc(alumno.turno || "")}</p>
        <div class="res-hora">${hora(reg.ts)}</div>
      </div>
      <div class="res-check">${reg.tipo === "entrada" ? "✓" : "↩"}</div>`, clase);
    refrescarPanel(reg);
  }

  /* ----- arranque de modelos, cámara y datos ----- */
  Estado.limpiarVista = () => {
    activo = false;
    clearTimeout(timerResultado);
    Face.detenerCamara();
    dejar.forEach(f => { try { f(); } catch { /* ya cerrado */ } });
    document.removeEventListener("fullscreenchange", alCambiarFull);
    document.body.classList.remove("en-kiosco", "kiosco-full");
  };
  const armarComparador = () => { comparador = Face.Comparador(Estado.alumnos, cfg.umbral, cfg.margen); };
  try {
    await Face.cargarModelos(p => {
      $("#k-carga-txt").textContent = p.indice < p.total ? `Cargando: ${p.paso}…` : "Encendiendo cámara…";
      $("#k-carga-barra").style.transform = `scaleX(${p.indice / p.total})`;
    });
    if (!activo) return;
    await Promise.all([recargarAlumnos(), cargarHoy()]);
    if (!activo) return;
    armarComparador();
    refrescarPanel();
    await Face.iniciarCamara(video, Local.get().camara || "");
    if (!activo) { Face.detenerCamara(); return; }
    $("#k-carga").classList.add("fuera");
  } catch (e) {
    if (!activo) return;
    $("#k-carga-txt").innerHTML = `<b>No se pudo iniciar.</b><br>${esc(e.message || e)}`;
    $(".anillo", root).hidden = true;
    setEstado("Sin cámara", "mal");
    return;
  }
  if (comparador.vacio) setEstado("No hay alumnos con rostro registrado", "aviso");
  else setEstado("Buscando rostros…");

  dejar.push(API.registros.suscribir(r => {
    if (r.fecha !== Estado.hoyFecha || Estado.hoy.some(x => x.id === r.id)) return;
    Estado.hoy.push(r);
    refrescarPanel(r);
  }));
  let timerAlumnos = null;
  dejar.push(API.alumnos.suscribir(() => {
    clearTimeout(timerAlumnos);
    timerAlumnos = setTimeout(async () => { if (!activo) return; await recargarAlumnos(); armarComparador(); }, 1500);
  }));
  API.registros.vaciarCola().then(n => { if (n) { toast(`${n} registro${n === 1 ? "" : "s"} pendiente${n === 1 ? "" : "s"} enviado${n === 1 ? "" : "s"}`); cargarHoy().then(() => refrescarPanel()); } }).catch(() => {});

  /* ----- bucle de detección ----- */
  const VERDE = "rgba(134,239,172,.95)", ORO = "rgba(245,184,46,.95)", BLANCO = "rgba(255,255,255,.75)", GRIS = "rgba(255,255,255,.35)";
  const limpiarCanvas = () => { canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height); };
  let ocupado = false;
  async function ciclo() {
    if (!activo) return;
    let espera = RITMO.sinRostro;
    if (Date.now() < pausa.hasta) {
      // Pausa tras un resultado: la cámara sigue, pero no se lee hasta que pase.
      const seg = Math.ceil((pausa.hasta - Date.now()) / 1000);
      setEstado(`${pausa.texto} · siguiente en ${seg} s`, pausa.clase);
      limpiarCanvas();
      espera = RITMO.enPausa;
    } else if (!ocupado && video.readyState >= 2) {
      ocupado = true;
      try {
        const rostros = await Face.detectar(video);
        if (!activo) return;
        const etiquetas = {};
        let principal = -1, areaMax = 0;
        rostros.forEach((r, i) => { const a = r.detection.box.width * r.detection.box.height; if (a > areaMax) { areaMax = a; principal = i; } });
        let listo = null;
        rostros.forEach((r, i) => {
          if (i !== principal) { etiquetas[i] = { texto: "", color: GRIS }; return; }
          // Un rostro pequeño está lejos: no se intenta reconocer a quien pasa al fondo.
          if (r.detection.box.width < video.videoWidth * 0.12) {
            racha = { id: null, n: 0, descs: [] }; desconocidos = 0;
            etiquetas[i] = { texto: "", color: GRIS };
            proponerEstado("Acércate a la cámara", "aviso");
            return;
          }
          const m = comparador.identificar(r.descriptor);
          if (m.alumno && m.confiable) {
            if (racha.id === m.alumno.id) { racha.n++; racha.descs.push(r.descriptor); }
            else racha = { id: m.alumno.id, n: 1, descs: [r.descriptor] };
            desconocidos = 0;
            const nombre = primerNombre(m.alumno.nombre);
            const progreso = Math.min(1, racha.n / cfg.confirmaciones);
            etiquetas[i] = { texto: nombre, color: VERDE, progreso };
            setEstado(progreso < 1 ? `Confirmando a ${nombre}…` : `Reconocido: ${m.alumno.nombre}`, "ok");
            if (racha.n >= cfg.confirmaciones) {
              listo = { alumno: m.alumno, descs: racha.descs.slice(-cfg.confirmaciones) };
              racha = { id: null, n: 0, descs: [] };
            }
          } else {
            racha = { id: null, n: 0, descs: [] };
            if (m.candidato && m.distancia <= cfg.umbral) {
              // Dentro del umbral pero sin ventaja clara sobre otro alumno: pide una mejor toma.
              desconocidos = 0;
              etiquetas[i] = { texto: "Verificando…", color: ORO };
              proponerEstado("Acércate un poco y mira de frente", "aviso");
            } else {
              desconocidos++;
              etiquetas[i] = { texto: "", color: BLANCO };
              if (desconocidos > 4) {
                // Varias lecturas seguidas sin coincidencia: se avisa una vez y se descansa.
                etiquetas[i] = { texto: "No registrado", color: BLANCO };
                pausar(PAUSA.desconocido, "Rostro no registrado", "aviso");
              } else if (!comparador.vacio) proponerEstado("Analizando…");
            }
          }
        });
        if (!rostros.length) {
          racha = { id: null, n: 0, descs: [] }; desconocidos = 0;
          if (!comparador.vacio) proponerEstado("Buscando rostros…");
        }
        Face.dibujar(canvas, video, rostros, etiquetas);
        if (listo) {
          // Segunda verificación con el promedio de los cuadros: quita el ruido de un cuadro aislado.
          const m2 = comparador.identificar(Face.promediar(listo.descs));
          if (m2.alumno && m2.alumno.id === listo.alumno.id) {
            await alReconocer(listo.alumno, m2.distancia);
            if (Date.now() >= pausa.hasta) pausar(PAUSA.registro, `Registrado: ${primerNombre(listo.alumno.nombre)}`, "ok");
          }
        }
        espera = rostros.length ? (racha.n ? RITMO.confirmando : RITMO.conRostro) : RITMO.sinRostro;
      } catch (e) { console.error(e); }
      ocupado = false;
    }
    setTimeout(ciclo, espera);
  }
  ciclo();
}

/* Registro manual (solo administrador): cuando la cámara falla o el alumno
   no tiene rostro registrado. */
function abrirRegistroManual(modo, alTerminar) {
  const m = modal(`<h3>Registro manual</h3>
    <p class="muted">Busca al alumno por nombre o matrícula.</p>
    <input class="input" id="man-q" placeholder="Nombre o matrícula…" autofocus style="margin-top:12px">
    <div class="segmento claro" id="man-modo" style="margin:12px 0">
      ${[["entrada", "Entrada"], ["salida", "Salida"]].map(([v, t]) =>
        `<button data-m="${v}" class="${(modo === "salida" ? "salida" : "entrada") === v ? "on" : ""}">${t}</button>`).join("")}
    </div>
    <ul class="lista-busq" id="man-lista"></ul>`, { ancho: 480 });
  let tipo = modo === "salida" ? "salida" : "entrada";
  $$("[data-m]", m.nodo).forEach(b => b.onclick = () => {
    tipo = b.dataset.m; $$("[data-m]", m.nodo).forEach(x => x.classList.toggle("on", x === b));
  });
  const q = $("#man-q", m.nodo), lista = $("#man-lista", m.nodo);
  const pintar = () => {
    const t = q.value.trim().toLowerCase();
    const res = t ? Estado.alumnos.filter(a => a.nombre.toLowerCase().includes(t) || String(a.matricula).toLowerCase().includes(t)).slice(0, 8) : [];
    lista.innerHTML = res.map(a => `<li data-id="${a.id}">
      <span class="avatar">${esc(iniciales(a.nombre))}</span>
      <span><b>${esc(a.nombre)}</b><small>${esc(a.grupo || "")} · ${esc(a.matricula)}</small></span>
      <button class="btn chico">Registrar</button></li>`).join("") || (t ? `<li class="muted" style="display:block;text-align:center">Sin resultados</li>` : "");
    $$("li[data-id] button", lista).forEach(b => b.onclick = async () => {
      const a = Estado.alumnos.find(x => x.id === b.closest("li").dataset.id);
      try {
        const r = await registrarAsistencia(a, tipo, "manual");
        Sonido.tocar(tipo);
        toast(`${tipo === "entrada" ? "Entrada" : "Salida"} de ${a.nombre} a las ${hora(r.registro.ts)}`);
        m.cerrar(); if (alTerminar) alTerminar(r.registro);
      } catch (e) { toast(e.message, "mal"); }
    });
  };
  q.oninput = pintar;
  setTimeout(() => q.focus(), 50);
}

/* ==========================================================================
   VISTA: ALUMNOS
   ========================================================================== */
async function vistaAlumnos(root) {
  await recargarAlumnos(true);
  let q = "", grupo = "", filtroRostro = "";
  root.innerHTML = `
  <section class="admin">
    <div class="admin-cab">
      <div><h2>Alumnos</h2><p class="muted" id="al-cuenta"></p></div>
      <div class="acciones">
        <button class="btn ghost" id="btn-csv">Importar lista CSV</button>
        <button class="btn" id="btn-nuevo">+ Nuevo alumno</button>
      </div>
    </div>
    <div class="filtros">
      <input class="input" id="al-q" placeholder="Buscar por nombre o matrícula…">
      <select class="input" id="al-grupo"><option value="">Todos los grupos</option>
        ${gruposDisponibles().map(g => `<option>${esc(g)}</option>`).join("")}</select>
      <select class="input" id="al-rostro"><option value="">Con y sin rostro</option><option value="sin">Solo sin rostro</option><option value="con">Solo con rostro</option></select>
    </div>
    <div class="grid-alumnos" id="al-grid"></div>
  </section>`;

  function pintar() {
    const t = q.toLowerCase();
    const lista = Estado.alumnos.filter(a => {
      const n = (a.descriptores || []).length;
      return (!grupo || a.grupo === grupo) && (!t || a.nombre.toLowerCase().includes(t) || String(a.matricula).toLowerCase().includes(t))
        && (!filtroRostro || (filtroRostro === "sin" ? !n : n));
    });
    const sinRostro = Estado.alumnos.filter(a => !(a.descriptores || []).length).length;
    $("#al-cuenta").textContent = `${Estado.alumnos.length} alumno${Estado.alumnos.length === 1 ? "" : "s"}` +
      (sinRostro ? ` · ${sinRostro} sin rostro registrado` : "");
    $("#al-grid").innerHTML = lista.length ? lista.map((a, i) => {
      const n = (a.descriptores || []).length;
      return `<article class="al-card ${n ? "" : "sin-rostro"}" data-id="${a.id}" style="animation-delay:${Math.min(i, 12) * 30}ms">
        <div class="al-foto">${fotoDe(a)}</div>
        <div class="al-info">
          <b title="${esc(a.nombre)}">${esc(a.nombre)}</b>
          <small>${esc(a.matricula)} · ${esc(a.grupo || "sin grupo")} · ${esc(a.turno || "")}</small>
          <span class="chip ${n ? "ok" : "warn"}">${n ? `${n} muestra${n === 1 ? "" : "s"}` : "Sin rostro"}</span>
        </div>
        <div class="al-acc">
          <button class="btn chico ${n ? "ghost" : ""}" data-rostro>📷 ${n ? "Reescanear" : "Escanear rostro"}</button>
          <button class="btn chico ghost" data-editar title="Editar">✎</button>
          <button class="btn chico ghost peligro" data-borrar title="Eliminar">🗑</button>
        </div>
      </article>`;
    }).join("") : `<div class="vacio-grande"><p>${Estado.alumnos.length ? "Nadie coincide con la búsqueda." : "Aún no hay alumnos. Da de alta al primero o importa una lista CSV."}</p></div>`;
    $$(".al-card", root).forEach(card => {
      const a = Estado.alumnos.find(x => x.id === card.dataset.id);
      const recargar = () => recargarAlumnos(true).then(pintar);
      $("[data-rostro]", card).onclick = () => asistenteAlumno(a, recargar, { escanear: true });
      $("[data-editar]", card).onclick = () => asistenteAlumno(a, recargar);
      $("[data-borrar]", card).onclick = async () => {
        if (await confirmar("Eliminar alumno", `Se borrará a <b>${esc(a.nombre)}</b> con sus muestras faciales y todos sus registros. Esta acción no se puede deshacer.`, { peligro: true, ok: "Eliminar" })) {
          try { await API.alumnos.eliminar(a.id); await recargar(); toast("Alumno eliminado"); }
          catch (e) { toast(e.message, "mal"); }
        }
      };
    });
  }
  $("#al-q").oninput = e => { q = e.target.value; pintar(); };
  $("#al-grupo").onchange = e => { grupo = e.target.value; pintar(); };
  $("#al-rostro").onchange = e => { filtroRostro = e.target.value; pintar(); };
  $("#btn-nuevo").onclick = () => asistenteAlumno(null, () => recargarAlumnos(true).then(pintar));
  $("#btn-csv").onclick = () => importarCSV(() => recargarAlumnos(true).then(pintar));
  pintar();
}

/* Asistente de alta/edición con escaneo guiado del rostro.
   El escaneo pide cinco poses y captura solo cuando la toma es buena. */
const PASOS_ESCANEO = [
  { texto: "Mira de frente a la cámara", pista: "Con el rostro dentro del óvalo", ok: p => Math.abs(p.yaw) < 0.12, al: (p, c) => { c.base = p; } },
  { texto: "Gira un poco la cabeza hacia un lado", pista: "Sin dejar de ver hacia la pantalla", ok: p => Math.abs(p.yaw) > 0.2 && Math.abs(p.yaw) < 0.75, al: (p, c) => { c.lado = Math.sign(p.yaw); } },
  { texto: "Ahora hacia el otro lado", pista: "Un giro ligero es suficiente", ok: (p, c) => Math.sign(p.yaw) === -c.lado && Math.abs(p.yaw) > 0.2 && Math.abs(p.yaw) < 0.75 },
  { texto: "Sube o baja un poco la barbilla", pista: "Como si asintieras despacio", ok: (p, c) => Math.abs(p.yaw) < 0.2 && Math.abs(p.pitch - (c.base ? c.base.pitch : p.pitch)) > 0.045 },
  { texto: "De frente otra vez… ¡y sonríe!", pista: "Última toma", ok: p => Math.abs(p.yaw) < 0.12 },
];
function asistenteAlumno(alumno, alGuardar, { escanear = false } = {}) {
  const a = alumno ? { ...alumno, descriptores: [...(alumno.descriptores || [])] }
    : { nombre: "", matricula: "", grupo: "", semestre: "1", turno: "Matutino", descriptores: [], foto: "" };
  let muestras = a.descriptores.map(d => ({ descriptor: d, miniatura: null }));
  let camActiva = true;
  const m = modal(`
    <h3>${alumno ? "Editar alumno" : "Nuevo alumno"}</h3>
    <p class="muted">${alumno ? "Cambia los datos o vuelve a escanear el rostro." : "Captura los datos y escanea el rostro: toma menos de un minuto."}</p>
    <div class="wiz-grid">
      <form class="form" id="f-alumno">
        <label>Nombre completo<input class="input" name="nombre" required value="${esc(a.nombre)}" placeholder="Apellidos y nombre"></label>
        <label>Matrícula / No. de control<input class="input" name="matricula" required value="${esc(a.matricula)}" placeholder="22180012"></label>
        <div class="fila">
          <label>Grupo<input class="input" name="grupo" list="grupos" value="${esc(a.grupo)}" placeholder="3A">
            <datalist id="grupos">${gruposDisponibles().map(g => `<option value="${esc(g)}">`).join("")}</datalist></label>
          <label>Semestre<select class="input" name="semestre">${[1, 2, 3, 4, 5, 6].map(s => `<option ${String(a.semestre) === String(s) ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          <label>Turno<select class="input" name="turno">${["Matutino", "Vespertino"].map(t => `<option ${a.turno === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        </div>
        <p class="error" id="f-error" hidden></p>
        <div class="acciones izq" style="margin-top:auto">
          <button type="button" class="btn ghost" id="f-cancelar">Cancelar</button>
          <button type="button" class="btn" id="f-guardar">Guardar alumno</button>
        </div>
      </form>
      <div class="scan">
        <div class="scan-pasos" id="sc-pasos">${PASOS_ESCANEO.map(() => "<i></i>").join("")}</div>
        <div class="scan-marco" id="sc-marco">
          <video id="sc-video" autoplay muted playsinline></video>
          <img id="sc-foto" alt="" ${a.foto ? `src="${a.foto}"` : "hidden"}>
          <div class="scan-ovalo"></div>
          <div class="scan-flash" id="sc-flash"></div>
          <div class="scan-msj" id="sc-msj">Encendiendo cámara…</div>
        </div>
        <div class="scan-instr" id="sc-instr"><b>Preparando el escaneo…</b><small>Colócate frente a la cámara</small></div>
        <div class="scan-muestras" id="sc-muestras"></div>
        <div class="scan-acc">
          <button type="button" class="btn ghost chico" id="sc-reiniciar">Reiniciar escaneo</button>
          <button type="button" class="btn ghost chico" id="sc-saltar" hidden>Saltar este paso</button>
          <label class="btn ghost chico">Desde una foto<input type="file" accept="image/*" id="sc-archivo" hidden></label>
        </div>
      </div>
    </div>`, { ancho: 1000, alCerrar: () => { camActiva = false; Face.detenerCamara(); } });

  const video = $("#sc-video", m.nodo), marco = $("#sc-marco", m.nodo), msj = $("#sc-msj", m.nodo);
  const instr = $("#sc-instr", m.nodo), foto = $("#sc-foto", m.nodo), pasosUI = $$("#sc-pasos i", m.nodo);
  // Al editar sin pedir escaneo se respeta el rostro que ya tiene; al escanear se empieza de cero.
  let paso = (alumno && !escanear && muestras.length) ? PASOS_ESCANEO.length : 0, estable = 0, ctx = {};
  if (escanear) muestras = [];
  const setMsj = (t, ok = false) => { msj.textContent = t; msj.classList.toggle("ok", ok); msj.classList.toggle("fuera", !t); };

  function pintarPasos() {
    pasosUI.forEach((i, k) => { i.className = k < paso ? "hecho" : k === paso ? "actual" : ""; });
    if (paso >= PASOS_ESCANEO.length) {
      instr.innerHTML = `<div class="scan-listo"><i>✓</i><span>Rostro registrado con ${muestras.length} muestra${muestras.length === 1 ? "" : "s"}. Ya puedes guardar.</span></div>`;
      marco.classList.add("listo");
      $("#sc-saltar", m.nodo).hidden = true;
      foto.hidden = !a.foto;
    } else {
      const p = PASOS_ESCANEO[paso];
      instr.innerHTML = `<b>${paso + 1}. ${p.texto}</b><small>${p.pista}</small>`;
      marco.classList.remove("listo");
      $("#sc-saltar", m.nodo).hidden = paso === 0;
      foto.hidden = true;
    }
  }
  function pintarMuestras() {
    $("#sc-muestras", m.nodo).innerHTML = muestras.map((s, i) => `
      <div class="muestra" title="Muestra ${i + 1}">${s.miniatura ? `<img src="${s.miniatura}" alt="">` : `<span>#${i + 1}</span>`}
        <button type="button" data-q="${i}" aria-label="Quitar muestra">✕</button></div>`).join("") +
      (muestras.length ? "" : `<span class="muted chico" style="align-self:center">Sin muestras todavía</span>`);
    $$("[data-q]", m.nodo).forEach(b => b.onclick = () => { muestras.splice(Number(b.dataset.q), 1); if (paso > muestras.length) paso = muestras.length; pintarMuestras(); pintarPasos(); });
  }
  pintarMuestras(); pintarPasos();

  function capturar(fuente, r, pose) {
    const mini = Face.recortarRostro(fuente, r, 96);
    muestras.push({ descriptor: Array.from(r.descriptor), miniatura: mini });
    if (!a.foto || muestras.length === 1) { a.foto = Face.recortarRostro(fuente, r, 192); foto.src = a.foto; }
    const flash = $("#sc-flash", m.nodo);
    flash.classList.remove("on"); void flash.offsetWidth; flash.classList.add("on");
    Sonido.tocar("paso");
    if (paso < PASOS_ESCANEO.length) { if (PASOS_ESCANEO[paso].al && pose) PASOS_ESCANEO[paso].al(pose, ctx); paso++; }
    estable = 0;
    pintarMuestras(); pintarPasos();
    if (paso >= PASOS_ESCANEO.length) Sonido.tocar("entrada");
  }

  (async () => {
    try {
      await Face.cargarModelos(p => setMsj(p.indice < p.total ? `Cargando ${p.paso.toLowerCase()}…` : "Encendiendo cámara…"));
      if (!camActiva) return;
      await Face.iniciarCamara(video, Local.get().camara || "");
      if (!camActiva) return;
      if (paso >= PASOS_ESCANEO.length) setMsj("Rostro ya registrado · pulsa «Reiniciar escaneo» para tomarlo de nuevo", true);
      while (camActiva) {
        if (paso < PASOS_ESCANEO.length && muestras.length < 8) {
          const r = await Face.detectarUno(video);
          if (!camActiva) return;
          if (r.error) { estable = 0; marco.classList.remove("bien"); setMsj(r.error); }
          else {
            const p = PASOS_ESCANEO[paso];
            if (p.ok(r.pose, ctx)) {
              estable++;
              marco.classList.add("bien");
              setMsj(estable < 3 ? "Quieto…" : "¡Listo!", true);
              if (estable >= 3) capturar(video, r.resultado, r.pose);
            } else { estable = 0; marco.classList.remove("bien"); setMsj(p.texto); }
          }
        }
        await new Promise(res => setTimeout(res, 140));
      }
    } catch (e) {
      if (camActiva) { setMsj("Sin cámara: " + (e.message || e)); instr.innerHTML = `<b>No se pudo usar la cámara</b><small>Puedes agregar el rostro desde una foto.</small>`; }
    }
  })();

  $("#sc-reiniciar", m.nodo).onclick = () => { muestras = []; paso = 0; estable = 0; ctx = {}; pintarMuestras(); pintarPasos(); setMsj("Reiniciado: mira de frente"); };
  $("#sc-saltar", m.nodo).onclick = () => { if (paso < PASOS_ESCANEO.length) { paso++; estable = 0; pintarPasos(); } };
  $("#sc-archivo", m.nodo).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    e.target.value = "";
    const img = new Image();
    img.onload = async () => {
      const r = await Face.detectarUno(img, { inputSize: 512 });
      URL.revokeObjectURL(img.src);
      if (r.error) { toast("Foto no utilizable: " + r.error.toLowerCase(), "mal"); Sonido.tocar("error"); return; }
      capturar(img, r.resultado, null);
      toast("Muestra agregada desde la foto");
    };
    img.src = URL.createObjectURL(f);
  };

  $("#f-cancelar", m.nodo).onclick = m.cerrar;
  $("#f-guardar", m.nodo).onclick = async () => {
    const form = $("#f-alumno", m.nodo), err = $("#f-error", m.nodo), btn = $("#f-guardar", m.nodo);
    if (!form.reportValidity()) return;
    const d = Object.fromEntries(new FormData(form));
    d.matricula = d.matricula.trim(); d.nombre = d.nombre.trim(); d.grupo = d.grupo.trim().toUpperCase();
    btn.disabled = true;
    try {
      const dup = await API.alumnos.porMatricula(d.matricula);
      if (dup && dup.id !== a.id) { err.textContent = `La matrícula ${d.matricula} ya pertenece a ${dup.nombre}.`; err.hidden = false; btn.disabled = false; return; }
      await API.alumnos.guardar({ id: a.id, ...d, foto: a.foto || null, descriptores: muestras.map(s => s.descriptor), activo: true });
      toast(muestras.length ? `${d.nombre} guardado con ${muestras.length} muestra${muestras.length === 1 ? "" : "s"}` : "Guardado sin rostro: no podrá registrarse por cámara", muestras.length ? "ok" : "aviso");
      m.cerrar(); alGuardar();
    } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; }
  };
}

/* Importa una lista (nombre, matrícula, grupo, semestre, turno) desde CSV. */
function importarCSV(alTerminar) {
  const m = modal(`<h3>Importar lista de alumnos</h3>
    <p class="muted">Archivo CSV con encabezados: <code>nombre, matricula, grupo, semestre, turno</code>. Las matrículas repetidas actualizan al alumno existente sin borrar su rostro.</p>
    <label class="zona-archivo" style="margin-top:14px"><input type="file" accept=".csv,text/csv" id="csv-arch" hidden><span>Elegir archivo CSV…</span></label>
    <pre class="csv-ej">nombre,matricula,grupo,semestre,turno
García López Ana,22180012,3A,3,Matutino
Hernández Ruiz Luis,22180045,3B,3,Vespertino</pre>
    <p id="csv-res" class="muted"></p>`, { ancho: 560 });
  $("#csv-arch", m.nodo).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const res = $("#csv-res", m.nodo);
    res.textContent = "Importando…";
    try {
      const texto = await f.text();
      const lineas = texto.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
      const sep = (lineas[0].match(/;/g) || []).length > (lineas[0].match(/,/g) || []).length ? ";" : ",";
      const campos = l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
      const cab = campos(lineas[0]).map(c => c.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
      const idx = n => cab.indexOf(n);
      if (idx("nombre") < 0 || idx("matricula") < 0) { res.textContent = "Faltan las columnas nombre y matricula."; return; }
      const lista = [];
      for (const l of lineas.slice(1)) {
        const c = campos(l);
        const matricula = c[idx("matricula")], nombre = c[idx("nombre")];
        if (!matricula || !nombre) continue;
        lista.push({ nombre, matricula, grupo: (c[idx("grupo")] || "").toUpperCase(), semestre: c[idx("semestre")] || "1",
          turno: /vesp/i.test(c[idx("turno")] || "") ? "Vespertino" : "Matutino" });
      }
      const r = await API.alumnos.importar(lista);
      res.textContent = `Listo: ${r.nuevos} nuevos, ${r.actualizados} actualizados.`;
      toast(`Importados ${r.nuevos + r.actualizados} alumnos`);
      alTerminar();
    } catch (err) { res.textContent = "No se pudo importar: " + err.message; }
  };
}

/* ==========================================================================
   VISTA: REGISTROS
   ========================================================================== */
async function vistaRegistros(root) {
  await recargarAlumnos();
  const hoy = fechaISO();
  const f = { desde: hoy, hasta: hoy, grupo: "", tipo: "", q: "" };
  root.innerHTML = `
  <section class="admin">
    <div class="admin-cab">
      <div><h2>Registros</h2><p class="muted" id="rg-sub"></p></div>
      <div class="acciones">
        <button class="btn ghost" id="rg-faltas">Ver ausentes</button>
        <button class="btn" id="rg-csv">Exportar CSV</button>
      </div>
    </div>
    <div class="filtros">
      <label class="lbl">Desde<input type="date" class="input" id="rg-desde" value="${hoy}"></label>
      <label class="lbl">Hasta<input type="date" class="input" id="rg-hasta" value="${hoy}"></label>
      <select class="input" id="rg-grupo"><option value="">Todos los grupos</option>${gruposDisponibles().map(g => `<option>${esc(g)}</option>`).join("")}</select>
      <select class="input" id="rg-tipo"><option value="">Entradas y salidas</option><option value="entrada">Solo entradas</option><option value="salida">Solo salidas</option></select>
      <input class="input" id="rg-q" placeholder="Nombre o matrícula…">
      <div class="atajos">
        <button class="btn chico ghost" data-rango="hoy">Hoy</button>
        <button class="btn chico ghost" data-rango="semana">Semana</button>
        <button class="btn chico ghost" data-rango="mes">Mes</button>
      </div>
    </div>
    <div class="stats" id="rg-stats"></div>
    <div class="tarjeta grafica-card">
      <div class="feed-cab"><h4>Entradas por hora</h4><small class="muted" id="gr-sub"></small></div>
      <div class="grafica" id="rg-grafica" role="img" aria-label="Entradas por hora"></div>
    </div>
    <div class="tarjeta tabla-card">
      <table class="tabla"><thead><tr><th>Fecha</th><th>Hora</th><th>Alumno</th><th>Matrícula</th><th>Grupo</th><th>Tipo</th><th>Origen</th><th></th></tr></thead>
      <tbody id="rg-tbody"></tbody></table>
    </div>
  </section>`;

  let filtrados = [];
  async function cargar() {
    if (f.desde > f.hasta) [f.desde, f.hasta] = [f.hasta, f.desde];
    let regs = [];
    try { regs = await API.registros.entreFechas(f.desde, f.hasta); }
    catch (e) { toast(e.message, "mal"); }
    const t = f.q.trim().toLowerCase();
    filtrados = regs.filter(r => (!f.grupo || r.grupo === f.grupo) && (!f.tipo || r.tipo === f.tipo) &&
      (!t || r.nombre.toLowerCase().includes(t) || String(r.matricula).toLowerCase().includes(t)))
      .sort((a, b) => b.ts - a.ts);
    pintar();
  }
  function pintar() {
    const entradas = filtrados.filter(r => r.tipo === "entrada");
    const alumnosConEntrada = new Set(entradas.map(r => r.alumnoId));
    const dias = new Set(filtrados.map(r => r.fecha)).size || 1;
    $("#rg-sub").textContent = f.desde === f.hasta ? fechaLarga(f.desde) : `${fechaLarga(f.desde)} — ${fechaLarga(f.hasta)}`;
    $("#rg-stats").innerHTML = [
      ["Registros", filtrados.length, ""], ["Alumnos con entrada", alumnosConEntrada.size, "ok"],
      ["Promedio por día", Math.round(filtrados.length / dias), "info"],
    ].map(([k, v, c]) => `<div class="stat ${c}"><b>${v}</b><span>${k}</span></div>`).join("");
    pintarGrafica($("#rg-grafica"), $("#gr-sub"), entradas);
    $("#rg-tbody").innerHTML = filtrados.length ? filtrados.slice(0, 400).map(r => `<tr>
      <td>${r.fecha}</td><td class="mono">${horaSeg(r.ts)}</td><td><b>${esc(r.nombre)}</b></td><td class="mono">${esc(r.matricula)}</td>
      <td>${esc(r.grupo || "")}</td><td><span class="chip ${r.tipo}">${r.tipo === "entrada" ? "Entrada" : "Salida"}</span></td>
      <td class="muted">${r.origen === "manual" ? "Manual" : "Facial"}</td>
      <td><button class="btn chico ghost peligro" data-del="${r.id}" title="Eliminar registro">🗑</button></td></tr>`).join("")
      : `<tr><td colspan="8" class="muted centro">No hay registros con esos filtros.</td></tr>`;
    if (filtrados.length > 400) $("#rg-tbody").insertAdjacentHTML("beforeend", `<tr><td colspan="8" class="muted centro">Se muestran 400 de ${filtrados.length}. Exporta el CSV para verlos todos.</td></tr>`);
    $$("[data-del]", root).forEach(b => b.onclick = async () => {
      if (await confirmar("Eliminar registro", "¿Borrar este registro de asistencia?", { peligro: true, ok: "Eliminar" })) {
        try { await API.registros.eliminar(Number(b.dataset.del)); toast("Registro eliminado"); cargar(); }
        catch (e) { toast(e.message, "mal"); }
      }
    });
  }
  const liga = (id, campo, ev = "change") => $(id).addEventListener(ev, e => { f[campo] = e.target.value; cargar(); });
  liga("#rg-desde", "desde"); liga("#rg-hasta", "hasta"); liga("#rg-grupo", "grupo"); liga("#rg-tipo", "tipo"); liga("#rg-q", "q", "input");
  $$("[data-rango]", root).forEach(b => b.onclick = () => {
    const d = new Date(); const desde = new Date(d);
    if (b.dataset.rango === "semana") desde.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (b.dataset.rango === "mes") desde.setDate(1);
    f.desde = fechaISO(desde); f.hasta = fechaISO(d);
    $("#rg-desde").value = f.desde; $("#rg-hasta").value = f.hasta; cargar();
  });
  $("#rg-csv").onclick = () => exportarCSV(filtrados, `asistencia_${f.desde}_${f.hasta}.csv`);
  $("#rg-faltas").onclick = async () => {
    const regs = await API.registros.entreFechas(f.desde, f.hasta);
    const con = new Set(regs.filter(r => r.tipo === "entrada").map(r => r.alumnoId));
    const sin = Estado.alumnos.filter(a => a.activo !== false && !con.has(a.id) && (!f.grupo || a.grupo === f.grupo));
    const m = modal(`<h3>Sin entrada en el rango</h3><p class="muted">${sin.length} alumno${sin.length === 1 ? "" : "s"}${f.grupo ? ` del grupo ${esc(f.grupo)}` : ""} no registraron entrada entre ${f.desde} y ${f.hasta}.</p>
      <ul class="lista-busq alta">${sin.map(a => `<li><span class="avatar">${esc(iniciales(a.nombre))}</span><span><b>${esc(a.nombre)}</b><small>${esc(a.grupo || "")} · ${esc(a.matricula)}</small></span><span></span></li>`).join("") || "<li class='muted' style='display:block;text-align:center'>Todos registraron entrada.</li>"}</ul>
      <div class="acciones"><button class="btn ghost" id="fa-csv">Exportar CSV</button></div>`, { ancho: 520 });
    $("#fa-csv", m.nodo).onclick = () => descargar(`ausentes_${f.desde}_${f.hasta}.csv`,
      aCSV([["Nombre", "Matrícula", "Grupo", "Turno"], ...sin.map(a => [a.nombre, a.matricula, a.grupo, a.turno])]), "text/csv;charset=utf-8");
  };
  cargar();
}

/* ==========================================================================
   VISTA: CONFIGURACIÓN
   ========================================================================== */
async function vistaConfig(root) {
  const cfg = Estado.cfg;
  const local = Local.get();
  const camaras = await Face.listarCamaras().catch(() => []);
  root.innerHTML = `
  <section class="admin">
    <div class="admin-cab"><div><h2>Configuración</h2><p class="muted">Los cambios se guardan al instante${API.modoDemo ? " en este navegador" : " para todos los equipos"}.</p></div></div>
    <div class="cfg-grid">
      <div class="tarjeta cfg">
        <h4>Plantel</h4>
        <label>Nombre del plantel<input class="input" data-cfg="plantel" value="${esc(cfg.plantel)}"></label>
      </div>
      <div class="tarjeta cfg">
        <h4>Reconocimiento</h4>
        <label>Sensibilidad <span class="muted" id="umbral-v">${Number(cfg.umbral).toFixed(2)}</span>
          <input type="range" min="0.35" max="0.65" step="0.01" data-cfg="umbral" value="${cfg.umbral}"></label>
        <p class="muted chico">Menor = más estricto. 0.50 funciona bien con buena luz; 0.55 si la caseta es oscura.</p>
        <label>Margen entre candidatos <span class="muted" id="margen-v">${Number(cfg.margen).toFixed(2)}</span>
          <input type="range" min="0" max="0.15" step="0.01" data-cfg="margen" value="${cfg.margen}"></label>
        <p class="muted chico">Ventaja que el mejor candidato debe sacarle al segundo. Evita confundir a dos alumnos parecidos (hermanos).</p>
        <div class="fila">
          <label>Confirmaciones<input type="number" min="1" max="10" class="input" data-cfg="confirmaciones" value="${cfg.confirmaciones}"></label>
          <label>Espera entre registros (s)<input type="number" min="5" max="3600" class="input" data-cfg="cooldownSeg" value="${cfg.cooldownSeg}"></label>
        </div>
        <label class="check" style="margin-top:12px"><input type="checkbox" data-cfg="sonido" ${cfg.sonido ? "checked" : ""}> Sonido al registrar</label>
        <hr>
        <label>Cámara de este equipo<select class="input" id="cfg-camara"><option value="">Automática</option>
          ${camaras.map(c => `<option value="${esc(c.deviceId)}" ${c.deviceId === local.camara ? "selected" : ""}>${esc(c.label || "Cámara")}</option>`).join("")}</select></label>
        <p class="muted chico">Se guarda solo en esta computadora.</p>
      </div>
      <div class="tarjeta cfg">
        <h4>Cuentas</h4>
        <p class="muted chico">Administrador: todo. Kiosco: solo la pantalla de la caseta. Las cuentas desactivadas no pueden entrar.</p>
        <ul class="cuentas" id="cu-lista"><li class="muted">Cargando…</li></ul>
        <hr>
        <form class="form" id="f-cuenta">
          <b>Nueva cuenta</b>
          <label>Correo<input class="input" type="email" name="correo" placeholder="caseta@cbtis002.edu.mx" required></label>
          <label>Contraseña<div class="clave-sugerida"><input class="input" type="text" name="clave" minlength="8" required autocomplete="off"><button type="button" class="btn ghost chico" id="cu-generar">Generar</button></div></label>
          <label>Rol<select class="input" name="rol"><option value="kiosco">Kiosco (caseta)</option><option value="admin">Administrador</option></select></label>
          <p class="error" hidden></p>
          <div class="acciones"><button class="btn">Crear cuenta</button></div>
        </form>
      </div>
      <div class="tarjeta cfg">
        <h4>Datos</h4>
        <p class="muted chico">${API.modoDemo ? "En modo demostración los datos viven solo en este navegador." : "Los datos viven en Supabase, con respaldo automático. Puedes descargar una copia completa."}</p>
        <div class="acciones izq">
          <button class="btn ghost" id="bk-exportar">Descargar copia (JSON)</button>
          <a class="btn ghost" href="#alumnos">Importar lista CSV</a>
        </div>
      </div>
      <div class="tarjeta cfg info">
        <h4>Acerca del sistema</h4>
        <p class="muted chico">El reconocimiento corre en el navegador: la cámara nunca se transmite. Solo se guardan los descriptores (128 números por muestra) y una foto pequeña de credencial.</p>
        <p class="muted chico" style="margin-top:8px">Conexión: <b>${API.modoDemo ? "modo demostración" : "Supabase"}</b> · Alumnos: <b>${Estado.alumnos.length}</b> · Modelos: ${Face.listos ? "cargados" : "se cargan al abrir el kiosco"}</p>
      </div>
    </div>
  </section>`;

  let timerTexto = null;
  $$("[data-cfg]", root).forEach(el => {
    const ev = el.type === "range" ? "input" : "change";
    el.addEventListener(ev, () => {
      let v = el.type === "checkbox" ? el.checked : el.value;
      if (el.type === "number" || el.type === "range") v = Number(v);
      if (el.dataset.cfg === "plantel" && !String(v).trim()) return;
      if (el.dataset.cfg === "umbral") $("#umbral-v").textContent = v.toFixed(2);
      if (el.dataset.cfg === "margen") $("#margen-v").textContent = v.toFixed(2);
      clearTimeout(timerTexto);
      timerTexto = setTimeout(async () => {
        try {
          Estado.cfg = await API.config.set({ [el.dataset.cfg]: v });
          if (el.dataset.cfg === "plantel") $(".marca b").textContent = v;
          toast("Guardado");
        } catch (e) { toast(e.message, "mal"); }
      }, el.type === "range" ? 500 : 150);
    });
  });
  $("#cfg-camara").onchange = e => { Local.set({ camara: e.target.value }); toast("Cámara guardada en este equipo"); };

  async function pintarCuentas() {
    const ul = $("#cu-lista");
    try {
      const lista = await API.usuarios.todos();
      ul.innerHTML = lista.map(u => `<li>
        <div><b title="${esc(u.correo)}">${esc(u.correo || u.id)}</b><small>${u.id === Estado.perfil.id ? "Tú · " : ""}desde ${new Date(u.creado).toLocaleDateString("es-MX")}</small></div>
        ${u.id === Estado.perfil.id ? `<span class="chip admin">Administrador</span>` : `<select class="input" data-rol="${u.id}">
          <option value="admin" ${u.rol === "admin" ? "selected" : ""}>Administrador</option>
          <option value="kiosco" ${u.rol === "kiosco" ? "selected" : ""}>Kiosco</option>
          <option value="pendiente" ${u.rol === "pendiente" ? "selected" : ""}>Desactivada</option></select>`}
      </li>`).join("") || `<li class="muted">No hay cuentas.</li>`;
      $$("[data-rol]", ul).forEach(s => s.onchange = async () => {
        try { await API.usuarios.cambiarRol(s.dataset.rol, s.value); toast("Rol actualizado"); }
        catch (e) { toast(e.message, "mal"); pintarCuentas(); }
      });
    } catch (e) { ul.innerHTML = `<li class="muted">${esc(e.message)}</li>`; }
  }
  pintarCuentas();
  const generarClave = () => {
    const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), b => abc[b % abc.length]).join("");
  };
  $("#cu-generar").onclick = () => { $("#f-cuenta input[name=clave]").value = generarClave(); };
  alEnviar($("#f-cuenta"), async d => {
    if (d.clave.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
    const r = await API.usuarios.crear(d.correo, d.clave, d.rol);
    $("#f-cuenta").reset();
    pintarCuentas();
    modal(`<h3>Cuenta creada</h3><p class="muted">Anota estos datos para la computadora de la caseta; la contraseña no se vuelve a mostrar.</p>
      <div class="csv-ej">Correo: ${esc(r.correo)}\nContraseña: ${esc(d.clave)}\nRol: ${r.rol === "admin" ? "Administrador" : "Kiosco"}</div>
      ${r.confirmada ? "" : `<p class="login-aviso">Supabase pide confirmar el correo antes de poder entrar. Para evitarlo, desactiva «Confirm email» en Authentication → Providers → Email.</p>`}`, { ancho: 460 });
    return "";
  }, { ocupado: "Creando…" });

  $("#bk-exportar").onclick = async () => {
    try {
      const datos = await API.exportar();
      descargar(`copia_asistencia_${fechaISO()}.json`, JSON.stringify(datos), "application/json");
      toast("Copia descargada");
    } catch (e) { toast(e.message, "mal"); }
  };
}

/* ---------- Enrutador ---------- */
const VISTAS = { panel: vistaPanel, kiosco: vistaKiosco, alumnos: vistaAlumnos, registros: vistaRegistros, config: vistaConfig };

async function navegar() {
  if (!Estado.perfil) return;
  const nombre = (location.hash || "").slice(1);
  let vista = VISTAS[nombre] ? nombre : "panel";
  if (!esAdmin()) vista = "kiosco";
  if (vista !== nombre) { location.hash = "#" + vista; return; }
  cerrarVista();
  Estado.vista = vista;
  marcarNav();
  const root = $("#vista");
  if (!root) return;
  root.className = "vista entra" + (esAdmin() ? "" : " solo-kiosco");
  root.innerHTML = `<div class="cargando"><div class="anillo"></div></div>`;
  try { await VISTAS[vista](root); }
  catch (e) {
    console.error(e);
    root.innerHTML = `<div class="vacio-grande"><p>Ocurrió un error: ${esc(e.message || e)}</p></div>`;
  }
}

window.addEventListener("hashchange", navegar);
window.addEventListener("DOMContentLoaded", async () => {
  if (typeof faceapi === "undefined") {
    $("#app").innerHTML = `<div class="vacio-grande"><p>No se pudo cargar la librería de reconocimiento (vendor/face-api.js).</p></div>`;
    return;
  }
  setInterval(reloj, 1000);
  API.init();
  API.auth.onCambio(evento => { if (evento === "SIGNED_OUT") { Estado.perfil = null; mostrarLogin(); } });
  try {
    const sesion = await API.auth.sesion();
    if (sesion) await entrarApp(); else await mostrarLogin();
  } catch (e) {
    console.error(e);
    document.body.classList.add("en-login");
    $("#app").innerHTML = `<div class="login"><div class="login-fondo"><i></i><i></i><i></i></div><section class="login-der" style="grid-column:1/-1"><div class="login-form">
      <h2>No se pudo iniciar</h2><p class="muted">${esc(e.message || e)}</p><button class="btn" onclick="location.reload()">Reintentar</button></div></section></div>`;
  }
});
