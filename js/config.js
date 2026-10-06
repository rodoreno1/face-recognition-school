/* Conexión con Supabase.

   Copia aquí los datos de tu proyecto (Project Settings → API):
     supabaseUrl      "https://xxxx.supabase.co"
     supabaseAnonKey  la llave "anon public" (es pública por diseño; la seguridad
                      la ponen las políticas RLS de supabase/schema.sql)

   Con los dos campos vacíos la app corre en modo demostración: los datos se
   guardan solo en este navegador y las cuentas son admin@demo / caseta@demo
   con contraseña demo1234. */
window.APP_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
};
