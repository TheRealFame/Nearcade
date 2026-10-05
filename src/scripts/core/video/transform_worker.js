// WebRTC Encoded Transform Worker
// This worker intercepts raw encoded video frames before they are packetized
// by WebRTC (Sender) and after they are depacketized (Receiver).

const MAGIC_SIG = 0x4E524344; // 'NRCD'

let pendingMetadata = [];

// Listen for metadata payloads from the main thread
self.onmessage = (e) => {
    if (e.data && e.data.type === 'inject_metadata') {
        pendingMetadata.push(e.data.payload);
    }
};

onrtctransform = (event) => {
    const transformer = event.transformer;
    const isSender = transformer.options.side === 'sender';

    transformer.reader = transformer.readable.getReader();
    transformer.writer = transformer.writable.getWriter();

    function processFrames() {
        transformer.reader.read().then(({ done, value }) => {
            if (done) return;
            
            // 'value' is an RTCEncodedVideoFrame
            let data = new Uint8Array(value.data);
            
            if (isSender) {
                // SENDER MODE: Inject custom metadata into the frame
                if (pendingMetadata.length > 0) {
                    // Combine all pending metadata into one JSON array
                    const metaStr = JSON.stringify(pendingMetadata);
                    pendingMetadata = []; // Clear queue
                    
                    const textEncoder = new TextEncoder();
                    const metaBytes = textEncoder.encode(metaStr);
                    
                    // Create a new buffer: Original Data + MetaBytes + MetaLength (4 bytes) + MagicSig (4 bytes)
                    const newBuffer = new ArrayBuffer(data.byteLength + metaBytes.byteLength + 8);
                    const newView = new DataView(newBuffer);
                    const newArray = new Uint8Array(newBuffer);
                    
                    newArray.set(data, 0); // Original frame
                    newArray.set(metaBytes, data.byteLength); // Metadata
                    
                    // Append Length & Magic Signature
                    newView.setUint32(data.byteLength + metaBytes.byteLength, metaBytes.byteLength, true);
                    newView.setUint32(data.byteLength + metaBytes.byteLength + 4, MAGIC_SIG, true);
                    
                    value.data = newBuffer;
                }
            } else {
                // RECEIVER MODE: Extract metadata if signature matches
                if (data.byteLength >= 8) {
                    const view = new DataView(value.data);
                    const sig = view.getUint32(data.byteLength - 4, true);
                    
                    if (sig === MAGIC_SIG) {
                        const metaLen = view.getUint32(data.byteLength - 8, true);
                        if (metaLen > 0 && data.byteLength >= 8 + metaLen) {
                            const originalLen = data.byteLength - 8 - metaLen;
                            const metaBytes = new Uint8Array(value.data, originalLen, metaLen);
                            
                            try {
                                const metaStr = new TextDecoder().decode(metaBytes);
                                const parsed = JSON.parse(metaStr);
                                // Post back to main viewer thread
                                self.postMessage({ type: 'frame_metadata', payload: parsed });
                            } catch (e) {
                                console.warn('[TransformWorker] Failed to parse injected metadata', e);
                            }
                            
                            // Strip the metadata so the decoder gets a clean video frame
                            value.data = value.data.slice(0, originalLen);
                        }
                    }
                }
            }

            // Write the frame back to the WebRTC pipeline
            transformer.writer.write(value).then(processFrames);
        }).catch(err => {
            console.error('[EncodedTransformWorker] Frame processing error:', err);
        });
    }
    
    processFrames();
};
