def init_plugin(intercept_layer):
    print("[MockPlugin] Initializing...")
    
    def on_input(data: bytes) -> bytes:
        # Just logging for demonstration
        print(f"[MockPlugin] Intercepted input payload of {len(data)} bytes")
        # In a real plugin, you could modify the bytes here
        return data
        
    intercept_layer.register_hook("mock-plugin-1", on_input, kind="input")
    print("[MockPlugin] Input hook registered successfully!")
