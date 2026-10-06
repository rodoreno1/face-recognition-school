# Control de acceso CBTis 002 — reconocimiento facial

Aplicación web para registrar la entrada y salida de alumnos del plantel con
la cámara de la caseta. El reconocimiento corre en el navegador; los datos y
las cuentas viven en Supabase (PostgreSQL con autenticación y permisos por
rol). Sin Supabase configurado la app corre en **modo demostración** con datos
locales, para verla funcionar.

## Qué hace

- **Acceso con cuentas.** Dos roles:
  - *Administrador*: panel en vivo, alumnos, registros, configuración y
    cuentas. También puede abrir el kiosco y hacer registros manuales.
  - *Kiosco* (la caseta): solo la pantalla de reconocimiento. No puede ver ni
    cambiar nada más.
- **Kiosco** (`#kiosco`): enciende la cámara, reconoce al alumno y registra su
  entrada o salida con tarjeta animada, sonido y conteo del día. Modo
  automático (alterna entrada/salida) o fijo. Pantalla completa. Si se cae el
  internet, los registros esperan en el equipo y se mandan al reconectar.
- **Panel** (`#panel`): resumen del día que se actualiza solo (tiempo real):
  dentro del plantel, entradas, salidas, ausentes; actividad
  reciente; entradas por hora.
- **Alumnos** (`#alumnos`): alta con **escaneo guiado del rostro**: la app
  pide cinco poses (de frente, a un lado, al otro, barbilla, de frente) y
  captura sola cuando la toma es buena. Importación de la lista por CSV.
- **Registros** (`#registros`): historial por fecha, grupo, tipo y nombre;
  estadísticas; gráfica; ausentes; exportación a CSV.
- **Configuración** (`#config`): nombre del plantel, sensibilidad
  del reconocimiento, cámara, cuentas y copia de los datos.

## Puesta en marcha con Supabase (una vez, 10 minutos)

1. Crea un proyecto gratuito en [supabase.com](https://supabase.com).
2. En **SQL Editor** pega el contenido de `supabase/schema.sql` y ejecútalo.
   Crea las tablas, los permisos (RLS) y el tiempo real. Se puede volver a
   ejecutar sin perder datos.
3. En **Authentication → Providers → Email** desactiva *Confirm email*. Así
   las cuentas que crees desde la app entran sin tener que confirmar correo.
   (Deja activo *Allow new users to sign up* en Authentication → Sign In / Up:
   la primera cuenta en registrarse se vuelve administrador; cualquier otra
   queda sin acceso hasta que un administrador le asigne rol.)
4. En **Project Settings → API** copia la *Project URL* y la llave
   *anon public* en `js/config.js`. La llave anon es pública por diseño: la
   seguridad la ponen las políticas RLS del paso 2.
5. Publica la carpeta tal cual en Vercel (o cualquier hosting estático con
   HTTPS; la cámara solo funciona con HTTPS o en `localhost`).
6. Abre el sitio: te pedirá **crear la cuenta de administrador**.
7. Entra a **Configuración → Cuentas** y crea la cuenta de la caseta con rol
   *Kiosco*. En la computadora de la entrada inicia sesión con esa cuenta y
   deja abierta la pestaña en pantalla completa.

Para probar en tu computadora:

```bash
npx http-server -p 8080
# abre http://localhost:8080
```

## Estructura

```
index.html           Armazón de la página
css/asistencia.css   Estilos (azul marino del escudo DGETI; kiosco oscuro,
                     administración clara)
js/config.js         URL y llave anon de Supabase (vacíos = modo demostración)
js/api.js            Capa de datos sobre Supabase: cuentas, alumnos, registros,
                     configuración, tiempo real y cola sin conexión
js/demo.js           La misma interfaz sobre localStorage (modo demostración)
js/face.js           Cámara, modelos, calidad de la toma, pose, comparación
js/app.js            Interfaz: acceso, panel, kiosco, alumnos (escaneo guiado),
                     registros, configuración
supabase/schema.sql  Tablas (students, attendance_records, settings, profiles),
                     roles, políticas RLS y tiempo real. El esquema está en
                     inglés; js/api.js traduce a los nombres en español de la app
models/              Pesos de los tres modelos (detector, puntos faciales,
                     reconocimiento), servidos localmente
vendor/face-api.js   Reconocimiento (@vladmandic/face-api, MIT)
vendor/supabase.js   Cliente de Supabase (supabase-js v2)
img/logo.png         Escudo del plantel
vercel.json          Cabeceras: permiso de cámara y caché de modelos
```

## Cómo reconoce

Cada rostro se convierte en un vector de 128 números (descriptor). En el alta
se guardan cinco muestras en poses distintas, y solo se aceptan tomas nítidas,
bien iluminadas y de tamaño suficiente. En el kiosco:

1. Se detectan los rostros de cada cuadro; se trabaja con el más grande.
2. Se calcula la distancia mínima a las muestras de cada alumno. Se acepta al
   mejor si su distancia es menor que la **sensibilidad** (0.50) **y** le saca
   al segundo candidato al menos el **margen** (0.06): así no se confunde a dos
   alumnos parecidos.
3. Se exige la misma identidad en varios cuadros seguidos (3) y se vuelve a
   verificar con el promedio de esos cuadros.
4. Hay una espera (60 s) antes de volver a registrar a la misma persona.

## Datos y privacidad

- Se guardan: nombre, matrícula, grupo, turno, los descriptores (números, no
  imágenes reconstruibles) y una foto pequeña de credencial. El video de la
  cámara nunca sale del equipo.
- Los datos biométricos de menores son datos personales sensibles: el plantel
  necesita el consentimiento de madres, padres o tutores y un aviso de
  privacidad. Supabase cifra los datos en reposo; elige la región del proyecto
  conforme a la política del plantel.
- Cada cuenta ve solo lo que su rol permite (políticas RLS en la base).
  Desactiva en Configuración → Cuentas las que ya no se usen.
- Desde Configuración se puede descargar una copia completa en JSON.

## Formato del CSV de alumnos

```
nombre,matricula,grupo,semestre,turno
García López Ana,22180012,3A,3,Matutino
Hernández Ruiz Luis,22180045,3B,3,Vespertino
```

Las matrículas repetidas actualizan al alumno existente sin borrar su rostro.
