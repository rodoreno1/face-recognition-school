/* ==========================================================================
   Modo demostración: la misma interfaz que APISupabase, pero todo vive en
   localStorage de este navegador. Se usa cuando js/config.js no tiene los
   datos de Supabase, para poder ver y probar la app sin servidor.

   Cuentas de prueba: admin@demo (administrador) y caseta@demo (kiosco),
   contraseña demo1234.
   ========================================================================== */

const APIDemo = (() => {
  const K = "cbtis-demo:";
  const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(K + k)) ?? def; } catch { return def; } };
  const guardar = (k, v) => localStorage.setItem(K + k, JSON.stringify(v));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const espera = (ms = 120) => new Promise(r => setTimeout(r, ms));
  const oyentes = { registros: new Set(), alumnos: new Set() };
  const avisar = (tema, dato) => oyentes[tema].forEach(cb => { try { cb(dato); } catch (e) { console.error(e); } });

  const CUENTAS = [
    { id: "demo-admin", correo: "admin@demo", rol: "admin", creado: "2026-01-01T00:00:00Z" },
    { id: "demo-kiosco", correo: "caseta@demo", rol: "kiosco", creado: "2026-01-01T00:00:00Z" },
  ];
  const cuentas = () => leer("cuentas", CUENTAS);
  let perfil = leer("sesion", null);
  const cambios = [];

  const auth = {
    async sesion() { return perfil ? { user: { id: perfil.id, email: perfil.correo } } : null; },
    async entrar(correo, clave) {
      await espera(300);
      const c = cuentas().find(x => x.correo === correo.trim().toLowerCase());
      if (!c || clave !== (c.clave || "demo1234")) throw new Error("Correo o contraseña incorrectos. En modo demo: admin@demo o caseta@demo con demo1234.");
      perfil = { id: c.id, correo: c.correo, rol: c.rol };
      guardar("sesion", perfil);
      cambios.forEach(cb => cb("SIGNED_IN", { user: { id: c.id } }));
      return { user: { id: c.id, email: c.correo } };
    },
    async salir() { perfil = null; localStorage.removeItem(K + "sesion"); cambios.forEach(cb => cb("SIGNED_OUT", null)); },
    async hayAdmin() { return true; },
    async crearPrimerAdmin() { throw new Error("No disponible en modo demostración."); },
    onCambio(cb) { cambios.push(cb); },
  };
  const miPerfil = async () => perfil;

  const alumnosLS = () => leer("alumnos", []);
  const alumnos = {
    async todos() { return alumnosLS().sort((a, b) => a.nombre.localeCompare(b.nombre, "es")); },
    async get(id) { return alumnosLS().find(a => a.id === id) || null; },
    async foto(id) { const a = alumnosLS().find(x => x.id === id); return a ? a.foto : null; },
    async porMatricula(m) { return alumnosLS().find(a => a.matricula === m) || null; },
    async guardar(a) {
      const lista = alumnosLS();
      const dup = lista.find(x => x.matricula === a.matricula && x.id !== a.id);
      if (dup) throw new Error("Esa matrícula ya está registrada.");
      const i = lista.findIndex(x => x.id === a.id);
      const ahora = new Date().toISOString();
      const nuevo = { ...(i >= 0 ? lista[i] : { id: uid(), creado: ahora }), ...a, actualizado: ahora };
      if (!nuevo.id) nuevo.id = uid();
      if (i >= 0) lista[i] = nuevo; else lista.push(nuevo);
      guardar("alumnos", lista); avisar("alumnos");
      return nuevo;
    },
    async eliminar(id) {
      guardar("alumnos", alumnosLS().filter(a => a.id !== id));
      guardar("registros", registrosLS().filter(r => r.alumnoId !== id));
      avisar("alumnos");
    },
    async importar(lista) {
      let nuevos = 0, actualizados = 0;
      for (const f of lista) {
        const base = await alumnos.porMatricula(f.matricula);
        await alumnos.guardar({ ...(base || { descriptores: [], foto: "", activo: true }), ...f });
        base ? actualizados++ : nuevos++;
      }
      return { nuevos, actualizados };
    },
    suscribir(cb) { oyentes.alumnos.add(cb); return () => oyentes.alumnos.delete(cb); },
  };

  const registrosLS = () => leer("registros", []);
  const registros = {
    async porFecha(f) { return registrosLS().filter(r => r.fecha === f).sort((a, b) => a.ts - b.ts); },
    async entreFechas(d, h) { return registrosLS().filter(r => r.fecha >= d && r.fecha <= h).sort((a, b) => b.ts - a.ts); },
    async agregar(r) {
      const lista = registrosLS();
      const nuevo = { ...r, id: (lista.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1 };
      lista.push(nuevo); guardar("registros", lista);
      setTimeout(() => avisar("registros", nuevo), 0);
      return nuevo;
    },
    async eliminar(id) { guardar("registros", registrosLS().filter(r => r.id !== id)); },
    suscribir(cb) { oyentes.registros.add(cb); return () => oyentes.registros.delete(cb); },
    pendientes: () => 0,
    vaciarCola: async () => 0,
  };
  registros.agregarConCola = registros.agregar;

  const CFG_DEFAULT = {
    plantel: "CBTis 002",
    umbral: 0.5, margen: 0.06, cooldownSeg: 60, confirmaciones: 3, sonido: true,
  };
  const config = {
    async get() { return { ...CFG_DEFAULT, ...leer("config", {}) }; },
    async set(parcial) { const n = { ...(await config.get()), ...parcial }; guardar("config", n); return n; },
  };

  const usuarios = {
    async todos() { return cuentas().map(({ clave, ...c }) => c); },
    async crear(correo, clave, rol) {
      correo = correo.trim().toLowerCase();
      const lista = cuentas();
      if (lista.some(c => c.correo === correo)) throw new Error("Ya existe una cuenta con ese correo.");
      const c = { id: uid(), correo, rol, clave, creado: new Date().toISOString() };
      lista.push(c); guardar("cuentas", lista);
      return { id: c.id, correo, rol, confirmada: true };
    },
    async cambiarRol(id, rol) {
      guardar("cuentas", cuentas().map(c => c.id === id ? { ...c, rol } : c));
    },
  };

  async function exportar() {
    return { version: 3, exportado: new Date().toISOString(), config: await config.get(), alumnos: alumnosLS(), registros: registrosLS() };
  }

  return { nombre: "demo", modoDemo: true, disponible: () => true, init() {}, auth, miPerfil, get perfil() { return perfil; },
           alumnos, registros, config, usuarios, exportar };
})();
