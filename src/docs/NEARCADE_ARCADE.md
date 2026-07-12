# Nearsec Arcade: The Matchmaking Core

Nearsec Arcade is a decentralized, public matchmaking directory designed to connect hosts with players for local-multiplayer gaming. Unlike the private "Direct Share" mode, the Arcade is built for discovery, community testing, and low-friction co-op.

## The Mission

* **For Hosts**: To provide a platform to share unique local co-op experiences without requiring players to own the hardware or software.
* **For Players**: To discover high-performance, low-latency gaming sessions globally while maintaining a "browser-first" security posture.

---

## Arcade Hosting Guidelines

To maintain the quality and safety of the public directory, the following automated rules are enforced on the Arcade backend:

* **The 80-Minute "Reaper" Rule**: Every session has a strict lifespan of **1 hour and 20 minutes**. Once this window expires, the session is automatically unlisted to prevent "ghost links" and ensure the lobby only contains active, reachable games.
* **WebRTC Active-Stream Check**: A session will only remain visible if it reports an active WebRTC data/video stream. If the host stops capturing their screen, the listing is hidden until capture resumes.
* **Infrastructure Requirements**: Arcade hosts must use verified tunneling (Cloudflared/zrok) to prevent raw IP exposure.
> **Note**: Hosting via VPS is currently restricted for Arcade listings to ensure the lowest possible input-to-pixel latency.



---

## Security & Moderation

The Arcade is built on a **Zero-Trust** model between the Host and the User.

### 1. Domain Whitelisting

To prevent phishing or malicious redirects, the Arcade frontend strictly enforces a domain whitelist. Only sessions utilizing the following tunnel providers are permitted:

* `*.trycloudflare.com`
* `*.zrok.io`
* `*.localhost.run`
* `*.serveo.net`

### 2. Mandatory Disclaimer

Every join attempt is met with a security modal. Users are reminded that while the transport is encrypted via WebRTC, they are connecting to a third-party machine and should never enter personal credentials or download unknown files during a session.

### 3. Version Parity

The Arcade automatically checks if the Player's client version matches the Host's version. If a mismatch is detected, a warning is issued to prevent input desync or WebHID gyro failures.

---

## Input & Presets

The Arcade supports Nearsec’s **Composite Device Driver**, allowing hosts to lock users into specific input modes to protect their system:

| Preset Name | Target Genre | Key Mapping Logic |
| --- | --- | --- |
| **Standard FPS** | Shooters | WASD movement with high-precision mouse-to-stick scaling. |
| **Classic Fighter** | Fighting Games | D-Pad movement for frame-perfect execution; Mouse disabled. |
| **Retro Platformer** | 2D Sidescrollers | Mapped for Arrow-key movement and X/Z action buttons. |

Hosts can dynamically switch a player between **Gamepad**, **Raw KBM**, or **Emulated KBM** modes via the dashboard Roster.


