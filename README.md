# Control de entradas y salidas por reconocimiento facial — CBTis

Aplicación web para registrar la entrada y salida de alumnos en un plantel
CBTis usando la cámara del equipo. Todo corre en el navegador: no necesita
servidor, base de datos externa ni internet una vez cargada.

## Qué hace

- **Kiosco** (`#kiosco`): la pantalla de la caseta. Enciende la cámara,
  reconoce al alumno y registra su entrada o salida sola, con tarjeta animada,
  sonido y conteo del día (dentro del plantel, entradas, salidas, retardos).
  Modo automático (alterna entrada/salida), o fijo en Entrada o Salida.
  Registro manual para cuando la cámara falla. Botón de pantalla completa.
- **Alumnos** (`#alumnos`): alta y edición con captura de rostro en vivo
  (3 a 5 muestras) o desde una foto. Importación de la lista completa por CSV.
- **Registros** (`#registros`): historial por fecha, grupo, tipo y nombre;
  estadísticas; gráfica de entradas por hora; lista de ausentes; exportación
  a CSV para Excel.
- **Configuración** (`#config`): nombre del plantel, hora de entrada por turno
  y tolerancia para marcar retardo, sensibilidad del reconocimiento, cámara,
  sonido, PIN de administrador, respaldo y restauración.

Las secciones de administración piden un PIN. El PIN inicial es **1234**;
cámbialo en Configuración.

## Cómo usarlo

1. Publica la carpeta tal cual en cualquier hosting estático con HTTPS
   (Vercel, Netlify, GitHub Pages). El archivo `vercel.json` ya permite la
   cámara y cachea los modelos. La cámara solo funciona con HTTPS o en
   `localhost`.
2. Para probar en tu computadora:
   ```bash
   npx http-server -p 8080
   # abre http://localhost:8080
   ```
3. Entra a **Alumnos**, da de alta a cada alumno y toma sus muestras de
   rostro. O importa primero la lista por CSV y después captura los rostros.
4. Deja abierta la pestaña **Kiosco** en la computadora de la entrada.

## Estructura

```
index.html          Armazón de la página
css/asistencia.css  Estilos (tema oscuro y claro por variables)
js/db.js            Almacenamiento local: IndexedDB para alumnos y registros,
                    localStorage para la configuración
js/face.js          Cámara, carga de modelos, detección y comparación de rostros
js/app.js           Interfaz: enrutador por hash, las cuatro vistas, PIN, lógica
                    de entrada/salida/retardo
models/             Pesos de los tres modelos (detector, puntos faciales,
                    reconocimiento), servidos localmente
vendor/face-api.js  Librería de reconocimiento (@vladmandic/face-api, MIT)
vercel.json         Cabeceras: permiso de cámara y caché
```

## Cómo reconoce

Cada rostro se convierte en un vector de 128 números (descriptor). Al dar de
alta a un alumno se guardan varios descriptores; en el kiosco se compara el
rostro que ve la cámara contra todos y se acepta la coincidencia más cercana si
la distancia es menor que la sensibilidad configurada (0.50 por defecto). Para
evitar falsos positivos se exige la misma identidad en varios cuadros seguidos
(3 por defecto) y hay un periodo de espera (60 s) antes de volver a registrar
a la misma persona.

## Datos y privacidad

- Fotos, descriptores y registros se guardan **solo en el navegador** del
  equipo donde se usa (IndexedDB). No se envía nada a ningún servidor.
- Si se borran los datos del navegador se pierde todo: descarga un respaldo
  desde Configuración con regularidad. El respaldo contiene datos personales y
  biométricos de menores; guárdalo en un lugar seguro.
- Para usar el sistema en varias computadoras hay que restaurar el mismo
  respaldo en cada una. Si el plantel necesita una base central, el archivo
  `js/db.js` concentra todo el acceso a datos y es el único que habría que
  cambiar por una API.

## Formato del CSV de alumnos

```
nombre,matricula,grupo,semestre,turno
García López Ana,22180012,3A,3,Matutino
Hernández Ruiz Luis,22180045,3B,3,Vespertino
```

Las matrículas repetidas actualizan al alumno existente sin borrar su rostro.
