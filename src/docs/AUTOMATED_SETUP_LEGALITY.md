# Legal Compliance and Setup Automation

This document outlines the legal standing and licensing compliance of the automated setup scripts used by Nearcade (such as `windows_setup.ps1`). 

Occasionally, automated scripts that download and silently install dependencies are mischaracterized by individuals as "unauthorized" or "malware-like." However, Nearcade's setup approach is entirely legal, open-source compliant, and aligns perfectly with industry-standard DevOps practices.

Here are the specific licenses and policies that explicitly permit this behavior:

## 1. Python Automated Installation
The setup script automatically downloads and installs Python using `/quiet` flags.
* **The License:** Python is governed by the **Python Software Foundation (PSF) License Agreement**, an OSI-approved open-source license.
* **The Policy:** The PSF License explicitly permits anyone to use, modify, distribute, and embed Python. 
* **The Mechanism:** The automated flags (`/quiet InstallAllUsers=0 PrependPath=1`) are not hacks; they are officially documented features created by the Python core developers. The Python Windows installer is built using WiX (Windows Installer XML) specifically to support "unattended installations" for enterprise and open-source orchestration.
* **Redistribution vs. Fetching:** The script uses `Invoke-WebRequest` to pull the installer directly from `https://www.python.org`. Because the script *fetches* the official binary directly from the source rather than illegally repacking and redistributing modified binaries, it strictly complies with software distribution laws.

## 2. ViGEmBus Driver Installation
The setup script triggers the installation of the ViGEmBus driver, which is required for virtual controller emulation.
* **The License:** The ViGEmBus project by Nefarius Software Solutions is open-source and licensed under the **BSD 3-Clause License** and **MIT License**.
* **The Policy:** Both the BSD and MIT licenses broadly permit the use, copying, and distribution of the software without restriction, provided the original copyright notices are maintained. Utilizing the official driver installer as a sub-process is fully authorized by the license parameters.

## 3. Package Management (pip)
The script installs dependencies like `vgamepad`, `pyautogui`, and `pyaudio` via `pip`.
* **The License:** These packages are published to the Python Package Index (PyPI) under permissive open-source licenses (predominantly MIT).
* **The Policy:** PyPI's terms of service and the individual MIT licenses of these packages explicitly exist to allow automated fetching by orchestration tools like `pip`. 

## 4. Reverse Tunneling Tools (Cloudflared, Zrok, Playit)
The script allows the user to optionally fetch tunneling binaries from GitHub.
* **The License:** Cloudflared is licensed under the **Apache License 2.0**. Zrok is licensed under the **Apache License 2.0**. Playit provides officially public binary releases.
* **The Policy:** The script does not steal or illegally distribute these programs. It instructs the user's computer to ping the official, public GitHub Release APIs to download the unadulterated binaries. This is identical to a user manually clicking the "Download" button on GitHub, simply automated via a script.

### Summary
Everything the script does—pinging official servers for binaries, running unattended install flags provided by the creators, and installing open-source libraries—is protected by permissive open-source licenses (PSFL, MIT, Apache 2.0, BSD-3) and complies fully with international copyright and software distribution laws. 
