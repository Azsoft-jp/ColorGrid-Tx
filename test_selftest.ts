import { ColorGridEncoder } from "./src/encoder";
import { ColorGridDecoder } from "./src/decoder";
import { GRID_PROFILES, GridProfileId } from "./src/types";
import { isReservedCell } from "./src/utils";

// Simulate of Canvas and context in node.
// To avoid canvas dependency in node, we can use a mock Canvas!
// Wait, a mock canvas has width and height, and rendering writes to a pixel array, or we can use a simple 2D buffer.
// Let's create a real-ish canvas mockup!
class MockCanvas {
  width = 0;
  height = 0;
  data: Uint8ClampedArray = new Uint8ClampedArray(0);

  getContext(type: string) {
    if (type !== "2d") return null;
    const self = this;
    const ctx = {
      imageSmoothingEnabled: false,
      fillStyle: "",
      fillRect(x: number, y: number, w: number, h: number) {
        // Parse fillStyle, supporting rgb(r, g, b) or #hex
        let r = 255, g = 255, b = 255;
        const style = ctx.fillStyle;
        if (style.startsWith("rgb")) {
          const parts = style.match(/\d+/g);
          if (parts) {
            r = parseInt(parts[0]);
            g = parseInt(parts[1]);
            b = parseInt(parts[2]);
          }
        } else if (style.startsWith("#")) {
          const hex = style.slice(1);
          if (hex.length === 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
          } else if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
          }
        }
        for (let dy = 0; dy < h; dy++) {
          const cy = y + dy;
          if (cy < 0 || cy >= self.height) continue;
          for (let dx = 0; dx < w; dx++) {
            const cx = x + dx;
            if (cx < 0 || cx >= self.width) continue;
            const i = (cy * self.width + cx) * 4;
            self.data[i] = r;
            self.data[i + 1] = g;
            self.data[i + 2] = b;
            self.data[i + 3] = 255;
          }
        }
      },
      getImageData(x: number, y: number, w: number, h: number) {
        return {
          width: w,
          height: h,
          data: self.data
        };
      }
    };
    return ctx;
  }
}

// Global visual document structure for the test
if (typeof document === "undefined") {
  (global as any).document = {
    createElement(type: string) {
      if (type === "canvas") return new MockCanvas();
      return {};
    }
  };
}

function runTest(profileId: GridProfileId, cellSize: number, marginCells: number) {
  const canvas = new MockCanvas();
  // Set width/height manually since MockCanvas is not automatically setting it when the property is updated on canvas? 
  // Wait, let's make sure ColorGridEncoder works if we intercept width/height setters.
  Object.defineProperty(canvas, "width", {
    get() { return this._width; },
    set(v) {
      this._width = v;
      if (this.height) {
        this.data = new Uint8ClampedArray(this._width * this._height * 4);
      }
    }
  });
  Object.defineProperty(canvas, "height", {
    get() { return this._height; },
    set(v) {
      this._height = v;
      if (this._width) {
        this.data = new Uint8ClampedArray(this._width * this._height * 4);
      }
    }
  });

  const encoder = new ColorGridEncoder(canvas as any);
  encoder.setProfile(profileId);
  encoder.setCellSize(cellSize);
  encoder.setMarginCells(marginCells);

  // Generate a large payload (chunk size like 500 bytes)
  const data = new Uint8Array(262198);
  for (let i = 0; i < 262198; i++) data[i] = i % 256;
  encoder.setData(data, { type: "file" });

  const profile = GRID_PROFILES[profileId];
  let dataCells = 0;
  for (let y = 0; y < profile.size; y++) {
    for (let x = 0; x < profile.size; x++) {
      if (!isReservedCell(x, y, profile)) dataCells++;
    }
  }
  const totalBytesPerFrame = Math.floor(dataCells * 3 / 8);
  const dataBytesPerFrame = Math.floor(totalBytesPerFrame / 1.25);
  const parityBytes = totalBytesPerFrame - dataBytesPerFrame;
  console.log(`Profile: ${profileId}, dataCells: ${dataCells}, totalBytesPerFrame: ${totalBytesPerFrame}, dataBytesPerFrame: ${dataBytesPerFrame}, parityBytes: ${parityBytes}`);

  console.log(`Total CHUNKS for ${profileId} (${GRID_PROFILES[profileId].size}x${GRID_PROFILES[profileId].size}): ${encoder.getStats().totalChunks}`);

  const t0 = performance.now();
  // Try encoding chunk 0
  encoder.renderChunk(0);
  const t1 = performance.now();
  console.log(`renderChunk took ${Math.round(t1 - t0)}ms`);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.error("No context");
    return;
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const decoder = new ColorGridDecoder();
  const t2 = performance.now();
  const res = decoder.decodeFrame(imageData as any);
  const t3 = performance.now();
  console.log(`decodeFrame took ${Math.round(t3 - t2)}ms`);

  console.log("Found Finder Centers:", res.debug?.finderPoints);
  console.log("Estimated corners:", res.debug?.corners);
  console.log("Detected profile ID:", res.debug?.detectedProfileId);

  console.log(`Profile: ${profileId}, cellSize: ${cellSize}, margin: ${marginCells}`);
  console.log(`Decode OK? ${res.ok}`);
  if (!res.ok) {
    console.log(`Reason: ${res.reason}`);
    console.log(`Debug Logs:`, (decoder as any).debugLogs ? (decoder as any).debugLogs.slice(-20) : "none");
    console.log(`Debug Centers Count:`, (decoder as any).debugCentersCount);
    console.log(`Debug Clusters Count:`, (decoder as any).debugClustersCount);
  } else {
    console.log(`Successfully decoded! Chunk: ${res.chunk?.chunkIndex}/${res.chunk?.totalChunks}`);
  }
}

console.log("=== Testing Micro (XS) ===");
runTest("XS", 8, 4);

console.log("\n=== Testing Medium (M) ===");
runTest("M", 5, 4);
