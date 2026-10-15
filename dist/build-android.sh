#!/usr/bin/env bash
set -e

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=============================================="
echo " Nearcade Android APK One-Click Build Script "
echo "=============================================="

# 1. Auto-detect Java 21 (Gradle 8.x + AGP requires Java 21)
if [ -z "$JAVA_HOME" ] || [ ! -d "$JAVA_HOME" ]; then
    if [ -d "/usr/lib/jvm/java-21-openjdk-amd64" ]; then
        export JAVA_HOME="/usr/lib/jvm/java-21-openjdk-amd64"
    elif [ -d "/usr/lib/jvm/java-21-openjdk" ]; then
        export JAVA_HOME="/usr/lib/jvm/java-21-openjdk"
    else
        POSSIBLE_JAVA=$(find /usr/lib/jvm -maxdepth 1 -type d -name "*21*" 2>/dev/null | head -n 1)
        if [ -n "$POSSIBLE_JAVA" ]; then
            export JAVA_HOME="$POSSIBLE_JAVA"
        fi
    fi
fi

if [ -n "$JAVA_HOME" ]; then
    export PATH="$JAVA_HOME/bin:$PATH"
    echo "Using JAVA_HOME: $JAVA_HOME"
else
    echo "Warning: Java 21 not detected in /usr/lib/jvm. Using system java:"
    java -version || true
fi

# 2. Auto-detect Android SDK
if [ -z "$ANDROID_HOME" ] || [ ! -d "$ANDROID_HOME" ]; then
    if [ -d "$HOME/Android/Sdk" ]; then
        export ANDROID_HOME="$HOME/Android/Sdk"
    elif [ -d "/home/fame/Android/Sdk" ]; then
        export ANDROID_HOME="/home/fame/Android/Sdk"
    fi
fi

if [ -n "$ANDROID_HOME" ]; then
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    echo "Using ANDROID_HOME: $ANDROID_HOME"
    # Ensure local.properties exists for Gradle
    echo "sdk.dir=$ANDROID_HOME" > "$REPO_ROOT/packaging/android/local.properties"
else
    echo "Warning: Android SDK not automatically found in $HOME/Android/Sdk"
fi

# 3. Synchronize Web Assets into Android App
echo ""
echo "=== Step 1/3: Syncing Android Web Assets ==="
cd "$REPO_ROOT"
node bin/build-android.js

# 4. Compile Signed Android APK via Gradle
echo ""
echo "=== Step 2/3: Compiling Release APK via Gradle ==="
cd "$REPO_ROOT/packaging/android"
chmod +x ./gradlew
./gradlew assembleRelease

# 5. Copy output APK into dist/
echo ""
echo "=== Step 3/3: Finalizing APK in dist/ ==="
APK_SRC="$REPO_ROOT/packaging/android/app/build/outputs/apk/release/app-release.apk"
APK_DEST="$REPO_ROOT/dist/Nearcade.apk"

if [ -f "$APK_SRC" ]; then
    cp "$APK_SRC" "$APK_DEST"
    echo "=============================================="
    echo "✓ Android APK build succeeded!"
    echo "  Location: $APK_DEST"
    echo "  Size:     $(du -h "$APK_DEST" | cut -f1)"
    echo "=============================================="
else
    echo "Error: Expected APK output at $APK_SRC was not found." >&2
    exit 1
fi
