/* ==========================================================================
   Capa de datos sobre Supabase.

   La app solo habla con este objeto (y con APIDemo, que imita la misma
   interfaz sin servidor). Supabase Auth maneja las cuentas; las políticas RLS
   de supabase/schema.sql deciden qué puede hacer cada rol:
     admin   todo
     kiosco  leer alumnos y configuración, agregar registros

   El esquema de la base está en inglés (students, attendance_records,
   settings, profiles) y la app trabaja en español (alumnos, registros, ...).
   Las funciones aApp / aDB de cada sección traducen nombres y valores.
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
    if (/duplicate key.*student_number/i.test(m)) return "Esa matrícula ya está registrada.";
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

  /* ---------- Diccionarios de valores ---------- */
  const ROL_APP = { admin: "admin", kiosk: "kiosco", pending: "pendiente" };
  const ROL_DB = { admin: "admin", kiosco: "kiosk", pendiente: "pending" };
  const TURNO_APP = { morning: "Matutino", afternoon: "Vespertino" };
  const TURNO_DB = { Matutino: "morning", Vespertino: "afternoon" };
  const TIPO_APP = { entry: "entrada", exit: "salida" };
  const TIPO_DB = { entrada: "entry", salida: "exit" };
  const ORIGEN_APP = { face: "facial", manual: "manual" };
  const ORIGEN_DB = { facial: "face", manual: "manual" };

  /* ---------- Cuentas ---------- */
  const auth = {
    async sesion() { const { data } = await sb.auth.getSession(); return data.session; },
    async entrar(correo, clave) {
      const d = falla(await sb.auth.signInWithPassword({ email: correo.trim(), password: clave }));
      return d.session;
    },
    async salir() { perfil = null; cfgCache = null; await sb.auth.signOut(); },
    async hayAdmin() { return !!falla(await sb.rpc("has_admin")); },
    /* Solo se ofrece cuando no existe ningún administrador: el disparador de la
       base le da el rol admin a la primera cuenta. */
    async crearPrimerAdmin(correo, clave) {
      const d = falla(await sb.auth.signUp({ email: correo.trim(), password: clave }));
      if (!d.session) throw new Error("La cuenta se creó, pero Supabase pide confirmar el correo. Desactiva «Confirm email» en Authentication → Providers → Email y vuelve a entrar.");
      return d.session;
    },
    onCambio(cb) { sb.auth.onAuthStateChange((evento, sesion) => cb(evento, sesion)); },
  };

  const perfilApp = p => ({ id: p.id, correo: p.email, rol: ROL_APP[p.role] || "pendiente", creado: p.created_at });
  async function miPerfil() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return (perfil = null);
    const p = falla(await sb.from("profiles").select("id, email, role, created_at").eq("id", session.user.id).maybeSingle());
    perfil = p ? perfilApp(p) : { id: session.user.id, correo: session.user.email, rol: "pendiente" };
    perfil.correo = perfil.correo || session.user.email;
    return perfil;
  }

  /* ---------- Alumnos (students) ---------- */
  const COLS = "id, student_number, full_name, group_name, semester, shift, descriptors, active, created_at, updated_at";
  const alumnoApp = s => s && ({
    id: s.id, matricula: s.student_number, nombre: s.full_name, grupo: s.group_name, semestre: s.semester,
    turno: TURNO_APP[s.shift] || "Matutino", foto: s.photo, descriptores: s.descriptors, activo: s.active,
    creado: s.created_at, actualizado: s.updated_at,
  });
  /* Solo manda los campos presentes: así una actualización no pisa foto o rostro. */
  const alumnoDB = a => {
    const f = {};
    if (a.matricula !== undefined) f.student_number = a.matricula;
    if (a.nombre !== undefined) f.full_name = a.nombre;
    if (a.grupo !== undefined) f.group_name = a.grupo;
    if (a.semestre !== undefined) f.semester = String(a.semestre);
    if (a.turno !== undefined) f.shift = TURNO_DB[a.turno] || "morning";
    if (a.foto !== undefined) f.photo = a.foto;
    if (a.descriptores !== undefined) f.descriptors = a.descriptores;
    if (a.activo !== undefined) f.active = a.activo;
    return f;
  };
  const alumnos = {
    /* Sin foto por defecto: el kiosco carga a todos y la foto se pide al reconocer. */
    todos: async ({ conFoto = false } = {}) =>
      (await paginar(() => sb.from("students").select(conFoto ? "*" : COLS).order("full_name"))).map(alumnoApp),
    async get(id) { return alumnoApp(falla(await sb.from("students").select("*").eq("id", id).maybeSingle())); },
    async foto(id) { const d = falla(await sb.from("students").select("photo").eq("id", id).maybeSingle()); return d ? d.photo : null; },
    async porMatricula(m) { return alumnoApp(falla(await sb.from("students").select(COLS).eq("student_number", m).maybeSingle())); },
    async guardar(a) {
      const fila = alumnoDB(a);
      if (a.id) return alumnoApp(falla(await sb.from("students").update(fila).eq("id", a.id).select(COLS).single()));
      return alumnoApp(falla(await sb.from("students").insert(fila).select(COLS).single()));
    },
    async eliminar(id) { falla(await sb.from("students").delete().eq("id", id)); },
    /* Lista por CSV: crea o actualiza por matrícula sin tocar rostro ni foto. */
    async importar(lista) {
      const filas = lista.map(({ nombre, matricula, grupo, semestre, turno }) =>
        alumnoDB({ nombre, matricula, grupo, semestre: semestre || "1", turno }));
      const d = falla(await sb.from("students").upsert(filas, { onConflict: "student_number" }).select("created_at, updated_at"));
      const nuevos = d.filter(x => Math.abs(new Date(x.updated_at) - new Date(x.created_at)) < 2000).length;
      return { nuevos, actualizados: d.length - nuevos };
    },
    suscribir(cb) {
      const ch = sb.channel("students-changes")
        .on("postgres_changes", { event: "*", schema: "public", table: "students" }, () => cb())
        .subscribe();
      return () => sb.removeChannel(ch);
    },
  };

  /* ---------- Registros (attendance_records) ---------- */
  const registroApp = r => ({
    id: r.id, alumnoId: r.student_id, nombre: r.full_name, matricula: r.student_number, grupo: r.group_name,
    turno: TURNO_APP[r.shift] || r.shift, tipo: TIPO_APP[r.type] || r.type, ts: new Date(r.recorded_at).getTime(),
    fecha: r.record_date, retardo: !!r.late, origen: ORIGEN_APP[r.source] || r.source, distancia: r.distance,
  });
  const registroDB = r => ({
    student_id: r.alumnoId, full_name: r.nombre, student_number: r.matricula, group_name: r.grupo,
    shift: TURNO_DB[r.turno] || null, type: TIPO_DB[r.tipo], recorded_at: new Date(r.ts).toISOString(),
    record_date: r.fecha, late: !!r.retardo, source: ORIGEN_DB[r.origen] || "face",
    distance: r.distancia == null ? null : r.distancia,
  });
  const registros = {
    async porFecha(f) {
      return (await paginar(() => sb.from("attendance_records").select("*").eq("record_date", f).order("recorded_at"))).map(registroApp);
    },
    async entreFechas(d, h) {
      return (await paginar(() => sb.from("attendance_records").select("*").gte("record_date", d).lte("record_date", h)
        .order("recorded_at", { ascending: false }))).map(registroApp);
    },
    async agregar(r) { return registroApp(falla(await sb.from("attendance_records").insert(registroDB(r)).select().single())); },
    async eliminar(id) { falla(await sb.from("attendance_records").delete().eq("id", id)); },
    suscribir(cb) {
      const ch = sb.channel("attendance-inserts")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "attendance_records" }, p => cb(registroApp(p.new)))
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

  /* ---------- Configuración (settings) ---------- */
  const CFG = {
    plantel: "school_name", entradaMatutino: "morning_entry_time", entradaVespertino: "afternoon_entry_time",
    toleranciaMin: "tolerance_minutes", umbral: "match_threshold", margen: "match_margin",
    cooldownSeg: "cooldown_seconds", confirmaciones: "confirmations", sonido: "sound_enabled",
  };
  const config = {
    async get(recargar = false) {
      if (cfgCache && !recargar) return cfgCache;
      const d = falla(await sb.from("settings").select("*").eq("id", 1).single());
      cfgCache = {};
      for (const [k, c] of Object.entries(CFG)) cfgCache[k] = d[c];
      cfgCache.entradaMatutino = String(cfgCache.entradaMatutino || "07:00").slice(0, 5);
      cfgCache.entradaVespertino = String(cfgCache.entradaVespertino || "13:30").slice(0, 5);
      return cfgCache;
    },
    async set(parcial) {
      const fila = {};
      for (const [k, v] of Object.entries(parcial)) if (CFG[k]) fila[CFG[k]] = v;
      falla(await sb.from("settings").update(fila).eq("id", 1).select("id"));
      cfgCache = { ...(cfgCache || {}), ...parcial };
      return cfgCache;
    },
  };

  /* ---------- Cuentas (profiles; solo admin) ---------- */
  const usuarios = {
    async todos() { return falla(await sb.from("profiles").select("id, email, role, created_at").order("created_at")).map(perfilApp); },
    /* Un cliente aparte sin persistencia: así el alta no pisa la sesión del administrador. */
    async crear(correo, clave, rol) {
      const aux = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey,
        { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const d = falla(await aux.auth.signUp({ email: correo.trim(), password: clave }));
      if (!d.user || (d.user.identities && d.user.identities.length === 0)) throw new Error("Ya existe una cuenta con ese correo.");
      falla(await sb.from("profiles").update({ role: ROL_DB[rol] || "pending" }).eq("id", d.user.id).select("id"));
      if (d.session) await aux.auth.signOut().catch(() => {});
      return { id: d.user.id, correo: correo.trim(), rol, confirmada: !!d.session };
    },
    async cambiarRol(id, rol) { falla(await sb.from("profiles").update({ role: ROL_DB[rol] || "pending" }).eq("id", id).select("id")); },
  };

  async function exportar() {
    const [a, r] = await Promise.all([
      alumnos.todos({ conFoto: true }),
      paginar(() => sb.from("attendance_records").select("*").order("recorded_at")),
    ]);
    return { version: 3, exportado: new Date().toISOString(), config: await config.get(), alumnos: a, registros: r.map(registroApp) };
  }

  return { nombre: "supabase", modoDemo: false, disponible, init, auth, miPerfil, get perfil() { return perfil; },
           alumnos, registros, config, usuarios, exportar };
})();
