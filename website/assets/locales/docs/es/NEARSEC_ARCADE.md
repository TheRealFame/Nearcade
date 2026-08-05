# Arcade Nearsec

Nearsec Arcade es un servicio global de emparejamiento donde cualquiera puede enumerar públicamente sus sesiones activas.

### Listando su sesión
Al iniciar una sesión de anfitrión, haga clic en el botón "Listar en Live Arcade". Su sesión aparecerá inmediatamente en la pestaña Arcade para todos los usuarios de Nearsec.

### Seguridad
- **Sin fuga directa de IP**: si está utilizando un túnel (zrok, cloudflared) o un VPS, la dirección IP real de su hogar está oculta en la lista de Arcade.
- **Protección PIN**: aún puedes aplicar un código PIN en las sesiones de Arcade. Los espectadores verán su lobby pero deben conocer el PIN para unirse.

### Latidos del corazón arcade
La aplicación anfitriona envía un ping de "latido" a Arcade cada 30 segundos. Si cierra Nearsec o pierde la conexión, su listado se eliminará automáticamente en 1 minuto.
