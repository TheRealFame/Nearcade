# Getting Started with Nearsec Together

Nearsec Together lets you share local games with friends over the internet using WebRTC.

## Hosting Options
You have two ways to host a session.

1. Private Tunnels: You can set up a custom tunnel through Cloudflare or Zrok to create a permanent link for your friends. This works best for private groups.
2. Nearsec Arcade: The Arcade is a public directory for finding local co-op games. Sessions are restricted to 80 minutes to keep the lobby active. You must use a verified tunneling provider like Cloudflared or Zrok to list a session. You can view the public lobby at https://nearsec.cutefame.net/arcade and join active games.

## Launching a Session
Follow these steps to start hosting.

1. Install Node.js version 18 or newer and Python 3 on your machine.
2. Most users will launch the compiled executable directly. The app manages permissions and tunnels automatically.
3. If you use the source code, open your terminal and navigate to the bin folder to run the setup script.

    ```bash
    cd bin
    sudo ./linux_setup.sh
    ```

4. The Linux application requests permission to load the uinput kernel module. This step is required to build native virtual controllers.
5. Click the Host Session button to open the capture dashboard.
6. Send the generated link and Session PIN to your viewers. The Rust router blocks all video and audio streams until the host application validates the PIN from the viewer.

This project uses artificial intelligence large language models for code generation and structure planning.
