/* ==========================================================================
   Reconocimiento facial: cámara, modelos, calidad de la toma y comparación.

   Encima de face-api (vendor/face-api.js, MIT). Los modelos se sirven desde
   /models para no depender de ningún CDN.

   Qué mejora frente a usar FaceMatcher tal cual:
     * calidad(): rechaza tomas chicas, oscuras, con contraluz o movidas antes
       de guardar un rostro, así las muestras del alta son buenas.
     * pose(): estima el giro de la cabeza con los 68 puntos; el alta pide
       cinco poses distintas para que el reconocimiento aguante ángulos y luz.
     * Comparador: distancia mínima por alumno (no el promedio) y exige una
       ventaja clara sobre el segundo candidato (margen) para evitar confundir
       a dos personas parecidas.
     * promediar(): el kiosco promedia varios cuadros seguidos antes de dar por
       bueno un reconocimiento; reduce el ruido de un cuadro aislado.
   ========================================================================== */

const Face = (() => {
  const RUTA_MODELOS = "models";
  let modelosListos = false;
  let stream = null;

  const opciones = (inputSize = 416) => new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.5 });

  async function cargarModelos(onProgreso = () => {}) {
    if (modelosListos) return;
    const pasos = [
      ["Detector de rostros", () => faceapi.nets.tinyFaceDetector.loadFromUri(RUTA_MODELOS)],
      ["Puntos faciales", () => faceapi.nets.faceLandmark68Net.loadFromUri(RUTA_MODELOS)],
      ["Reconocimiento", () => faceapi.nets.faceRecognitionNet.loadFromUri(RUTA_MODELOS)],
    ];
    for (let i = 0; i < pasos.length; i++) {
      onProgreso({ paso: pasos[i][0], indice: i, total: pasos.length });
      await pasos[i][1]();
    }
    onProgreso({ paso: "Listo", indice: pasos.length, total: pasos.length });
    modelosListos = true;
  }

  async function listarCamaras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const lista = await navigator.mediaDevices.enumerateDevices();
    return lista.filter(d => d.kind === "videoinput");
  }

  /* Mensajes en español para los errores de getUserMedia. */
  function explicarErrorCamara(e) {
    const n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "El navegador tiene bloqueada la cámara. Haz clic en el candado junto a la dirección, permite la cámara y recarga.";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "No se encontró ninguna cámara conectada.";
    if (n === "NotReadableError" || n === "AbortError") return "Otra aplicación está usando la cámara (Zoom, Teams, Cámara…). Ciérrala y recarga.";
    return (e && e.message) || "No se pudo encender la cámara.";
  }

  async function iniciarCamara(video, deviceId = "") {
    detenerCamara();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(window.isSecureContext ? "Este navegador no permite usar la cámara. Usa Chrome, Edge o Safari actualizados." : "La cámara solo funciona con HTTPS (o en localhost). Abre la dirección que empieza con https://");
    }
    const videoCfg = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" };
    if (deviceId) { videoCfg.deviceId = { exact: deviceId }; delete videoCfg.facingMode; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoCfg, audio: false });
    } catch (e) {
      if (!deviceId) throw new Error(explicarErrorCamara(e));
      // La cámara guardada ya no está conectada: usa la que haya.
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false }); }
      catch (e2) { throw new Error(explicarErrorCamara(e2)); }
    }
    video.srcObject = stream;
    await new Promise(res => {
      if (video.readyState >= 2) return res();
      video.onloadedmetadata = () => res();
    });
    await video.play();
    return stream;
  }

  function detenerCamara() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }

  /* Todos los rostros con puntos y descriptor. [] si el video aún no tiene cuadros. */
  async function detectar(fuente, { inputSize = 416 } = {}) {
    if (!modelosListos) return [];
    if (fuente instanceof HTMLVideoElement && (fuente.paused || fuente.ended || !fuente.videoWidth)) return [];
    return faceapi.detectAllFaces(fuente, opciones(inputSize)).withFaceLandmarks().withFaceDescriptors();
  }

  const tam = f => ({ w: f.videoWidth || f.naturalWidth || f.width, h: f.videoHeight || f.naturalHeight || f.height });

  /* ---------- Calidad de la toma ---------- */
  const lienzo = document.createElement("canvas");
  lienzo.width = lienzo.height = 64;
  function analizar(fuente, box) {
    const ctx = lienzo.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(fuente, box.x, box.y, box.width, box.height, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    const g = new Float32Array(4096);
    let suma = 0;
    for (let i = 0; i < 4096; i++) { g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; suma += g[i]; }
    // Varianza del laplaciano: baja cuando la imagen está movida o desenfocada.
    let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < 63; y++) for (let x = 1; x < 63; x++) {
      const i = y * 64 + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - 64] - g[i + 64];
      s += l; s2 += l * l; n++;
    }
    return { brillo: suma / 4096, nitidez: s2 / n - (s / n) ** 2 };
  }

  /* "" si la toma sirve; si no, qué debe corregir la persona. */
  function calidad(fuente, r) {
    const { x, y, width, height } = r.detection.box;
    const { w, h } = tam(fuente);
    if (Math.min(width, height) < Math.max(80, w * 0.14)) return "Acércate un poco más";
    if (x < w * 0.02 || y < h * 0.02 || x + width > w * 0.98 || y + height > h * 0.98) return "Centra tu rostro en el óvalo";
    if (r.detection.score < 0.7) return "Busca mejor luz";
    const { brillo, nitidez } = analizar(fuente, r.detection.box);
    if (brillo < 55) return "Muy oscuro: busca más luz";
    if (brillo > 215) return "Demasiada luz: evita el contraluz";
    if (nitidez < 25) return "Imagen movida: quédate quieto";
    return "";
  }

  /* Para el alta: exactamente un rostro y de buena calidad. */
  async function detectarUno(fuente, { inputSize = 416 } = {}) {
    const todos = await detectar(fuente, { inputSize });
    if (todos.length === 0) return { error: "No se ve ningún rostro" };
    if (todos.length > 1) return { error: "Debe aparecer solo una persona" };
    const r = todos[0];
    const error = calidad(fuente, r);
    if (error) return { error };
    return { resultado: r, pose: pose(r.landmarks) };
  }

  /* ---------- Pose a partir de los 68 puntos ----------
     yaw   giro izquierda/derecha: 0 de frente, |0.25| ya es un giro claro
     pitch posición vertical de la nariz; se compara contra la pose de frente
     roll  inclinación lateral en radianes */
  const centro = pts => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });
  function pose(landmarks) {
    const p = landmarks.positions;
    const ojoI = centro(p.slice(36, 42)), ojoD = centro(p.slice(42, 48));
    const nariz = p[30], barbilla = p[8];
    const medio = { x: (ojoI.x + ojoD.x) / 2, y: (ojoI.y + ojoD.y) / 2 };
    const anchoOjos = Math.hypot(ojoD.x - ojoI.x, ojoD.y - ojoI.y) || 1;
    const alto = Math.hypot(barbilla.x - medio.x, barbilla.y - medio.y) || 1;
    return {
      yaw: (nariz.x - medio.x) / anchoOjos,
      pitch: (nariz.y - medio.y) / alto,
      roll: Math.atan2(ojoD.y - ojoI.y, ojoD.x - ojoI.x),
    };
  }

  /* Recorta el rostro a un JPEG cuadrado pequeño para la credencial. */
  function recortarRostro(fuente, deteccion, lado = 192) {
    const box = deteccion.detection.box;
    const { w, h } = tam(fuente);
    const margen = box.width * 0.4;
    const x = Math.max(0, box.x - margen), y = Math.max(0, box.y - margen * 1.4);
    const ancho = Math.min(w - x, box.width + margen * 2), alto = Math.min(h - y, box.height + margen * 2.4);
    const l = Math.max(ancho, alto);
    const c = document.createElement("canvas");
    c.width = c.height = lado;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#0d2d4d";
    ctx.fillRect(0, 0, lado, lado);
    ctx.drawImage(fuente, x - (l - ancho) / 2, y - (l - alto) / 2, l, l, 0, 0, lado, lado);
    return c.toDataURL("image/jpeg", 0.84);
  }

  /* ---------- Comparación ---------- */
  function distancia(a, b) {
    let s = 0;
    for (let i = 0; i < 128; i++) { const t = a[i] - b[i]; s += t * t; }
    return Math.sqrt(s);
  }
  function promediar(descs) {
    const out = new Float32Array(128);
    for (const d of descs) for (let i = 0; i < 128; i++) out[i] += d[i];
    for (let i = 0; i < 128; i++) out[i] /= descs.length;
    return out;
  }

  /* umbral: distancia máxima para aceptar. margen: ventaja mínima que el mejor
     candidato debe sacarle al segundo; si dos alumnos quedan muy cerca no se
     registra a ninguno (confiable = false). */
  function Comparador(alumnos, umbral = 0.5, margen = 0.06) {
    const muestras = [];
    const porId = {};
    for (const a of alumnos) {
      if (a.activo === false || !Array.isArray(a.descriptores)) continue;
      porId[a.id] = a;
      for (const d of a.descriptores) if (d && d.length === 128) muestras.push({ id: a.id, d: Float32Array.from(d) });
    }
    function identificar(descriptor) {
      const mejor = {};
      for (const m of muestras) {
        const d = distancia(descriptor, m.d);
        if (!(m.id in mejor) || d < mejor[m.id]) mejor[m.id] = d;
      }
      const orden = Object.entries(mejor).sort((a, b) => a[1] - b[1]);
      if (!orden.length) return { alumno: null, candidato: null, distancia: 1, ventaja: 1, confiable: false };
      const [id, d] = orden[0];
      const segundo = orden[1] ? orden[1][1] : 1;
      const dentro = d <= umbral;
      return { alumno: dentro ? porId[id] : null, candidato: porId[id], distancia: d, ventaja: segundo - d, confiable: dentro && segundo - d >= margen };
    }
    return { vacio: !muestras.length, muestras: muestras.length, identificar };
  }

  /* ---------- Dibujo sobre el video ----------
     etiquetas[i] = { texto, color, progreso (0..1) }. El video está espejeado
     por CSS y el canvas también, así que las X no se invierten; solo el texto
     se vuelve a espejear para que se lea. */
  function dibujar(canvas, video, rostros, etiquetas = {}) {
    const dims = { width: video.clientWidth, height: video.clientHeight };
    if (!dims.width || !dims.height) return;
    if (canvas.width !== dims.width || canvas.height !== dims.height) { canvas.width = dims.width; canvas.height = dims.height; }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!rostros.length) return;
    const escala = faceapi.resizeResults(rostros, dims);
    escala.forEach((r, i) => {
      const { x, y, width, height } = r.detection.box;
      const info = etiquetas[i] || {};
      const color = info.color || "rgba(61,214,245,.95)";
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      const e = Math.min(width, height) * 0.22;
      ctx.beginPath();
      [[x, y + e, x, y, x + e, y], [x + width - e, y, x + width, y, x + width, y + e],
       [x + width, y + height - e, x + width, y + height, x + width - e, y + height],
       [x + e, y + height, x, y + height, x, y + height - e]].forEach(([a, b, c, d, f, g]) => {
        ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.lineTo(f, g);
      });
      ctx.stroke();
      if (info.progreso > 0) {
        const cx = x + width / 2, cy = y + height / 2, radio = Math.max(width, height) * 0.64;
        ctx.beginPath();
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(255,255,255,.18)";
        ctx.arc(cx, cy, radio, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.lineWidth = 5;
        ctx.strokeStyle = color;
        ctx.arc(cx, cy, radio, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, info.progreso));
        ctx.stroke();
      }
      if (info.texto) {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.font = "700 15px 'Plus Jakarta Sans', sans-serif";
        const tw = ctx.measureText(info.texto).width + 22;
        const tx = -(x + width / 2) - tw / 2;
        const ty = y + height + 14;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(tx, ty, tw, 30, 10);
        ctx.fill();
        ctx.fillStyle = "#061527";
        ctx.textBaseline = "middle";
        ctx.fillText(info.texto, tx + 11, ty + 15);
        ctx.restore();
      }
    });
  }

  return { cargarModelos, listarCamaras, iniciarCamara, detenerCamara, detectar, detectarUno, calidad, pose,
           recortarRostro, Comparador, promediar, dibujar, get listos() { return modelosListos; } };
})();
