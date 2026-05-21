import React, { useState, useRef, useEffect } from 'react';
import { ColorGridEncoder } from './encoder';
import { ColorGridDecoder } from './decoder';
import { GRID_PROFILES, GridProfileId, DecodeDebugInfo, PayloadMeta } from './types';

export default function App() {
  const [mode, setMode] = useState<"SEND" | "RECEIVE">("SEND");
  
  // ================= SEND MODE =================
  const encCanvasRef = useRef<HTMLCanvasElement>(null);
  const [encoder, setEncoder] = useState<ColorGridEncoder | null>(null);
  const [sendText, setSendText] = useState("Hello, ColorGrid! 👋✨");
  const [profileId, setProfileId] = useState<GridProfileId>("M");
  const [cellSize, setCellSize] = useState(5);
  const [marginCells, setMarginCells] = useState(4);
  const [fps, setFps] = useState(10);
  const [isStreaming, setIsStreaming] = useState(false);
  const [encStats, setEncStats] = useState({ totalChunks: 0 });

  useEffect(() => {
    if (encCanvasRef.current && !encoder) {
      setEncoder(new ColorGridEncoder(encCanvasRef.current));
    }
  }, []);

  useEffect(() => {
    if (encoder) {
      encoder.setProfile(profileId);
      encoder.setCellSize(cellSize);
      encoder.setMarginCells(marginCells);
      updateEncData();
    }
  }, [profileId, cellSize, marginCells, sendText]);

  const updateEncData = () => {
    if (!encoder) return;
    const data = new TextEncoder().encode(sendText);
    const meta: PayloadMeta = { type: "text" };
    encoder.setData(data, meta);
    setEncStats({ totalChunks: encoder.getStats().totalChunks });
    encoder.renderChunk(0); // プレビューとして0番目を描画
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0] || !encoder) return;
    const file = e.target.files[0];
    const buffer = await file.arrayBuffer();
    const meta: PayloadMeta = { type: "file", filename: file.name, mimeType: file.type };
    encoder.setData(new Uint8Array(buffer), meta);
    setEncStats({ totalChunks: encoder.getStats().totalChunks });
    encoder.renderChunk(0);
  };

  const toggleStreaming = () => {
    if (!encoder) return;
    if (isStreaming) {
      encoder.stopStreaming();
    } else {
      updateEncData();
      encoder.startStreaming(fps);
    }
    setIsStreaming(!isStreaming);
  };

  // ================= RECEIVE MODE =================
  const videoRef = useRef<HTMLVideoElement>(null);
  const decCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [decOutputText, setDecOutputText] = useState("");
  const [debugInfo, setDebugInfo] = useState<DecodeDebugInfo | null>(null);
  const [chunksReceived, setChunksReceived] = useState<Record<number, Uint8Array>>({});
  const decoderRef = useRef(new ColorGridDecoder());

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraOn(true);
      }
    } catch (e) {
      alert("カメラの許可が取れないみ😭 " + String(e));
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
    setIsCameraOn(false);
  };

  useEffect(() => {
    let reqId: number;
    const processFrame = () => {
      if (isCameraOn && videoRef.current && decCanvasRef.current) {
        const video = videoRef.current;
        const canvas = decCanvasRef.current;
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            // 背景透過クリアしてデバッグ描画用にする
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // 解析用に裏のCanvasに映像をコピーしてImageData取得する
            const offscreenCanvas = document.createElement('canvas');
            offscreenCanvas.width = video.videoWidth;
            offscreenCanvas.height = video.videoHeight;
            const oCtx = offscreenCanvas.getContext("2d");
            if (oCtx) {
                oCtx.drawImage(video, 0, 0);
                const imageData = oCtx.getImageData(0, 0, video.videoWidth, video.videoHeight);
                const res = decoderRef.current.decodeFrame(imageData);

                setDebugInfo(res.debug || null);

                // デバッグ情報のオーバーレイ描画
                if (res.debug) {
                  if (res.debug.corners) {
                    ctx.strokeStyle = '#00ff00';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    const pts = res.debug.corners;
                    ctx.moveTo(pts[0].x, pts[0].y);
                    ctx.lineTo(pts[1].x, pts[1].y);
                    ctx.lineTo(pts[2].x, pts[2].y);
                    ctx.lineTo(pts[3].x, pts[3].y);
                    ctx.closePath();
                    ctx.stroke();
                  }
                  if (res.debug.finderPoints) {
                    ctx.fillStyle = '#ff00ff';
                    for (const p of res.debug.finderPoints) {
                      ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
                    }
                  }
                }

                if (res.ok && res.chunk) {
                  const { chunkIndex, totalChunks, payload, profileId: pId, gridSize } = res.chunk;
                  setChunksReceived(prev => {
                    const next = { ...prev, [chunkIndex]: payload };
                    
                    // 全部揃ったかの簡易確認
                    if (Object.keys(next).length >= totalChunks) {
                       // 結合（今回は順番保証や完全結合は端折ってるけど大枠で！）
                       let totalLen = 0;
                       for (let i=0; i<totalChunks; i++) totalLen += next[i].length;
                       const resultData = new Uint8Array(totalLen);
                       let offset = 0;
                       for (let i=0; i<totalChunks; i++) {
                          resultData.set(next[i], offset);
                          offset += next[i].length;
                       }
                       setDecOutputText(new TextDecoder().decode(resultData));
                    }
                    return next;
                  });
                }
            }
          }
        }
      }
      reqId = requestAnimationFrame(processFrame);
    };
    if (isCameraOn) reqId = requestAnimationFrame(processFrame);
    return () => cancelAnimationFrame(reqId);
  }, [isCameraOn]);


  // ================= SELF TEST =================
  const runSelfTest = () => {
     if (!encoder || !encCanvasRef.current) return;
     const ctx = encCanvasRef.current.getContext('2d');
     if (!ctx) return;
     
     const tStart = performance.now();
     const imageData = ctx.getImageData(0, 0, encCanvasRef.current.width, encCanvasRef.current.height);
     const decoder = new ColorGridDecoder();
     const res = decoder.decodeFrame(imageData);
     const tEnd = performance.now();
     
     if (res.ok && res.chunk) {
       const recovered = new TextDecoder().decode(res.chunk.payload);
       alert(`✅ テスト成功！\n\n[Send]: ${sendText}\n[Recovered]: ${recovered}\n[Time]: ${Math.round(tEnd - tStart)}ms`);
     } else {
       alert(`❌ テスト失敗...\n理由: ${res.reason}`);
     }
  };

  return (
    <div className="fixed inset-0 bg-[#0f1115] text-[#d1d5db] font-sans flex flex-col p-4 select-none lg:overflow-hidden overflow-y-auto">
      {/* Header Section */}
      <header className="flex flex-col md:flex-row items-center justify-between border-b border-[#2d333d] pb-4 mb-4 gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-blue-600 rounded flex items-center justify-center border border-white/20 shadow-[0_0_15px_rgba(6,182,212,0.3)] shrink-0">
            <div className="grid grid-cols-2 gap-0.5">
              <div className="w-2 h-2 bg-white"></div><div className="w-2 h-2 bg-red-500"></div>
              <div className="w-2 h-2 bg-green-500"></div><div className="w-2 h-2 bg-blue-500"></div>
            </div>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2 flex-wrap">
              ColorGrid-Tx 
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 bg-cyan-900/40 text-cyan-400 rounded border border-cyan-800">v1.1.0-alpha</span>
            </h1>
            <p className="text-[11px] text-gray-500 font-mono">OPTICAL BIT-TRANSFER PROTOCOL / PURE TS</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2 flex-wrap justify-center">
          <button onClick={runSelfTest} className="px-4 py-2 bg-[#1c1f26] border border-[#374151] rounded text-xs font-semibold hover:bg-[#2d333d] transition-colors flex items-center gap-2 text-white shadow-md">
            <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block"></span> RUN SELF-TEST
          </button>
          
          <div className="flex bg-[#1c1f26] border border-[#374151] rounded p-0.5 shadow-md">
            <button
              onClick={() => setMode("SEND")}
              className={`px-4 py-1.5 rounded text-xs font-bold transition-colors ${mode === "SEND" ? "bg-cyan-600 text-white shadow-lg shadow-cyan-900/20" : "text-gray-400 hover:text-white"}`}
            >
              ENC_MODE
            </button>
            <button
              onClick={() => setMode("RECEIVE")}
              className={`px-4 py-1.5 rounded text-xs font-bold transition-colors ${mode === "RECEIVE" ? "bg-pink-600 text-white shadow-lg shadow-pink-900/20" : "text-gray-400 hover:text-white"}`}
            >
              DEC_MODE
            </button>
          </div>
        </div>
      </header>

      {/* Main Operation Area */}
      <main className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden pb-2 lg:pb-0">
        {mode === "SEND" && (
          <div className="grid lg:grid-cols-2 gap-4 h-full min-h-[600px] lg:min-h-0">
            {/* Left: Encoder Controls */}
            <section className="bg-[#15181e] rounded-xl border border-[#2d333d] flex flex-col p-4 overflow-y-auto relative h-full">
              <div className="flex items-center justify-between mb-4 shrink-0">
                <span className="text-[10px] font-bold text-cyan-400 tracking-widest uppercase">ENCODER / TX_NODE</span>
                <span className="text-[10px] font-mono text-gray-500 uppercase">Status: {isStreaming ? "Transmitting" : "Standby"}</span>
              </div>

              <div className="space-y-4 flex-1">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase text-gray-500">Payload Source (Text)</label>
                  <textarea 
                    className="bg-[#1c2128] border border-[#374151] rounded p-3 text-sm text-white focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 outline-none transition-all placeholder-gray-600"
                    rows={3}
                    value={sendText}
                    onChange={e => setSendText(e.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase text-gray-500">File Ingestion</label>
                  <input type="file" onChange={handleFileChange} className="text-xs text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-[#2d333d] file:text-gray-200 hover:file:bg-[#374151] cursor-pointer" />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase text-gray-500">Profile</label>
                    <select className="bg-[#1c2128] border border-[#374151] rounded px-2 py-1.5 text-xs text-white outline-none" value={profileId} onChange={e => setProfileId(e.target.value as GridProfileId)}>
                      {Object.keys(GRID_PROFILES).map(k => <option key={k} value={k}>{GRID_PROFILES[k as GridProfileId].name}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase text-gray-500">Cell Size (px)</label>
                    <select className="bg-[#1c2128] border border-[#374151] rounded px-2 py-1.5 text-xs text-white outline-none" value={cellSize} onChange={e => setCellSize(Number(e.target.value))}>
                      {[3, 4, 5, 6, 7, 8].map(v => <option key={v} value={v}>{v}px</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase text-gray-500">Margin Cells</label>
                    <select className="bg-[#1c2128] border border-[#374151] rounded px-2 py-1.5 text-xs text-white outline-none" value={marginCells} onChange={e => setMarginCells(Number(e.target.value))}>
                      {[2, 4, 6, 8].map(v => <option key={v} value={v}>{v} cells</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase text-gray-500">Sync FPS</label>
                    <input type="number" className="bg-[#1c2128] border border-[#374151] rounded px-2 py-1.5 text-xs text-white outline-none" value={fps} onChange={e => setFps(Number(e.target.value))} />
                  </div>
                </div>
              </div>

              <div className="mt-4 shrink-0">
                <button
                  onClick={toggleStreaming}
                  className={`w-full py-3 text-xs font-bold rounded uppercase tracking-widest transition-all
                    ${isStreaming 
                      ? "bg-red-600/10 border border-red-600/50 text-red-500 hover:bg-red-600/20 shadow-[0_0_10px_rgba(239,68,68,0.2)]" 
                      : "bg-green-600/10 border border-green-600/50 text-green-500 hover:bg-green-600/20 shadow-[0_0_10px_rgba(34,197,94,0.2)]"}`}
                >
                  {isStreaming ? "STOP TRANSMISSION" : "START TRANSMISSION"}
                </button>
              </div>
            </section>

            {/* Right: Encoder Canvas output */}
            <section className="bg-[#15181e] rounded-xl border border-[#2d333d] flex flex-col p-4 relative h-full">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-[10px] font-bold text-gray-500 uppercase pt-1">Matrix Output</span>
              </div>
              
              <div className="flex-1 bg-black rounded border border-[#2d333d] flex items-center justify-center p-2 relative group overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_transparent_0%,_#000_100%)] opacity-40 pointer-events-none z-10"></div>
                <canvas ref={encCanvasRef} className="max-w-full max-h-full object-contain relative z-0" style={{ imageRendering: 'pixelated' }}></canvas>
                
                <div className="absolute top-4 left-4 z-20">
                   {isStreaming && <div className="text-[10px] font-mono bg-red-900/60 text-red-400 border border-red-800 px-2 py-0.5 uppercase animate-pulse">TX_ACTIVE</div>}
                </div>
                
                <div className="absolute bottom-4 right-4 flex flex-col gap-1 items-end z-20">
                   <div className="text-[10px] font-mono bg-black/60 px-2 py-1 text-cyan-300 border border-cyan-800">CHUNKS: {encStats.totalChunks}</div>
                   {isStreaming && <div className="text-[10px] font-mono bg-black/60 px-2 py-1 text-green-400 border border-green-800">FPS: {fps} (TARGET)</div>}
                </div>
              </div>
            </section>
          </div>
        )}

        {mode === "RECEIVE" && (
          <div className="grid lg:grid-cols-2 gap-4 h-full min-h-[600px] lg:min-h-0">
            {/* Left: Decoder Camera Feed */}
            <section className="bg-[#15181e] rounded-xl border border-[#2d333d] flex flex-col p-4 relative h-full overflow-hidden">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-[10px] font-bold text-pink-400 tracking-widest">DECODER / RX_NODE</span>
                <span className="text-[10px] font-mono text-gray-500 uppercase">Camera: {isCameraOn ? "Active" : "Inactive"}</span>
              </div>

              <div className="flex-1 bg-black rounded border border-[#2d333d] overflow-hidden relative flex flex-col items-center justify-center min-h-[300px]">
                {!isCameraOn && (
                  <div className="text-gray-600 font-mono text-xs flex items-center gap-2">
                    <span className="w-2 h-2 bg-gray-600 rounded-full"></span> CAM_OFFLINE
                  </div>
                )}
                <video ref={videoRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-cover opacity-80"></video>
                <canvas ref={decCanvasRef} className="absolute inset-0 w-full h-full object-cover pointer-events-none z-10"></canvas>
                
                {isCameraOn && <div className="absolute top-4 left-4 flex flex-col gap-1 z-20">
                  <div className={`text-[9px] font-mono px-2 py-0.5 uppercase border ${debugInfo?.detectedProfileId ? 'bg-pink-900/60 text-pink-200 border-pink-700' : 'bg-black/60 text-gray-400 border-gray-700'}`}>
                    Sync: {debugInfo?.detectedProfileId ? 'LOCKED' : 'SEARCHING'}
                  </div>
                </div>}
              </div>

              <div className="mt-4 shrink-0">
                <button 
                  onClick={isCameraOn ? stopCamera : startCamera} 
                  className={`w-full py-3 text-xs font-bold rounded uppercase tracking-widest transition-all
                    ${isCameraOn 
                      ? "bg-red-600/10 border border-red-600/50 text-red-500 hover:bg-red-600/20" 
                      : "bg-pink-600/10 border border-pink-600/50 text-pink-500 hover:bg-pink-600/20 shadow-[0_0_10px_rgba(236,72,153,0.2)]"}`}
                >
                  {isCameraOn ? "TERMINATE SCANNER" : "INITIALIZE SCANNER"}
                </button>
              </div>
            </section>

            {/* Right: Decoder Outputs & Logs */}
            <section className="bg-[#15181e] rounded-xl border border-[#2d333d] flex flex-col p-4 relative h-full">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-[10px] font-bold text-gray-500 uppercase pt-1">Telemetry & Payload</span>
              </div>

              <div className="flex-1 flex flex-col gap-4 min-h-0">
                <div className="flex-1 bg-black/40 border border-[#2d333d] p-3 rounded flex flex-col overflow-hidden">
                  <div className="flex justify-between items-center mb-2 shrink-0">
                    <span className="text-[10px] font-bold text-gray-500 uppercase">Live Decode Logs</span>
                    <span className={`text-[10px] font-mono uppercase ${debugInfo?.crcOk ? 'text-green-500' : 'text-gray-600'}`}>
                      CRC: {debugInfo?.crcOk ? "OK" : "WAITING"}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono leading-relaxed flex-1 overflow-y-auto space-y-1">
                    <div className="text-gray-500">// SCANNER TELEMETRY</div>
                    {debugInfo ? (
                      <>
                        <div className="text-cyan-600">Corners Found: {debugInfo.corners ? 'TRUE' : 'FALSE'}</div>
                        {debugInfo.detectedProfileId && <div className="text-pink-400">Profile Locked: [{debugInfo.detectedProfileId}] (Size: {debugInfo.estimatedGridSize})</div>}
                        <div className="text-cyan-600">Payload CRC: {debugInfo.crcOk ? <span className="text-green-400">PASSED</span> : <span className="text-red-400">FAILED</span>}</div>
                        <div className="text-gray-300">Total Chunks Recv: {Object.keys(chunksReceived).length}</div>
                      </>
                    ) : (
                      <div className="text-gray-600 animate-pulse">Awaiting matrix engagement...</div>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-1 shrink-0">
                  <label className="text-[10px] font-bold text-gray-500 uppercase">Recovered Payload Buffer</label>
                  <textarea 
                    className="w-full bg-[#1c2128] border border-[#374151] rounded p-3 text-sm text-cyan-400 font-mono outline-none h-28 resize-none shadow-inner leading-relaxed overflow-y-auto" 
                    readOnly 
                    value={decOutputText} 
                    placeholder="[NO_DATA]" 
                  />
                </div>
              </div>
            </section>
          </div>
        )}
      </main>

      <footer className="h-10 mt-2 border-t border-[#2d333d] flex items-center justify-between px-2 shrink-0 hidden md:flex">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-gray-500">TX_MODE:</span>
            <span className="text-[10px] font-mono text-white">{mode}</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[10px] font-mono text-gray-500">
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'bg-green-500 shadow-[0_0_5px_#22c55e]' : 'bg-gray-600'}`}></span> TX_ACTIVE
          </span>
          <span className="flex items-center gap-1.5 text-white">
            <span className={`w-1.5 h-1.5 rounded-full ${isCameraOn ? 'bg-blue-500 shadow-[0_0_5px_#3b82f6]' : 'bg-gray-600'}`}></span> SCANNER_RDY
          </span>
        </div>
      </footer>
    </div>
  );
}
