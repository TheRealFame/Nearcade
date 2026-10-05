{
  "variables": {
    # Override with: node-gyp rebuild --va_include=/path/to/headers
    # (needs the 'va' subdir, e.g. <dir>/va/va.h). Defaults to system headers.
    "va_include%": "/usr/include"
  },
  "targets": [
    {
      "target_name": "capture_linux",
      "sources": [ "capture-linux.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "/usr/include/libdrm"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "libraries": [ "-ldrm" ],
      "cflags_cc": [ "-std=c++17", "-O3" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    },
    {
      "target_name": "vaapi_encoder",
      "sources": [ "vaapi_encoder.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(va_include)"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "libraries": [ "-lva", "-lva-drm" ],
      "cflags_cc": [ "-std=c++17", "-O3" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    },
    {
      "target_name": "avcodec_encoder",
      "sources": [ "avcodec_encoder.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "/usr/include/x86_64-linux-gnu",
        "<(va_include)"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "libraries": [ "-lavcodec", "-lavutil" ],
      "cflags_cc": [ "-std=c++17", "-O3" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ],
  "conditions": [
    ["OS=='win'", {
      "targets": [
        {
          "target_name": "capture_win",
          "sources": [ "capture-win.cc" ],
          "include_dirs": [ "<!@(node -p \"require('node-addon-api').include\")" ],
          "dependencies": [ "<!(node -p \"require('node-addon-api').gyp\")" ],
          "libraries": [ "-ldxgi.lib", "-ld3d11.lib" ],
          "cflags_cc": [ "-std=c++17", "-O3" ],
          "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
        }
      ]
    }]
  ]
}

