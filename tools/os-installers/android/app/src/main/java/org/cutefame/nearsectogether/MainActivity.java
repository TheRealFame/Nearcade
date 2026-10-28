package org.cutefame.nearsectogether;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public class MainActivity extends BridgeActivity {
    private boolean isImmersiveActive = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                getWindow().setAttributes(lp);
            } catch (Exception ignored) {}
        }
        try {
            if (this.bridge != null && this.bridge.getWebView() != null) {
                android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
                cookieManager.setAcceptCookie(true);
                cookieManager.setAcceptThirdPartyCookies(this.bridge.getWebView(), true);
                syncTextZoom();
                this.bridge.getWebView().addJavascriptInterface(new AndroidNativeClipboard(), "AndroidClipboard");
            }
            getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    try {
                        if (bridge != null && bridge.getWebView() != null) {
                            String currentUrl = bridge.getWebView().getUrl();
                            String appUrl = bridge.getAppUrl();
                            if (currentUrl != null && appUrl != null && !currentUrl.startsWith(appUrl)) {
                                applyImmersiveMode(false);
                                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                                bridge.getWebView().loadUrl(appUrl);
                                return;
                            }
                        }
                    } catch (Exception ignored) {}
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            });
        } catch (Exception ignored) {}
    }

    private void syncTextZoom() {
        try {
            if (this.bridge != null && this.bridge.getWebView() != null) {
                float fontScale = getResources().getConfiguration().fontScale;
                this.bridge.getWebView().getSettings().setTextZoom((int) (fontScale * 100));
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onResume() {
        super.onResume();
        syncTextZoom();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && isImmersiveActive) {
            applyImmersiveMode(true);
        }
    }

    public void applyImmersiveMode(final boolean enable) {
        isImmersiveActive = enable;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        getWindow().setDecorFitsSystemWindows(!enable);
                        WindowInsetsController insetsController = getWindow().getInsetsController();
                        if (insetsController != null) {
                            if (enable) {
                                insetsController.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                                insetsController.setSystemBarsBehavior(
                                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                                );
                            } else {
                                insetsController.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                            }
                        }
                    }
                    View decorView = getWindow().getDecorView();
                    if (decorView != null) {
                        if (enable) {
                            decorView.setSystemUiVisibility(
                                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                            );
                        } else {
                            decorView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
                        }
                    }
                } catch (Exception ignored) {}
            }
        });
    }

    @Override
    public void onBackPressed() {
        try {
            if (this.bridge != null && this.bridge.getWebView() != null) {
                String currentUrl = this.bridge.getWebView().getUrl();
                String appUrl = this.bridge.getAppUrl();
                if (currentUrl != null && appUrl != null && !currentUrl.startsWith(appUrl)) {
                    applyImmersiveMode(false);
                    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                    this.bridge.getWebView().loadUrl(appUrl);
                    return;
                }
            }
        } catch (Exception ignored) {}
        super.onBackPressed();
    }

    public class AndroidNativeClipboard {
        @JavascriptInterface
        public String getClipboard() {
            final AtomicReference<String> result = new AtomicReference<>("");
            final CountDownLatch latch = new CountDownLatch(1);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (clipboard != null && clipboard.hasPrimaryClip() && clipboard.getPrimaryClip().getItemCount() > 0) {
                            CharSequence text = clipboard.getPrimaryClip().getItemAt(0).getText();
                            if (text != null) {
                                result.set(text.toString());
                            }
                        }
                    } catch (Exception ignored) {}
                    finally {
                        latch.countDown();
                    }
                }
            });
            try {
                latch.await(500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ignored) {}
            return result.get();
        }

        @JavascriptInterface
        public boolean setClipboard(final String text) {
            final AtomicBoolean success = new AtomicBoolean(false);
            final CountDownLatch latch = new CountDownLatch(1);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (clipboard != null) {
                            ClipData clip = ClipData.newPlainText("Nearcade", text);
                            clipboard.setPrimaryClip(clip);
                            success.set(true);
                        }
                    } catch (Exception ignored) {}
                    finally {
                        latch.countDown();
                    }
                }
            });
            try {
                latch.await(500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ignored) {}
            return success.get();
        }

        @JavascriptInterface
        public String getSystemAccentColor() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    try {
                        int color = getColor(android.R.color.system_accent1_500);
                        if ((0xFFFFFF & color) != 0) {
                            return String.format("#%06X", (0xFFFFFF & color));
                        }
                    } catch (Exception ignored) {}
                    try {
                        int color = getColor(android.R.color.system_accent1_600);
                        if ((0xFFFFFF & color) != 0) {
                            return String.format("#%06X", (0xFFFFFF & color));
                        }
                    } catch (Exception ignored) {}
                    try {
                        int resId = getResources().getIdentifier("system_accent1_500", "color", "android");
                        if (resId != 0) {
                            int color = getResources().getColor(resId, getTheme());
                            if ((0xFFFFFF & color) != 0) {
                                return String.format("#%06X", (0xFFFFFF & color));
                            }
                        }
                    } catch (Exception ignored) {}
                }
                android.util.TypedValue typedValue = new android.util.TypedValue();
                if (getTheme().resolveAttribute(android.R.attr.colorAccent, typedValue, true) && typedValue.data != 0) {
                    return String.format("#%06X", (0xFFFFFF & typedValue.data));
                }
                int attrId = getResources().getIdentifier("colorAccent", "attr", getPackageName());
                if (attrId != 0 && getTheme().resolveAttribute(attrId, typedValue, true) && typedValue.data != 0) {
                    return String.format("#%06X", (0xFFFFFF & typedValue.data));
                }
            } catch (Exception ignored) {}
            return "";
        }

        @JavascriptInterface
        public String getNativeThemeJson() {
            try {
                boolean isDark = (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES;
                String accent = getSystemAccentColor();
                if (accent == null || accent.isEmpty() || !accent.startsWith("#")) {
                    accent = "#c084fc";
                }
                String bg, surface, surfaceHover, sidebar, text, muted, border;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    try {
                        if (isDark) {
                            int cBg = getColor(android.R.color.system_neutral1_900);
                            int cSurf = getColor(android.R.color.system_neutral1_800);
                            int cSurfHover = getColor(android.R.color.system_neutral1_700);
                            bg = String.format("#%06X", (0xFFFFFF & cBg));
                            surface = String.format("#%06X", (0xFFFFFF & cSurf));
                            surfaceHover = String.format("#%06X", (0xFFFFFF & cSurfHover));
                            sidebar = surface;
                            text = "#f3f4f6";
                            muted = "#9ca3af";
                            border = "rgba(255,255,255,0.1)";
                        } else {
                            int cBg = getColor(android.R.color.system_neutral1_50);
                            int cSurf = getColor(android.R.color.system_neutral1_100);
                            int cSurfHover = getColor(android.R.color.system_neutral1_200);
                            bg = String.format("#%06X", (0xFFFFFF & cBg));
                            surface = String.format("#%06X", (0xFFFFFF & cSurf));
                            surfaceHover = String.format("#%06X", (0xFFFFFF & cSurfHover));
                            sidebar = surface;
                            text = "#111827";
                            muted = "#4b5563";
                            border = "rgba(0,0,0,0.1)";
                        }
                    } catch (Exception e) {
                        bg = isDark ? "#121214" : "#f8f9fa";
                        surface = isDark ? "#1e1e24" : "#ffffff";
                        surfaceHover = isDark ? "#282830" : "#f1f3f5";
                        sidebar = surface;
                        text = isDark ? "#f3f4f6" : "#111827";
                        muted = isDark ? "#9ca3af" : "#4b5563";
                        border = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
                    }
                } else {
                    bg = isDark ? "#121214" : "#f8f9fa";
                    surface = isDark ? "#1e1e24" : "#ffffff";
                    surfaceHover = isDark ? "#282830" : "#f1f3f5";
                    sidebar = surface;
                    text = isDark ? "#f3f4f6" : "#111827";
                    muted = isDark ? "#9ca3af" : "#4b5563";
                    border = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
                }
                return String.format("{\"bg\":\"%s\",\"surface\":\"%s\",\"surfaceHover\":\"%s\",\"sidebar\":\"%s\",\"text\":\"%s\",\"muted\":\"%s\",\"border\":\"%s\",\"accent\":\"%s\"}",
                    bg, surface, surfaceHover, sidebar, text, muted, border, accent);
            } catch (Exception ignored) {}
            return "";
        }

        @JavascriptInterface
        public void setImmersive(final boolean enabled) {
            applyImmersiveMode(enabled);
        }

        @JavascriptInterface
        public void setOrientation(final String mode) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if ("landscape".equalsIgnoreCase(mode)) {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                        } else if ("portrait".equalsIgnoreCase(mode)) {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
                        } else {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                        }
                    } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public void backToDashboard() {
            applyImmersiveMode(false);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                        if (bridge != null && bridge.getWebView() != null) {
                            String appUrl = bridge.getAppUrl();
                            if (appUrl != null) {
                                bridge.getWebView().loadUrl(appUrl);
                            }
                        }
                    } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public int getStatusBarHeight() {
            try {
                int resourceId = getResources().getIdentifier("status_bar_height", "dimen", "android");
                if (resourceId > 0) {
                    return getResources().getDimensionPixelSize(resourceId);
                }
            } catch (Exception ignored) {}
            return 0;
        }

        @JavascriptInterface
        public float getFontScale() {
            try {
                return getResources().getConfiguration().fontScale;
            } catch (Exception ignored) {}
            return 1.0f;
        }
    }
}
