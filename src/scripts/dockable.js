// dockable.js - OBS style docking manager
document.addEventListener('DOMContentLoaded', () => {
    const shell = document.querySelector('.app-shell');
    if (!shell) return;

    // Convert CSS Grid to Flexbox splits
    shell.style.display = 'flex';
    shell.style.flexDirection = 'row';

    const panels = Array.from(document.querySelectorAll('.left-rail, .topbar, .preview-stage, .bottom-dock, .right-panel, .main-stage'));
    panels.forEach(p => {
        p.classList.add('ns-dock-panel');
        
        if (p.classList.contains('left-rail')) p.style.flex = '0 0 68px';
        else if (p.classList.contains('right-panel')) p.style.flex = '0 0 336px';
        else if (p.classList.contains('main-stage') || p.classList.contains('preview-stage')) p.style.flex = '1 1 auto';
        else p.style.flex = '0 0 auto';
        
        // Add a drag handle to panels that don't have an obvious one
        let handle = p.querySelector('.panel-header') || p;
        
        // Custom handles
        if (p.classList.contains('left-rail')) handle = p.querySelector('.rail-logo') || p;
        if (p.classList.contains('topbar')) handle = p.querySelector('.host-meta') || p;
        if (p.classList.contains('bottom-dock')) handle = p.querySelector('.dock-card:first-child .dock-label') || p;

        handle.setAttribute('draggable', 'true');
        handle.style.cursor = 'grab';

        handle.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', '');
            window._dockDraggingPanel = p;
            e.stopPropagation();
        });
    });

    // Add styles for dropzones and splits
    const style = document.createElement('style');
    style.textContent = `
        .ns-split-row { display: flex; flex-direction: row; flex: 1; gap: 12px; min-height: 0; min-width: 0; width: 100%; height: 100%; }
        .ns-split-col { display: flex; flex-direction: column; flex: 1; gap: 12px; min-height: 0; min-width: 0; width: 100%; height: 100%; }
        .ns-dock-panel { position: relative; min-height: 0; min-width: 0; }
        .ns-dock-panel * { user-select: none; }
        .ns-dropzone {
            position: absolute;
            background: rgba(139, 92, 246, 0.2);
            border: 2px dashed #c084fc;
            z-index: 10000;
            pointer-events: all;
            opacity: 0;
            transition: opacity 0.15s, background 0.15s;
        }
        .ns-dropzone.active { opacity: 1; background: rgba(139, 92, 246, 0.5); }
        
        .ns-dz-top { top: 0; left: 0; right: 0; height: 30%; }
        .ns-dz-bottom { bottom: 0; left: 0; right: 0; height: 30%; }
        .ns-dz-left { top: 0; bottom: 0; left: 0; width: 30%; }
        .ns-dz-right { top: 0; bottom: 0; right: 0; width: 30%; }
        .ns-dz-center { top: 30%; bottom: 30%; left: 30%; right: 30%; border: 2px solid #fff; }
    `;
    document.head.appendChild(style);

    // Create global drop zones that appear over panels when dragging
    let activeDropPanel = null;
    let dzOverlay = document.createElement('div');
    dzOverlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9999;display:none;';
    
    ['top', 'bottom', 'left', 'right', 'center'].forEach(dir => {
        let dz = document.createElement('div');
        dz.className = `ns-dropzone ns-dz-${dir}`;
        dz.dataset.dir = dir;
        dzOverlay.appendChild(dz);

        dz.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dz.classList.add('active');
        });
        dz.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dz.classList.remove('active');
        });
        dz.addEventListener('dragover', (e) => e.preventDefault());
        dz.addEventListener('drop', (e) => {
            e.preventDefault();
            dz.classList.remove('active');
            handleDrop(window._dockDraggingPanel, activeDropPanel, dir);
            hideDropZones();
        });
    });

    document.body.appendChild(dzOverlay);

    function showDropZones(targetPanel) {
        if (!targetPanel || targetPanel === window._dockDraggingPanel) return;
        activeDropPanel = targetPanel;
        const rect = targetPanel.getBoundingClientRect();
        dzOverlay.style.top = rect.top + 'px';
        dzOverlay.style.left = rect.left + 'px';
        dzOverlay.style.width = rect.width + 'px';
        dzOverlay.style.height = rect.height + 'px';
        dzOverlay.style.display = 'block';
        dzOverlay.style.pointerEvents = 'all';
    }

    function hideDropZones() {
        dzOverlay.style.display = 'none';
        dzOverlay.style.pointerEvents = 'none';
        activeDropPanel = null;
    }

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        // Find panel under mouse
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const panel = el ? el.closest('.ns-dock-panel') : null;
        
        if (panel && panel !== window._dockDraggingPanel) {
            showDropZones(panel);
        } else if (!dzOverlay.contains(el)) {
            hideDropZones();
        }
    });

    document.addEventListener('dragend', () => {
        hideDropZones();
        window._dockDraggingPanel = null;
    });

    function handleDrop(source, target, dir) {
        if (!source || !target || source === target || source.contains(target) || target.contains(source)) return;

        const isHorizontal = dir === 'left' || dir === 'right';
        const split = document.createElement('div');
        split.className = isHorizontal ? 'ns-split-row' : 'ns-split-col';
        
        // Preserve target's outer flex behavior
        split.style.flex = target.style.flex;
        
        target.parentNode.insertBefore(split, target);
        
        // If they are flexible panels, let them share space equally
        if (source.style.flex.includes('auto') && target.style.flex.includes('auto')) {
            source.style.flex = '1 1 0%';
            target.style.flex = '1 1 0%';
        }
        
        if (dir === 'left' || dir === 'top') {
            split.appendChild(source);
            split.appendChild(target);
        } else if (dir === 'right' || dir === 'bottom') {
            split.appendChild(target);
            split.appendChild(source);
        } else if (dir === 'center') {
            split.appendChild(target);
            split.appendChild(source);
        }

        cleanupSplits(document.body);
    }

    function cleanupSplits(container) {
        // Remove empty splits or flatten nested splits of same direction
        const splits = container.querySelectorAll('.ns-split-row, .ns-split-col');
        splits.forEach(s => {
            if (s.children.length === 0) {
                s.remove();
            } else if (s.children.length === 1) {
                // Flatten
                const child = s.children[0];
                child.style.flex = s.style.flex;
                s.parentNode.insertBefore(child, s);
                s.remove();
            }
        });
    }
});
