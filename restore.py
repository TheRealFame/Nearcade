import subprocess

with open('/tmp/user_files.txt') as f:
    lines = f.read().splitlines()

files_to_restore = []
for line in lines:
    parts = line.split('\t')
    if len(parts) < 2:
        continue
    file_path = parts[1]
    
    # Exclude files I modified specifically for the folder restructuring
    if file_path.startswith('.github/'): continue
    if file_path.startswith('services/'): continue
    if file_path == 'package.json': continue
    if file_path == 'package-lock.json': continue
    if file_path == 'wrangler.jsonc': continue
    
    files_to_restore.append(file_path)

if files_to_restore:
    # We must account for the fact that 'packages/' was renamed to 'tools/npm-packages/'
    # wait! The user's changes were in 'packages/native-palette/linux-kde.js'
    # if we checkout 'packages/native-palette/linux-kde.js', it will recreate the 'packages/' directory!
    # Let's just checkout the blob and put it in the right place!
    for fp in files_to_restore:
        # Get blob content
        content = subprocess.check_output(['git', 'show', f'e4aa3362:{fp}'])
        
        # Remap 'packages/...' to 'tools/npm-packages/...'
        target_path = fp
        if target_path.startswith('packages/'):
            target_path = target_path.replace('packages/', 'tools/npm-packages/', 1)
            
        # Write to target path
        import os
        os.makedirs(os.path.dirname(target_path) or '.', exist_ok=True)
        with open(target_path, 'wb') as out:
            out.write(content)
            
    print("Restored", len(files_to_restore), "files.")
