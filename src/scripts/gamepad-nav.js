class GamepadNav {
    constructor() {
        this.active = false;
        this.polling = false;
        this.elements = [];
        this.currentIndex = -1;
        this.lastTime = 0;
        this.cooldown = 200; // ms between dpad moves
        
        window.addEventListener('gamepadconnected', (e) => {
            console.log("Gamepad connected for UI Nav:", e.gamepad.id);
            this.active = true;
            this.scanElements();
            if (this.currentIndex === -1 && this.elements.length > 0) {
                this.focus(0);
            }
            if (!this.polling) {
                this.polling = true;
                this.poll();
            }
        });
        
        window.addEventListener('gamepaddisconnected', () => {
            this.active = navigator.getGamepads().some(gp => gp !== null);
            if (!this.active) this.polling = false;
        });
    }

    scanElements() {
        this.elements = Array.from(document.querySelectorAll('button:not([disabled]), a[href], input, select, .nav-item, .rcard, .grid-item')).filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        });
    }

    focus(index) {
        if (index < 0) index = this.elements.length - 1;
        if (index >= this.elements.length) index = 0;
        this.currentIndex = index;
        const el = this.elements[index];
        el.focus();
        
        // Add a visual indicator class for custom styling if desired
        this.elements.forEach(e => e.classList.remove('gp-focus'));
        el.classList.add('gp-focus');
    }

    poll() {
        if (!this.active) return;
        requestAnimationFrame(() => this.poll());
        
        const now = Date.now();
        if (now - this.lastTime < this.cooldown) return;

        const gamepads = navigator.getGamepads();
        for (let i = 0; i < gamepads.length; i++) {
            const gp = gamepads[i];
            if (!gp) continue;

            // D-Pad Up (12)
            if (gp.buttons[12]?.pressed || gp.axes[1] < -0.5) {
                this.scanElements();
                this.focus(this.currentIndex - 1);
                this.lastTime = now;
            }
            // D-Pad Down (13)
            else if (gp.buttons[13]?.pressed || gp.axes[1] > 0.5) {
                this.scanElements();
                this.focus(this.currentIndex + 1);
                this.lastTime = now;
            }
            // D-Pad Left (14)
            else if (gp.buttons[14]?.pressed || gp.axes[0] < -0.5) {
                this.scanElements();
                this.focus(this.currentIndex - 1);
                this.lastTime = now;
            }
            // D-Pad Right (15)
            else if (gp.buttons[15]?.pressed || gp.axes[0] > 0.5) {
                this.scanElements();
                this.focus(this.currentIndex + 1);
                this.lastTime = now;
            }
            // A Button (0) - Click
            else if (gp.buttons[0]?.pressed) {
                if (this.currentIndex >= 0 && this.elements[this.currentIndex]) {
                    this.elements[this.currentIndex].click();
                    this.lastTime = now + 200; // Extra cooldown for click
                }
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Inject custom focus style to make it obvious on Steam Deck
    const style = document.createElement('style');
    style.innerHTML = \`
        .gp-focus, :focus {
            outline: 3px solid var(--accent, #c957e6) !important;
            outline-offset: 2px !important;
            box-shadow: 0 0 12px var(--accent, #c957e6) !important;
            transform: scale(1.02);
            transition: all 0.1s ease;
        }
    \`;
    document.head.appendChild(style);
    
    window._gamepadNav = new GamepadNav();
});
