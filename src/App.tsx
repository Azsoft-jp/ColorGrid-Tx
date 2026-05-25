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

  // 🔄 双方向インタラクティブ同期モード（Interactive Feedback Sync）用の鬼ヤバパラメータたち！💖
  const [interactiveModeTx, setInteractiveModeTx] = useState(false); // 送信側
  const [interactiveModeRx, setInteractiveModeRx] = useState(false); // 受信側
  const [isAckCameraOn, setIsAckCameraOn] = useState(false); // 送信側のACK監視カメラ稼働
  const [ackDebugInfo, setAckDebugInfo] = useState<DecodeDebugInfo | null>(null); // ACK監視カメラ用デバッグ
  const [isAckConnected, setIsAckConnected] = useState(false); // 相手のフィードバックコードを捉えているか！🔗✨
  const [ackMsg, setAckMsg] = useState(""); // デコードされた相手からの要求メッセージ
  const [selectiveNackListStr, setSelectiveNackListStr] = useState(""); // 送信側が独自（ARQ無効時など）にループ再送するためのチャンクリスト(CSV)だよ！💖
  const [showNackFeedbackRx, setShowNackFeedbackRx] = useState(false); // 受信側がARQ無効でも欠落チャンクリストコードを逆送信(1枚表示)したい時のトグル！✨

  // 🔄 送信データ更新用の神ヘルパー関数（関数宣言型にすることで安全にホイストさせるみ！💖）
  function updateEncData() {
    if (!encoder) return;
    encoder.forceChunkIndex = null;
    encoder.forceChunkList = null;
    setSelectiveNackListStr(""); // データを変更した時は自動的に再送対象をクリアするよ！✨
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
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || !e.target.files[0]) return;
    const file = e.target.files[0];
    const buffer = await file.arrayBuffer();
    const meta: PayloadMeta = { type: "file", filename: file.name, mimeType: file.type };
    setFileData(new Uint8Array(buffer));
    setFileMeta(meta);
    setPayloadType("file");
  }

  function toggleStreaming() {
    if (!encoder) return;
    encoder.forceChunkIndex = null;
    encoder.forceChunkList = null;
    if (isStreaming) {
      encoder.stopStreaming();
    } else {
      updateEncData();
      encoder.startStreaming(fps);
    }
    setIsStreaming(!isStreaming);
  }

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

  // 🔄 送信側の選択的再送/強制ホールドリストの同期制御！✨
  useEffect(() => {
    if (!encoder) return;
    if (selectiveNackListStr.trim() !== "") {
      const parts = selectiveNackListStr.split(",").map(x => parseInt(x.trim(), 10)).filter(x => !isNaN(x));
      if (parts.length > 0) {
        if (parts.length === 1) {
          encoder.forceChunkList = null;
          encoder.forceChunkIndex = parts[0];
          setCurrentTxIndex(parts[0]);
        } else {
          encoder.forceChunkIndex = null;
          encoder.forceChunkList = parts;
          setCurrentTxIndex(parts[0]);
        }
      } else {
        encoder.forceChunkIndex = null;
        encoder.forceChunkList = null;
      }
    } else {
      encoder.forceChunkIndex = null;
      encoder.forceChunkList = null;
    }
  }, [selectiveNackListStr, encoder]);

  // ================= RECEIVE MODE =================
  const videoRef = useRef<HTMLVideoElement>(null);
  const decCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [decOutputText, setDecOutputText] = useState("");
  const [decPayload, setDecPayload] = useState<Uint8Array | null>(null);
  const [debugInfo, setDebugInfo] = useState<DecodeDebugInfo | null>(null);
  const [chunksReceived, setChunksReceived] = useState<Record<number, Uint8Array>>({});
  const [totalRxChunks, setTotalRxChunks] = useState(1); // デコード時にヘッダから自動取得するよお！
  const [lastErrorReason, setLastErrorReason] = useState("");
  const decoderRef = useRef(new ColorGridDecoder());

  // 🔍 iOSのカメラぼやけ・ピント対策用の神パラメータたち！💖
  const [hardwareZoomSupported, setHardwareZoomSupported] = useState(false);
  const [zoomMin, setZoomMin] = useState(1);
  const [zoomMax, setZoomMax] = useState(3);
  const [zoomVal, setZoomVal] = useState(1.5);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);

  const handleZoomChange = async (newVal: number) => {
    setZoomVal(newVal);
    if (hardwareZoomSupported && cameraTrackRef.current) {
      try {
        await cameraTrackRef.current.applyConstraints({
          advanced: [{ zoom: newVal } as any]
        });
      } catch (err) {
        console.warn("ズーム適用エラー💦:", err);
      }
    }
  };

  const triggerAutoFocus = async () => {
    if (cameraTrackRef.current) {
      try {
        // フォーカスを強制再トリガーするために、一瞬だけズーム値を揺らすお！✨
        const currZoom = zoomVal;
        const tempZoom = currZoom > 1.1 ? currZoom - 0.1 : currZoom + 0.1;
        if (hardwareZoomSupported) {
          await cameraTrackRef.current.applyConstraints({
            advanced: [{ zoom: tempZoom } as any]
          });
          setTimeout(async () => {
            if (cameraTrackRef.current) {
              await cameraTrackRef.current.applyConstraints({
                advanced: [{ zoom: currZoom } as any, { focusMode: "continuous" } as any]
              });
            }
          }, 100);
        } else {
          // ソフトウェアズーム時はダミーの連続オートフォーカス制約を再適用してSafariのAFをキックする！💖
          await cameraTrackRef.current.applyConstraints({
            advanced: [{ focusMode: "continuous" } as any]
          });
        }
      } catch (err) {
        console.warn("オートフォーカス再起動エラー🥺:", err);
      }
    }
  };

  // 🛠 デバッグUI用の神パラメータたち！✨
  const [isFreezeLog, setIsFreezeLog] = useState(false);
  const isFreezeLogRef = useRef(false);
  React.useEffect(() => {
    isFreezeLogRef.current = isFreezeLog;
  }, [isFreezeLog]);

  const [accumulatedLogs, setAccumulatedLogs] = useState<any[]>([]);
  const [isCopied, setIsCopied] = useState(false);
  const [decodeSuccessCount, setDecodeSuccessCount] = useState(0);
  const [decodeFailureCount, setDecodeFailureCount] = useState(0);
  const [isErrorStopped, setIsErrorStopped] = useState(false);

  const toggleFreezeLog = () => {
    if (isFreezeLog) {
      setIsFreezeLog(false);
      setIsErrorStopped(false);
    } else {
      setIsFreezeLog(true);
    }
  };

  const handleCopyLogs = () => {
    const jsonStr = JSON.stringify(accumulatedLogs, null, 2);
    navigator.clipboard.writeText(jsonStr).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }).catch(err => {
      console.error("Failed to copy debug logs:", err);
    });
  };

  // 双方向制御用Refs! 🛠
  const ackVideoRef = useRef<HTMLVideoElement>(null);
  const ackCanvasRef = useRef<HTMLCanvasElement>(null);
  const feedbackCanvasRef = useRef<HTMLCanvasElement>(null);
  const feedbackEncoderRef = useRef<ColorGridEncoder | null>(null);
  const ackDecoderRef = useRef(new ColorGridDecoder());

  // 💖 絶賛待機中のターゲット・チャンクを chunksReceived の状況からリアルタイムで神検出するよ！✨
  const awaitingChunkIndex = (() => {
    const keysCount = Object.keys(chunksReceived).length;
    if (keysCount === 0) return 0;
    for (let i = 0; i < totalRxChunks; i++) {
      if (chunksReceived[i] === undefined) {
        return i;
      }
    }
    return totalRxChunks;
  })();

  // 💖 全てのチャンクが余すことなく揃ったかを厳格に判定するよ！✨
  const isAllChunksRecovered = Object.keys(chunksReceived).length > 0 && Object.keys(chunksReceived).length === totalRxChunks;

  // 受信バッファなどを初期化するリセッターだよ！✨
  const resetReceiver = () => {
    setChunksReceived({});
    setDecOutputText("");
    setDecPayload(null);
    setTotalRxChunks(1);
    setLastErrorReason("");
  };

  const startCamera = async () => {
    resetReceiver(); // 起動時にクリアして、新鮮なデータを受信できるようにする💖
    try {
      // 1080P指定にすることで、近くのフォーカスが合うカメラモジュールが選ばれやすくする！✨
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: "environment", 
          width: { ideal: 1920 }, 
          height: { ideal: 1080 },
          // advancedでfocusModeや初期ズームをブラウザに提案するお！💖
          advanced: [
            { focusMode: "continuous" } as any,
            { zoom: 1.5 } as any
          ]
        }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraOn(true);

        const [track] = stream.getVideoTracks();
        if (track) {
          cameraTrackRef.current = track;
          const capabilities = track.getCapabilities ? track.getCapabilities() : {};
          if ('zoom' in capabilities) {
            const zoomCap = (capabilities as any).zoom;
            setHardwareZoomSupported(true);
            setZoomMin(zoomCap.min || 1);
            setZoomMax(zoomCap.max || 3);
            // 初期ズームを 1.5倍（または最大値より小さめの値）に自動適用するよ！✨
            const initZoom = Math.min(1.5, zoomCap.max || 1.5);
            setZoomVal(initZoom);
            try {
              await track.applyConstraints({
                advanced: [{ zoom: initZoom } as any]
              });
            } catch (err) {
              console.warn("初期ズームの適用に失敗したみ🥺:", err);
            }
          } else {
            setHardwareZoomSupported(false);
            setZoomMin(1.0);
            setZoomMax(3.0);
            setZoomVal(1.5); // ソフトウェアズームの初期値を1.5xにしてピンぼけを最初から防ぐお！💖
          }
        }
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
    // ズーム関連のクリーンアップ
    cameraTrackRef.current = null;
    setHardwareZoomSupported(false);
  };

  // 🔄 送信側のACKフィードバック監視カメラの起動・終了ロジックだよ！✨
  const startAckCamera = async () => {
    setAckMsg("");
    setIsAckConnected(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } }
      });
      if (ackVideoRef.current) {
        ackVideoRef.current.srcObject = stream;
        setIsAckCameraOn(true);
      }
    } catch (e) {
      console.warn("ACK Camera initial failed, trying front/any:", e);
      // メインの背面カメラがダメだったら、一般条件でフォールバック
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } }
        });
        if (ackVideoRef.current) {
          ackVideoRef.current.srcObject = stream;
          setIsAckCameraOn(true);
        }
      } catch (err) {
        setTestResult({
          ok: false,
          title: "ACK Camera Error",
          details: "ACK監視カメラの起動に失敗したみ😭\n" + String(err)
        });
      }
    }
  };

  const stopAckCamera = () => {
    if (ackVideoRef.current && ackVideoRef.current.srcObject) {
      const stream = ackVideoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(t => t.stop());
      ackVideoRef.current.srcObject = null;
    }
    setIsAckCameraOn(false);
    setIsAckConnected(false);
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
            // ハイブリッドズームロジック：ハードウェアズーム未サポート時はソフトウェア側でトリミング切り出し拡大するお！💖
            const swZoom = hardwareZoomSupported ? 1.0 : zoomVal;
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const sw = vw / swZoom;
            const sh = vh / swZoom;
            const sx = (vw - sw) / 2;
            const sy = (vh - sh) / 2;

            // 1. まず表示用キャンバスに（ソフトズーム適用済みの）映像を描画する！✨
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, vw, vh);
            
            // 解析用に裏のCanvasに映像をコピーしてImageData取得する
            const offscreenCanvas = document.createElement('canvas');
            offscreenCanvas.width = vw;
            offscreenCanvas.height = vh;
            const oCtx = offscreenCanvas.getContext("2d");
            if (oCtx) {
                oCtx.drawImage(video, sx, sy, sw, sh, 0, 0, vw, vh);
                const imageData = oCtx.getImageData(0, 0, vw, vh);
                const res = decoderRef.current.decodeFrame(imageData);

                setDebugInfo(res.debug || null);

                // 📊 成功・失敗数カウントアップ＆自動凍結制御 📊
                if (res.ok) {
                  setDecodeSuccessCount(prev => prev + 1);
                } else {
                  setDecodeFailureCount(prev => prev + 1);
                  // エラーが発生した瞬間に自動でストップして現場保存！🚨
                  setIsFreezeLog(true);
                  setIsErrorStopped(true);
                }

                // 📊 ログ表示エリアの更新（凍結中でないか、Profile Lockedしたときだけ蓄積！） 📊
                if (res.debug?.phaseLogs && res.debug.phaseLogs.length > 0) {
                  if (!isFreezeLogRef.current || res.debug.detectedProfileId) {
                    setAccumulatedLogs(prev => {
                      const merged = [...prev, ...(res.debug!.phaseLogs!)];
                      return merged.slice(-50); // 直近50件制限
                    });
                  }
                }

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
                  setLastErrorReason(""); // 成功時にエラー理由をクリア！✨
                  const { chunkIndex, totalChunks, payload } = res.chunk;
                  setTotalRxChunks(totalChunks);

                  setChunksReceived(prev => {
                    const next = { ...prev, [chunkIndex]: payload };
                    
                    // 全てのチャンクが漏れなく揃っているか厳密にチェックして自動結合するよ！🧩💖
                    let allMatched = true;
                    for (let i = 0; i < totalChunks; i++) {
                      if (next[i] === undefined) {
                        allMatched = false;
                        break;
                      }
                    }

                    if (allMatched) {
                       let totalLen = 0;
                       for (let i = 0; i < totalChunks; i++) {
                         totalLen += next[i].length;
                       }
                       const resultData = new Uint8Array(totalLen);
                       let offset = 0;
                       for (let i = 0; i < totalChunks; i++) {
                         resultData.set(next[i], offset);
                         offset += next[i].length;
                       }
                       setDecPayload(resultData);
                       setDecOutputText(new TextDecoder().decode(resultData));
                    }

                    return next;
                  });
                } else {
                  if (res.reason) {
                    setLastErrorReason(res.reason);
                  }
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


  // 🔄 送信側のACKフィードバックデコードの超リアルタイムループ！🔗✨
  useEffect(() => {
    let reqId: number;
    const processAckFrame = () => {
      if (isAckCameraOn && ackVideoRef.current && ackCanvasRef.current) {
        const video = ackVideoRef.current;
        const canvas = ackCanvasRef.current;
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // オフスクリーンにコピー
            const offscreenCanvas = document.createElement('canvas');
            offscreenCanvas.width = video.videoWidth;
            offscreenCanvas.height = video.videoHeight;
            const oCtx = offscreenCanvas.getContext("2d");
            if (oCtx) {
              oCtx.drawImage(video, 0, 0);
              const imageData = oCtx.getImageData(0, 0, video.videoWidth, video.videoHeight);
              const res = ackDecoderRef.current.decodeFrame(imageData);
              setAckDebugInfo(res.debug || null);
              
              if (res.debug) {
                setIsAckConnected(true);
                // オーバーレイ描画はシアンブルーでハイライトしてハッカー感を演出するよ！💎
                if (res.debug.corners) {
                  ctx.strokeStyle = '#22d3ee';
                  ctx.lineWidth = 2.5;
                  ctx.beginPath();
                  const pts = res.debug.corners;
                  ctx.moveTo(pts[0].x, pts[0].y);
                  ctx.lineTo(pts[1].x, pts[1].y);
                  ctx.lineTo(pts[2].x, pts[2].y);
                  ctx.lineTo(pts[3].x, pts[3].y);
                  ctx.closePath();
                  ctx.stroke();
                }
              } else {
                setIsAckConnected(false);
              }
              
              if (res.ok && res.chunk) {
                const text = new TextDecoder().decode(res.chunk.payload);
                setAckMsg(text);
                
                // コマンド判定！ "F:X" または "F:DONE" または "F:X,Y,Z..." だよお！
                if (text.startsWith("F:")) {
                  const cmd = text.slice(2);
                  if (cmd === "DONE") {
                    // お疲れ様でした！完璧完了！💖
                    if (encoder) {
                      encoder.forceChunkIndex = null;
                      encoder.forceChunkList = null;
                      encoder.stopStreaming();
                    }
                    setIsStreaming(false);
                    setTestResult({
                      ok: true,
                      title: "🎉 双方向超高速データ転送完了！ 💮",
                      details: `おめでとう！カメラ対向フィードバックにより、受信側の全チャンク完全回収が完了したよ！🥺💖✨\n\n[確認メッセージ]: ${text}\nインジケータもDONEになったため、送信を安全に停止したよ！`
                    });
                    stopAckCamera(); // カメラおしまい！
                  } else {
                    // 欠落しているチャンク番号リスト（カンマ区切り）をパースするみ！✨
                    const parts = cmd.split(",").map(x => parseInt(x.trim(), 10)).filter(x => !isNaN(x));
                    if (parts.length > 0) {
                      // 状態変数に同期するだけで、連動 useEffect によって一括で処理されるみ！💖
                      setSelectiveNackListStr(parts.join(","));
                    }
                  }
                }
              }
            }
          }
        }
      }
      reqId = requestAnimationFrame(processAckFrame);
    };
    if (isAckCameraOn) reqId = requestAnimationFrame(processAckFrame);
    return () => cancelAnimationFrame(reqId);
  }, [isAckCameraOn, encoder]);


  // 🔄 受信側の「私の現在要求＆欠落チャンクリスト」フィードバックエンコーダの初期化とストリーミング管理！🎨✨
  useEffect(() => {
    const isFeedbackActive = interactiveModeRx || showNackFeedbackRx;
    if (isFeedbackActive && feedbackCanvasRef.current) {
      const fCanvas = feedbackCanvasRef.current;
      // フィードバック用に超小型 Micro(XS) の ColorGridEncoder インスタンスを作成するよ！
      const fEncoder = new ColorGridEncoder(fCanvas, {
        profileId: "XS",
        cellSize: 3.5, // 相手のカメラが読みやすくて可愛いサイズ！3.5px！
        marginCells: 1,
        fps: 8 // クロックのチカチカ変化を安定して追従させやすくなるように 8fps！
      });
      feedbackEncoderRef.current = fEncoder;
      
      const missing: number[] = [];
      for (let i = 0; i < totalRxChunks; i++) {
        if (chunksReceived[i] === undefined) {
          missing.push(i);
        }
      }
      
      // ARQかつNACK非表示なら、送信者の受信完了を完全に待つため「単一の最小未受信インデックス」をStop-and-Wait要求！🎯
      // ARQ無効 or 明示的にNACKトグルがONなら、欠落をまとめて1枚で逆送り！💖
      let payloadStr = "F:DONE";
      if (!isAllChunksRecovered) {
        if (showNackFeedbackRx) {
          payloadStr = "F:" + missing.slice(0, 15).join(",");
        } else {
          payloadStr = `F:${awaitingChunkIndex}`;
        }
      }
      
      const payloadBytes = new TextEncoder().encode(payloadStr);
      fEncoder.setData(payloadBytes, { type: "text" });
      
      fEncoder.startStreaming(8); // 点灯開始！
      
      return () => {
        fEncoder.stopStreaming();
        feedbackEncoderRef.current = null;
      };
    }
  }, [interactiveModeRx, showNackFeedbackRx]);

  // 🔄 受信データの状況が更新されたら、ストリーミングはそのままでデータだけ超高速で差し替えるよ！🚀✨
  useEffect(() => {
    const isFeedbackActive = interactiveModeRx || showNackFeedbackRx;
    if (isFeedbackActive && feedbackEncoderRef.current) {
      const fEncoder = feedbackEncoderRef.current;
      const missing: number[] = [];
      for (let i = 0; i < totalRxChunks; i++) {
        if (chunksReceived[i] === undefined) {
          missing.push(i);
        }
      }
      
      let payloadStr = "F:DONE";
      if (!isAllChunksRecovered) {
        if (showNackFeedbackRx) {
          payloadStr = "F:" + missing.slice(0, 15).join(",");
        } else {
          payloadStr = `F:${awaitingChunkIndex}`;
        }
      }
      
      const payloadBytes = new TextEncoder().encode(payloadStr);
      fEncoder.setData(payloadBytes, { type: "text" });
    }
  }, [interactiveModeRx, showNackFeedbackRx, chunksReceived, totalRxChunks, isAllChunksRecovered, awaitingChunkIndex]);


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
    <div className={`fixed inset-0 bg-[#0f1115] text-[#d1d5db] font-sans flex flex-col select-none overflow-y-auto ${isMaximizedSend ? "p-0" : "p-4"}`}>
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
                <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 bg-cyan-900/40 text-cyan-400 rounded border border-cyan-800">v1.4.9</span>
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
      <main className="flex-1 min-h-0 overflow-y-auto pb-2">
        {mode === "SEND" && (
          <div className={`grid ${isMaximized ? "grid-cols-1 h-full" : "lg:grid-cols-2"} gap-4 h-auto lg:h-full lg:min-h-[500px]`}>
            {/* Left: Encoder Controls */}
            {!isMaximized && (
              <section className="bg-[#15181e] rounded-xl border border-[#2d333d] flex flex-col p-4 overflow-y-auto relative min-h-[500px] lg:h-full shrink-0 lg:shrink">
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

                  {/* 📊 1フレーム実効容量のリアルタイム神算出パネル 📊 */}
                  <div className="p-3 bg-black/60 rounded-lg border border-[#2d333d] flex flex-col gap-1.5 text-[10px] font-mono shrink-0">
                    <div className="text-gray-500 font-bold uppercase flex justify-between">
                      <span>📦 {t.profile} FRAME ANALYSIS</span>
                      <span className="text-cyan-400 font-bold">{profileId} PROFILE</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-1 py-1.5 border-y border-[#2d333d]/40">
                      <div className="flex flex-col">
                        <span className="text-gray-500 font-bold uppercase text-[8px]">{t.capData}</span>
                        <span className="text-white font-bold text-xs mt-0.5">
                          {profileId === "XS" ? "471 B" : profileId === "S" ? "2,228 B" : profileId === "M" ? "4,212 B" : profileId === "L" ? "6,134 B" : "9,219 B"}
                        </span>
                      </div>
                      <div className="flex flex-col border-x border-[#2d333d]/40 px-2">
                        <span className="text-gray-500 font-bold uppercase text-[8px]">{t.capParity}</span>
                        <span className="text-gray-400 text-xs mt-0.5">
                          {profileId === "XS" ? "118 B" : profileId === "S" ? "557 B" : profileId === "M" ? "1,053 B" : profileId === "L" ? "1,534 B" : "2,305 B"}
                        </span>
                      </div>
                      <div className="flex flex-col pl-1">
                        <span className="text-gray-500 font-bold uppercase text-[8px]">{t.capTotal}</span>
                        <span className="text-cyan-300 font-bold text-xs mt-0.5">
                          {profileId === "XS" ? "589 B" : profileId === "S" ? "2,785 B" : profileId === "M" ? "5,265 B" : profileId === "L" ? "7,668 B" : "11,524 B"}
                        </span>
                      </div>
                    </div>
                    <span className="text-[9px] text-[#22c55e]/90 leading-relaxed pt-0.5">※ 約25%のReed-Solomon誤り訂正込みで完璧な耐ノイズ性能を発揮するよ！💖</span>
                  </div>

                  {/* 🧩 選択的再送ループ (CSV形式) 制御 🧩 */}
                  <div className="mt-3 border-t border-[#2d333d]/65 pt-3 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-yellow-500 uppercase tracking-wider">🎯 Selective Repeat / ホールド再送</span>
                      {selectiveNackListStr && (
                        <button
                          onClick={() => setSelectiveNackListStr("")}
                          className="text-[9px] font-black text-gray-400 hover:text-white px-2 py-0.5 bg-[#2d333d] rounded cursor-pointer transition-colors"
                        >
                          クリア
                        </button>
                      )}
                    </div>
                    <p className="text-[9px] text-gray-500 leading-normal">
                      受信側で欠落した特定のチャンク番号（例: <code className="text-pink-400 bg-black/40 px-1 rounded">2,3</code>）だけを絞り込んで無限ローテーション放流する凄腕モード！双方向同期(ARQ)での自動検知、または下への手入力で起動するよ！💖
                    </p>
                    <div className="flex gap-2 mt-0.5">
                      <input
                        type="text"
                        className="bg-[#1c2128] border border-[#374151] rounded px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:border-yellow-500 outline-none flex-1 font-mono"
                        placeholder="例: 2, 3 (カンマ区切り)"
                        value={selectiveNackListStr}
                        onChange={(e) => setSelectiveNackListStr(e.target.value)}
                      />
                    </div>
                    {selectiveNackListStr && (
                      <div className="text-[9px] font-mono text-yellow-400 flex items-center gap-1.5 bg-yellow-950/20 border border-yellow-800/40 px-2 py-1.2 rounded">
                        <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-ping" />
                        <span>{selectiveNackListStr.split(",").length > 1 ? "【選択的再送ループ中】欠落チャンクのみをチカチカ自動ローテーション中！" : "【チャンク固定中】特定の１枚で点滅を固定しているよ！🎯"}</span>
                      </div>
                    )}
                  </div>

                  {/* 🔄 双方向インタラクティブ同期 (Feedback ARQ Loop) 制御 🔄 */}
                  <div className="mt-4 border-t border-[#2d333d]/60 pt-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-gray-500 uppercase">FEEDBACK LOOP (ARQ)</span>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={interactiveModeTx} 
                          onChange={(e) => {
                            const val = e.target.checked;
                            setInteractiveModeTx(val);
                            if (val) {
                              startAckCamera();
                            } else {
                              stopAckCamera();
                              if (encoder) {
                                encoder.forceChunkIndex = null;
                              }
                            }
                          }} 
                          className="sr-only peer" 
                        />
                        <div className="w-9 h-5 bg-[#1c2128] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-400 after:border-gray-300 after:border peer-checked:bg-cyan-500 peer-checked:after:bg-white border border-[#374151]" />
                        <span className="ml-2 text-xs font-bold text-gray-300 select-none cursor-pointer">{t.interactiveSync}</span>
                      </label>
                    </div>
                    <p className="text-[10px] text-gray-500 leading-normal">{t.interactiveSyncDesc}</p>
                    
                    {/* ACK監視カメラ用のライブプレビュー窓💖 */}
                    {isAckCameraOn && (
                      <div className="mt-2 bg-black/60 rounded-lg p-2 border border-[#2d333d] flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] font-mono text-cyan-400 flex items-center gap-1.5">
                            <span className={`w-1.5 h-1.5 rounded-full ${isAckConnected ? "bg-[#22c55e] animate-pulse shadow-[0_0_8px_#22c55e]" : "bg-cyan-400 shadow-[0_0_8px_#22d3ee] animate-ping"}`} />
                            {isAckConnected ? "FEEDBACK CODE LOCKED 🔒" : "ALIGNING WITH RECEIVER..."}
                          </span>
                          {ackMsg && (
                            <span className="text-[9px] font-mono bg-cyan-950/60 text-cyan-300 border border-cyan-800/80 px-1.5 py-0.5 rounded shadow-inner">
                              REQUEST: {ackMsg}
                            </span>
                          )}
                        </div>
                        
                        <div className="relative aspect-video max-h-32 bg-gray-950/80 rounded overflow-hidden flex items-center justify-center border border-[#1c2128]">
                          <video
                            ref={ackVideoRef}
                            autoPlay
                            playsInline
                            muted
                            className="absolute inset-0 w-full h-full object-cover opacity-60 scale-x-[-1]"
                          />
                          <canvas
                            ref={ackCanvasRef}
                            className="absolute inset-0 w-full h-full object-cover z-10 pointer-events-none scale-x-[-1]"
                          />
                          {!isAckConnected && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-20 pointer-events-none">
                              <div className="text-[9px] font-mono text-cyan-400/80 animate-pulse text-center leading-relaxed">
                                相手の画面の「フィードバックコード」を<br/>カメラに写して同期してね！🔗
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
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
            <section className={`bg-[#15181e] flex flex-col p-4 relative ${isMaximized ? "border-0 rounded-none h-full w-full" : "rounded-xl border border-[#2d333d] min-h-[400px] lg:h-full"}`}>
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
              <section className="bg-[#15181e] rounded-xl border border-[#2d333d] flex flex-col p-4 relative min-h-[500px] lg:h-full overflow-hidden shrink-0 lg:shrink">
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
                   <video ref={videoRef} autoPlay playsInline className="absolute top-0 left-0 w-1 h-1 opacity-0 pointer-events-none z-0"></video>
                   <canvas 
                     ref={decCanvasRef} 
                     onClick={triggerAutoFocus}
                     className="absolute inset-0 w-full h-full object-cover z-10 cursor-crosshair"
                     title="タップしてカメラのピントを合わせ直すお！💖"
                   />
                   
                   {isCameraOn && (
                     <div className="absolute top-4 left-4 flex flex-col gap-1 z-20 pointer-events-none">
                       <div className={`text-[9px] font-mono px-2 py-0.5 uppercase border ${debugInfo?.detectedProfileId ? 'bg-pink-900/60 text-pink-200 border-pink-700' : 'bg-black/60 text-gray-400 border-gray-700'}`}>
                         Sync: {debugInfo?.detectedProfileId ? t.syncLocked : t.syncSearching}
                       </div>
                     </div>
                   )}

                   {isCameraOn && (
                     <div className="absolute top-4 right-4 flex flex-col gap-1 z-20 pointer-events-none">
                       <div className="text-[9px] font-mono px-2 py-0.5 uppercase border bg-black/60 text-cyan-400 border-cyan-800/80 animate-pulse">
                         👆 画面をタップしてピントリセット！✨
                       </div>
                     </div>
                   )}

                  {/* 🔄 フィードバックコードの Picture-in-Picture レンダラー 🔄 */}
                  {(interactiveModeRx || showNackFeedbackRx) && (
                    <div className="absolute bottom-4 right-4 flex flex-col items-end gap-1 z-30 p-1.5 bg-black/85 rounded-lg border border-[#2d333d] shadow-[0_0_15px_rgba(236,72,153,0.3)] animate-pulse">
                      <span className="text-[7px] font-mono font-black text-pink-400 uppercase tracking-widest flex items-center gap-1 pb-0.5">
                        <span className="w-1 h-1 rounded-full bg-pink-500 animate-ping inline-block" /> FEEDBACK TX
                      </span>
                      <canvas 
                        ref={feedbackCanvasRef} 
                        className="w-20 h-20 bg-white rounded border border-pink-500/40" 
                        style={{ imageRendering: 'pixelated' }}
                      />
                    </div>
                  )}
                </div>

                {/* 🔄 双方向フィードバック(ARQ)出力制御 🔄 */}
                <div className="mt-4 px-1 flex flex-col gap-2 shrink-0 border-t border-[#2d333d]/60 pt-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-gray-500 uppercase">FEEDBACK SENDER (RX-LOOP)</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={interactiveModeRx} 
                        onChange={(e) => {
                          const val = e.target.checked;
                          setInteractiveModeRx(val);
                          if (val) setShowNackFeedbackRx(false); // リアルタイム同期時は一括NACKはOFFにする
                        }} 
                        className="sr-only peer" 
                      />
                      <div className="w-9 h-5 bg-[#1c2128] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-400 after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-pink-600 peer-checked:after:bg-white border border-[#374151]" />
                      <span className="ml-2 text-xs font-bold text-gray-300 select-none cursor-pointer">{t.interactiveSync} (ARQ同期)</span>
                    </label>
                  </div>
                  <p className="text-[9px] text-gray-500 leading-normal">送信側と双方向カメラ。相手がこちらの進捗を完全に待ってステップアップする極限の安定同期モード！</p>

                  {/* 🎯 ARQ無効で使える「欠落リストの一括逆送り(NACK code)」トグル 🎯 */}
                  <div className="flex items-center justify-between mt-1 pt-1.5 border-t border-[#2d333d]/40">
                    <span className="text-[10px] font-bold text-yellow-500 uppercase">逆方向 NACK リストコード送信</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={showNackFeedbackRx} 
                        onChange={(e) => {
                          const val = e.target.checked;
                          setShowNackFeedbackRx(val);
                          if (val) setInteractiveModeRx(false); // NACK一撃送り時はリアルタイムステップ同期はOFFにする
                        }} 
                        className="sr-only peer" 
                      />
                      <div className="w-9 h-5 bg-[#1c2128] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-400 after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-yellow-600 peer-checked:after:bg-white border border-[#374151]" />
                      <span className="ml-2 text-xs font-bold text-gray-300 select-none cursor-pointer">欠落を一括逆送り (NACK)</span>
                    </label>
                  </div>
                  <p className="text-[9px] text-gray-400 leading-normal">
                    スライドショー（ARQ無効）中などに一部が欠落した時、これをONにして右下の極小(XS)フィードバックコードを送信カメラに写せば、**送信側が「欠落チャンクのみの繰り返し送信」に自動で切り替わります！**
                  </p>
                </div>

                {isCameraOn && (
                  <div className="mt-3 p-3 bg-black/40 rounded border border-[#2d333d] flex flex-col gap-2 shrink-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-gray-200">
                        🔍 カメラズーム {hardwareZoomSupported ? "(物理ハードズームお！✨)" : "(自律デジタル拡大お！💖)"}
                      </span>
                      <span className="text-xs font-mono text-pink-400 font-bold">{zoomVal.toFixed(1)}x</span>
                    </div>
                    
                    <div className="flex items-center gap-3">
                      <input 
                        type="range" 
                        min={zoomMin} 
                        max={zoomMax} 
                        step="0.1" 
                        value={zoomVal} 
                        onChange={(e) => handleZoomChange(parseFloat(e.target.value))}
                        className="flex-1 accent-pink-500 h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer"
                      />
                      <div className="flex gap-1 shrink-0">
                        {[1.0, 1.5, 2.0].map(v => (
                          <button
                            key={v}
                            onClick={() => handleZoomChange(v)}
                            className={`px-2 py-1 text-[10px] font-mono rounded font-bold transition-all border cursor-pointer
                              ${Math.abs(zoomVal - v) < 0.05 
                                ? 'bg-pink-600 border-pink-500 text-white shadow-[0_0_8px_rgba(236,72,153,0.4)]' 
                                : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                          >
                            {v.toFixed(1)}x
                          </button>
                        ))}
                      </div>
                    </div>

                    <p className="text-[9.5px] text-gray-400 italic leading-normal font-medium">
                      💡 iOS/iPhoneでぼやける場合は、**ColorGridから20〜30cmほどカメラを離して、ズームを「1.5x」や「2.0x」にピッと設定する**とピントが爆速で合うよ！さらに、**画面タップで強制オートフォーカス再起動**もできるお！✨
                    </p>
                  </div>
                )}

                <div className="mt-3 shrink-0">
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
            <section className="bg-[#15181e] rounded-xl border border-[#2d333d] flex flex-col p-4 relative min-h-[450px] lg:h-full">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-[10px] font-bold text-gray-500 uppercase pt-1">{t.telemetryPayload}</span>
              </div>

              <div className="flex-1 flex flex-col gap-4 min-h-0">
                <div className="flex-1 bg-black/40 border border-[#2d333d] p-3 rounded flex flex-col overflow-hidden max-h-[350px]">
                  <div className="flex flex-col gap-2 mb-2 shrink-0">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{t.liveDecodeLogs}</span>
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${debugInfo?.crcOk ? 'bg-green-950 text-green-400 border border-green-800' : 'bg-gray-900 text-gray-500 border border-gray-850'}`}>
                        CRC: {debugInfo?.crcOk ? t.crcOk : t.crcWaiting}
                      </span>
                    </div>

                    {/* 📊 フレームカウンター 📊 */}
                    <div className="flex items-center justify-between p-1.5 rounded bg-black/60 border border-[#2d333d]">
                      <span className="text-[9px] font-mono text-gray-400 leading-none">
                        成功: <span className="text-green-400 font-bold">{decodeSuccessCount}</span> / 
                        失敗: <span className="text-red-400 font-bold">{decodeFailureCount}</span> / 
                        成功率: <span className="text-cyan-400 font-bold">{decodeSuccessCount + decodeFailureCount > 0 ? Math.round((decodeSuccessCount / (decodeSuccessCount + decodeFailureCount)) * 100) : 0}%</span>
                      </span>
                      <div className="flex gap-1.5">
                        <button
                          onClick={toggleFreezeLog}
                          className="px-2 py-0.5 rounded text-[8px] font-bold uppercase transition-colors border bg-[#1c2128] border-[#374151] hover:bg-[#2d333d] text-cyan-300 cursor-pointer"
                        >
                          {isFreezeLog ? "▶ 再開" : "⏸ 一時停止"}
                        </button>
                        <button
                          onClick={handleCopyLogs}
                          className="px-2 py-0.5 rounded text-[8px] font-bold uppercase transition-colors border bg-[#1c2128] border-[#374151] hover:bg-[#2d333d] text-pink-400 cursor-pointer"
                        >
                          {isCopied ? "✅ コピー完了" : "📋 ログをコピー"}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 🚨 エラー発生時：現場保存バナー 🚨 */}
                  {isErrorStopped && (
                    <div className="p-2 mb-2 rounded bg-red-950/40 border border-red-700/60 text-red-200 text-[10px] font-bold leading-none flex items-center justify-between shrink-0 animate-pulse">
                      <span>🔴 エラーで一時停止中お！(現場保存)</span>
                      <button 
                        onClick={() => { setIsFreezeLog(false); setIsErrorStopped(false); }} 
                        className="px-1.5 py-0.5 bg-red-700 hover:bg-red-600 text-white rounded text-[8px]"
                      >
                        ▶ ログ再開
                      </button>
                    </div>
                  )}

                  <div className="text-[11px] font-mono leading-relaxed flex-1 overflow-y-auto space-y-2 pr-1 select-text">
                    {/* telemetry summary */}
                    <div className="space-y-1 p-2 bg-black/30 border border-[#2d333d]/50 rounded mb-2">
                      <div className="text-cyan-500 text-[10px]">Corners Found: {debugInfo?.corners ? 'TRUE' : 'FALSE'}</div>
                      {debugInfo?.detectedProfileId && <div className="text-pink-400 text-[10px]">Profile Locked: [{debugInfo.detectedProfileId}] (Size: {debugInfo.estimatedGridSize})</div>}
                      <div className="text-cyan-500 text-[10px]">Payload CRC: {debugInfo?.crcOk ? <span className="text-green-400">PASSED</span> : <span className="text-red-400">FAILED</span>}</div>
                      <div className="text-gray-300 text-[10px]">Total Chunks Recv: {Object.keys(chunksReceived).length} / {totalRxChunks}</div>
                      {isAllChunksRecovered ? (
                        <div className="text-green-400 font-bold text-[10px] animate-bounce">✨ ALL CHUNKS FULLY RECOVERED! 🎉</div>
                      ) : (
                        <div className="text-yellow-400 animate-pulse font-bold text-[10px]">Awaiting Target: #{awaitingChunkIndex} (Remaining: {totalRxChunks - Object.keys(chunksReceived).length})</div>
                      )}
                    </div>

                    <div className="text-gray-500 border-t border-[#2d333d]/40 pt-1 text-[9px] uppercase font-bold tracking-wider">// RECENT DIAGNOSTIC PHASE LOGS (MAX 50)</div>
                    
                    <div className="space-y-1.5">
                      {accumulatedLogs.length > 0 ? (
                        [...accumulatedLogs].reverse().map((pl, lIdx) => (
                          <div key={lIdx} className="p-1 px-1.5 rounded bg-[#13151b] border border-[#2d333d]/40 flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                              <span className={`text-[8px] font-extrabold px-1 rounded uppercase min-w-[50px] text-center
                                ${pl.ok 
                                  ? 'bg-green-950/60 border border-green-800/80 text-green-400' 
                                  : 'bg-red-950/60 border border-red-800/80 text-red-400'
                                }`}
                              >
                                {pl.phase}
                              </span>
                              <span className="text-gray-600 text-[8px]">{pl.durationMs.toFixed(1)}ms</span>
                            </div>
                            <pre className="text-[10px] text-gray-300 whitespace-pre-wrap leading-normal font-sans pt-0.5">
                              {pl.detail}
                            </pre>
                          </div>
                        ))
                      ) : (
                        <div className="text-gray-600 animate-pulse text-[10px]">Awaiting decode feedback to populate diagnostic logs...</div>
                      )}
                    </div>
                  </div>
                </div>

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
