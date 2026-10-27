package org.cutefame.nearsectogether;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
    public void onBackPressed() {
        try {
            if (this.bridge != null && this.bridge.getWebView() != null) {
                String currentUrl = this.bridge.getWebView().getUrl();
                String appUrl = this.bridge.getAppUrl();
                if (currentUrl != null && appUrl != null && !currentUrl.startsWith(appUrl)) {
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
        public void backToDashboard() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
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
