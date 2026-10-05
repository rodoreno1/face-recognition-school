/* ==========================================================================
   Control de entradas y salidas por reconocimiento facial — interfaz.

   Una sola página con cuatro vistas (hash en la URL):
     #kiosco     pantalla de la caseta: cámara, reconoce y registra sola
     #alumnos    alta, edición y captura de rostros (requiere PIN)
     #registros  historial, estadísticas y exportación (requiere PIN)
     #config     horarios, sensibilidad, cámara, respaldo (requiere PIN)

   Depende de db.js (datos) y face.js (reconocimiento). Sin frameworks: todo
   se pinta con plantillas de texto y se vuelve a pintar cuando cambia algo.
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
const minutosDe = hhmm => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const iniciales = nombre => nombre.trim().split(/\s+/).slice(0, 2).map(p => p[0] || "").join("").toUpperCase();
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

let toastTimer = null;
function toast(msg, tipo = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast on " + tipo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 3200);
}

/* Modal genérico: devuelve el nodo del cuerpo y una función para cerrar. */
function modal(html, { ancho = 560, alCerrar = null } = {}) {
  const capa = document.createElement("div");
  capa.className = "capa";
  capa.innerHTML = `<div class="modal" style="max-width:${ancho}px" role="dialog" aria-modal="true">
      <button class="cerrar" aria-label="Cerrar">✕</button>${html}</div>`;
  document.body.appendChild(capa);
  document.body.classList.add("con-modal");
  requestAnimationFrame(() => capa.classList.add("on"));
  const cerrar = () => {
    capa.classList.remove("on");
    document.body.classList.remove("con-modal");
    setTimeout(() => capa.remove(), 220);
    document.removeEventListener("keydown", escK);
    if (alCerrar) alCerrar();
  };
  const escK = e => { if (e.key === "Escape") cerrar(); };
  document.addEventListener("keydown", escK);
  capa.addEventListener("click", e => { if (e.target === capa) cerrar(); });
  $(".cerrar", capa).addEventListener("click", cerrar);
  return { nodo: $(".modal", capa), cerrar };
}

function confirmar(titulo, texto, { peligro = false, ok = "Confirmar" } = {}) {
  return new Promise(res => {
    const m = modal(`<h3>${esc(titulo)}</h3><p class="muted">${texto}</p>
      <div class="acciones"><button class="btn ghost" data-no>Cancelar</button>
      <button class="btn ${peligro ? "peligro" : ""}" data-si>${esc(ok)}</button></div>`, { ancho: 440 });
    $("[data-no]", m.nodo).onclick = () => { m.cerrar(); res(false); };
    $("[data-si]", m.nodo).onclick = () => { m.cerrar(); res(true); };
  });
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
    if (!DB.config.get().sonido) return;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      const t = ctx.currentTime;
      if (clase === "entrada") { tono(660, 0.12, t); tono(990, 0.18, t + 0.12); }
      else if (clase === "salida") { tono(880, 0.12, t); tono(587, 0.2, t + 0.12); }
      else if (clase === "retardo") { tono(520, 0.15, t, "triangle"); tono(520, 0.15, t + 0.2, "triangle"); }
      else if (clase === "error") { tono(220, 0.25, t, "square", 0.08); }
      else { tono(440, 0.08, t); }
    } catch { /* sin audio no pasa nada */ }
  }
  return { tocar };
})();

/* ---------- Estado global ---------- */
const Estado = {
  cfg: DB.config.get(),
  alumnos: [],
  vista: null,
  limpiarVista: null, // función para apagar cámaras/temporizadores al salir
};
const GRUPOS_BASE = ["1A", "1B", "2A", "2B", "3A", "3B", "4A", "4B", "5A", "5B", "6A", "6B"];
const gruposDisponibles = () => {
  const set = new Set([...GRUPOS_BASE, ...Estado.alumnos.map(a => a.grupo).filter(Boolean)]);
  return [...set].sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
};

async function recargarAlumnos() {
  Estado.alumnos = (await DB.alumnos.todos()).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  return Estado.alumnos;
}

