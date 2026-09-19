package com.bkt.wallet;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import com.bkt.wallet.BuildConfig;

import java.io.File;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "bkt_wallet";
    private static final String KEY_URL = "server_url";
    private static final String DEFAULT_URL = "https://ewallet-36dc.up.railway.app";

    private WebView webView;
    private ProgressBar progressBar;
    private View errorView;
    private SharedPreferences prefs;
    private final Handler timeoutHandler = new Handler();
    private Runnable timeoutRunnable;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep screen on for POS use
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);
        errorView = findViewById(R.id.errorView);

        setupWebView();

        // Clear invalid URLs (e.g. GitHub URLs accidentally saved), then load
        String savedUrl = prefs.getString(KEY_URL, "");
        if (!savedUrl.isEmpty() && !isValidServerUrl(savedUrl)) {
            prefs.edit().remove(KEY_URL).apply();
        }
        loadServerUrl();

        // Long-press title area to change URL
        findViewById(R.id.titleBar).setOnLongClickListener(v -> {
            showUrlDialog(false);
            return true;
        });

        findViewById(R.id.btnRetry).setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            loadServerUrl();
        });

        findViewById(R.id.btnChangeUrl).setOnClickListener(v -> showUrlDialog(false));
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // Expose app version to JavaScript synchronously
        webView.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public String getVersion() {
                return BuildConfig.VERSION_NAME;
            }
        }, "BKTWallet");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                errorView.setVisibility(View.GONE);
                // Start 10-second timeout
                if (timeoutRunnable != null) timeoutHandler.removeCallbacks(timeoutRunnable);
                timeoutRunnable = () -> {
                    progressBar.setVisibility(View.GONE);
                    errorView.setVisibility(View.VISIBLE);
                    String base = prefs.getString(KEY_URL, DEFAULT_URL);
                    ((TextView) findViewById(R.id.tvErrorUrl)).setText(base + "/admin");
                };
                timeoutHandler.postDelayed(timeoutRunnable, 10000);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                if (timeoutRunnable != null) timeoutHandler.removeCallbacks(timeoutRunnable);
                // Detect silent blank page (server unreachable on Samsung WebView)
                if (url == null || url.equals("about:blank") || url.isEmpty()) {
                    errorView.setVisibility(View.VISIBLE);
                    String base = prefs.getString(KEY_URL, DEFAULT_URL);
                    ((TextView) findViewById(R.id.tvErrorUrl)).setText(base + "/admin");
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame()) {
                    progressBar.setVisibility(View.GONE);
                    errorView.setVisibility(View.VISIBLE);
                    String url = prefs.getString(KEY_URL, DEFAULT_URL);
                    ((TextView) findViewById(R.id.tvErrorUrl)).setText(url);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                // Open external links in browser, keep same-host in WebView
                String serverUrl = prefs.getString(KEY_URL, DEFAULT_URL);
                Uri serverUri = Uri.parse(serverUrl);
                Uri reqUri = request.getUrl();
                if (reqUri.getHost() != null && reqUri.getHost().equals(serverUri.getHost())) {
                    return false;
                }
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                return true;
            }
        });

        // Handle APK and file downloads
        // Handle target="_blank" links — open in external browser
        webView.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
                String url = view.getHitTestResult().getExtra();
                if (url != null) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                }
                return false;
            }
        });
        settings.setSupportMultipleWindows(true);

        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url.endsWith(".apk") || "application/vnd.android.package-archive".equals(mimetype)) {
                downloadApk(url, URLUtil.guessFileName(url, contentDisposition, mimetype));
            } else {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimetype);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        URLUtil.guessFileName(url, contentDisposition, mimetype));
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                dm.enqueue(request);
                Toast.makeText(this, "Downloading...", Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void downloadApk(String url, String fileName) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("BKT Wallet Update");
            request.setDescription("Downloading " + fileName);
            request.setMimeType("application/vnd.android.package-archive");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            long downloadId = dm.enqueue(request);

            Toast.makeText(this, "Downloading update. Check notifications when done.", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            // Fallback: open in browser
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        }
    }

    private void loadServerUrl() {
        String base = prefs.getString(KEY_URL, DEFAULT_URL);
        // Always start on admin panel
        String url = base.replaceAll("/+$", "") + "/admin";
        if (!isNetworkAvailable()) {
            errorView.setVisibility(View.VISIBLE);
            ((TextView) findViewById(R.id.tvErrorUrl)).setText(url);
            return;
        }
        webView.loadUrl(url);
    }

    private void showUrlDialog(boolean isFirstLaunch) {
        String current = prefs.getString(KEY_URL, DEFAULT_URL);
        EditText input = new EditText(this);
        input.setText(current);
        input.setSelection(current.length());
        input.setSingleLine(true);
        input.setPadding(48, 32, 48, 32);

        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle(isFirstLaunch ? "Server URL" : "Change Server URL")
                .setMessage("Enter the BKT Wallet server address:")
                .setView(input)
                .setCancelable(!isFirstLaunch)
                .setPositiveButton("Connect", (dialog, which) -> {
                    String url = input.getText().toString().trim();
                    if (!url.isEmpty()) {
                        if (!url.startsWith("http://") && !url.startsWith("https://")) {
                            url = "http://" + url;
                        }
                        prefs.edit().putString(KEY_URL, url).apply();
                        loadServerUrl();
                    }
                });

        if (!isFirstLaunch) {
            builder.setNegativeButton("Cancel", null);
        }

        builder.show();
    }

    private boolean isValidServerUrl(String url) {
        // Reject GitHub, Play Store, or non-http URLs
        if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
        if (url.contains("github.com") || url.contains("play.google.com")) return false;
        return true;
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkInfo info = cm.getActiveNetworkInfo();
        return info != null && info.isConnected();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }
}
