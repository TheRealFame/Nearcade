#!/bin/bash
set -e
mkdir -p bin/bin
echo "Downloading Windows Tunnels..."
wget -qO bin/bin/cloudflared.exe "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
wget -qO bin/bin/cloudflared-x86.exe "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-386.exe" || true
wget -qO bin/bin/cloudflared-arm64.exe "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-arm64.exe" || true

ZROK_VER=$(curl -sL https://api.github.com/repos/openziti/zrok/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/' | sed 's/v//')
wget -qO zrok_amd64.tar.gz "https://github.com/openziti/zrok/releases/download/v${ZROK_VER}/zrok_${ZROK_VER}_windows_amd64.tar.gz"
tar xzf zrok_amd64.tar.gz zrok2.exe || true
mv zrok2.exe bin/bin/zrok2.exe || true
rm -f zrok_amd64.tar.gz

wget -qO zrok_arm64.tar.gz "https://github.com/openziti/zrok/releases/download/v${ZROK_VER}/zrok_${ZROK_VER}_windows_arm64.tar.gz" || true
if [ -f zrok_arm64.tar.gz ]; then
    tar xzf zrok_arm64.tar.gz zrok2.exe || true
    mv zrok2.exe bin/bin/zrok2-arm64.exe || true
    rm -f zrok_arm64.tar.gz
fi

echo "Downloading Linux Tunnels..."
wget -qO bin/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
wget -qO bin/bin/cloudflared-arm64 "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" || true
chmod +x bin/bin/cloudflared*

wget -qO zrok.tar.gz "https://github.com/openziti/zrok/releases/download/v${ZROK_VER}/zrok_${ZROK_VER}_linux_amd64.tar.gz"
tar xzf zrok.tar.gz zrok2
mv zrok2 bin/bin/zrok2

wget -qO zrok_arm.tar.gz "https://github.com/openziti/zrok/releases/download/v${ZROK_VER}/zrok_${ZROK_VER}_linux_arm64.tar.gz" || true
if [ -f zrok_arm.tar.gz ]; then
    tar xzf zrok_arm.tar.gz zrok2
    mv zrok2 bin/bin/zrok2-arm64
    rm -f zrok_arm.tar.gz
fi
chmod +x bin/bin/zrok2*

echo "All tunnels successfully downloaded to bin/bin/"
