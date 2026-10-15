package org.cutefame.nearsectogether;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 1. Thread Priority & Core Pinning (Push UI/Input thread to absolute maximum)
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_DISPLAY);

        // 2. Prevent Display Sleep
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 3. Force Hardware Acceleration for WebRTC & WebCodecs rendering
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        );
    }

    @Override
    public void onStart() {
        super.onStart();
        // 6. Maximize WebView Performance
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            // Force high-performance rendering modes
            webView.setLayerType(WebView.LAYER_TYPE_HARDWARE, null);
            settings.setOffscreenPreRaster(true);
        }
    }
}