/* ---------- PIN de administrador ---------- */
const Pin = (() => {
  async function hash(texto) {
    if (crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cbtis:" + texto));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    }
    return "plano:" + texto; // navegador sin crypto.subtle (http sin https); mejor que nada
  }
  async function asegurar() {
    if (!Estado.cfg.pinHash) Estado.cfg = DB.config.set({ pinHash: await hash("1234") });
  }
  const desbloqueado = () => sessionStorage.getItem("cbtis-asistencia:admin") === "1";
  function pedir() {
    return new Promise(res => {
      const m = modal(`<h3>Acceso de administración</h3>
        <p class="muted">Escribe el PIN para entrar. El PIN inicial es <b>1234</b>; cámbialo en Configuración.</p>
        <form class="pin-form">
          <input type="password" inputmode="numeric" autocomplete="off" class="pin-input" maxlength="8" placeholder="••••" autofocus>
          <p class="error" hidden>PIN incorrecto</p>
          <div class="acciones"><a class="btn ghost" href="#kiosco">Volver al kiosco</a><button class="btn">Entrar</button></div>
        </form>`, { ancho: 400, alCerrar: () => res(desbloqueado()) });
      const form = $("form", m.nodo), input = $("input", m.nodo);
      setTimeout(() => input.focus(), 50);
      form.onsubmit = async e => {
        e.preventDefault();
        if (await hash(input.value) === DB.config.get().pinHash) {
          sessionStorage.setItem("cbtis-asistencia:admin", "1");
          m.cerrar(); res(true);
        } else {
          $(".error", m.nodo).hidden = false;
          input.value = ""; input.classList.add("shake");
          setTimeout(() => input.classList.remove("shake"), 400);
          Sonido.tocar("error");
        }
      };
      $("a", m.nodo).onclick = () => m.cerrar();
    });
  }
  function bloquear() { sessionStorage.removeItem("cbtis-asistencia:admin"); }
  return { hash, asegurar, desbloqueado, pedir, bloquear };
})();

/* ---------- Lógica de registro (compartida por kiosco y registro manual) ---------- */
function esRetardo(turno, ts) {
  const cfg = DB.config.get();
  const limite = minutosDe(turno === "Vespertino" ? cfg.entradaVespertino : cfg.entradaMatutino) + Number(cfg.toleranciaMin || 0);
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes() > limite;
}

/* Decide el tipo (entrada/salida), aplica el periodo de gracia y guarda.
   Devuelve { registro } o { duplicado, ultimo }. */
async function registrarAsistencia(alumno, modo, origen, distancia = null) {
  const cfg = DB.config.get();
  const ahora = Date.now();
  const fecha = fechaISO(new Date(ahora));
  const deHoy = (await DB.registros.deAlumnoEnFecha(alumno.id, fecha)).sort((a, b) => a.ts - b.ts);
  const ultimo = deHoy[deHoy.length - 1];
  if (ultimo && origen === "facial" && ahora - ultimo.ts < cfg.cooldownSeg * 1000) {
    return { duplicado: true, ultimo };
  }
  let tipo = modo;
  if (modo === "auto") tipo = ultimo && ultimo.tipo === "entrada" ? "salida" : "entrada";
  const primeraEntrada = tipo === "entrada" && !deHoy.some(r => r.tipo === "entrada");
  const registro = await DB.registros.agregar({
    alumnoId: alumno.id, nombre: alumno.nombre, matricula: alumno.matricula, grupo: alumno.grupo,
    turno: alumno.turno, tipo, ts: ahora, fecha, retardo: primeraEntrada && esRetardo(alumno.turno, ahora),
    origen, distancia: distancia == null ? null : Math.round(distancia * 1000) / 1000,
  });
  return { registro };
}

/* ---------- Armazón: cabecera, reloj, navegación ---------- */
function pintarCabecera() {
  const cfg = DB.config.get();
  $("#cabecera").innerHTML = `
    <a class="marca" href="#kiosco">
      <span class="marca-ico">◉</span>
      <span><b>${esc(cfg.plantel)}</b><small>Control de acceso</small></span>
    </a>
    <nav class="nav">
      <a href="#kiosco" data-v="kiosco">Kiosco</a>
      <a href="#alumnos" data-v="alumnos">Alumnos</a>
      <a href="#registros" data-v="registros">Registros</a>
      <a href="#config" data-v="config">Configuración</a>
    </nav>
    <div class="cab-der">
      <div class="reloj"><b id="reloj-h">--:--</b><small id="reloj-f"></small></div>
      <button class="btn icono" id="btn-tema" title="Cambiar tema">${cfg.tema === "claro" ? "🌙" : "☀️"}</button>
      <button class="btn icono" id="btn-bloq" title="Cerrar sesión de administrador" ${Pin.desbloqueado() ? "" : "hidden"}>🔒</button>
    </div>`;
  $("#btn-tema").onclick = () => {
    const tema = DB.config.get().tema === "claro" ? "oscuro" : "claro";
    Estado.cfg = DB.config.set({ tema });
    aplicarTema();
    pintarCabecera();
  };
  $("#btn-bloq").onclick = () => { Pin.bloquear(); toast("Sesión de administrador cerrada"); location.hash = "#kiosco"; };
  marcarNav();
}
function marcarNav() {
  $$(".nav a").forEach(a => a.classList.toggle("activo", a.dataset.v === Estado.vista));
}
function reloj() {
  const d = new Date();
  const h = $("#reloj-h"), f = $("#reloj-f");
  if (h) h.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (f) f.textContent = d.toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short" });
  $$("[data-reloj-grande]").forEach(el => { el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`; });
}
function aplicarTema() {
  document.documentElement.dataset.tema = DB.config.get().tema;
}

/* ==========================================================================
   VISTA: KIOSCO
   ========================================================================== */
async function vistaKiosco(root) {
  const cfg = DB.config.get();
  const modoGuardado = localStorage.getItem("cbtis-asistencia:modo") || "auto";
  root.innerHTML = `
  <section class="kiosco">
    <div class="cam-col">
      <div class="cam-marco">
        <video id="cam" autoplay muted playsinline></video>
        <canvas id="cam-canvas"></canvas>
        <div class="cam-estado" id="cam-estado">
          <span class="punto"></span><span id="cam-estado-txt">Cargando modelos…</span>
        </div>
        <div class="cam-carga" id="cam-carga">
          <div class="anillo"></div>
          <p id="cam-carga-txt">Preparando reconocimiento facial…</p>
          <div class="barra"><i id="cam-carga-barra"></i></div>
        </div>
        <div class="cam-reloj" data-reloj-grande>--:--</div>
      </div>
      <div class="cam-barra">
        <div class="segmento" role="radiogroup" aria-label="Tipo de registro">
          ${[["auto", "Automático"], ["entrada", "Entrada"], ["salida", "Salida"]].map(([v, t]) =>
            `<button data-modo="${v}" class="${v === modoGuardado ? "on" : ""}" role="radio" aria-checked="${v === modoGuardado}">${t}</button>`).join("")}
        </div>
        <div class="cam-acciones">
          <button class="btn ghost" id="btn-manual">Registro manual</button>
          <button class="btn ghost icono" id="btn-full" title="Pantalla completa">⛶</button>
        </div>
      </div>
    </div>
    <aside class="panel-col">
      <div class="tarjeta resultado" id="resultado">
        <div class="res-vacio">
          <div class="res-ico">👤</div>
          <h3>Mira a la cámara</h3>
          <p class="muted">Al reconocerte se registra tu ${modoGuardado === "salida" ? "salida" : "entrada"} automáticamente.</p>
        </div>
      </div>
      <div class="stats" id="stats"></div>
      <div class="tarjeta feed">
        <div class="feed-cab"><h4>Últimos registros</h4><small class="muted" id="feed-fecha"></small></div>
        <ul id="feed"></ul>
      </div>
    </aside>
  </section>`;

  const video = $("#cam"), canvas = $("#cam-canvas");
  const estadoTxt = $("#cam-estado-txt"), estadoBox = $("#cam-estado");
  let modo = modoGuardado;
  let activo = true;
  let comparador = null;
  let candidato = { id: null, rachas: 0 };
  let timerResultado = null;
  let mostradosCooldown = {};

  const setEstado = (txt, clase = "") => { estadoTxt.textContent = txt; estadoBox.className = "cam-estado " + clase; };

  $$("[data-modo]", root).forEach(b => b.onclick = () => {
    modo = b.dataset.modo;
    localStorage.setItem("cbtis-asistencia:modo", modo);
    $$("[data-modo]", root).forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    toast(`Modo: ${b.textContent}`);
  });
  $("#btn-full").onclick = () => {
    const full = document.body.classList.toggle("kiosco-full");
    if (full && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    if (!full && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  const alCambiarFull = () => { if (!document.fullscreenElement) document.body.classList.remove("kiosco-full"); };
  document.addEventListener("fullscreenchange", alCambiarFull);
  $("#btn-manual").onclick = () => abrirRegistroManual(modo, () => refrescarPanel());

  /* ----- panel derecho ----- */
  async function refrescarPanel() {
    const fecha = fechaISO();
    const regs = (await DB.registros.porFecha(fecha)).sort((a, b) => b.ts - a.ts);
    const entradas = regs.filter(r => r.tipo === "entrada");
    const salidas = regs.filter(r => r.tipo === "salida");
    const dentro = new Set();
    [...regs].reverse().forEach(r => r.tipo === "entrada" ? dentro.add(r.alumnoId) : dentro.delete(r.alumnoId));
    const retardos = entradas.filter(r => r.retardo).length;
    $("#stats").innerHTML = [
      ["Dentro del plantel", dentro.size, "ok"], ["Entradas", entradas.length, ""],
      ["Salidas", salidas.length, ""], ["Retardos", retardos, retardos ? "warn" : ""],
    ].map(([k, v, c]) => `<div class="stat ${c}"><b>${v}</b><span>${k}</span></div>`).join("");
    $("#feed-fecha").textContent = fechaLarga(fecha);
    $("#feed").innerHTML = regs.length ? regs.slice(0, 8).map(r => `
      <li class="${r.tipo}">
        <span class="hora">${hora(r.ts)}</span>
        <span class="quien"><b>${esc(r.nombre)}</b><small>${esc(r.grupo || "")} · ${esc(r.matricula)}</small></span>
        <span class="chip ${r.tipo}">${r.tipo === "entrada" ? "Entrada" : "Salida"}${r.retardo ? " · retardo" : ""}</span>
      </li>`).join("") : `<li class="vacio muted">Todavía no hay registros hoy.</li>`;
  }

  function mostrarResultado(html, clase, ms = 6000) {
    const res = $("#resultado");
    res.className = "tarjeta resultado " + clase;
    res.innerHTML = html;
    clearTimeout(timerResultado);
    timerResultado = setTimeout(() => {
      res.className = "tarjeta resultado";
      res.innerHTML = `<div class="res-vacio"><div class="res-ico">👤</div><h3>Mira a la cámara</h3>
        <p class="muted">Al reconocerte se registra tu asistencia automáticamente.</p></div>`;
    }, ms);
  }
  const fotoDe = a => a.foto ? `<img src="${a.foto}" alt="">` : `<span class="avatar">${esc(iniciales(a.nombre))}</span>`;

  async function alReconocer(alumno, distancia) {
    const r = await registrarAsistencia(alumno, modo, "facial", distancia);
    if (r.duplicado) {
      const hace = Math.round((Date.now() - r.ultimo.ts) / 1000);
      if (!mostradosCooldown[alumno.id] || Date.now() - mostradosCooldown[alumno.id] > 4000) {
        mostradosCooldown[alumno.id] = Date.now();
        mostrarResultado(`<div class="res-foto">${fotoDe(alumno)}</div>
          <div class="res-info"><small class="eyebrow">Ya registrado</small><h3>${esc(alumno.nombre)}</h3>
          <p class="muted">${r.ultimo.tipo === "entrada" ? "Entrada" : "Salida"} a las ${hora(r.ultimo.ts)} (hace ${hace} s)</p></div>`, "repetido", 3000);
      }
      return;
    }
    const reg = r.registro;
    Sonido.tocar(reg.retardo ? "retardo" : reg.tipo);
    mostrarResultado(`
      <div class="res-foto">${fotoDe(alumno)}</div>
      <div class="res-info">
        <small class="eyebrow">${reg.tipo === "entrada" ? "Entrada registrada" : "Salida registrada"}</small>
        <h3>${esc(alumno.nombre)}</h3>
        <p>${esc(alumno.grupo || "")} · ${esc(alumno.matricula)} · ${esc(alumno.turno || "")}</p>
        <div class="res-hora">${hora(reg.ts)}${reg.retardo ? `<span class="chip warn">Retardo</span>` : ""}</div>
      </div>
      <div class="res-check">${reg.tipo === "entrada" ? "✓" : "↩"}</div>`, reg.retardo ? "retardo" : reg.tipo);
    refrescarPanel();
  }

  /* ----- arranque de modelos y cámara ----- */
  try {
    await Face.cargarModelos(p => {
      $("#cam-carga-txt").textContent = p.indice < p.total ? `Cargando: ${p.paso}…` : "Encendiendo cámara…";
      $("#cam-carga-barra").style.transform = `scaleX(${p.indice / p.total})`;
    });
    if (!activo) return;
    await Face.iniciarCamara(video, cfg.camara);
    $("#cam-carga").classList.add("fuera");
  } catch (e) {
    $("#cam-carga-txt").innerHTML = `<b>No se pudo iniciar.</b><br>${esc(e.message || e)}<br><small>Revisa el permiso de cámara en el navegador.</small>`;
    $(".anillo", root).hidden = true;
    setEstado("Sin cámara", "mal");
    return;
  }
  await recargarAlumnos();
  comparador = Face.Comparador(Estado.alumnos, cfg.umbral);
  if (comparador.vacio) setEstado("No hay alumnos con rostro registrado", "aviso");
  else setEstado("Buscando rostros…");
  refrescarPanel();

  /* ----- bucle de detección ----- */
  let ocupado = false;
  async function ciclo() {
    if (!activo) return;
    if (!ocupado && video.readyState >= 2) {
      ocupado = true;
      try {
        const rostros = await Face.detectar(video);
        if (!activo) return;
        const etiquetas = {};
        let mejor = null;
        rostros.forEach((r, i) => {
          const m = comparador.identificar(r.descriptor);
          if (m.alumno) {
            etiquetas[i] = { texto: m.alumno.nombre.split(" ")[0], color: "rgba(43,240,228,.95)" };
            if (!mejor || m.distancia < mejor.distancia) mejor = { ...m, rostro: r };
          } else etiquetas[i] = { texto: comparador.vacio ? "" : "Desconocido", color: "rgba(255,255,255,.7)" };
        });
        Face.dibujar(canvas, video, rostros, etiquetas);
        if (mejor) {
          // Pide varias coincidencias seguidas antes de registrar: evita falsos positivos.
          if (candidato.id === mejor.alumno.id) candidato.rachas++;
          else candidato = { id: mejor.alumno.id, rachas: 1 };
          const faltan = Math.max(0, DB.config.get().confirmaciones - candidato.rachas);
          setEstado(faltan > 0 ? `Confirmando a ${mejor.alumno.nombre.split(" ")[0]}…` : `Reconocido: ${mejor.alumno.nombre}`, "ok");
          if (faltan === 0) { candidato.rachas = 0; await alReconocer(mejor.alumno, mejor.distancia); }
        } else {
          candidato = { id: null, rachas: 0 };
          if (!comparador.vacio) setEstado(rostros.length ? "Rostro no registrado" : "Buscando rostros…", rostros.length ? "aviso" : "");
        }
      } catch (e) { console.error(e); }
      ocupado = false;
    }
    setTimeout(ciclo, 120);
  }
  ciclo();

  /* El alta de alumnos cambia el comparador: se reconstruye al volver. */
  Estado.limpiarVista = () => {
    activo = false;
    clearTimeout(timerResultado);
    Face.detenerCamara();
    document.removeEventListener("fullscreenchange", alCambiarFull);
    document.body.classList.remove("kiosco-full");
  };
}

/* Registro manual: buscar al alumno y registrar sin cámara (credencial olvidada,
   cámara descompuesta, etc.). */
function abrirRegistroManual(modo, alTerminar) {
  const m = modal(`<h3>Registro manual</h3>
    <p class="muted">Busca al alumno por nombre o matrícula.</p>
    <input class="input" id="man-q" placeholder="Nombre o matrícula…" autofocus>
    <div class="segmento chico" id="man-modo">
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
    const res = t ? Estado.alumnos.filter(a => a.nombre.toLowerCase().includes(t) || a.matricula.toLowerCase().includes(t)).slice(0, 8) : [];
    lista.innerHTML = res.map(a => `<li data-id="${a.id}">
      ${a.foto ? `<img src="${a.foto}" alt="">` : `<span class="avatar">${esc(iniciales(a.nombre))}</span>`}
      <span><b>${esc(a.nombre)}</b><small>${esc(a.grupo || "")} · ${esc(a.matricula)}</small></span>
      <button class="btn chico">Registrar</button></li>`).join("") || (t ? `<li class="muted">Sin resultados</li>` : "");
    $$("li[data-id] button", lista).forEach(b => b.onclick = async () => {
      const a = Estado.alumnos.find(x => x.id === b.closest("li").dataset.id);
      const r = await registrarAsistencia(a, tipo, "manual");
      Sonido.tocar(r.registro.retardo ? "retardo" : tipo);
      toast(`${tipo === "entrada" ? "Entrada" : "Salida"} de ${a.nombre} a las ${hora(r.registro.ts)}${r.registro.retardo ? " (retardo)" : ""}`);
      m.cerrar(); if (alTerminar) alTerminar();
    });
  };
  q.oninput = pintar;
  setTimeout(() => q.focus(), 50);
}

/* ==========================================================================
   VISTA: ALUMNOS
   ========================================================================== */
async function vistaAlumnos(root) {
  await recargarAlumnos();
  let q = "", grupo = "";
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
    </div>
    <div class="grid-alumnos" id="al-grid"></div>
  </section>`;

  function pintar() {
    const t = q.toLowerCase();
    const lista = Estado.alumnos.filter(a =>
      (!grupo || a.grupo === grupo) && (!t || a.nombre.toLowerCase().includes(t) || a.matricula.toLowerCase().includes(t)));
    const sinRostro = Estado.alumnos.filter(a => !(a.descriptores || []).length).length;
    $("#al-cuenta").textContent = `${Estado.alumnos.length} alumno${Estado.alumnos.length === 1 ? "" : "s"}` +
      (sinRostro ? ` · ${sinRostro} sin rostro registrado` : "");
    $("#al-grid").innerHTML = lista.length ? lista.map(a => {
      const n = (a.descriptores || []).length;
      return `<article class="al-card ${n ? "" : "sin-rostro"}" data-id="${a.id}">
        <div class="al-foto">${a.foto ? `<img src="${a.foto}" alt="">` : `<span class="avatar">${esc(iniciales(a.nombre))}</span>`}</div>
        <div class="al-info">
          <b>${esc(a.nombre)}</b>
          <small>${esc(a.matricula)} · ${esc(a.grupo || "sin grupo")} · ${esc(a.turno || "")}</small>
          <span class="chip ${n ? "ok" : "warn"}">${n ? `${n} muestra${n === 1 ? "" : "s"} facial${n === 1 ? "" : "es"}` : "Sin rostro"}</span>
        </div>
        <div class="al-acc">
          <button class="btn chico" data-rostro title="Capturar rostro">📷</button>
          <button class="btn chico ghost" data-editar title="Editar">✎</button>
          <button class="btn chico ghost peligro" data-borrar title="Eliminar">🗑</button>
        </div>
      </article>`;
    }).join("") : `<div class="vacio-grande"><p>${Estado.alumnos.length ? "Nadie coincide con la búsqueda." : "Aún no hay alumnos. Da de alta al primero o importa una lista CSV."}</p></div>`;
    $$(".al-card", root).forEach(card => {
      const a = Estado.alumnos.find(x => x.id === card.dataset.id);
      $("[data-rostro]", card).onclick = () => formularioAlumno(a, pintar, true);
      $("[data-editar]", card).onclick = () => formularioAlumno(a, pintar);
      $("[data-borrar]", card).onclick = async () => {
        if (await confirmar("Eliminar alumno", `Se borrará a <b>${esc(a.nombre)}</b> junto con sus muestras faciales y todos sus registros. Esta acción no se puede deshacer.`, { peligro: true, ok: "Eliminar" })) {
          await DB.registros.eliminarDeAlumno(a.id);
          await DB.alumnos.eliminar(a.id);
          await recargarAlumnos(); pintar(); toast("Alumno eliminado");
        }
      };
    });
  }
  $("#al-q").oninput = e => { q = e.target.value; pintar(); };
  $("#al-grupo").onchange = e => { grupo = e.target.value; pintar(); };
  $("#btn-nuevo").onclick = () => formularioAlumno(null, pintar);
  $("#btn-csv").onclick = () => importarCSV(pintar);
  pintar();
}

/* Formulario de alta/edición con captura de rostro en vivo. */
function formularioAlumno(alumno, alGuardar, irARostro = false) {
  const a = alumno ? { ...alumno, descriptores: [...(alumno.descriptores || [])] } : { nombre: "", matricula: "", grupo: "", semestre: "1", turno: "Matutino", descriptores: [], foto: "" };
  const m = modal(`
    <h3>${alumno ? "Editar alumno" : "Nuevo alumno"}</h3>
    <div class="form-2col">
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
      </form>
      <div class="captura">
        <div class="cap-marco">
          <video id="cap-video" autoplay muted playsinline></video>
          <img id="cap-foto" alt="" ${a.foto ? `src="${a.foto}"` : "hidden"}>
          <div class="cap-msj" id="cap-msj">Encendiendo cámara…</div>
        </div>
        <div class="cap-muestras" id="cap-muestras"></div>
        <div class="cap-acc">
          <button type="button" class="btn" id="cap-tomar" disabled>📷 Tomar muestra</button>
          <label class="btn ghost">Desde foto<input type="file" accept="image/*" id="cap-archivo" hidden></label>
        </div>
        <p class="muted chico">Toma 3 a 5 muestras: de frente, un poco de perfil, con y sin lentes. Un solo rostro en la toma.</p>
      </div>
    </div>
    <div class="acciones">
      <button class="btn ghost" id="f-cancelar">Cancelar</button>
      <button class="btn" id="f-guardar">Guardar</button>
    </div>`, { ancho: 920, alCerrar: () => { camActiva = false; Face.detenerCamara(); } });

  const video = $("#cap-video", m.nodo), msj = $("#cap-msj", m.nodo), btnTomar = $("#cap-tomar", m.nodo);
  const foto = $("#cap-foto", m.nodo);
  let camActiva = true;
  let muestras = a.descriptores.map(d => ({ descriptor: d, miniatura: null }));
  if (irARostro) setTimeout(() => btnTomar.scrollIntoView({ behavior: "smooth", block: "center" }), 300);

  function pintarMuestras() {
    $("#cap-muestras", m.nodo).innerHTML = muestras.map((s, i) => `
      <div class="muestra" title="Muestra ${i + 1}">${s.miniatura ? `<img src="${s.miniatura}" alt="">` : `<span>#${i + 1}</span>`}
        <button type="button" data-q="${i}" aria-label="Quitar muestra">✕</button></div>`).join("") +
      (muestras.length ? "" : `<span class="muted chico">Sin muestras todavía</span>`);
    $$("[data-q]", m.nodo).forEach(b => b.onclick = () => { muestras.splice(Number(b.dataset.q), 1); pintarMuestras(); });
  }
  pintarMuestras();

  (async () => {
    try {
      await Face.cargarModelos(p => { msj.textContent = p.indice < p.total ? `Cargando ${p.paso.toLowerCase()}…` : "Encendiendo cámara…"; });
      if (!camActiva) return;
      await Face.iniciarCamara(video, DB.config.get().camara);
      msj.textContent = ""; msj.classList.add("fuera");
      btnTomar.disabled = false;
      // Vista previa: indica en vivo si hay un rostro utilizable.
      (async function vigilar() {
        while (camActiva) {
          const r = await Face.detectarUno(video);
          if (!camActiva) return;
          msj.textContent = r.error || "";
          msj.classList.toggle("fuera", !r.error);
          msj.classList.toggle("ok", !r.error);
          await new Promise(res => setTimeout(res, 400));
        }
      })();
    } catch (e) {
      msj.textContent = "Sin cámara: " + (e.message || e) + ". Puedes subir una foto.";
    }
  })();

  async function agregarMuestra(fuente) {
    btnTomar.disabled = true;
    const r = await Face.detectarUno(fuente);
    if (r.error) { toast(r.error, "mal"); Sonido.tocar("error"); btnTomar.disabled = false; return; }
    const mini = Face.recortarRostro(fuente, r.resultado, 96);
    muestras.push({ descriptor: Array.from(r.resultado.descriptor), miniatura: mini });
    if (!a.foto || muestras.length === 1) { a.foto = Face.recortarRostro(fuente, r.resultado, 192); foto.src = a.foto; foto.hidden = false; setTimeout(() => { foto.hidden = true; }, 900); }
    Sonido.tocar("ok");
    toast(`Muestra ${muestras.length} tomada`);
    pintarMuestras();
    btnTomar.disabled = muestras.length >= 8;
  }
  btnTomar.onclick = () => agregarMuestra(video);
  $("#cap-archivo", m.nodo).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image();
    img.onload = async () => { await agregarMuestra(img); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(f);
    e.target.value = "";
  };

  $("#f-cancelar", m.nodo).onclick = m.cerrar;
  $("#f-guardar", m.nodo).onclick = async () => {
    const form = $("#f-alumno", m.nodo), err = $("#f-error", m.nodo);
    if (!form.reportValidity()) return;
    const d = Object.fromEntries(new FormData(form));
    d.matricula = d.matricula.trim(); d.nombre = d.nombre.trim(); d.grupo = d.grupo.trim().toUpperCase();
    const dup = await DB.alumnos.porMatricula(d.matricula);
    if (dup && dup.id !== a.id) { err.textContent = `La matrícula ${d.matricula} ya pertenece a ${dup.nombre}.`; err.hidden = false; return; }
    await DB.alumnos.guardar({ ...a, ...d, descriptores: muestras.map(s => s.descriptor), activo: true });
    await recargarAlumnos();
    toast(muestras.length ? "Alumno guardado" : "Guardado sin rostro: no podrá registrarse por cámara", muestras.length ? "ok" : "aviso");
    m.cerrar(); alGuardar();
  };
}

/* Importa una lista (nombre, matrícula, grupo, semestre, turno) desde CSV.
   Los rostros se capturan después, uno por uno. */
function importarCSV(alTerminar) {
  const m = modal(`<h3>Importar lista de alumnos</h3>
    <p class="muted">Archivo CSV con encabezados: <code>nombre, matricula, grupo, semestre, turno</code>. Las matrículas repetidas actualizan al alumno existente sin borrar su rostro.</p>
    <label class="zona-archivo"><input type="file" accept=".csv,text/csv" id="csv-arch" hidden><span>Elegir archivo CSV…</span></label>
    <pre class="csv-ej">nombre,matricula,grupo,semestre,turno
García López Ana,22180012,3A,3,Matutino
Hernández Ruiz Luis,22180045,3B,3,Vespertino</pre>
    <p id="csv-res" class="muted"></p>`, { ancho: 560 });
  $("#csv-arch", m.nodo).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const texto = await f.text();
    const lineas = texto.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
    const sep = (lineas[0].match(/;/g) || []).length > (lineas[0].match(/,/g) || []).length ? ";" : ",";
    const campos = l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
    const cab = campos(lineas[0]).map(c => c.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
    const idx = n => cab.indexOf(n);
    if (idx("nombre") < 0 || idx("matricula") < 0) { $("#csv-res", m.nodo).textContent = "Faltan las columnas nombre y matricula."; return; }
    let nuevos = 0, actualizados = 0;
    for (const l of lineas.slice(1)) {
      const c = campos(l);
      const matricula = c[idx("matricula")], nombre = c[idx("nombre")];
      if (!matricula || !nombre) continue;
      const base = await DB.alumnos.porMatricula(matricula);
      const turno = /vesp/i.test(c[idx("turno")] || "") ? "Vespertino" : "Matutino";
      await DB.alumnos.guardar({ ...(base || { descriptores: [], foto: "" }), nombre, matricula,
        grupo: (c[idx("grupo")] || "").toUpperCase(), semestre: c[idx("semestre")] || base?.semestre || "1", turno, activo: true });
      base ? actualizados++ : nuevos++;
    }
    await recargarAlumnos();
    $("#csv-res", m.nodo).textContent = `Listo: ${nuevos} nuevos, ${actualizados} actualizados.`;
    toast(`Importados ${nuevos + actualizados} alumnos`);
    alTerminar();
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
        <button class="btn ghost" id="rg-csv">Exportar CSV</button>
        <button class="btn ghost" id="rg-faltas">Ver ausentes</button>
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
        <button class="btn chico ghost" data-rango="semana">Esta semana</button>
        <button class="btn chico ghost" data-rango="mes">Este mes</button>
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
    const regs = await DB.registros.entreFechas(f.desde, f.hasta);
    const t = f.q.trim().toLowerCase();
    filtrados = regs.filter(r => (!f.grupo || r.grupo === f.grupo) && (!f.tipo || r.tipo === f.tipo) &&
      (!t || r.nombre.toLowerCase().includes(t) || String(r.matricula).toLowerCase().includes(t)))
      .sort((a, b) => b.ts - a.ts);
    pintar(regs);
  }
  function pintar(todosRango) {
    const entradas = filtrados.filter(r => r.tipo === "entrada");
    const alumnosConEntrada = new Set(entradas.map(r => r.alumnoId));
    const retardos = entradas.filter(r => r.retardo).length;
    const dias = new Set(filtrados.map(r => r.fecha)).size || 1;
    $("#rg-sub").textContent = f.desde === f.hasta ? fechaLarga(f.desde) : `${fechaLarga(f.desde)} — ${fechaLarga(f.hasta)}`;
    $("#rg-stats").innerHTML = [
      ["Registros", filtrados.length, ""], ["Alumnos con entrada", alumnosConEntrada.size, "ok"],
      ["Retardos", retardos, retardos ? "warn" : ""], ["Promedio por día", Math.round(filtrados.length / dias), ""],
    ].map(([k, v, c]) => `<div class="stat ${c}"><b>${v}</b><span>${k}</span></div>`).join("");

    // Gráfica: una serie (entradas), un tono, barras finas con tope redondeado.
    const porHora = Array.from({ length: 24 }, () => 0);
    entradas.forEach(r => porHora[new Date(r.ts).getHours()]++);
    const activas = porHora.map((v, h) => [h, v]).filter(([, v]) => v > 0);
    const hMin = activas.length ? Math.max(0, activas[0][0] - 1) : 6;
    const hMax = activas.length ? Math.min(23, activas[activas.length - 1][0] + 1) : 20;
    const max = Math.max(...porHora, 1);
    $("#gr-sub").textContent = entradas.length ? `${entradas.length} entradas` : "Sin entradas en el rango";
    $("#rg-grafica").innerHTML = `<div class="gr-barras">${porHora.slice(hMin, hMax + 1).map((v, i) => {
      const h = hMin + i;
      return `<div class="gr-col" title="${pad(h)}:00 — ${v} entrada${v === 1 ? "" : "s"}">
        <div class="gr-pista"><i style="height:${Math.round(v / max * 100)}%"></i></div>
        <small>${pad(h)}</small><b class="gr-val">${v || ""}</b></div>`;
    }).join("")}</div>`;

    $("#rg-tbody").innerHTML = filtrados.length ? filtrados.slice(0, 400).map(r => `<tr>
      <td>${r.fecha}</td><td class="mono-num">${horaSeg(r.ts)}</td><td><b>${esc(r.nombre)}</b></td><td class="mono-num">${esc(r.matricula)}</td>
      <td>${esc(r.grupo || "")}</td><td><span class="chip ${r.tipo}">${r.tipo === "entrada" ? "Entrada" : "Salida"}</span>${r.retardo ? ` <span class="chip warn">Retardo</span>` : ""}</td>
      <td class="muted">${r.origen === "manual" ? "Manual" : "Facial"}</td>
      <td><button class="btn chico ghost peligro" data-del="${r.id}" title="Eliminar registro">🗑</button></td></tr>`).join("")
      : `<tr><td colspan="8" class="muted centro">No hay registros con esos filtros.</td></tr>`;
    if (filtrados.length > 400) $("#rg-tbody").insertAdjacentHTML("beforeend", `<tr><td colspan="8" class="muted centro">Se muestran 400 de ${filtrados.length}. Exporta el CSV para verlos todos.</td></tr>`);
    $$("[data-del]", root).forEach(b => b.onclick = async () => {
      if (await confirmar("Eliminar registro", "¿Borrar este registro de asistencia?", { peligro: true, ok: "Eliminar" })) {
        await DB.registros.eliminar(Number(b.dataset.del)); cargar(); toast("Registro eliminado");
      }
    });
  }
  const liga = (id, campo, ev = "change") => $(id).addEventListener(ev, e => { f[campo] = e.target.value; cargar(); });
  liga("#rg-desde", "desde"); liga("#rg-hasta", "hasta"); liga("#rg-grupo", "grupo"); liga("#rg-tipo", "tipo"); liga("#rg-q", "q", "input");
  $$("[data-rango]", root).forEach(b => b.onclick = () => {
    const d = new Date(); let desde = new Date(d);
    if (b.dataset.rango === "semana") desde.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (b.dataset.rango === "mes") desde.setDate(1);
    f.desde = fechaISO(desde); f.hasta = fechaISO(d);
    $("#rg-desde").value = f.desde; $("#rg-hasta").value = f.hasta; cargar();
  });
  $("#rg-csv").onclick = () => {
    const filas = [["Fecha", "Hora", "Nombre", "Matrícula", "Grupo", "Turno", "Tipo", "Retardo", "Origen"],
      ...filtrados.map(r => [r.fecha, horaSeg(r.ts), r.nombre, r.matricula, r.grupo, r.turno, r.tipo, r.retardo ? "Sí" : "No", r.origen])];
    descargar(`asistencia_${f.desde}_${f.hasta}.csv`, aCSV(filas), "text/csv;charset=utf-8");
  };
  $("#rg-faltas").onclick = async () => {
    const regs = await DB.registros.entreFechas(f.desde, f.hasta);
    const con = new Set(regs.filter(r => r.tipo === "entrada").map(r => r.alumnoId));
    const sin = Estado.alumnos.filter(a => !con.has(a.id) && (!f.grupo || a.grupo === f.grupo));
    const m = modal(`<h3>Sin entrada en el rango</h3><p class="muted">${sin.length} alumno${sin.length === 1 ? "" : "s"}${f.grupo ? ` del grupo ${esc(f.grupo)}` : ""} no registraron entrada entre ${f.desde} y ${f.hasta}.</p>
      <ul class="lista-busq alta">${sin.map(a => `<li><span class="avatar">${esc(iniciales(a.nombre))}</span><span><b>${esc(a.nombre)}</b><small>${esc(a.grupo || "")} · ${esc(a.matricula)}</small></span></li>`).join("") || "<li class='muted'>Todos registraron entrada.</li>"}</ul>
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
  const cfg = DB.config.get();
  const camaras = await Face.listarCamaras().catch(() => []);
  root.innerHTML = `
  <section class="admin">
    <div class="admin-cab"><div><h2>Configuración</h2><p class="muted">Los cambios se guardan al instante en este equipo.</p></div></div>
    <div class="cfg-grid">
      <div class="tarjeta cfg">
        <h4>Plantel y horarios</h4>
        <label>Nombre del plantel<input class="input" data-cfg="plantel" value="${esc(cfg.plantel)}"></label>
        <div class="fila">
          <label>Entrada matutino<input type="time" class="input" data-cfg="entradaMatutino" value="${cfg.entradaMatutino}"></label>
          <label>Entrada vespertino<input type="time" class="input" data-cfg="entradaVespertino" value="${cfg.entradaVespertino}"></label>
          <label>Tolerancia (min)<input type="number" min="0" max="120" class="input" data-cfg="toleranciaMin" value="${cfg.toleranciaMin}"></label>
        </div>
        <p class="muted chico">Una entrada después de la hora más la tolerancia se marca como retardo. Solo cuenta la primera entrada del día.</p>
      </div>
      <div class="tarjeta cfg">
        <h4>Reconocimiento</h4>
        <label>Sensibilidad <span class="muted" id="umbral-v">${cfg.umbral}</span>
          <input type="range" min="0.35" max="0.65" step="0.01" data-cfg="umbral" value="${cfg.umbral}"></label>
        <p class="muted chico">Menor = más estricto (puede no reconocer con mala luz). Mayor = más permisivo (riesgo de confundir personas). 0.50 funciona bien.</p>
        <div class="fila">
          <label>Confirmaciones<input type="number" min="1" max="10" class="input" data-cfg="confirmaciones" value="${cfg.confirmaciones}"></label>
          <label>Espera entre registros (s)<input type="number" min="5" max="3600" class="input" data-cfg="cooldownSeg" value="${cfg.cooldownSeg}"></label>
        </div>
        <label>Cámara<select class="input" data-cfg="camara"><option value="">Automática</option>
          ${camaras.map(c => `<option value="${esc(c.deviceId)}" ${c.deviceId === cfg.camara ? "selected" : ""}>${esc(c.label || "Cámara")}</option>`).join("")}</select></label>
        <label class="check"><input type="checkbox" data-cfg="sonido" ${cfg.sonido ? "checked" : ""}> Sonido al registrar</label>
      </div>
      <div class="tarjeta cfg">
        <h4>Seguridad</h4>
        <form id="f-pin" class="form">
          <label>Nuevo PIN de administrador<input class="input" type="password" inputmode="numeric" minlength="4" maxlength="8" id="pin-1" placeholder="4 a 8 dígitos" required></label>
          <label>Repetir PIN<input class="input" type="password" inputmode="numeric" id="pin-2" required></label>
          <div class="acciones"><button class="btn">Cambiar PIN</button></div>
        </form>
      </div>
      <div class="tarjeta cfg">
        <h4>Respaldo y datos</h4>
        <p class="muted chico">Todo se guarda en este navegador. Haz un respaldo seguido y guárdalo en un lugar seguro: contiene datos personales y biométricos de los alumnos.</p>
        <div class="acciones izq">
          <button class="btn" id="bk-exportar">Descargar respaldo</button>
          <label class="btn ghost">Restaurar respaldo<input type="file" accept="application/json" id="bk-importar" hidden></label>
        </div>
        <hr>
        <div class="acciones izq">
          <button class="btn ghost peligro" id="bk-regs">Borrar todos los registros</button>
          <button class="btn peligro" id="bk-todo">Borrar todo</button>
        </div>
      </div>
      <div class="tarjeta cfg info">
        <h4>Acerca del sistema</h4>
        <p class="muted chico">El reconocimiento corre por completo en este equipo: ni las fotos ni los rostros se envían a ningún servidor. Para usar la cámara el sitio debe abrirse con HTTPS (o en localhost).</p>
        <p class="muted chico">Alumnos: <b>${Estado.alumnos.length}</b> · Modelos: ${Face.listos ? "cargados" : "se cargan al abrir el kiosco"}</p>
      </div>
    </div>
  </section>`;

  $$("[data-cfg]", root).forEach(el => {
    const ev = el.type === "range" ? "input" : "change";
    el.addEventListener(ev, () => {
      let v = el.type === "checkbox" ? el.checked : el.value;
      if (el.type === "number" || el.type === "range") v = Number(v);
      if (el.dataset.cfg === "plantel" && !String(v).trim()) return;
      Estado.cfg = DB.config.set({ [el.dataset.cfg]: v });
      if (el.dataset.cfg === "umbral") $("#umbral-v").textContent = v.toFixed(2);
      if (el.dataset.cfg === "plantel") pintarCabecera();
      if (ev === "change") toast("Guardado");
    });
  });
  $("#f-pin").onsubmit = async e => {
    e.preventDefault();
    const p1 = $("#pin-1").value, p2 = $("#pin-2").value;
    if (!/^\d{4,8}$/.test(p1)) return toast("El PIN debe tener de 4 a 8 dígitos", "mal");
    if (p1 !== p2) return toast("Los PIN no coinciden", "mal");
    Estado.cfg = DB.config.set({ pinHash: await Pin.hash(p1) });
    e.target.reset(); toast("PIN actualizado");
  };
  $("#bk-exportar").onclick = async () => {
    const datos = await DB.exportar();
    descargar(`respaldo_asistencia_${fechaISO()}.json`, JSON.stringify(datos), "application/json");
    toast("Respaldo descargado");
  };
  $("#bk-importar").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const datos = JSON.parse(await f.text());
      const reemplazar = await confirmar("Restaurar respaldo",
        `El archivo tiene <b>${datos.alumnos?.length ?? 0}</b> alumnos y <b>${datos.registros?.length ?? 0}</b> registros.<br><br>¿Quieres <b>reemplazar</b> los datos actuales? Si cancelas, se agregan encima de lo que ya hay.`,
        { ok: "Reemplazar todo", peligro: true });
      const r = await DB.importar(datos, { reemplazar });
      Estado.cfg = DB.config.get();
      toast(`Restaurado: ${r.alumnos} alumnos, ${r.registros} registros`);
      await recargarAlumnos(); vistaConfig(root);
    } catch (err) { toast("No se pudo leer el respaldo: " + err.message, "mal"); }
    e.target.value = "";
  };
  $("#bk-regs").onclick = async () => {
    if (await confirmar("Borrar registros", "Se eliminarán <b>todos</b> los registros de entrada y salida. Los alumnos se conservan.", { peligro: true, ok: "Borrar registros" })) {
      await DB.registros.limpiar(); toast("Registros borrados");
    }
  };
  $("#bk-todo").onclick = async () => {
    if (await confirmar("Borrar todo", "Se eliminarán alumnos, rostros y registros. Descarga un respaldo antes si lo necesitas.", { peligro: true, ok: "Borrar todo" })) {
      await DB.borrarTodo(); await recargarAlumnos(); toast("Datos eliminados"); vistaConfig(root);
    }
  };
}

