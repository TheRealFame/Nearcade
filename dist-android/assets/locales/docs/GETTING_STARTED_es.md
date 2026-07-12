# Comenzando juntos con Nearsec

Nearcade te permite compartir juegos locales con amigos a través de Internet mediante WebRTC.

## Opciones de alojamiento
Tienes dos formas de organizar una sesión.

1. Túneles privados: puedes configurar un túnel personalizado a través de Cloudflare o Zrok para crear un enlace permanente para tus amigos. Esto funciona mejor para grupos privados.
2. Nearsec Arcade: Arcade es un directorio público para buscar juegos cooperativos locales. Las sesiones están restringidas a 80 minutos para mantener activo el lobby. Debe utilizar un proveedor de túnel verificado como Cloudflared o Zrok para enumerar una sesión. Puedes ver el lobby público en https://nearcade.cutefame.net/arcade y unirte a juegos activos.

## Iniciar una sesión
Siga estos pasos para comenzar a alojar.

1. Instale Node.js versión 18 o posterior y Python 3 en su máquina.
2. La mayoría de los usuarios iniciarán el ejecutable compilado directamente. La aplicación gestiona permisos y túneles automáticamente.
3. Si usa el código fuente, abra su terminal y navegue hasta la carpeta bin para ejecutar el script de configuración.

    ```bash
    cd bin
    sudo ./linux_setup.sh
    ```

4. La aplicación Linux solicita permiso para cargar el módulo del kernel uinput. Este paso es necesario para crear controladores virtuales nativos.
5. Haga clic en el botón Organizar sesión para abrir el panel de captura.
6. Envíe el enlace generado y el PIN de sesión a sus espectadores. El enrutador Rust bloquea todas las transmisiones de video y audio hasta que la aplicación host valide el PIN del espectador.

Este proyecto utiliza modelos de lenguaje grandes de inteligencia artificial para la generación de código y la planificación de estructuras.
