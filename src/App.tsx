import React, { useState, useRef, useEffect } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { ColorGridEncoder } from './encoder';
import { ColorGridDecoder } from './decoder';
import { GRID_PROFILES, GridProfileId, DecodeDebugInfo, PayloadMeta } from './types';
import { translations, Language } from './i18n';

export default function App() {
  const [mode, setMode] = useState<"SEND" | "RECEIVE">("SEND");
  const [lang, setLang] = useState<Language>('ja');
  
  const t = translations[lang];

  const [testResult, setTestResult] = useState<{
    ok: boolean;
    title: string;
    details: string;
  } | null>(null);

  // ================= SEND MODE =================
  const encCanvasRef = useRef<HTMLCanvasElement>(null);
  const [encoder, setEncoder] = useState<ColorGridEncoder | null>(null);
  const [sendText, setSendText] = useState("Hello, ColorGrid! 👋✨");
  const [payloadType, setPayloadType] = useState<"text" | "file">("text");
  const [fileData, setFileData] = useState<Uint8Array | null>(null);
  const [fileMeta, setFileMeta] = useState<PayloadMeta | null>(null);
  const [profileId, setProfileId] = useState<GridProfileId>("M");
  const [cellSize, setCellSize] = useState(5);
  const [marginCells, setMarginCells] = useState(4);
  const [fps, setFps] = useState(10);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [encStats, setEncStats] = useState({ totalChunks: 0 });
  const [currentTxIndex, setCurrentTxIndex] = useState(0); // 現在送信中のチャンクインデックス✨

  useEffect(() => {
    let enc: ColorGridEncoder | null = null;
    if (encCanvasRef.current && !encoder) {
      enc = new ColorGridEncoder(encCanvasRef.current);
      // 送信フレームが変わるたびにインデックスを受け取るよ！💖
      enc.onChunkChange = (idx, total) => {
        setCurrentTxIndex(idx);
        setEncStats({ totalChunks: total });
      };
      setEncoder(enc);
    }
    return () => {
      enc?.stopStreaming();
    };
  }, []);

  useEffect(() => {
    if (encoder) {
      encoder.setProfile(profileId);
      encoder.setCellSize(cellSize);
      encoder.setMarginCells(marginCells);
      updateEncData();
    }
  }, [profileId, cellSize, marginCells, sendText, payloadType, fileData]);

  const updateEncData = () => {
    if (!encoder) return;
    if (payloadType === "text") {
      const data = new TextEncoder().encode(sendText);
      const meta: PayloadMeta = { type: "text" };
      encoder.setData(data, meta);
    } else if (payloadType === "file" && fileData && fileMeta) {
      encoder.setData(fileData, fileMeta);
    } else {
      encoder.setData(new Uint8Array(0));
    }
    setEncStats({ totalChunks: encoder.getStats().totalChunks });
    encoder.renderChunk(isStreaming ? encoder.currentChunkIndex : 0);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0]) return;
    const file = e.target.files[0];
    const buffer = await file.arrayBuffer();
    const meta: PayloadMeta = { type: "file", filename: file.name, mimeType: file.type };
    setFileData(new Uint8Array(buffer));
    setFileMeta(meta);
    setPayloadType("file");
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
  const [decPayload, setDecPayload] = useState<Uint8Array | null>(null);
  const [debugInfo, setDebugInfo] = useState<DecodeDebugInfo | null>(null);
  const [chunksReceived, setChunksReceived] = useState<Record<number, Uint8Array>>({});
  const [awaitingChunkIndex, setAwaitingChunkIndex] = useState(0); // 💖 絶賛待機中のターゲット・チャンク！
  const [totalRxChunks, setTotalRxChunks] = useState(1); // デコード時にヘッダから自動取得するよお！
  const decoderRef = useRef(new ColorGridDecoder());

  // 受信バッファなどを初期化するリセッターだよ！✨
  const resetReceiver = () => {
    setChunksReceived({});
    setAwaitingChunkIndex(0);
    setDecOutputText("");
    setDecPayload(null);
    setTotalRxChunks(1);
  };

  const startCamera = async () => {
    resetReceiver(); // 起動時にクリアして、新鮮なデータを受信できるようにする💖
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraOn(true);
      }
    } catch (e) {
      setTestResult({
         ok: false,
         title: "Camera Error",
         details: "カメラの許可が取れないみ😭\n" + String(e)
      });
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
                  const { chunkIndex, totalChunks, payload } = res.chunk;
                  setTotalRxChunks(totalChunks);

                  setChunksReceived(prev => {
                    const next = { ...prev, [chunkIndex]: payload };
                    
                    // 全部揃ったかの簡易確認
                    if (Object.keys(next).length >= totalChunks) {
                       let totalLen = 0;
                       for (let i = 0; i < totalChunks; i++) {
                         if (next[i]) totalLen += next[i].length;
                       }
                       const resultData = new Uint8Array(totalLen);
                       let offset = 0;
                       for (let i = 0; i < totalChunks; i++) {
                         if (next[i]) {
                           resultData.set(next[i], offset);
                           offset += next[i].length;
                         }
                       }
                       setDecPayload(resultData);
                       setDecOutputText(new TextDecoder().decode(resultData));
                    }

                    // 💖 1回でも該当チャンクの受信に成功したら次のチャンクを待機するようにシフトするよ！✨
                    setAwaitingChunkIndex(currentAwaiting => {
                       // 今受信した chunkIndex が現在の待機対象だった場合、もしくは既に受信済みの場合
                       if (next[currentAwaiting]) {
                          // 次の未受信の最小インデックスを探してそこを新しい待機対象にする！
                          for (let i = currentAwaiting + 1; i < totalChunks; i++) {
                             if (!next[i]) return i;
                          }
                          for (let i = 0; i < totalChunks; i++) {
                             if (!next[i]) return i;
                          }
                          return totalChunks; // 全部揃ったら totalChunks (完了) にセット！
                       }
                       return currentAwaiting; // まだ期待のチャンクが来ていなければ待機を維持
                    });

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
     // 仮想キャンバスを作って確実に状態非依存でテストするみ！✨
     const tempCanvas = document.createElement('canvas');
     const tempEncoder = new ColorGridEncoder(tempCanvas);
     
     tempEncoder.setProfile(profileId);
     tempEncoder.setCellSize(cellSize);
     tempEncoder.setMarginCells(marginCells);
     
     if (payloadType === "text") {
       tempEncoder.setData(new TextEncoder().encode(sendText), { type: "text" });
     } else if (fileData && fileMeta) {
       tempEncoder.setData(fileData, fileMeta);
     }
     tempEncoder.renderChunk(0);

     const ctx = tempCanvas.getContext('2d');
     if (!ctx) return;
     
     const tStart = performance.now();
     const imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
     const decoder = new ColorGridDecoder();
     const res = decoder.decodeFrame(imageData);
     const tEnd = performance.now();
     
     if (res.ok && res.chunk) {
       const recovered = payloadType === "text" 
          ? new TextDecoder().decode(res.chunk.payload)
          : `[Binary Data: ${res.chunk.payload.length} bytes]`;
       setTestResult({
         ok: true,
         title: t.testSuccess,
         details: `[${t.send}]: ${payloadType === 'text' ? sendText : 'File'}\n[${t.recovered}]: ${recovered}\n[${t.time}]: ${Math.round(tEnd - tStart)}ms`
       });
     } else {
       setTestResult({
         ok: false,
         title: t.testFailed,
         details: `${t.reason}: ${res.reason}\n\nCanvas Size: ${tempCanvas.width}x${tempCanvas.height}`
       });
     }
  };

  const handleSaveImage = () => {
    if (!encCanvasRef.current) return;
    const url = encCanvasRef.current.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = "colorgrid_tx.png";
    a.click();
  };

  const handleDownloadPayload = () => {
    if (!decPayload) return;
    const blob = new Blob([decPayload]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "received_payload.bin";
    a.click();
    URL.revokeObjectURL(url);
  };

  const isMaximizedSend = mode === "SEND" && isMaximized;

  return (
    <div className={`fixed inset-0 bg-[#0f1115] text-[#d1d5db] font-sans flex flex-col select-none lg:overflow-hidden overflow-y-auto ${isMaximizedSend ? "p-0" : "p-4"}`}>
      {testResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[#1c2128] border border-[#374151] rounded-xl p-6 shadow-2xl max-w-md w-full flex flex-col">
            <h3 className={`text-lg font-bold mb-4 ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>
              {testResult.title}
            </h3>
            <div className="relative group flex-1 min-h-0 overflow-y-auto">
              <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap bg-[#15181e] p-3 rounded border border-[#2d333d] h-full overflow-x-auto max-h-[60vh]">
                {testResult.details}
              </pre>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(testResult.details);
                  setTestResult(prev => prev ? { ...prev, title: "マジコピった！📋✨" } : null);
                }}
                className="absolute top-2 right-4 px-2 py-1 bg-[#2d333d] hover:bg-pink-600 rounded text-[10px] font-bold text-gray-300 hover:text-white transition-colors shadow-md border border-[#4b5563]"
              >
                📋 コピー
              </button>
            </div>
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setTestResult(null)}
                className="px-4 py-2 bg-[#2d333d] hover:bg-[#374151] text-white text-xs font-bold rounded transition-colors"
              >
                CLOSE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header Section */}
      {!isMaximizedSend && (
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
              <p className="text-[11px] text-gray-500 font-mono">{t.subtitle}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <select
              value={lang}
              onChange={e => setLang(e.target.value as Language)}
              className="bg-[#1c1f26] border border-[#374151] rounded px-3 py-1.5 text-xs font-semibold text-white outline-none cursor-pointer hover:bg-[#2d333d] shadow-md"
            >
              <option value="ja">🇯🇵 日本語</option>
              <option value="en">🇺🇸 EN</option>
              <option value="zh">🇨🇳 中文</option>
              <option value="ko">🇰🇷 한국어</option>
              <option value="ru">🇷🇺 РУС</option>
            </select>
            <button onClick={runSelfTest} className="px-4 py-1.5 bg-[#1c1f26] border border-[#374151] rounded text-xs font-semibold hover:bg-[#2d333d] transition-colors flex items-center gap-2 text-white shadow-md">
              <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block"></span> {t.selfTest}
            </button>
            
            <div className="flex bg-[#1c1f26] border border-[#374151] rounded p-0.5 shadow-md">
              <button
                onClick={() => setMode("SEND")}
                className={`px-4 py-1.5 rounded text-xs font-bold transition-colors ${mode === "SEND" ? "bg-cyan-600 text-white shadow-lg shadow-cyan-900/20" : "text-gray-400 hover:text-white"}`}
              >
                {t.encMode}
              </button>
              <button
                onClick={() => { setMode("RECEIVE"); resetReceiver(); }}
                className={`px-4 py-1.5 rounded text-xs font-bold transition-colors ${mode === "RECEIVE" ? "bg-pink-600 text-white shadow-lg shadow-pink-900/20" : "text-gray-400 hover:text-white"}`}
              >
                {t.decMode}
              </button>
            </div>
          </div>
        </header>
      )}

      {/* Main Operation Area */}
      <main className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden pb-2 lg:pb-0">
        {mode === "SEND" && (
          <div className={`grid ${isMaximized ? "grid-cols-1 h-full" : "lg:grid-cols-2"} gap-4 h-auto lg:h-full lg:min-h-0`}>
            {/* Left: Encoder Controls */}
            {!isMaximized && (
              <section className="bg-[#15181e] rounded-xl border border-[#2d333d] flex flex-col p-4 overflow-y-auto relative h-[500px] lg:h-full shrink-0 lg:shrink">
                <div className="flex items-center justify-between mb-4 shrink-0">
                  <span className="text-[10px] font-bold text-cyan-400 tracking-widest uppercase">{t.encoderTitle}</span>
                  <span className="text-[10px] font-mono text-gray-500 uppercase">Status: {isStreaming ? t.statusTransmitting : t.statusStandby}</span>
                </div>

                <div className="space-y-4 flex-1">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase text-gray-500">{t.payloadSourceText}</label>
                    <textarea 
                      className="bg-[#1c2128] border border-[#374151] rounded p-3 text-sm text-white focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 outline-none transition-all placeholder-gray-600"
                      rows={3}
                      value={sendText}
                      onChange={e => { setPayloadType("text"); setSendText(e.target.value); }}
                    />
                    {payloadType === "text" && sendText.startsWith("data:image/") && (
                      <div className="mt-2 bg-black/40 rounded p-2 flex items-center justify-center border border-[#2d333d]">
                        <img src={sendText} alt="Payload Preview" className="max-h-24 object-contain rounded" />
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase text-gray-500">{t.fileIngestion}</label>
                    <input type="file" onChange={handleFileChange} className="text-xs text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-[#2d333d] file:text-gray-200 hover:file:bg-[#374151] cursor-pointer" />
                    {payloadType === "file" && fileData && fileMeta && fileMeta.mimeType?.startsWith("image/") && (
                      <div className="mt-2 bg-black/40 rounded p-2 flex items-center justify-center border border-[#2d333d]">
                        <img src={URL.createObjectURL(new Blob([fileData], { type: fileMeta.mimeType }))} alt="File Preview" className="max-h-24 object-contain rounded" />
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold uppercase text-gray-500">{t.profile}</label>
                      <select className="bg-[#1c2128] border border-[#374151] rounded px-2 py-1.5 text-xs text-white outline-none" value={profileId} onChange={e => setProfileId(e.target.value as GridProfileId)}>
                        {Object.keys(GRID_PROFILES).map(k => <option key={k} value={k}>{GRID_PROFILES[k as GridProfileId].name}</option>)}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold uppercase text-gray-500">{t.cellSize}</label>
                      <select className="bg-[#1c2128] border border-[#374151] rounded px-2 py-1.5 text-xs text-white outline-none" value={cellSize} onChange={e => setCellSize(Number(e.target.value))}>
                        {[3, 4, 5, 6, 7, 8].map(v => <option key={v} value={v}>{v}px</option>)}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold uppercase text-gray-500">{t.marginCells}</label>
                      <select className="bg-[#1c2128] border border-[#374151] rounded px-2 py-1.5 text-xs text-white outline-none" value={marginCells} onChange={e => setMarginCells(Number(e.target.value))}>
                        {[2, 4, 6, 8].map(v => <option key={v} value={v}>{v} cells</option>)}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold uppercase text-gray-500">{t.syncFps}</label>
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
                    {isStreaming ? t.stopTransmission : t.startTransmission}
                  </button>
                </div>
              </section>
            )}

            {/* Right: Encoder Canvas output */}
            <section className={`bg-[#15181e] flex flex-col p-4 relative ${isMaximized ? "border-0 rounded-none h-full w-full" : "rounded-xl border border-[#2d333d] h-[400px] lg:h-full"}`}>
              <div className="flex items-center justify-between mb-3 shrink-0 gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold text-gray-500 uppercase pt-1">{t.matrixOutput}</span>
                  {isStreaming && (
                    <span className="text-[9px] font-mono bg-red-900/60 text-red-400 border border-red-800 px-1.5 py-0.5 uppercase animate-pulse rounded">
                      TX_ACTIVE
                    </span>
                  )}
                  <span className="text-[9px] font-mono bg-[#15181e] px-1.5 py-0.5 text-cyan-300 border border-cyan-800 rounded">
                    {t.chunks}: {encStats.totalChunks}
                  </span>
                  {isStreaming && (
                    <>
                      <span className="text-[9px] font-mono bg-yellow-950/40 text-yellow-400 border border-yellow-800/80 px-1.5 py-0.5 rounded animate-pulse">
                        TX_CHUNK: {currentTxIndex} / {encStats.totalChunks - 1} (REMAIN: {encStats.totalChunks - currentTxIndex - 1})
                      </span>
                      <span className="text-[9px] font-mono bg-[#15181e] px-1.5 py-0.5 text-green-400 border border-green-800 rounded">
                        {t.fpsTarget}: {fps}
                      </span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleStreaming}
                    className={`px-3 py-1 bg-[#2d333d] hover:bg-[#374151] rounded text-[10px] font-bold transition-all border border-[#4b5563] cursor-pointer
                      ${isStreaming 
                        ? "bg-red-950/40 hover:bg-red-900/60 text-red-400 border-red-800/80 shadow-[0_0_10px_rgba(239,68,68,0.15)] animate-pulse" 
                        : "bg-green-950/30 hover:bg-green-900/55 text-green-400 border-green-800/80 shadow-[0_0_10px_rgba(34,197,94,0.15)]"}`}
                  >
                    {isStreaming ? t.stopTransmission : t.startTransmission}
                  </button>
                  <button
                    onClick={handleSaveImage}
                    className="px-3 py-1 bg-[#2d333d] hover:bg-[#374151] rounded text-[10px] font-bold text-gray-300 transition-colors border border-[#4b5563] cursor-pointer"
                  >
                    {t.saveImage}
                  </button>
                  <button
                    onClick={() => setIsMaximized(!isMaximized)}
                    className="px-3 py-1 bg-[#1a2d3d] hover:bg-[#203a4f] text-cyan-400 rounded text-[10px] font-bold border border-cyan-800/80 flex items-center gap-1.5 shadow-md cursor-pointer"
                    title={isMaximized ? t.normalMode : t.theaterMode}
                  >
                    {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                    <span>{isMaximized ? t.normalMode : t.theaterMode}</span>
                  </button>
                </div>
              </div>
              
              <div className="flex-1 bg-black rounded border border-[#2d333d] flex items-center justify-center p-2 relative group overflow-hidden">
                <canvas ref={encCanvasRef} className="max-w-full max-h-full object-contain relative z-0" style={{ imageRendering: 'pixelated' }}></canvas>
              </div>
            </section>
          </div>
        )}

        {mode === "RECEIVE" && (
          <div className="grid lg:grid-cols-2 gap-4 h-auto lg:h-full lg:min-h-0">
            {/* Left: Decoder Camera Feed */}
            <section className="bg-[#15181e] rounded-xl border border-[#2d333d] flex flex-col p-4 relative h-[450px] lg:h-full overflow-hidden shrink-0 lg:shrink">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-[10px] font-bold text-pink-400 tracking-widest">{t.decoderTitle}</span>
                <span className="text-[10px] font-mono text-gray-500 uppercase">Camera: {isCameraOn ? t.cameraActive : t.cameraInactive}</span>
              </div>

              <div className="flex-1 bg-black rounded border border-[#2d333d] overflow-hidden relative flex flex-col items-center justify-center min-h-[250px]">
                {!isCameraOn && (
                  <div className="text-gray-600 font-mono text-xs flex items-center gap-2">
                    <span className="w-2 h-2 bg-gray-600 rounded-full"></span> {t.camOffline}
                  </div>
                )}
                <video ref={videoRef} autoPlay playsInline className="absolute inset-0 w-full h-full object-cover opacity-80"></video>
                <canvas ref={decCanvasRef} className="absolute inset-0 w-full h-full object-cover pointer-events-none z-10"></canvas>
                
                {isCameraOn && <div className="absolute top-4 left-4 flex flex-col gap-1 z-20">
                  <div className={`text-[9px] font-mono px-2 py-0.5 uppercase border ${debugInfo?.detectedProfileId ? 'bg-pink-900/60 text-pink-200 border-pink-700' : 'bg-black/60 text-gray-400 border-gray-700'}`}>
                    Sync: {debugInfo?.detectedProfileId ? t.syncLocked : t.syncSearching}
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
                  {isCameraOn ? t.termScanner : t.initScanner}
                </button>
              </div>
            </section>

            {/* Right: Decoder Outputs & Logs */}
            <section className="bg-[#15181e] rounded-xl border border-[#2d333d] flex flex-col p-4 relative h-[350px] lg:h-full">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-[10px] font-bold text-gray-500 uppercase pt-1">{t.telemetryPayload}</span>
              </div>

              <div className="flex-1 flex flex-col gap-4 min-h-0">
                <div className="flex-1 bg-black/40 border border-[#2d333d] p-3 rounded flex flex-col overflow-hidden">
                  <div className="flex justify-between items-center mb-2 shrink-0">
                    <span className="text-[10px] font-bold text-gray-500 uppercase">{t.liveDecodeLogs}</span>
                    <span className={`text-[10px] font-mono uppercase ${debugInfo?.crcOk ? 'text-green-500' : 'text-gray-600'}`}>
                      CRC: {debugInfo?.crcOk ? t.crcOk : t.crcWaiting}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono leading-relaxed flex-1 overflow-y-auto space-y-2">
                    <div className="text-gray-500">// SCANNER TELEMETRY</div>
                    {debugInfo ? (
                      <div className="space-y-1">
                        <div className="text-cyan-600">Corners Found: {debugInfo.corners ? 'TRUE' : 'FALSE'}</div>
                        {debugInfo.detectedProfileId && <div className="text-pink-400">Profile Locked: [{debugInfo.detectedProfileId}] (Size: {debugInfo.estimatedGridSize})</div>}
                        <div className="text-cyan-600">Payload CRC: {debugInfo.crcOk ? <span className="text-green-400">PASSED</span> : <span className="text-red-400">FAILED</span>}</div>
                        <div className="text-gray-300">Total Chunks Recv: {Object.keys(chunksReceived).length} / {totalRxChunks}</div>
                        {awaitingChunkIndex < totalRxChunks ? (
                          <div className="text-yellow-400 animate-pulse font-bold">Awaiting Target: #{awaitingChunkIndex} (Remaining: {totalRxChunks - Object.keys(chunksReceived).length})</div>
                        ) : (
                          <div className="text-green-400 font-bold animate-bounce">✨ ALL CHUNKS FULLY RECOVERED! 🎉</div>
                        )}
                      </div>
                    ) : (
                      <div className="text-gray-600 animate-pulse">Awaiting matrix engagement...</div>
                    )}

                    {/* 💖 受信状況ビジュアルグリッド 💖 */}
                    <div className="mt-4 border-t border-[#2d333d]/60 pt-3">
                      <div className="text-[10px] font-bold text-gray-500 uppercase mb-2 flex justify-between items-center">
                        <span>CHUNK RECEIVE MATRIX</span>
                        <span className="text-pink-400 font-mono text-[10px]">{Math.round((Object.keys(chunksReceived).length / Math.max(1, totalRxChunks)) * 100)}% COMPLETE</span>
                      </div>
                      
                      {/* リアルタイムインジケーター */}
                      <div className="flex flex-wrap gap-1 p-2 bg-black/60 rounded border border-[#2d333d] max-h-[140px] overflow-y-auto">
                        {Array.from({ length: totalRxChunks }).map((_, idx) => {
                          const isRecv = !!chunksReceived[idx];
                          const isAwaiting = idx === awaitingChunkIndex;
                          return (
                            <div
                              key={idx}
                              title={`Chunk ${idx}${isRecv ? ': RECEIVED' : isAwaiting ? ': AWAITING' : ': PENDING'}`}
                              className={`w-6 h-6 rounded flex items-center justify-center text-[8px] font-mono font-bold border transition-all duration-300
                                ${isRecv 
                                  ? 'bg-pink-600/30 text-pink-400 border-pink-500 shadow-[0_0_8px_rgba(236,72,153,0.3)] animate-pulse font-black' 
                                  : isAwaiting 
                                    ? 'bg-yellow-500/20 text-yellow-400 border-yellow-400 animate-pulse border-dashed' 
                                    : 'bg-gray-800/40 text-gray-600 border-gray-700/60'
                                }`}
                            >
                              {idx}
                            </div>
                          );
                        })}
                      </div>
                      
                      <div className="mt-2 flex items-center justify-between text-[9px] font-mono text-gray-400 uppercase">
                        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-pink-600/30 border border-pink-500"></span> Received</span>
                        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-yellow-500/20 border border-yellow-400"></span> Awaiting</span>
                        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-gray-800/40 border border-gray-700/60"></span> Pending</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-1 shrink-0">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-bold text-gray-500 uppercase">{t.recoveredPayload}</label>
                    {decPayload && (
                      <button
                        onClick={handleDownloadPayload}
                        className="px-3 py-1 bg-[#2d333d] hover:bg-[#374151] rounded text-[10px] font-bold text-cyan-300 transition-colors border border-[#4b5563]"
                      >
                        {t.downloadPayload}
                      </button>
                    )}
                  </div>
                  {decOutputText.startsWith("data:image/") && (
                    <div className="bg-[#1c2128] border border-[#374151] rounded p-2 mt-1 mb-2 flex justify-center shrink-0">
                      <img src={decOutputText} alt="Decoded Preview" className="max-h-32 object-contain rounded drop-shadow-lg" />
                    </div>
                  )}
                  <textarea 
                    className="w-full bg-[#1c2128] border border-[#374151] rounded p-3 text-sm text-cyan-400 font-mono outline-none h-28 resize-none shadow-inner leading-relaxed overflow-y-auto" 
                    readOnly 
                    value={decOutputText} 
                    placeholder={t.noData} 
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
