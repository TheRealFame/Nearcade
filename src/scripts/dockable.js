// dockable.js - OBS style docking manager
// dockable.js - Defined Spaces OBS-Style Docking
document.addEventListener('DOMContentLoaded', () => {
    const shell = document.querySelector('.app-shell');
    if (!shell) return;

    // 1. Convert the static grid into a defined flex structure with specific drop zones
    shell.style.display = 'flex';
    shell.style.flexDirection = 'column';
    shell.style.padding = '12px';
    shell.style.gap = '12px';

    const originalLeft = document.querySelector('.left-rail');
    const originalMain = document.querySelector('.main-stage');
    const originalRight = document.querySelector('.right-panel');

    originalMain.style.flex = '1';
    originalMain.style.minWidth = '0'; // Allow it to shrink if needed
    
    // Create Defined Docks
    const dockTop = document.createElement('div');
    dockTop.className = 'ns-dock-zone ns-dock-top';
    
    const middleRow = document.createElement('div');
    middleRow.className = 'ns-dock-middle-row';
    middleRow.style.display = 'flex';
    middleRow.style.flexDirection = 'row';
    middleRow.style.flex = '1';
    middleRow.style.gap = '12px';
    middleRow.style.minHeight = '0';

    const dockLeft = document.createElement('div');
    dockLeft.className = 'ns-dock-zone ns-dock-left';
    
    const dockRight = document.createElement('div');
    dockRight.className = 'ns-dock-zone ns-dock-right';
    
    const dockBottom = document.createElement('div');
    dockBottom.className = 'ns-dock-zone ns-dock-bottom';

    // Assemble defined spaces
    shell.innerHTML = '';
    shell.appendChild(dockTop);
    shell.appendChild(middleRow);
    middleRow.appendChild(dockLeft);
    middleRow.appendChild(originalMain);
    middleRow.appendChild(dockRight);
    shell.appendChild(dockBottom);

    // Initial placement logic reading from localStorage
    const savedLayoutStr = localStorage.getItem('ns_dock_layout');
    let layoutConfig = { 'left-rail': 'ns-dock-left', 'right-panel': 'ns-dock-right' };
    
    if (savedLayoutStr) {
        try { layoutConfig = JSON.parse(savedLayoutStr); } catch(e) {}
    }

    function placePanel(panelEl, className) {
        if (!panelEl) return;
        const targetClass = layoutConfig[className] || ('ns-dock-' + (className==='left-rail'?'left':'right'));
        const targetZone = shell.querySelector('.' + targetClass);
        if (targetZone) targetZone.appendChild(panelEl);
    }

    placePanel(originalLeft, 'left-rail');
    placePanel(originalRight, 'right-panel');

    function saveDockLayout() {
        const config = {};
        if (originalLeft && originalLeft.parentElement) {
            config['left-rail'] = Array.from(originalLeft.parentElement.classList).find(c => c.startsWith('ns-dock-'));
        }
        if (originalRight && originalRight.parentElement) {
            config['right-panel'] = Array.from(originalRight.parentElement.classList).find(c => c.startsWith('ns-dock-'));
        }
        localStorage.setItem('ns_dock_layout', JSON.stringify(config));
    }

    // Expose reset to global scope because host-modals.html is injected dynamically and inline scripts don't run
    window.resetDockLayout = function() {
        localStorage.removeItem('ns_dock_layout');
        layoutConfig = { 'left-rail': 'ns-dock-left', 'right-panel': 'ns-dock-right' };
        placePanel(originalLeft, 'left-rail');
        placePanel(originalRight, 'right-panel');
    };

    // CSS for predefined docks
    const style = document.createElement('style');
    style.textContent = `
        .ns-dock-zone {
            display: flex;
            gap: 12px;
            flex-shrink: 0;
            transition: min-width 0.2s, min-height 0.2s, background 0.2s;
        }
        .ns-dock-top, .ns-dock-bottom { flex-direction: row; }
        .ns-dock-left, .ns-dock-right { flex-direction: column; height: 100%; }
        
        .ns-dock-zone:empty { display: none; }
        
        /* Dragging over states */
        .ns-dock-zone.drag-active {
            display: flex !important;
            background: rgba(139, 92, 246, 0.1);
            border: 2px dashed #c084fc;
            border-radius: 12px;
        }
        .ns-dock-top.drag-active, .ns-dock-bottom.drag-active { min-height: 80px; }
        .ns-dock-left.drag-active, .ns-dock-right.drag-active { min-width: 80px; height: 100%; }
        
        .left-rail, .right-panel { transition: flex-direction 0.2s, height 0.2s, width 0.2s; }
        
        /* Preserve original widths when in vertical side docks */
        .ns-dock-left > .left-rail, .ns-dock-right > .left-rail { width: 68px; min-width: 68px; }
        .ns-dock-left > .right-panel, .ns-dock-right > .right-panel { width: 336px; min-width: 336px; }

        /* Force panels in vertical docks to fill vertical space */
        .ns-dock-left > *, .ns-dock-right > * {
            flex: 1;
            height: 100%;
            min-height: 0;
        }

        /* Horizontal mode for rail when in top/bottom docks */
        .ns-dock-top .left-rail, .ns-dock-bottom .left-rail {
            flex-direction: row;
            height: 68px;
            width: 100%;
            justify-content: flex-start;
        }
        .ns-dock-top .rail-divider, .ns-dock-bottom .rail-divider {
            width: 1px;
            height: 28px;
            margin: 0 4px;
        }
        .ns-dock-top .rail-btn-group, .ns-dock-bottom .rail-btn-group {
            flex-direction: row;
        }
    `;
    document.head.appendChild(style);

    // 2. Setup dragging logic exclusively for the sidebar (left-rail) first
    let draggedPanel = null;
    let dragGhost = null;
    let isDragging = false;
    let currentHoverZone = null;
    let currentDragHandle = null;

    const onPointerMove = (e) => {
        if (!isDragging) return;
        
        const x = e.clientX;
        const y = e.clientY;
        const w = window.innerWidth;
        const h = window.innerHeight;
        
        // Update ghost position
        if (dragGhost) {
            dragGhost.style.left = (x - 34) + 'px';
            dragGhost.style.top = (y - 34) + 'px';
        }
        
        let targetZone = null;
        
        // Use robust screen-percentage zones (20% edges)
        if (y < h * 0.20) targetZone = dockTop;
        else if (y > h * 0.80) targetZone = dockBottom;
        else if (x < w * 0.20) targetZone = dockLeft;
        else if (x > w * 0.80) targetZone = dockRight;
        
        // Prevent dropping on the zone it's already in
        if (targetZone === draggedPanel.parentElement) {
            targetZone = null;
        }

        // Update visual highlights
        [dockTop, dockBottom, dockLeft, dockRight].forEach(zone => {
            zone.style.background = '';
        });
        
        if (targetZone) {
            targetZone.style.background = 'rgba(139, 92, 246, 0.4)';
            currentHoverZone = targetZone;
        } else {
            currentHoverZone = null;
        }
    };

    const endDrag = (e) => {
        if (!isDragging) return;
        try {
            if (currentDragHandle && currentDragHandle.hasPointerCapture(e.pointerId)) {
                currentDragHandle.releasePointerCapture(e.pointerId);
            }
        } catch(err) {}
        
        if (currentHoverZone && draggedPanel) {
            currentHoverZone.appendChild(draggedPanel);
            saveDockLayout();
        }
        
        cancelDrag();
    };

    if (originalLeft) {
        const dragHandle = originalLeft.querySelector('.rail-logo');
        if (dragHandle) {
            dragHandle.style.cursor = 'grab';

            dragHandle.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return; // Left click only
                
                // Prevent browser native drag/text-selection which aborts JS pointer events!
                e.preventDefault();
                
                draggedPanel = originalLeft;
                currentDragHandle = dragHandle;
                isDragging = true;
                document.body.style.userSelect = 'none';
                
                // Create visual ghost
                dragGhost = originalLeft.cloneNode(true);
                dragGhost.style.position = 'fixed';
                // Force it into vertical mode so it's small and predictable
                dragGhost.className = 'left-rail glass'; 
                dragGhost.style.width = '68px';
                dragGhost.style.height = 'auto';
                dragGhost.style.flexDirection = 'column';
                dragGhost.style.justifyContent = 'flex-start';
                dragGhost.style.padding = '10px';
                dragGhost.style.gap = '6px';
                
                // Center the top part of the ghost perfectly on the mouse cursor
                dragGhost.style.left = (e.clientX - 34) + 'px';
                dragGhost.style.top = (e.clientY - 34) + 'px';
                
                dragGhost.style.pointerEvents = 'none';
                dragGhost.style.opacity = '0.7';
                dragGhost.style.zIndex = '999999';
                dragGhost.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
                dragGhost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
                document.body.appendChild(dragGhost);
                
                // Force empty docks to show up as drop targets
                [dockTop, dockBottom, dockLeft, dockRight].forEach(d => {
                    if (d.children.length === 0) d.classList.add('drag-active');
                });
                
                dragHandle.style.cursor = 'grabbing';
                e.stopPropagation();
                
                // Bind to window to guarantee we don't drop events if capture fails
                window.addEventListener('pointermove', onPointerMove);
                window.addEventListener('pointerup', endDrag);
                window.addEventListener('pointercancel', cancelDrag);
                
                try { dragHandle.setPointerCapture(e.pointerId); } catch(err) {}
            });
        }
    }

    // Cancel dragging on ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isDragging) {
            cancelDrag();
        }
    });

    function cancelDrag() {
        isDragging = false;
        draggedPanel = null;
        currentHoverZone = null;
        document.body.style.userSelect = '';
        
        if (dragGhost) {
            dragGhost.remove();
            dragGhost = null;
        }
        
        // Remove window listeners
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', endDrag);
        window.removeEventListener('pointercancel', cancelDrag);
        
        if (currentDragHandle) {
            currentDragHandle.style.cursor = 'grab';
            currentDragHandle = null;
        }

        [dockTop, dockBottom, dockLeft, dockRight].forEach(d => {
            d.classList.remove('drag-active');
            d.style.background = '';
        });
    }
});
