/**
 * src/scripts/extended/spatial-nav.js
 * Gamepad & TV Remote Virtual Cursor Engine
 */

const cursor = document.getElementById('virtual-cursor');
let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
let lastTime = performance.now();
let vx = 0, vy = 0;
const keys = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false };

function updateGamepad(time) {
  const dt = Math.min((time - lastTime) / 1000, 0.1); // Cap delta time at 100ms
  lastTime = time;

  // TV Remote (Keyboard) Acceleration
  const accel = 3500;
  const maxSpeed = 1200;
  const friction = 0.8; // Apply per frame approximation

  if (keys.ArrowUp) vy -= accel * dt;
  if (keys.ArrowDown) vy += accel * dt;
  if (keys.ArrowLeft) vx -= accel * dt;
  if (keys.ArrowRight) vx += accel * dt;

  if (!keys.ArrowUp && !keys.ArrowDown) vy *= Math.pow(friction, dt * 60);
  if (!keys.ArrowLeft && !keys.ArrowRight) vx *= Math.pow(friction, dt * 60);

  const currentSpeed = Math.sqrt(vx*vx + vy*vy);
  if (currentSpeed > maxSpeed) {
      vx = (vx / currentSpeed) * maxSpeed;
      vy = (vy / currentSpeed) * maxSpeed;
  }

  let totalDx = vx * dt;
  let totalDy = vy * dt;

  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    const gdx = p.axes[0], gdy = p.axes[1];
    const speed = 840;

    if (Math.abs(gdx) > 0.15) totalDx += gdx * speed * dt;
    if (Math.abs(gdy) > 0.15) totalDy += gdy * speed * dt;

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

  // Magnetism (Snap to buttons)
  if (Math.abs(totalDx) > 0.5 || Math.abs(totalDy) > 0.5) {
      const clickables = document.querySelectorAll('button, input, select, a, .nav-btn, .clickable');
      let closestDist = 120; // Magnetic radius
      let mx = 0, my = 0;
      
      for (const el of clickables) {
        if (!el.offsetParent) continue; // skip hidden elements
        const rect = el.getBoundingClientRect();
        
        // Element center
        const ex = rect.left + rect.width / 2;
        const ey = rect.top + rect.height / 2;
        
        const dx = ex - cx;
        const dy = ey - cy;
        const dist = Math.sqrt(dx*dx + dy*dy);
        
        if (dist < closestDist) {
            closestDist = dist;
            // Stronger pull when closer
            const pullStrength = 15 * Math.pow(1 - dist/120, 2);
            mx = (dx / dist) * pullStrength;
            my = (dy / dist) * pullStrength;
        }
      }
      
      totalDx += mx;
      totalDy += my;
  }

  cx += totalDx;
  cy += totalDy;

  cx = Math.max(0, Math.min(window.innerWidth, cx));
  cy = Math.max(0, Math.min(window.innerHeight, cy));
  
  if (Math.abs(totalDx) > 0.1 || Math.abs(totalDy) > 0.1) {
    cursor.style.display = 'block';
    cursor.style.left = cx + 'px';
    cursor.style.top = cy + 'px';
  }

  requestAnimationFrame(updateGamepad);
}

// Start loop immediately
requestAnimationFrame(updateGamepad);

window.addEventListener('keydown', (e) => {
  if (keys.hasOwnProperty(e.key)) {
    e.preventDefault();
    keys[e.key] = true;
    cursor.style.display = 'block';
  } else if (e.key === 'Enter') {
    e.preventDefault();
    cursor.classList.add('clicking');
    setTimeout(() => cursor.classList.remove('clicking'), 150);
    const el = document.elementFromPoint(cx, cy);
    if (el && typeof el.click === 'function') el.click();
  }
});

window.addEventListener('keyup', (e) => {
  if (keys.hasOwnProperty(e.key)) {
    e.preventDefault();
    keys[e.key] = false;
  }
});
