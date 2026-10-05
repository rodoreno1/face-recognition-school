/* ==========================================================================
   Almacenamiento local del sistema de asistencia.

   Todo vive en el navegador (IndexedDB para alumnos y registros, localStorage
   para la configuración). Los descriptores faciales nunca salen del equipo:
   es un requisito de privacidad para datos biométricos de menores.

   La interfaz es pequeña a propósito (alumnos.*, registros.*, config.*) para
   que el día que el plantel quiera un servidor central se cambie solo este
   archivo por uno que hable con una API.
   ========================================================================== */

const DB = (() => {
  const NOMBRE = "cbtis-asistencia";
  const VERSION = 1;
  let conexion = null;

  function abrir() {
    if (conexion) return Promise.resolve(conexion);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NOMBRE, VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("alumnos")) {
          const a = db.createObjectStore("alumnos", { keyPath: "id" });
          a.createIndex("matricula", "matricula", { unique: true });
          a.createIndex("grupo", "grupo");
        }
        if (!db.objectStoreNames.contains("registros")) {
          const r = db.createObjectStore("registros", { keyPath: "id", autoIncrement: true });
          r.createIndex("fecha", "fecha");
          r.createIndex("alumnoId", "alumnoId");
          r.createIndex("alumnoFecha", ["alumnoId", "fecha"]);
        }
      };
      req.onsuccess = () => { conexion = req.result; resolve(conexion); };
      req.onerror = () => reject(req.error);
    });
  }

  /* Envuelve una transacción en una promesa. `fn` recibe el store y devuelve
     la petición cuyo resultado queremos. */
  async function tx(store, modo, fn) {
    const db = await abrir();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, modo);
      const s = t.objectStore(store);
      const req = fn(s);
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const todos = (store, indice, rango) => tx(store, "readonly", s =>
    indice ? s.index(indice).getAll(rango) : s.getAll());

  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  /* ---------- Alumnos ---------- */
  const alumnos = {
    todos: () => todos("alumnos"),
    get: id => tx("alumnos", "readonly", s => s.get(id)),
    porMatricula: m => tx("alumnos", "readonly", s => s.index("matricula").get(m)),
    guardar(a) {
      if (!a.id) a.id = uid();
      if (!a.creado) a.creado = Date.now();
      a.actualizado = Date.now();
      return tx("alumnos", "readwrite", s => s.put(a)).then(() => a);
    },
    eliminar: id => tx("alumnos", "readwrite", s => s.delete(id)),
    limpiar: () => tx("alumnos", "readwrite", s => s.clear()),
  };

  /* ---------- Registros de entrada / salida ---------- */
  const registros = {
    porFecha: fecha => todos("registros", "fecha", IDBKeyRange.only(fecha)),
    entreFechas: (desde, hasta) => todos("registros", "fecha", IDBKeyRange.bound(desde, hasta)),
    deAlumnoEnFecha: (alumnoId, fecha) =>
      todos("registros", "alumnoFecha", IDBKeyRange.only([alumnoId, fecha])),
    todos: () => todos("registros"),
    agregar(r) {
      return tx("registros", "readwrite", s => s.add(r)).then(id => ({ ...r, id }));
    },
    eliminar: id => tx("registros", "readwrite", s => s.delete(id)),
    eliminarDeAlumno: async alumnoId => {
      const lista = await todos("registros", "alumnoId", IDBKeyRange.only(alumnoId));
      await tx("registros", "readwrite", s => { lista.forEach(r => s.delete(r.id)); });
    },
    limpiar: () => tx("registros", "readwrite", s => s.clear()),
    importar: lista => tx("registros", "readwrite", s => { lista.forEach(r => s.put(r)); }),
  };

  /* ---------- Configuración ---------- */
  const CONFIG_KEY = "cbtis-asistencia:config";
  const CONFIG_DEFAULT = {
    plantel: "CBTis",
    entradaMatutino: "07:00",
    entradaVespertino: "13:30",
    toleranciaMin: 10,
    umbral: 0.5,          // distancia euclidiana máxima para aceptar una coincidencia
    cooldownSeg: 60,      // segundos antes de volver a registrar a la misma persona
    confirmaciones: 3,    // cuadros seguidos con la misma identidad antes de registrar
    sonido: true,
    tema: "oscuro",
    camara: "",
    pinHash: "",
  };
  const config = {
    get() {
      try { return { ...CONFIG_DEFAULT, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") }; }
      catch { return { ...CONFIG_DEFAULT }; }
    },
    set(parcial) {
      const nuevo = { ...config.get(), ...parcial };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(nuevo));
      return nuevo;
    },
    reset() { localStorage.removeItem(CONFIG_KEY); },
  };

  /* ---------- Respaldo completo ---------- */
  async function exportar() {
    const [a, r] = await Promise.all([alumnos.todos(), registros.todos()]);
    const { pinHash, ...cfg } = config.get();
    return { version: 1, exportado: new Date().toISOString(), config: cfg, alumnos: a, registros: r };
  }
  async function importar(datos, { reemplazar = false } = {}) {
    if (!datos || !Array.isArray(datos.alumnos)) throw new Error("El archivo no tiene el formato esperado.");
    if (reemplazar) { await alumnos.limpiar(); await registros.limpiar(); }
    for (const a of datos.alumnos) await tx("alumnos", "readwrite", s => s.put(a));
    if (Array.isArray(datos.registros)) {
      const sinId = datos.registros.map(({ id, ...r }) => r);
      await tx("registros", "readwrite", s => { sinId.forEach(r => s.add(r)); });
    }
    if (datos.config) config.set(datos.config);
    return { alumnos: datos.alumnos.length, registros: (datos.registros || []).length };
  }
  async function borrarTodo() {
    await alumnos.limpiar();
    await registros.limpiar();
  }

  return { alumnos, registros, config, exportar, importar, borrarTodo, uid };
})();
