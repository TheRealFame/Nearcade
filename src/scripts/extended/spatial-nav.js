/**
 * src/scripts/extended/spatial-nav.js
 * Gamepad & TV Remote Virtual Cursor Engine
 */

const cursor = document.getElementById('virtual-cursor');
let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
let lastTime = performance.now();

function updateGamepad(time) {
  const dt = Math.min((time - lastTime) / 1000, 0.1); // Cap delta time at 100ms
  lastTime = time;

  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    cursor.style.display = 'block';
    const dx = p.axes[0], dy = p.axes[1];

    // At 60hz, we moved 14 pixels per frame (840px per second)
    const speed = 840;

    if (Math.abs(dx) > 0.15) cx += dx * speed * dt;
    if (Math.abs(dy) > 0.15) cy += dy * speed * dt;

    cx = Math.max(0, Math.min(window.innerWidth, cx));
    cy = Math.max(0, Math.min(window.innerHeight, cy));
    cursor.style.left = cx + 'px';
    cursor.style.top = cy + 'px';

    if (p.buttons[0].pressed && !p._wasPressed) {
      cursor.classList.add('clicking');
      const el = document.elementFromPoint(cx, cy);
      if (el && typeof el.click === 'function') el.click();
      p._wasPressed = true;
    } else if (!p.buttons[0].pressed) {
      cursor.classList.remove('clicking');
      p._wasPressed = false;
    }
  }
  requestAnimationFrame(updateGamepad);
}

window.addEventListener('gamepadconnected', () => {
  lastTime = performance.now();
  requestAnimationFrame(updateGamepad);
});

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
    cursor.style.display = 'block';
    if (e.key === 'ArrowUp') cy -= 40;
    if (e.key === 'ArrowDown') cy += 40;
    if (e.key === 'ArrowLeft') cx -= 40;
    if (e.key === 'ArrowRight') cx += 40;
    
    cx = Math.max(0, Math.min(window.innerWidth, cx));
    cy = Math.max(0, Math.min(window.innerHeight, cy));
    cursor.style.left = cx + 'px';
    cursor.style.top = cy + 'px';
    
    if (e.key === 'Enter') {
      cursor.classList.add('clicking');
      setTimeout(() => cursor.classList.remove('clicking'), 150);
      const el = document.elementFromPoint(cx, cy);
      if (el && typeof el.click === 'function') el.click();
    }
  }
});
