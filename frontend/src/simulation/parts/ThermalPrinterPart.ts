import { PartSimulationRegistry } from './PartSimulationRegistry';

const SIDECAR_URL_DEFAULT = 'http://localhost:9100';

// ESC/POS parser states
type ParserState = 'idle' | 'esc' | 'gs' | 'gs_v' | 'raster_header' | 'raster_data' | 'dle' | 'status_query';

PartSimulationRegistry.register('thermal-printer', {
  attachEvents: (element, simulator, getArduinoPinHelper, componentId) => {
    const sim = simulator as any;
    const el = element as any;
    const deviceId: string = el.deviceId ?? 'EM0000000001';
    const sidecarUrl: string = el.sidecarUrl ?? SIDECAR_URL_DEFAULT;

    // Parser state
    let state: ParserState = 'idle';
    let headerBuf: number[] = [];
    let rasterData: Uint8Array | null = null;
    let rasterOffset = 0;
    let rasterBytesPerRow = 0;
    let rasterHeight = 0;

    function resetParser() {
      state = 'idle';
      headerBuf = [];
      rasterData = null;
      rasterOffset = 0;
    }

    function respondToFirmware(bytes: Uint8Array) {
      if (typeof sim.uart1Write === 'function') {
        sim.uart1Write(String.fromCharCode(...bytes));
      }
    }

    async function emitRaster(width: number, height: number, data: Uint8Array) {
      // Convert to base64
      let binary = '';
      for (let i = 0; i < data.length; i++) {
        binary += String.fromCharCode(data[i]);
      }
      const rasterBase64 = btoa(binary);

      console.log(`[ThermalPrinter ${deviceId}] Raster ${width}x${height} (${data.length} bytes) → sidecar`);

      try {
        const res = await fetch(`${sidecarUrl}/print`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, width, height, raster: rasterBase64 }),
        });
        const result = await res.json();
        console.log(`[ThermalPrinter ${deviceId}] PDF saved: ${result.pdfPath}`);
      } catch (err) {
        console.error(`[ThermalPrinter ${deviceId}] Sidecar error:`, err);
      }
    }

    function processByte(byte: number) {
      switch (state) {
        case 'idle':
          if (byte === 0x1b) state = 'esc';
          else if (byte === 0x1d) state = 'gs';
          else if (byte === 0x10) state = 'dle';
          break;
        case 'esc':
          if (byte === 0x40) resetParser();
          state = 'idle';
          break;
        case 'gs':
          if (byte === 0x76) { state = 'gs_v'; }
          else if (byte === 0x72) {
            respondToFirmware(new Uint8Array([0xfe, 0x23, 0x12]));
            state = 'idle';
          } else { state = 'idle'; }
          break;
        case 'gs_v':
          if (byte === 0x30) { headerBuf = []; state = 'raster_header'; }
          else { state = 'idle'; }
          break;
        case 'raster_header':
          headerBuf.push(byte);
          if (headerBuf.length === 5) {
            rasterBytesPerRow = headerBuf[1] | (headerBuf[2] << 8);
            rasterHeight = headerBuf[3] | (headerBuf[4] << 8);
            const total = rasterBytesPerRow * rasterHeight;
            rasterData = new Uint8Array(total);
            rasterOffset = 0;
            state = 'raster_data';
          }
          break;
        case 'raster_data':
          // ESC byte interrupts raster collection (ESC @ reset is real-time)
          if (byte === 0x1b) {
            state = 'esc';
            break;
          }
          if (rasterData) {
            rasterData[rasterOffset++] = byte;
            if (rasterOffset >= rasterData.length) {
              emitRaster(rasterBytesPerRow * 8, rasterHeight, rasterData);
              rasterData = null;
              state = 'idle';
            }
          }
          break;
        case 'dle':
          if (byte === 0x04) state = 'status_query';
          else state = 'idle';
          break;
        case 'status_query':
          respondToFirmware(new Uint8Array([0x00]));
          state = 'idle';
          break;
      }
    }

    // Hook into UART1 data from the simulator
    const prevHandler = sim.onUart1Data;
    sim.onUart1Data = (ch: string) => {
      processByte(ch.charCodeAt(0));
    };

    console.log(`[ThermalPrinter] Registered for ${deviceId}, sidecar at ${sidecarUrl}`);

    return () => {
      sim.onUart1Data = prevHandler;
      resetParser();
    };
  },
});
