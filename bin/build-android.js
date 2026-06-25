const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist-android');
const src = path.join(__dirname, '..', 'src');
const root = path.join(__dirname, '..');

// Clean dist-android
if (fs.existsSync(dist)) {
    fs.rmSync(dist, { recursive: true, force: true });
}
fs.mkdirSync(dist);

// Helper to process HTML files
function processHtml(srcPath, destPath, extraHead = '') {
    let content = fs.readFileSync(srcPath, 'utf8');
    content = content.replace(/\.\.\/scripts\//g, 'js/');
    content = content.replace(/\.\.\/css\//g, 'css/');
    content = content.replace(/\.\.\/\.\.\/assets\//g, 'assets/');
    content = content.replace(/\/assets\//g, 'assets/');
    if (extraHead) {
        content = content.replace(/<\/head>/, extraHead + '</head>');
    }
    fs.writeFileSync(destPath, content);
}

// Copy pages
console.log('Copying HTML pages...');
processHtml(path.join(src, 'pages', 'dashboard.html'), path.join(dist, 'index.html'), '<style>#tab-host, #tab-containers, #settingRowOldUI, #settingRowAutoHost, #settingRowTray, #settingRowAlwaysOnTop, #settingRowHidePreview, #settingRowMic { display: none !important; }</style>');
processHtml(path.join(src, 'pages', 'index.html'), path.join(dist, 'viewer.html'));
processHtml(path.join(src, 'pages', 'gamepad-popup.html'), path.join(dist, 'gamepad-popup.html'), '<style>.host-only, [id*="driver"], [id*="Driver"], [class*="driver"] { display: none !important; }</style>');

// Copy scripts
console.log('Copying scripts...');
fs.mkdirSync(path.join(dist, 'js'));
const scripts = fs.readdirSync(path.join(src, 'scripts'));
for (const s of scripts) {
    if (s.endsWith('.js') || s.endsWith('.mjs')) {
        fs.copyFileSync(path.join(src, 'scripts', s), path.join(dist, 'js', s));
    }
}

// Copy assets
console.log('Copying assets...');
function copyRecursive(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const item of fs.readdirSync(srcDir)) {
        const sPath = path.join(srcDir, item);
        const dPath = path.join(destDir, item);
        if (fs.lstatSync(sPath).isDirectory()) {
            copyRecursive(sPath, dPath);
        } else {
            fs.copyFileSync(sPath, dPath);
        }
    }
}
copyRecursive(path.join(root, 'assets'), path.join(dist, 'assets'));

console.log('Android dist built successfully!');