/* ---------- Enrutador ---------- */
const VISTAS = { kiosco: vistaKiosco, alumnos: vistaAlumnos, registros: vistaRegistros, config: vistaConfig };
const PROTEGIDAS = new Set(["alumnos", "registros", "config"]);

async function navegar() {
  const nombre = (location.hash || "#kiosco").slice(1);
  const vista = VISTAS[nombre] ? nombre : "kiosco";
  if (PROTEGIDAS.has(vista) && !Pin.desbloqueado()) {
    const ok = await Pin.pedir();
    if (!ok) { if (location.hash !== "#kiosco") location.hash = "#kiosco"; return; }
    pintarCabecera();
  }
  if (Estado.limpiarVista) { Estado.limpiarVista(); Estado.limpiarVista = null; }
  Estado.vista = vista;
  marcarNav();
  document.body.classList.remove("kiosco-full");
  const root = $("#vista");
  root.className = "vista entra";
  root.innerHTML = `<div class="cargando"><div class="anillo"></div></div>`;
  try { await VISTAS[vista](root); }
  catch (e) { console.error(e); root.innerHTML = `<div class="vacio-grande"><p>Ocurrió un error: ${esc(e.message || e)}</p></div>`; }
}

window.addEventListener("hashchange", navegar);
window.addEventListener("DOMContentLoaded", async () => {
  aplicarTema();
  await Pin.asegurar();
  await recargarAlumnos();
  pintarCabecera();
  reloj(); setInterval(reloj, 1000);
  if (typeof faceapi === "undefined") {
    $("#vista").innerHTML = `<div class="vacio-grande"><p>No se pudo cargar la librería de reconocimiento (vendor/face-api.js).</p></div>`;
    return;
  }
  navegar();
});
