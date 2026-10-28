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
                    int color = getColor(android.R.color.system_accent1_500);
                    return String.format("#%06X", (0xFFFFFF & color));
                } else {
                    android.util.TypedValue typedValue = new android.util.TypedValue();
                    if (getTheme().resolveAttribute(android.R.attr.colorAccent, typedValue, true)) {
                        return String.format("#%06X", (0xFFFFFF & typedValue.data));
                    }
                }
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
    }
}
