import { useRef, useState, useEffect } from 'react';
import { SSE } from 'sse.js';
import './App.css';

interface Point { x: number; y: number; }

type AppState = 'upload' | 'edit' | 'loading' | 'result';

function App() {
  const [state, setState] = useState<AppState>('upload');
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [paths, setPaths] = useState<Point[][]>([]);
  const [currentPath, setCurrentPath] = useState<Point[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [maskDataUrl, setMaskDataUrl] = useState<string | null>(null);
  const [refinedMask, setRefinedMask] = useState<string | null>(null);
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [resultImgLoaded, setResultImgLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string>('');

  // "Always include" / "Remove" lasso on the result
  const [includePaths, setIncludePaths] = useState<Point[][]>([]);
  const [removePaths, setRemovePaths] = useState<Point[][]>([]);
  const [resultCurrentPath, setResultCurrentPath] = useState<Point[]>([]);
  const [resultDrawing, setResultDrawing] = useState(false);
  const [resultMode, setResultMode] = useState<'include' | 'remove'>('include');
  const [compositedImage, setCompositedImage] = useState<string | null>(null);
  const [finalMask, setFinalMask] = useState<string | null>(null); // New state for the final, edited mask
  const [originalOpacity, setOriginalOpacity] = useState(0);
  // Unified history for undo: tracks which list each path was added to
  const [resultHistory, setResultHistory] = useState<('include' | 'remove')[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Result canvas refs
  const resultCanvasRef = useRef<HTMLCanvasElement>(null);
  const resultOverlayRef = useRef<HTMLCanvasElement>(null);
  const resultImgRef = useRef<HTMLImageElement | null>(null);

  // Refs to avoid side effects inside state updaters (React Strict Mode)
  const currentPathRef = useRef<Point[]>([]);
  const resultCurrentPathRef = useRef<Point[]>([]);

  // Compute display size that fits within a maxW panel
  const maxDisplayW = 540;
  const scale = imageSize.w > 0 ? Math.min(1, maxDisplayW / imageSize.w) : 1;
  const displayW = Math.round(imageSize.w * scale);
  const displayH = Math.round(imageSize.h * scale);

  // Load the uploaded image
  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      const img = new Image();
      img.onload = () => {
        imgRef.current = img;
        setImageSrc(url);
        setImageSize({ w: img.naturalWidth, h: img.naturalHeight });
        setPaths([]);
        setCurrentPath([]);
        setMaskDataUrl(null);
        setRefinedMask(null);
        setResultImage(null);
        setIncludePaths([]);
        setRemovePaths([]);
        setResultCurrentPath([]);
        setResultHistory([]);
        setCompositedImage(null);
        setFinalMask(null);
        setError(null);
        setState('edit');
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  };

  // Draw image onto base canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || displayW === 0) return;
    canvas.width = displayW;
    canvas.height = displayH;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, displayW, displayH);
  }, [imageSrc, displayW, displayH]);

  // Draw lasso overlay
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || displayW === 0) return;
    canvas.width = displayW;
    canvas.height = displayH;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, displayW, displayH);

    // Draw filled regions
    const allPaths = [...paths, ...(currentPath.length > 0 ? [currentPath] : [])];
    if (allPaths.length > 0) {
      ctx.fillStyle = 'rgba(108, 92, 231, 0.25)';
      ctx.strokeStyle = 'rgba(108, 92, 231, 0.8)';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (const path of allPaths) {
        if (path.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(path[i].x, path[i].y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }, [paths, currentPath, displayW, displayH]);

  // Generate the full-res mask when paths change
  useEffect(() => {
    if (paths.length === 0 || imageSize.w === 0) {
      setMaskDataUrl(null);
      return;
    }
    const offscreen = document.createElement('canvas');
    offscreen.width = imageSize.w;
    offscreen.height = imageSize.h;
    const ctx = offscreen.getContext('2d')!;
    // Black background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, imageSize.w, imageSize.h);
    // White filled mask
    ctx.fillStyle = '#fff';
    const invScale = 1 / scale;
    for (const path of paths) {
      if (path.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(path[0].x * invScale, path[0].y * invScale);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x * invScale, path[i].y * invScale);
      }
      ctx.closePath();
      ctx.fill();
    }
    setMaskDataUrl(offscreen.toDataURL('image/png'));
  }, [paths, imageSize, scale]);

  // ─── Edit-mode lasso mouse handling ────────────────────────────────

  const clampPos = (clientX: number, clientY: number, ref: React.RefObject<HTMLCanvasElement | null>): Point => {
    const rect = ref.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(displayW, clientX - rect.left)),
      y: Math.max(0, Math.min(displayH, clientY - rect.top)),
    };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDrawing(true);
    const p = clampPos(e.clientX, e.clientY, overlayRef);
    currentPathRef.current = [p];
    setCurrentPath([p]);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const p = clampPos(e.clientX, e.clientY, overlayRef);
    // Hit-test paths in reverse order (topmost first)
    for (let i = paths.length - 1; i >= 0; i--) {
      const path = paths[i];
      if (path.length < 3) continue;
      const path2d = new Path2D();
      path2d.moveTo(path[0].x, path[0].y);
      for (let j = 1; j < path.length; j++) {
        path2d.lineTo(path[j].x, path[j].y);
      }
      path2d.closePath();
      const ctx = overlayRef.current?.getContext('2d');
      if (ctx && ctx.isPointInPath(path2d, p.x, p.y)) {
        setPaths(prev => prev.filter((_, idx) => idx !== i));
        return;
      }
    }
  };

  // Attach window-level listeners while drawing (edit mode)
  useEffect(() => {
    if (!drawing) return;

    const onWindowMove = (e: MouseEvent) => {
      const p = clampPos(e.clientX, e.clientY, overlayRef);
      currentPathRef.current = [...currentPathRef.current, p];
      setCurrentPath(prev => [...prev, p]);
    };

    const onWindowUp = () => {
      setDrawing(false);
      const path = currentPathRef.current;
      if (path.length > 2) {
        setPaths(old => [...old, path]);
      }
      currentPathRef.current = [];
      setCurrentPath([]);
    };

    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    return () => {
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onWindowUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, displayW, displayH]);

  // ─── Result-mode "include area" lasso mouse handling ───────────────

  const onResultMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setResultDrawing(true);
    const p = clampPos(e.clientX, e.clientY, resultOverlayRef);
    resultCurrentPathRef.current = [p];
    setResultCurrentPath([p]);
  };

  const onResultContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const p = clampPos(e.clientX, e.clientY, resultOverlayRef);
    const ctx = resultOverlayRef.current?.getContext('2d');
    if (!ctx) return;

    const hitTest = (pathList: Point[][]) => {
      for (let i = pathList.length - 1; i >= 0; i--) {
        const path = pathList[i];
        if (path.length < 3) continue;
        const path2d = new Path2D();
        path2d.moveTo(path[0].x, path[0].y);
        for (let j = 1; j < path.length; j++) {
          path2d.lineTo(path[j].x, path[j].y);
        }
        path2d.closePath();
        if (ctx.isPointInPath(path2d, p.x, p.y)) return i;
      }
      return -1;
    };

    // Check include paths first, then remove paths
    const includeIdx = hitTest(includePaths);
    if (includeIdx >= 0) {
      setIncludePaths(prev => prev.filter((_, i) => i !== includeIdx));
      // Remove corresponding history entry
      const histIdx = resultHistory.reduce((found, mode, i) => {
        if (found >= 0) return found;
        const count = resultHistory.slice(0, i + 1).filter(m => m === 'include').length;
        return count === includeIdx + 1 ? i : -1;
      }, -1);
      if (histIdx >= 0) setResultHistory(prev => prev.filter((_, i) => i !== histIdx));
      return;
    }

    const removeIdx = hitTest(removePaths);
    if (removeIdx >= 0) {
      setRemovePaths(prev => prev.filter((_, i) => i !== removeIdx));
      const histIdx = resultHistory.reduce((found, mode, i) => {
        if (found >= 0) return found;
        const count = resultHistory.slice(0, i + 1).filter(m => m === 'remove').length;
        return count === removeIdx + 1 ? i : -1;
      }, -1);
      if (histIdx >= 0) setResultHistory(prev => prev.filter((_, i) => i !== histIdx));
    }
  };

  useEffect(() => {
    if (!resultDrawing) return;
    const mode = resultMode; // capture mode at draw start

    const onWindowMove = (e: MouseEvent) => {
      const p = clampPos(e.clientX, e.clientY, resultOverlayRef);
      resultCurrentPathRef.current = [...resultCurrentPathRef.current, p];
      setResultCurrentPath(prev => [...prev, p]);
    };

    const onWindowUp = () => {
      setResultDrawing(false);
      const path = resultCurrentPathRef.current;
      if (path.length > 2) {
        if (mode === 'include') {
          setIncludePaths(old => [...old, path]);
        } else {
          setRemovePaths(old => [...old, path]);
        }
        setResultHistory(old => [...old, mode]);
      }
      resultCurrentPathRef.current = [];
      setResultCurrentPath([]);
    };

    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    return () => {
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onWindowUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultDrawing, resultMode, displayW, displayH]);

  // ─── Draw result image + composite include areas ───────────────────

  // Load the result image into an HTMLImageElement for canvas drawing
  useEffect(() => {
    if (!resultImage) { resultImgRef.current = null; return; }
    const img = new Image();
    img.onload = () => { resultImgRef.current = img; setResultImgLoaded(n => n + 1); };
    img.src = resultImage;
  }, [resultImage]);

  // Draw result canvas: result image + include-area overlay from original
  useEffect(() => {
    const canvas = resultCanvasRef.current;
    const resImg = resultImgRef.current;
    const origImg = imgRef.current;
    if (!canvas || !resImg || !origImg || displayW === 0) return;

    canvas.width = displayW;
    canvas.height = displayH;
    const ctx = canvas.getContext('2d')!;

    // Draw result image as base
    ctx.drawImage(resImg, 0, 0, displayW, displayH);

    // Composite include areas from original image
    for (const path of includePaths) {
      if (path.length < 3) continue;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(origImg, 0, 0, displayW, displayH);
      ctx.restore();
    }

    // Clear remove areas
    for (const path of removePaths) {
      if (path.length < 3) continue;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.closePath();
      ctx.clip();
      ctx.clearRect(0, 0, displayW, displayH);
      ctx.restore();
    }
  }, [resultImage, resultImgLoaded, includePaths, removePaths, displayW, displayH]);

  // Draw overlay highlights for include (green) and remove (red) paths
  useEffect(() => {
    const canvas = resultOverlayRef.current;
    if (!canvas || displayW === 0) return;
    canvas.width = displayW;
    canvas.height = displayH;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, displayW, displayH);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const drawPaths = (paths: Point[][], fill: string, stroke: string) => {
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      for (const path of paths) {
        if (path.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(path[i].x, path[i].y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    };

    drawPaths(includePaths, 'rgba(0, 210, 160, 0.2)', 'rgba(0, 210, 160, 0.8)');
    drawPaths(removePaths, 'rgba(255, 83, 112, 0.2)', 'rgba(255, 83, 112, 0.8)');

    // Current path being drawn
    if (resultCurrentPath.length > 0) {
      const isInclude = resultMode === 'include';
      drawPaths(
        [resultCurrentPath],
        isInclude ? 'rgba(0, 210, 160, 0.2)' : 'rgba(255, 83, 112, 0.2)',
        isInclude ? 'rgba(0, 210, 160, 0.8)' : 'rgba(255, 83, 112, 0.8)',
      );
    }
  }, [includePaths, removePaths, resultCurrentPath, resultMode, displayW, displayH]);

  // Generate full-res composited image for download
  useEffect(() => {
    const origImg = imgRef.current;
    const resImg = resultImgRef.current;
    if (!resImg || !origImg || (includePaths.length === 0 && removePaths.length === 0) || imageSize.w === 0) {
      setCompositedImage(null);
      return;
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = imageSize.w;
    offscreen.height = imageSize.h;
    const ctx = offscreen.getContext('2d')!;
    const invScale = 1 / scale;

    // Draw result at full res
    ctx.drawImage(resImg, 0, 0, imageSize.w, imageSize.h);

    // Composite include areas from original
    for (const path of includePaths) {
      if (path.length < 3) continue;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(path[0].x * invScale, path[0].y * invScale);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x * invScale, path[i].y * invScale);
      }
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(origImg, 0, 0, imageSize.w, imageSize.h);
      ctx.restore();
    }

    // Clear remove areas
    for (const path of removePaths) {
      if (path.length < 3) continue;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(path[0].x * invScale, path[0].y * invScale);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x * invScale, path[i].y * invScale);
      }
      ctx.closePath();
      ctx.clip();
      ctx.clearRect(0, 0, imageSize.w, imageSize.h);
      ctx.restore();
    }

    setCompositedImage(offscreen.toDataURL('image/png'));
  }, [includePaths, removePaths, imageSize, scale, resultImage]);

  // Generate final mask (refined mask + include/remove edits)
  useEffect(() => {
    if (!refinedMask || imageSize.w === 0) {
      setFinalMask(null);
      return;
    }

    const img = new Image();
    img.onload = () => {
      const offscreen = document.createElement('canvas');
      offscreen.width = imageSize.w;
      offscreen.height = imageSize.h;
      const ctx = offscreen.getContext('2d')!;
      const invScale = 1 / scale;

      // Draw original refined mask
      ctx.drawImage(img, 0, 0, imageSize.w, imageSize.h);

      // Composite include areas (white)
      ctx.fillStyle = '#fff';
      for (const path of includePaths) {
        if (path.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(path[0].x * invScale, path[0].y * invScale);
        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(path[i].x * invScale, path[i].y * invScale);
        }
        ctx.closePath();
        ctx.fill();
      }

      // Composite remove areas (black)
      ctx.fillStyle = '#000';
      for (const path of removePaths) {
        if (path.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(path[0].x * invScale, path[0].y * invScale);
        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(path[i].x * invScale, path[i].y * invScale);
        }
        ctx.closePath();
        ctx.fill();
      }

      setFinalMask(offscreen.toDataURL('image/png'));
    };
    img.src = refinedMask;
  }, [refinedMask, includePaths, removePaths, imageSize, scale]);

  // ─── API submission ────────────────────────────────────────────────

  const handleSubmit = () => {
    if (!imageSrc || !maskDataUrl) return;
    setState('loading');
    setError(null);
    setRefinedMask(null);
    setFinalMask(null);
    setResultImage(null);
    setIncludePaths([]);
    setRemovePaths([]);
    setResultCurrentPath([]);
    setResultHistory([]);
    setCompositedImage(null);
    setStatusText('Uploading…');

    const source = new SSE('https://1417.gpu.mainly.cloud/upload', {
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify({ image: imageSrc, mask: maskDataUrl }),
      method: 'POST',
    });

    source.addEventListener('mask', (e: MessageEvent) => {
      const data = e.data.startsWith('"') ? JSON.parse(e.data) : e.data;
      setRefinedMask(data);
      setStatusText('Mask received, generating result…');
    });

    source.addEventListener('image', (e: MessageEvent) => {
      const data = e.data.startsWith('"') ? JSON.parse(e.data) : e.data;
      setResultImage(data);
      setStatusText('');
      setState('result');
      source.close();
    });

    source.addEventListener('error', (e: Event) => {
      const msg = (e as MessageEvent)?.data;
      setError(msg || 'Connection error');
      setState('edit');
      source.close();
    });

    source.stream();
  };

  const handleReset = () => {
    setImageSrc(null);
    setImageSize({ w: 0, h: 0 });
    setPaths([]);
    setCurrentPath([]);
    setMaskDataUrl(null);
    setRefinedMask(null);
    setFinalMask(null);
    setResultImage(null);
    setIncludePaths([]);
    setRemovePaths([]);
    setResultCurrentPath([]);
    setResultHistory([]);
    setCompositedImage(null);
    setError(null);
    setStatusText('');
    setState('upload');
  };

  const handleClearMask = () => {
    setPaths([]);
    setCurrentPath([]);
  };

  const handleUndo = () => {
    setPaths(prev => prev.slice(0, -1));
  };

  const handleUndoResult = () => {
    const last = resultHistory[resultHistory.length - 1];
    if (!last) return;
    if (last === 'include') {
      setIncludePaths(prev => prev.slice(0, -1));
    } else {
      setRemovePaths(prev => prev.slice(0, -1));
    }
    setResultHistory(prev => prev.slice(0, -1));
  };

  const handleClearResult = () => {
    setIncludePaths([]);
    setRemovePaths([]);
    setResultCurrentPath([]);
    setResultHistory([]);
  };

  const downloadUrl = compositedImage || resultImage;

  return (
    <div className="app">
      <header className="header">
        <h1>Masked Background Removal</h1>
        <p>Upload an image, lasso the object, remove the background</p>
      </header>

      {error && <div className="error-message fade-in">{error}</div>}

      {state === 'upload' && (
        <div
          className="upload-zone fade-in"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={e => {
            e.preventDefault();
            e.stopPropagation();
            const file = e.dataTransfer.files[0];
            if (file?.type.startsWith('image/')) handleFile(file);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
          <div className="upload-icon">📸</div>
          <h3>Drop an image or click to upload</h3>
          <span>PNG, JPG, WEBP — any size</span>
        </div>
      )}

      {(state === 'edit' || state === 'loading') && (
        <div className="fade-in">
          <div className="editor-layout">
            {/* Left: Image + Lasso */}
            <div className="panel">
              <div className="panel-header">
                <h3>Draw Mask</h3>
                <div className="toolbar">
                  <button onClick={handleUndo} disabled={paths.length === 0}>
                    Undo
                  </button>
                  <button onClick={handleClearMask} disabled={paths.length === 0}>
                    Clear
                  </button>
                  {paths.length > 0 ? (
                    <span className="status-badge ready">● Mask ready</span>
                  ) : (
                    <span className="status-badge drawing">● Draw a lasso</span>
                  )}
                </div>
              </div>
              <div className="panel-body">
                <div className="canvas-container" ref={containerRef}>
                  <canvas ref={canvasRef} />
                  <canvas
                    ref={overlayRef}
                    className="canvas-overlay"
                    onMouseDown={onMouseDown}
                    onContextMenu={onContextMenu}
                  />
                </div>
              </div>
            </div>

            {/* Right: Mask preview */}
            <div className="panel">
              <div className="panel-header">
                <h3>Mask Preview</h3>
              </div>
              <div className="panel-body">
                {maskDataUrl ? (
                  <div className="canvas-container">
                    <img src={maskDataUrl} alt="Mask" className="mask-preview-img" width={displayW} height={displayH} />
                  </div>
                ) : (
                  <div className="empty-state">
                    Draw a selection on the image to see the mask here
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="actions">
            <button className="btn-secondary" onClick={handleReset}>
              ↩ Change Image
            </button>
            <button
              className="btn-primary"
              onClick={handleSubmit}
              disabled={!maskDataUrl || state === 'loading'}
            >
              {state === 'loading' ? 'Processing…' : '✦ Remove Background'}
            </button>
          </div>
        </div>
      )}

      {state === 'loading' && (
        <div className="spinner-wrap fade-in">
          <div className="spinner" />
          <span>{statusText || 'Removing background…'}</span>
        </div>
      )}

      {state === 'result' && (
        <div className="result-section fade-in">
          <div className="editor-layout">
            {/* Left: Result image with include/remove lasso */}
            {resultImage && (
              <div className="panel">
                <div className="panel-header">
                  <h3>Result</h3>
                  <div className="toolbar">
                    <button
                      className={resultMode === 'include' ? 'active' : ''}
                      onClick={() => setResultMode('include')}
                      style={resultMode === 'include' ? { borderColor: 'var(--success)', color: 'var(--success)', background: 'rgba(0,210,160,0.12)' } : {}}
                    >
                      + Include
                    </button>
                    <button
                      className={resultMode === 'remove' ? 'active' : ''}
                      onClick={() => setResultMode('remove')}
                      style={resultMode === 'remove' ? { borderColor: 'var(--error)', color: 'var(--error)', background: 'rgba(255,83,112,0.12)' } : {}}
                    >
                      − Remove
                    </button>
                    <button onClick={handleUndoResult} disabled={resultHistory.length === 0}>
                      Undo
                    </button>
                    <button onClick={handleClearResult} disabled={resultHistory.length === 0}>
                      Clear
                    </button>
                  </div>
                  <div className="slider-row">
                    <label>Show Original</label>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={originalOpacity}
                      onChange={e => setOriginalOpacity(parseFloat(e.target.value))}
                    />
                  </div>
                </div>
                <div className="panel-body">
                  <div className="canvas-container">
                    {imageSrc && originalOpacity > 0 && (
                      <img
                        src={imageSrc}
                        alt="Original"
                        className="original-underlay"
                        style={{ width: displayW, height: displayH, opacity: originalOpacity }}
                      />
                    )}
                    <canvas ref={resultCanvasRef} />
                    <canvas
                      ref={resultOverlayRef}
                      className="canvas-overlay"
                      onMouseDown={onResultMouseDown}
                      onContextMenu={onResultContextMenu}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Right: Refined Mask */}
            {finalMask && (
              <div className="panel">
                <div className="panel-header">
                  <h3>Refined Mask</h3>
                </div>
                <div className="panel-body">
                  <img src={finalMask} alt="Refined Mask" className="mask-preview-img" />
                </div>
              </div>
            )}
          </div>

          <div className="actions">
            <button className="btn-secondary" onClick={handleReset}>
              ↩ New Image
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                if (!downloadUrl) return;
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.download = 'result.png';
                a.click();
              }}
              disabled={!downloadUrl}
            >
              ⬇ Image
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                if (!finalMask) return;
                const a = document.createElement('a');
                a.href = finalMask;
                a.download = 'mask.png';
                a.click();
              }}
              disabled={!finalMask}
            >
              ⬇ Mask
            </button>
          </div>
        </div>
      )}
      <a
        className="mainly-btn"
        href="https://platform.mainly.ai/designer/projects/1/graphs/1417"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="mainly-btn-label">Edit on</span>
        <img src="/wordmark-light.svg" alt="Mainly.AI" className="mainly-wordmark" />
      </a>
    </div>
  );
}

export default App;
