/* ==========================================================================
   Capa de datos sobre Supabase.

   La app solo habla con este objeto (y con APIDemo, que imita la misma
   interfaz sin servidor). Supabase Auth maneja las cuentas; las políticas RLS
   de supabase/schema.sql deciden qué puede hacer cada rol:
     admin   todo
     kiosco  leer alumnos y configuración, agregar registros

   Los nombres de columna van en snake_case en la base y en camelCase en la
   app; las funciones aApp/aDB traducen.
   ========================================================================== */

const APISupabase = (() => {
  const cfg = window.APP_CONFIG || {};
  let sb = null, perfil = null, cfgCache = null;

  const disponible = () => !!(cfg.supabaseUrl && cfg.supabaseAnonKey && typeof supabase !== "undefined");

  function init() {
    sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey,
      { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  }

  /* Supabase devuelve { data, error }; aquí se vuelve una excepción en español. */
  function traducir(e) {
    const m = (e && e.message) || String(e);
    if (/Invalid login credentials/i.test(m)) return "Correo o contraseña incorrectos.";
    if (/Email not confirmed/i.test(m)) return "La cuenta no está confirmada. En Supabase desactiva «Confirm email» (Authentication → Providers → Email) o confirma el correo.";
    if (/Signups not allowed|signup is disabled/i.test(m)) return "El alta de cuentas está desactivada en Supabase (Authentication → Sign In / Up → Allow new users to sign up).";
    if (/already registered|already exists|already been registered/i.test(m)) return "Ya existe una cuenta con ese correo.";
    if (/Password should be/i.test(m)) return "La contraseña no cumple el mínimo que pide Supabase (6 caracteres).";
    if (/rate limit/i.test(m)) return "Demasiadas peticiones seguidas. Espera un minuto.";
    if (/duplicate key.*matricula/i.test(m)) return "Esa matrícula ya está registrada.";
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return "Sin conexión con la base de datos.";
    if (/row-level security/i.test(m)) return "Tu cuenta no tiene permiso para hacer esto.";
    if (/relation .* does not exist|schema cache/i.test(m)) return "Faltan las tablas: ejecuta supabase/schema.sql en el SQL Editor de Supabase.";
    return m;
  }
  const falla = r => { if (r.error) throw new Error(traducir(r.error)); return r.data; };
  const esRed = e => /Sin conexión/.test(e.message || "");

  /* PostgREST entrega 1000 renglones por página; `q` debe devolver una consulta nueva cada vez. */
  async function paginar(q) {
    const out = [];
    for (let desde = 0; ; desde += 1000) {
      const d = falla(await q().range(desde, desde + 999));
      out.push(...d);
      if (d.length < 1000) break;
    }
    return out;
  }

  /* ---------- Cuentas ---------- */
  const auth = {
    async sesion() { const { data } = await sb.auth.getSession(); return data.session; },
    async entrar(correo, clave) {
      const d = falla(await sb.auth.signInWithPassword({ email: correo.trim(), password: clave }));
      return d.session;
    },
    async salir() { perfil = null; cfgCache = null; await sb.auth.signOut(); },
    async hayAdmin() { return !!falla(await sb.rpc("hay_admin")); },
    /* Solo se ofrece cuando no existe ningún administrador: el disparador de la
       base le da el rol admin a la primera cuenta. */
    async crearPrimerAdmin(correo, clave) {
      const d = falla(await sb.auth.signUp({ email: correo.trim(), password: clave }));
      if (!d.session) throw new Error("La cuenta se creó, pero Supabase pide confirmar el correo. Desactiva «Confirm email» en Authentication → Providers → Email y vuelve a entrar.");
      return d.session;
    },
    onCambio(cb) { sb.auth.onAuthStateChange((evento, sesion) => cb(evento, sesion)); },
  };

  async function miPerfil() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return (perfil = null);
    const p = falla(await sb.from("perfiles").select("id, correo, rol").eq("id", session.user.id).maybeSingle());
    perfil = { id: session.user.id, correo: session.user.email, rol: "pendiente", ...(p || {}) };
    perfil.correo = perfil.correo || session.user.email;
    return perfil;
  }

  /* ---------- Alumnos ---------- */
  const COLS = "id, matricula, nombre, grupo, semestre, turno, descriptores, activo, creado, actualizado";
  const limpiarAlumno = a => {
    const f = {};
    for (const k of ["matricula", "nombre", "grupo", "semestre", "turno", "foto", "descriptores", "activo"]) {
      if (a[k] !== undefined) f[k] = a[k];
    }
    if (f.semestre !== undefined) f.semestre = String(f.semestre);
    return f;
  };
  const alumnos = {
    /* Sin foto por defecto: el kiosco carga a todos y la foto se pide al reconocer. */
    todos: ({ conFoto = false } = {}) =>
      paginar(() => sb.from("alumnos").select(conFoto ? "*" : COLS).order("nombre")),
    async get(id) { return falla(await sb.from("alumnos").select("*").eq("id", id).maybeSingle()); },
    async foto(id) { const d = falla(await sb.from("alumnos").select("foto").eq("id", id).maybeSingle()); return d ? d.foto : null; },
    async porMatricula(m) { return falla(await sb.from("alumnos").select(COLS).eq("matricula", m).maybeSingle()); },
    async guardar(a) {
      const fila = limpiarAlumno(a);
      if (a.id) return falla(await sb.from("alumnos").update(fila).eq("id", a.id).select(COLS).single());
      return falla(await sb.from("alumnos").insert(fila).select(COLS).single());
    },
    async eliminar(id) { falla(await sb.from("alumnos").delete().eq("id", id)); },
    /* Lista por CSV: crea o actualiza por matrícula sin tocar rostro ni foto. */
    async importar(lista) {
      const filas = lista.map(({ nombre, matricula, grupo, semestre, turno }) => ({ nombre, matricula, grupo, semestre: String(semestre || "1"), turno }));
      const d = falla(await sb.from("alumnos").upsert(filas, { onConflict: "matricula" }).select("creado, actualizado"));
      const nuevos = d.filter(x => Math.abs(new Date(x.actualizado) - new Date(x.creado)) < 2000).length;
      return { nuevos, actualizados: d.length - nuevos };
    },
    suscribir(cb) {
      const ch = sb.channel("alumnos-cambios")
        .on("postgres_changes", { event: "*", schema: "public", table: "alumnos" }, () => cb())
        .subscribe();
      return () => sb.removeChannel(ch);
    },
  };

  /* ---------- Registros ---------- */
  const aApp = r => ({ ...r, alumnoId: r.alumno_id, ts: new Date(r.ts).getTime() });
  const aDB = r => ({
    alumno_id: r.alumnoId, nombre: r.nombre, matricula: r.matricula, grupo: r.grupo, turno: r.turno,
    tipo: r.tipo, ts: new Date(r.ts).toISOString(), fecha: r.fecha, retardo: !!r.retardo,
    origen: r.origen, distancia: r.distancia == null ? null : r.distancia,
  });
  const registros = {
    async porFecha(f) { return (await paginar(() => sb.from("registros").select("*").eq("fecha", f).order("ts"))).map(aApp); },
    async entreFechas(d, h) {
      return (await paginar(() => sb.from("registros").select("*").gte("fecha", d).lte("fecha", h).order("ts", { ascending: false }))).map(aApp);
    },
    async agregar(r) { return aApp(falla(await sb.from("registros").insert(aDB(r)).select().single())); },
    async eliminar(id) { falla(await sb.from("registros").delete().eq("id", id)); },
    suscribir(cb) {
      const ch = sb.channel("registros-nuevos")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "registros" }, p => cb(aApp(p.new)))
        .subscribe();
      return () => sb.removeChannel(ch);
    },
  };

  /* Si la caseta pierde internet, los registros esperan en este navegador y
     se mandan al reconectar. */
  const COLA = "cbtis:registros-pendientes";
  const cola = {
    leer: () => { try { return JSON.parse(localStorage.getItem(COLA) || "[]"); } catch { return []; } },
    guardar: l => localStorage.setItem(COLA, JSON.stringify(l)),
  };
  registros.agregarConCola = async r => {
    try { return await registros.agregar(r); }
    catch (e) {
      if (!esRed(e)) throw e;
      const l = cola.leer(); l.push(r); cola.guardar(l);
      return { ...r, id: null, pendiente: true };
    }
  };
  registros.pendientes = () => cola.leer().length;
  registros.vaciarCola = async () => {
    let enviados = 0;
    while (true) {
      const l = cola.leer();
      if (!l.length) break;
      try { await registros.agregar(l[0]); enviados++; }
      catch (e) { if (esRed(e)) break; }
      cola.guardar(cola.leer().slice(1));
    }
    return enviados;
  };
  window.addEventListener("online", () => { if (sb) registros.vaciarCola().catch(() => {}); });

  /* ---------- Configuración ---------- */
  const CFG = {
    plantel: "plantel", entradaMatutino: "entrada_matutino", entradaVespertino: "entrada_vespertino",
    toleranciaMin: "tolerancia_min", umbral: "umbral", margen: "margen", cooldownSeg: "cooldown_seg",
    confirmaciones: "confirmaciones", sonido: "sonido",
  };
  const config = {
    async get(recargar = false) {
      if (cfgCache && !recargar) return cfgCache;
      const d = falla(await sb.from("config").select("*").eq("id", 1).single());
      cfgCache = {};
      for (const [k, c] of Object.entries(CFG)) cfgCache[k] = d[c];
      cfgCache.entradaMatutino = String(cfgCache.entradaMatutino || "07:00").slice(0, 5);
      cfgCache.entradaVespertino = String(cfgCache.entradaVespertino || "13:30").slice(0, 5);
      return cfgCache;
    },
    async set(parcial) {
      const fila = {};
      for (const [k, v] of Object.entries(parcial)) if (CFG[k]) fila[CFG[k]] = v;
      falla(await sb.from("config").update(fila).eq("id", 1).select("id"));
      cfgCache = { ...(cfgCache || {}), ...parcial };
      return cfgCache;
    },
  };

  /* ---------- Cuentas (solo admin) ---------- */
  const usuarios = {
    async todos() { return falla(await sb.from("perfiles").select("id, correo, rol, creado").order("creado")); },
    /* Un cliente aparte sin persistencia: así el alta no pisa la sesión del administrador. */
    async crear(correo, clave, rol) {
      const aux = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey,
        { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const d = falla(await aux.auth.signUp({ email: correo.trim(), password: clave }));
      if (!d.user || (d.user.identities && d.user.identities.length === 0)) throw new Error("Ya existe una cuenta con ese correo.");
      falla(await sb.from("perfiles").update({ rol }).eq("id", d.user.id).select("id"));
      if (d.session) await aux.auth.signOut().catch(() => {});
      return { id: d.user.id, correo: correo.trim(), rol, confirmada: !!d.session };
    },
    async cambiarRol(id, rol) { falla(await sb.from("perfiles").update({ rol }).eq("id", id).select("id")); },
  };

  async function exportar() {
    const [a, r] = await Promise.all([alumnos.todos({ conFoto: true }), paginar(() => sb.from("registros").select("*").order("ts"))]);
    return { version: 3, exportado: new Date().toISOString(), config: await config.get(), alumnos: a, registros: r.map(aApp) };
  }

  return { nombre: "supabase", modoDemo: false, disponible, init, auth, miPerfil, get perfil() { return perfil; },
           alumnos, registros, config, usuarios, exportar };
})();
