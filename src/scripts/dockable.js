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

    // CSS for predefined docks
    const style = document.createElement('style');
    style.textContent = `
        .ns-dock-zone {
            display: flex;
            gap: 12px;
            transition: min-width 0.2s, min-height 0.2s, background 0.2s;
        }
        .ns-dock-top, .ns-dock-bottom { flex-direction: row; }
        .ns-dock-left, .ns-dock-right { flex-direction: column; }
        
        .ns-dock-zone:empty { display: none; }
        
        /* Dragging over states */
        .ns-dock-zone.drag-active {
            display: flex !important;
            background: rgba(139, 92, 246, 0.1);
            border: 2px dashed #c084fc;
            border-radius: 12px;
        }
        .ns-dock-top.drag-active, .ns-dock-bottom.drag-active { min-height: 80px; }
        .ns-dock-left.drag-active, .ns-dock-right.drag-active { min-width: 80px; }
        
        .left-rail, .right-panel { transition: flex-direction 0.2s, height 0.2s, width 0.2s; }
        
        /* Force panels in vertical docks to fill vertical space */
        .ns-dock-left > *, .ns-dock-right > * {
            flex: 1;
            height: 100%;
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

    if (originalLeft) {
        const dragHandle = originalLeft.querySelector('.rail-logo');
        if (dragHandle) {
            dragHandle.setAttribute('draggable', 'true');
            dragHandle.style.cursor = 'grab';

            dragHandle.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', '');
                draggedPanel = originalLeft;
                document.body.classList.add('is-dragging-dock');
                
                // Force empty docks to show up as drop targets
                [dockTop, dockBottom, dockLeft, dockRight].forEach(d => {
                    if (d.children.length === 0) d.classList.add('drag-active');
                });
                e.stopPropagation();
            });

            dragHandle.addEventListener('dragend', () => {
                cancelDrag();
            });
        }
    }

    // Cancel dragging on ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && draggedPanel) {
            cancelDrag();
        }
    });

    function cancelDrag() {
        draggedPanel = null;
        document.body.classList.remove('is-dragging-dock');
        [dockTop, dockBottom, dockLeft, dockRight].forEach(d => {
            d.classList.remove('drag-active');
            d.classList.remove('drag-over');
            d.style.background = '';
        });
    }

    // 3. Setup Drop Zones
    [dockTop, dockBottom, dockLeft, dockRight].forEach(zone => {
        zone.addEventListener('dragover', (e) => {
            if (!draggedPanel) return;
            e.preventDefault(); // Necessary to allow dropping
            zone.style.background = 'rgba(139, 92, 246, 0.3)';
        });

        zone.addEventListener('dragleave', (e) => {
            if (!draggedPanel) return;
            zone.style.background = '';
        });

        zone.addEventListener('drop', (e) => {
            if (!draggedPanel) return;
            e.preventDefault();
            
            // Move panel to defined space
            zone.appendChild(draggedPanel);
            cancelDrag();
            saveDockLayout();
        });
    });
});
