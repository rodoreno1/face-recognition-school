/* ==========================================================================
   Reconocimiento facial: cámara, modelos y comparación de rostros.

   Encima de face-api (vendor/face-api.js, MIT). Los modelos se sirven desde
   /asistencia/models para no depender de ningún CDN: la caseta de entrada
   tiene que funcionar aunque el internet del plantel esté lento.

   Flujo:
     1. Face.cargarModelos(onProgreso)   descarga los tres modelos una vez
     2. Face.iniciarCamara(video, id)    pide permiso y arranca el <video>
     3. Face.detectar(video)             rostros + descriptores de 128 números
     4. Face.Comparador(alumnos, umbral) encuentra a quién pertenece un rostro
   ========================================================================== */

const Face = (() => {
  const RUTA_MODELOS = "models";
  let modelosListos = false;
  let stream = null;

  const opcionesDeteccion = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });

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

  async function iniciarCamara(video, deviceId = "") {
    detenerCamara();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Este navegador no permite usar la cámara. Abre la página en Chrome, Edge o Safari actualizados y con HTTPS.");
    }
    const videoCfg = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" };
    if (deviceId) { videoCfg.deviceId = { exact: deviceId }; delete videoCfg.facingMode; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoCfg, audio: false });
    } catch (e) {
      if (deviceId) {
        // La cámara guardada ya no está conectada: usa la que haya.
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      } else throw e;
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

  /* Detecta todos los rostros con su descriptor. Devuelve [] si el video aún
     no tiene cuadros. */
  async function detectar(fuente) {
    if (!modelosListos) return [];
    if (fuente instanceof HTMLVideoElement && (fuente.paused || fuente.ended || !fuente.videoWidth)) return [];
    const res = await faceapi.detectAllFaces(fuente, opcionesDeteccion())
      .withFaceLandmarks().withFaceDescriptors();
    return res;
  }

  /* Para el alta: exige exactamente un rostro, de buen tamaño y nítido. */
  async function detectarUno(fuente) {
    const todos = await detectar(fuente);
    if (todos.length === 0) return { error: "No se ve ningún rostro. Acércate y mira a la cámara." };
    if (todos.length > 1) return { error: "Hay más de una persona en la toma. Debe aparecer solo el alumno." };
    const r = todos[0];
    const { width, height } = r.detection.box;
    const ancho = fuente.videoWidth || fuente.naturalWidth || fuente.width;
    if (Math.min(width, height) < Math.max(90, ancho * 0.12)) {
      return { error: "El rostro se ve muy pequeño. Acércate a la cámara." };
    }
    if (r.detection.score < 0.7) return { error: "La imagen no es clara. Busca mejor luz y quédate quieto." };
    return { resultado: r };
  }

  /* Recorta el rostro detectado a un JPEG cuadrado pequeño para la credencial. */
  function recortarRostro(fuente, deteccion, tam = 192) {
    const box = deteccion.detection.box;
    const margen = box.width * 0.35;
    const x = Math.max(0, box.x - margen), y = Math.max(0, box.y - margen * 1.3);
    const w = Math.min((fuente.videoWidth || fuente.naturalWidth) - x, box.width + margen * 2);
    const h = Math.min((fuente.videoHeight || fuente.naturalHeight) - y, box.height + margen * 2.3);
    const lado = Math.max(w, h);
    const c = document.createElement("canvas");
    c.width = c.height = tam;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#1d1140";
    ctx.fillRect(0, 0, tam, tam);
    ctx.drawImage(fuente, x - (lado - w) / 2, y - (lado - h) / 2, lado, lado, 0, 0, tam, tam);
    return c.toDataURL("image/jpeg", 0.82);
  }

  /* Comparador: construye un FaceMatcher con todos los descriptores guardados.
     Cada alumno puede tener varias muestras (distintos ángulos / luz). */
  function Comparador(alumnos, umbral = 0.5) {
    const etiquetados = alumnos
      .filter(a => a.activo !== false && Array.isArray(a.descriptores) && a.descriptores.length)
      .map(a => new faceapi.LabeledFaceDescriptors(a.id, a.descriptores.map(d => new Float32Array(d))));
    const matcher = etiquetados.length ? new faceapi.FaceMatcher(etiquetados, umbral) : null;
    const porId = Object.fromEntries(alumnos.map(a => [a.id, a]));
    return {
      vacio: !matcher,
      identificar(descriptor) {
        if (!matcher) return { alumno: null, distancia: 1 };
        const m = matcher.findBestMatch(descriptor);
        if (m.label === "unknown") return { alumno: null, distancia: m.distance };
        return { alumno: porId[m.label] || null, distancia: m.distance };
      },
    };
  }

  /* Dibuja los recuadros sobre el <canvas> que cubre al video. Se usa el
     mismo tamaño que el video mostrado para que coincidan. */
  function dibujar(canvas, video, rostros, etiquetas = {}) {
    const dims = { width: video.clientWidth, height: video.clientHeight };
    if (canvas.width !== dims.width || canvas.height !== dims.height) {
      canvas.width = dims.width; canvas.height = dims.height;
    }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!rostros.length) return;
    // El video está espejeado por CSS; el canvas también, así que no hay que invertir X.
    const escala = faceapi.resizeResults(rostros, dims);
    escala.forEach((r, i) => {
      const { x, y, width, height } = r.detection.box;
      const info = etiquetas[i] || {};
      const color = info.color || "rgba(167,139,250,.95)";
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.lineJoin = "round";
      const e = Math.min(width, height) * 0.22;
      // Esquinas en vez de rectángulo completo: estorba menos sobre la cara.
      ctx.beginPath();
      [[x, y + e, x, y, x + e, y], [x + width - e, y, x + width, y, x + width, y + e],
       [x + width, y + height - e, x + width, y + height, x + width - e, y + height],
       [x + e, y + height, x, y + height, x, y + height - e]].forEach(([a, b, c, d, f, g]) => {
        ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.lineTo(f, g);
      });
      ctx.stroke();
      if (info.texto) {
        ctx.save();
        ctx.scale(-1, 1); // deshace el espejo para que el texto se lea
        ctx.font = "600 15px 'Instrument Sans', sans-serif";
        const tw = ctx.measureText(info.texto).width + 20;
        const tx = -(x + width / 2) - tw / 2;
        const ty = y + height + 12;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(tx, ty, tw, 28, 8);
        ctx.fill();
        ctx.fillStyle = "#0A0512";
        ctx.textBaseline = "middle";
        ctx.fillText(info.texto, tx + 10, ty + 14);
        ctx.restore();
      }
    });
  }

  return { cargarModelos, listarCamaras, iniciarCamara, detenerCamara, detectar, detectarUno,
           recortarRostro, Comparador, dibujar, get listos() { return modelosListos; } };
})();
