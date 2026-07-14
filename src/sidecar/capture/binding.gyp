{
  "targets": [
    {
      "target_name": "capture_win",
      "sources": [ "capture-win.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "-ldxgi.lib",
            "-ld3d11.lib"
          ]
        }]
      ],
      "cflags_cc": [ "-std=c++17", "-O3" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ]
}

