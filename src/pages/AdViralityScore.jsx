import { useEffect, useState } from 'react'

const API_URL = import.meta.env.VITE_VIRALITY_API_URL

// ─── responsive hook ─────────────────────────────────────────────────────────

function useWindowWidth() {
  const [w, setW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 800))
  useEffect(() => {
    const handler = () => setW(window.innerWidth)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])
  return w
}

// ─── history helpers (localStorage) ──────────────────────────────────────────

const HISTORY_KEY = 'virality_history'
const HISTORY_MAX = 10

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveToHistory(filename, scores) {
  if (!scores || typeof scores.overall !== 'number') return loadHistory()
  const numericScores = Object.fromEntries(
    Object.entries(scores).filter(([, v]) => typeof v === 'number'),
  )
  const entry = {
    id:
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filename: filename || 'Untitled',
    timestamp: Date.now(),
    scores: numericScores,
    feedback: scores.feedback ?? null,
    transcript: scores.transcript ?? null,
  }
  const next = [entry, ...loadHistory()].slice(0, HISTORY_MAX)
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    // storage full or unavailable — ignore
  }
  return next
}

function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY)
  } catch {
    // ignore
  }
  return []
}

function formatHistoryDate(ts) {
  const d = new Date(ts)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `Today, ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

const MAX_PX = 1280
const JPEG_Q = 0.82
const AUDIO_MAX_SEC = 60   // first 60s of audio → ~1.9MB WAV, well under Vercel 4.5MB limit
const AUDIO_SR = 16000     // 16 kHz mono — Whisper's native rate

// ─── canvas helpers ──────────────────────────────────────────────────────────

function canvasToFile(canvas, name, quality = JPEG_Q) {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(new File([blob], name, { type: 'image/jpeg' })),
      'image/jpeg',
      quality,
    )
  })
}

function resizeCanvas(source, maxPx = MAX_PX) {
  let w = source.videoWidth ?? source.naturalWidth ?? source.width
  let h = source.videoHeight ?? source.naturalHeight ?? source.height
  if (w > maxPx || h > maxPx) {
    const r = Math.min(maxPx / w, maxPx / h)
    w = Math.round(w * r)
    h = Math.round(h * r)
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(source, 0, 0, w, h)
  return canvas
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = async () => {
      URL.revokeObjectURL(url)
      const canvas = resizeCanvas(img)
      resolve(await canvasToFile(canvas, file.name.replace(/\.\w+$/, '.jpg')))
    }
    img.onerror = reject
    img.src = url
  })
}

// ─── video storyboard ────────────────────────────────────────────────────────

function seekTo(video, time) {
  return new Promise((resolve) => {
    video.onseeked = () => resolve()
    video.currentTime = time
  })
}

async function extractVideoStoryboard(file, frameCount = 6) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    const url = URL.createObjectURL(file)

    video.onloadedmetadata = async () => {
      try {
        const duration = video.duration
        const cols = 3
        const rows = Math.ceil(frameCount / cols)
        const thumbW = 320
        const thumbH = Math.round(thumbW * (video.videoHeight / video.videoWidth)) || 180

        const grid = document.createElement('canvas')
        grid.width  = cols * thumbW
        grid.height = rows * thumbH
        const ctx = grid.getContext('2d')
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, grid.width, grid.height)

        for (let i = 0; i < frameCount; i++) {
          const t = duration * (0.02 + (0.96 * i) / (frameCount - 1))
          await seekTo(video, t)
          const col = i % cols
          const row = Math.floor(i / cols)
          ctx.drawImage(video, col * thumbW, row * thumbH, thumbW, thumbH)
          const label = `${Math.round(t)}s`
          ctx.fillStyle = 'rgba(0,0,0,0.55)'
          ctx.fillRect(col * thumbW + 4, row * thumbH + 4, 36, 16)
          ctx.fillStyle = '#fff'
          ctx.font = '11px sans-serif'
          ctx.fillText(label, col * thumbW + 7, row * thumbH + 15)
        }

        URL.revokeObjectURL(url)
        resolve(await canvasToFile(grid, 'storyboard.jpg', 0.88))
      } catch (e) {
        URL.revokeObjectURL(url)
        reject(e)
      }
    }
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Video load failed')) }
    video.src = url
  })
}

// ─── audio extraction ────────────────────────────────────────────────────────

// Encode PCM float32 samples → 16-bit WAV Blob
function pcmToWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)            // PCM
  v.setUint16(22, 1, true)            // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    off += 2
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// Extract first AUDIO_MAX_SEC seconds of audio as 16 kHz mono WAV.
// Returns a Blob (for FormData) or null if the video has no audio.
async function extractAudioWav(videoFile) {
  // Skip audio extraction for very large files to avoid OOM
  if (videoFile.size > 50 * 1024 * 1024) return null
  try {
    const arrayBuffer = await videoFile.arrayBuffer()
    const tempCtx = new AudioContext()
    let audioBuffer
    try {
      audioBuffer = await tempCtx.decodeAudioData(arrayBuffer)
    } catch {
      return null   // no decodable audio track
    } finally {
      tempCtx.close()
    }
    const duration = Math.min(audioBuffer.duration, AUDIO_MAX_SEC)
    const numSamples = Math.floor(duration * AUDIO_SR)
    const offCtx = new OfflineAudioContext(1, numSamples, AUDIO_SR)
    const src = offCtx.createBufferSource()
    src.buffer = audioBuffer
    src.connect(offCtx.destination)
    src.start(0)
    const rendered = await offCtx.startRendering()
    return pcmToWav(rendered.getChannelData(0), AUDIO_SR)
  } catch {
    return null
  }
}

// ─── scoring ─────────────────────────────────────────────────────────────────

const MOCK_SCORES = {
  overall: 78, emotion: 82, hook: 71,
  retention: 75, shareability: 84, trend: 69,
}

const SCORE_LABELS = {
  overall: 'Overall Virality',
  emotion: 'Emotional Resonance',
  hook: 'Hook Strength',
  retention: 'Retention Power',
  shareability: 'Shareability',
  trend: 'Trend Alignment',
}

function scoreColor(score) {
  if (score >= 80) return '#22c55e'
  if (score >= 60) return '#f59e0b'
  return '#ef4444'
}

async function fetchScore({ file, url, inputMode, setStatus }) {
  if (!API_URL) {
    await new Promise(r => setTimeout(r, 1200))
    return {
      ...MOCK_SCORES,
      overall: Math.floor(60 + Math.random() * 35),
      emotion: Math.floor(55 + Math.random() * 40),
      hook: Math.floor(50 + Math.random() * 45),
      retention: Math.floor(55 + Math.random() * 40),
      shareability: Math.floor(60 + Math.random() * 35),
      trend: Math.floor(45 + Math.random() * 50),
      feedback: {
        summary: 'Mock analysis: strong visual but hook could be sharper.',
        strengths: ['Clear product focus', 'Good color contrast'],
        improvements: [
          'Strengthen the opening 3 seconds',
          'Add captions for silent viewers',
          'Test a curiosity-gap headline',
        ],
      },
    }
  }

  if (inputMode === 'url') {
    setStatus('Analyzing...')
    const res = await fetch(`${API_URL}/score-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type: 'video', platform: 'tiktok' }),
    })
    if (!res.ok) throw new Error('Backend error')
    return res.json()
  }

  const isVideo = file.type.startsWith('video/')

  // Run storyboard + audio extraction in parallel
  setStatus('🎬 Extracting frames...')
  const [storyboard, audioBlob] = await Promise.all([
    isVideo ? extractVideoStoryboard(file) : compressImage(file),
    isVideo ? extractAudioWav(file) : Promise.resolve(null),
  ])

  setStatus('⚡ Analyzing with AI...')
  const form = new FormData()
  form.append('file', storyboard)
  form.append('type', 'video')
  form.append('platform', 'tiktok')
  if (audioBlob) {
    form.append('audio', new File([audioBlob], 'audio.wav', { type: 'audio/wav' }))
  }

  const res = await fetch(`${API_URL}/score`, { method: 'POST', body: form })
  if (!res.ok) throw new Error('Backend error')
  return res.json()
}

// ─── UI components ────────────────────────────────────────────────────────────

const SCORE_ICONS = {
  overall: '⚡',
  emotion: '❤️',
  hook: '🎯',
  retention: '👁️',
  shareability: '🔁',
  trend: '📈',
}

function HeroScore({ score }) {
  const radius = 56
  const stroke = 10
  const circumference = 2 * Math.PI * radius
  const filled = (score / 100) * circumference
  const color = scoreColor(score)
  const label = score >= 80 ? 'High Viral Potential' : score >= 60 ? 'Moderate Potential' : 'Needs Work'
  const emoji = score >= 80 ? '🔥' : score >= 60 ? '📈' : '⚠️'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '8px 0 24px' }}>
      <div style={{ position: 'relative', width: 140, height: 140 }}>
        <svg width="140" height="140" viewBox="0 0 140 140" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="70" cy="70" r={radius} fill="none" stroke="#f0f0f5" strokeWidth={stroke} />
          <circle
            cx="70" cy="70" r={radius} fill="none" stroke={color} strokeWidth={stroke}
            strokeDasharray={`${filled} ${circumference - filled}`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 1.2s cubic-bezier(.4,0,.2,1)', filter: `drop-shadow(0 0 8px ${color}88)` }}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 38, fontWeight: 900, color, lineHeight: 1 }}>{score}</span>
          <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600 }}>/100</span>
        </div>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#1f2937' }}>{emoji} {label}</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
          {score >= 80 ? 'Strong signals — consider paid boost' : score >= 60 ? 'Strengthen hook & emotion for lift' : 'Revisit concept, hook & targeting'}
        </div>
      </div>
    </div>
  )
}

function MiniRing({ score, label }) {
  const radius = 24
  const circumference = 2 * Math.PI * radius
  const filled = (score / 100) * circumference
  const color = scoreColor(score)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{ position: 'relative', width: 62, height: 62 }}>
        <svg width="62" height="62" viewBox="0 0 62 62" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="31" cy="31" r={radius} fill="none" stroke="#f0f0f5" strokeWidth="7" />
          <circle
            cx="31" cy="31" r={radius} fill="none" stroke={color} strokeWidth="7"
            strokeDasharray={`${filled} ${circumference - filled}`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 1.2s cubic-bezier(.4,0,.2,1)' }}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 15, fontWeight: 800, color }}>{score}</span>
        </div>
      </div>
      <span style={{ fontSize: 11, color: '#6b7280', textAlign: 'center', maxWidth: 70, lineHeight: 1.3 }}>{label}</span>
    </div>
  )
}

function BarScore({ label, score, icon }) {
  const color = scoreColor(score)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{label}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color }}>{score}</span>
        </div>
        <div style={{ background: '#f0f0f5', borderRadius: 999, height: 7, overflow: 'hidden' }}>
          <div style={{ width: `${score}%`, background: `linear-gradient(90deg, ${color}bb, ${color})`, height: '100%', borderRadius: 999, transition: 'width 1.2s cubic-bezier(.4,0,.2,1)' }} />
        </div>
      </div>
    </div>
  )
}

function LoadingDots({ status }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 0 }}>
      <span style={{ display: 'inline-flex', gap: 8 }}>
        {[0, 1, 2].map(i => (
          <span key={i} style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'linear-gradient(135deg, #667eea, #764ba2)', animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite` }} />
        ))}
      </span>
      <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 500 }}>{status || 'Analyzing…'}</span>
    </span>
  )
}

// ─── main component ───────────────────────────────────────────────────────────

export default function AdViralityScore() {
  const [file, setFile] = useState(null)
  const [url, setUrl] = useState('')
  const [inputMode, setInputMode] = useState('file')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [scores, setScores] = useState(null)
  const [error, setError] = useState(null)
  const [history, setHistory] = useState([])
  const [historyOpen, setHistoryOpen] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const [ctaHover, setCtaHover] = useState(false)

  const isMobile = useWindowWidth() < 600

  useEffect(() => {
    setHistory(loadHistory())
  }, [])

  async function handleScore() {
    setError(null)
    setScores(null)
    setLoading(true)
    setStatus('Starting…')
    try {
      const result = await fetchScore({ file, url, inputMode, setStatus })
      setScores(result)
      const label = inputMode === 'file' ? file?.name : url.trim() || 'Untitled URL'
      setHistory(saveToHistory(label, result))
    } catch {
      setError('Scoring failed. Please try again.')
    } finally {
      setLoading(false)
      setStatus('')
    }
  }

  function handleRestore(entry) {
    setScores({ ...entry.scores, feedback: entry.feedback ?? undefined, transcript: entry.transcript ?? undefined })
    setError(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) { setFile(f); setScores(null) }
  }

  function handleCopyScore() {
    if (!scores) return
    const text = `Virality Score: ${scores.overall}/100\nEmotion: ${scores.emotion} · Hook: ${scores.hook} · Retention: ${scores.retention}\nShareability: ${scores.shareability} · Trend: ${scores.trend}`
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const highestScore = history.reduce((max, h) => Math.max(max, h.scores?.overall ?? 0), 0)
  const canScore = inputMode === 'file' ? !!file : url.trim().length > 0

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg, #5b49e8 0%, #764ba2 60%, #9333ea 100%)', padding: isMobile ? '24px 12px 40px' : '40px 16px 48px' }}>
      <div style={{ maxWidth: 620, margin: '0 auto' }}>

        {/* ── Header ── */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 56, height: 56, borderRadius: 16, background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)', marginBottom: 14, fontSize: 26 }}>⚡</div>
          <h1 style={{ fontSize: isMobile ? 24 : 30, fontWeight: 900, color: '#fff', margin: '0 0 8px', letterSpacing: '-0.5px' }}>Virality Score</h1>
          <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: 15, margin: 0, lineHeight: 1.5 }}>
            Upload your video — get an AI score before you post
          </p>
        </div>

        {/* ── History (shown above input when history exists and no active result) ── */}
        {history.length > 0 && !scores && (
          <div style={{ background: 'rgba(255,255,255,0.1)', backdropFilter: 'blur(12px)', borderRadius: 20, padding: '16px 20px', marginBottom: 16, border: '1px solid rgba(255,255,255,0.15)' }}>
            <button
              onClick={() => setHistoryOpen(o => !o)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15 }}>📜</span>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#fff', letterSpacing: 0.3 }}>Recent Scores</span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.25)', padding: '2px 7px', borderRadius: 999, fontWeight: 600 }}>{history.length}</span>
              </div>
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>{historyOpen ? '▾' : '▸'}</span>
            </button>
            {historyOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
                {history.map((entry) => {
                  const overall = entry.scores?.overall ?? 0
                  const color = scoreColor(overall)
                  const isTop = overall === highestScore && highestScore > 0
                  return (
                    <button key={entry.id} onClick={() => handleRestore(entry)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px', borderRadius: 12, border: `1px solid ${isTop ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)'}`, background: isTop ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', transition: 'background 0.15s' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = isTop ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)' }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {isTop && <span style={{ fontSize: 11 }}>🏆</span>}
                          <span style={{ fontSize: 13, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.filename}</span>
                        </div>
                        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>{formatHistoryDate(entry.timestamp)}</span>
                      </div>
                      <div style={{ flexShrink: 0, padding: '4px 10px', borderRadius: 999, background: color, color: '#fff', fontSize: 13, fontWeight: 700, boxShadow: isTop ? `0 2px 8px ${color}66` : 'none' }}>{overall}</div>
                    </button>
                  )
                })}
                <button onClick={() => setHistory(clearHistory())}
                  style={{ marginTop: 4, width: '100%', padding: '8px 0', borderRadius: 10, border: '1px solid rgba(255,100,100,0.35)', background: 'transparent', color: 'rgba(255,160,160,0.9)', fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                  🗑 Clear history
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Input Card ── */}
        <div style={{ background: '#fff', borderRadius: 24, padding: isMobile ? '20px 16px' : '28px 24px', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>

          {/* Mode tabs */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 20, background: '#f3f4f6', borderRadius: 12, padding: 4 }}>
            {[{ key: 'file', label: '📁 Upload File' }, { key: 'url', label: '🔗 Paste URL' }].map(({ key, label }) => (
              <button key={key} onClick={() => { setInputMode(key); setScores(null) }}
                style={{ flex: 1, padding: '8px 0', borderRadius: 9, border: 'none', background: inputMode === key ? '#fff' : 'transparent', color: inputMode === key ? '#4f46e5' : '#6b7280', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: inputMode === key ? '0 1px 4px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.2s', fontFamily: 'inherit' }}>
                {label}
              </button>
            ))}
          </div>

          {/* Input area */}
          {inputMode === 'file' ? (
            <label
              style={{ display: 'block', border: `2px dashed ${dragging ? '#6d28d9' : file ? '#a5b4fc' : '#d1d5db'}`, borderRadius: 16, padding: isMobile ? '20px 16px' : '28px 20px', textAlign: 'center', cursor: 'pointer', background: dragging ? '#f5f3ff' : file ? '#faf5ff' : '#fafafa', marginBottom: 20, transition: 'all 0.15s' }}
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <input type="file" accept="image/*,video/*" style={{ display: 'none' }}
                onChange={e => { setFile(e.target.files[0]); setScores(null) }} />
              {file ? (
                <div>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 6 }}>
                    <polyline points="16 16 12 12 8 16" />
                    <line x1="12" y1="12" x2="12" y2="21" />
                    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
                  </svg>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#4f46e5' }}>{file.name}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <span style={{ background: '#eef2ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 999, fontWeight: 600 }}>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                    <span>{file.type.startsWith('video/') ? 'storyboard + audio' : file.size > 1024 * 1024 ? 'will compress' : 'image'}</span>
                    <span>· tap to change</span>
                  </div>
                </div>
              ) : (
                <div>
                  {dragging ? (
                    <div style={{ fontSize: 32, marginBottom: 8 }}>⬇️</div>
                  ) : (
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8 }}>
                      <polyline points="16 16 12 12 8 16" />
                      <line x1="12" y1="12" x2="12" y2="21" />
                      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
                    </svg>
                  )}
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#374151' }}>{dragging ? 'Drop it!' : 'Drop file or click to browse'}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>MP4 · MOV · JPG · PNG · Any size</div>
                </div>
              )}
            </label>
          ) : (
            <input type="url" placeholder="https://example.com/video.mp4" value={url}
              onChange={e => { setUrl(e.target.value); setScores(null) }}
              style={{ width: '100%', padding: '13px 15px', borderRadius: 12, border: '1.5px solid #e5e7eb', fontSize: 14, marginBottom: 20, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', transition: 'border-color 0.15s' }}
              onFocus={e => { e.target.style.borderColor = '#6d28d9' }}
              onBlur={e => { e.target.style.borderColor = '#e5e7eb' }}
            />
          )}

          {/* CTA button */}
          <button onClick={handleScore} disabled={!canScore || loading}
            onMouseEnter={() => { if (canScore && !loading) setCtaHover(true) }}
            onMouseLeave={() => setCtaHover(false)}
            style={{ width: '100%', padding: '15px 0', borderRadius: 14, border: 'none', background: canScore && !loading ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' : '#f3f4f6', color: canScore && !loading ? '#fff' : '#9ca3af', fontWeight: 800, fontSize: 16, cursor: canScore && !loading ? 'pointer' : 'not-allowed', transition: 'all 0.2s', letterSpacing: 0.2, fontFamily: 'inherit', boxShadow: canScore && !loading ? (ctaHover ? '0 6px 28px rgba(102,126,234,0.6)' : '0 4px 20px rgba(102,126,234,0.45)') : 'none', transform: canScore && !loading && ctaHover ? 'translateY(-1px)' : 'none' }}>
            {loading ? <LoadingDots status={status} /> : '⚡ Analyze Virality'}
          </button>

          {error && (
            <div style={{ marginTop: 14, padding: '11px 15px', background: '#fef2f2', borderRadius: 10, color: '#dc2626', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', borderLeft: '3px solid #ef4444' }}>
              <span>⚠️</span><span>{error}</span>
            </div>
          )}
        </div>

        {/* ── Results ── */}
        {scores && (
          <div style={{ background: '#fff', borderRadius: 24, padding: isMobile ? '20px 16px' : '28px 24px', boxShadow: '0 24px 64px rgba(0,0,0,0.18)', marginTop: 16, animation: 'slideUp 0.4s cubic-bezier(.4,0,.2,1)' }}>

            {/* Results heading */}
            <div style={{ textAlign: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1 }}>Your Virality Score</span>
            </div>

            {/* Hero score */}
            <HeroScore score={scores.overall} />

            {/* Sub-score rings */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(5, 1fr)', gap: 8, justifyItems: 'center', borderTop: '1px solid #f3f4f6', paddingTop: 20, marginBottom: 20 }}>
              {Object.entries(scores)
                .filter(([k, val]) => k !== 'overall' && typeof val === 'number')
                .map(([key, val]) => <MiniRing key={key} score={val} label={SCORE_LABELS[key] ?? key} />)}
            </div>

            {/* Bar breakdown */}
            <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 18, marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.8 }}>Breakdown</div>
              {Object.entries(scores)
                .filter(([k, val]) => k !== 'overall' && typeof val === 'number')
                .map(([key, val]) => <BarScore key={key} label={SCORE_LABELS[key] ?? key} score={val} icon={SCORE_ICONS[key] ?? '•'} />)}
            </div>

            {/* Transcript */}
            {scores.transcript && (
              <div style={{ marginTop: 16, padding: '12px 15px', background: '#f8f8ff', borderRadius: 12, border: '1px solid #e0e7ff' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>🎙 Transcript detected</div>
                <p style={{ fontSize: 13, color: '#374151', margin: 0, lineHeight: 1.55 }}>
                  {scores.transcript.length > 220 ? scores.transcript.slice(0, 220) + '…' : scores.transcript}
                </p>
              </div>
            )}

            {/* AI Feedback */}
            {scores.feedback && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {scores.feedback.summary && (
                  <div style={{ padding: '15px 18px', borderRadius: 14, background: '#f9fafb', border: '1px solid #e5e7eb' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.8 }}>AI Summary</div>
                    <p style={{ fontSize: 14, color: '#1f2937', lineHeight: 1.6, margin: 0 }}>{scores.feedback.summary}</p>
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : (scores.feedback.strengths?.length && scores.feedback.improvements?.length ? '1fr 1fr' : '1fr'), gap: 12 }}>
                  {scores.feedback.strengths?.length > 0 && (
                    <div style={{ padding: '15px 16px', borderRadius: 14, background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#15803d', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>✅ Strengths</div>
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {scores.feedback.strengths.map((item, i) => (
                          <li key={i} style={{ fontSize: 13, color: '#14532d', lineHeight: 1.45 }}>· {item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {scores.feedback.improvements?.length > 0 && (
                    <div style={{ padding: '15px 16px', borderRadius: 14, background: '#fffbeb', border: '1px solid #fde68a' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>💡 Improvements</div>
                      <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {scores.feedback.improvements.map((item, i) => (
                          <li key={i} style={{ fontSize: 13, color: '#78350f', lineHeight: 1.45, display: 'flex', gap: 7 }}>
                            <span style={{ flexShrink: 0, fontWeight: 700, color: '#f59e0b' }}>{i + 1}.</span><span>{item}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 8, marginTop: 20 }}>
              <button onClick={handleCopyScore}
                style={{ flex: 1, padding: '11px 0', borderRadius: 12, border: '1.5px solid #e5e7eb', background: '#fff', color: copied ? '#22c55e' : '#374151', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' }}>
                {copied ? '✅ Copied!' : '📋 Copy Score'}
              </button>
              <button onClick={() => { setScores(null); setFile(null); setUrl('') }}
                style={{ flex: 1, padding: '11px 0', borderRadius: 12, border: 'none', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                ⚡ Score Another
              </button>
            </div>
          </div>
        )}

        {/* ── History (shown below results when a result is visible) ── */}
        {history.length > 0 && scores && (
          <div style={{ background: 'rgba(255,255,255,0.1)', backdropFilter: 'blur(12px)', borderRadius: 20, padding: '14px 18px', marginTop: 16, border: '1px solid rgba(255,255,255,0.15)' }}>
            <button onClick={() => setHistoryOpen(o => !o)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13 }}>📜</span>
                <span style={{ fontWeight: 700, fontSize: 13, color: '#fff' }}>History</span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.15)', padding: '2px 7px', borderRadius: 999, fontWeight: 600 }}>{history.length}</span>
              </div>
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>{historyOpen ? '▾' : '▸'}</span>
            </button>
            {historyOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10 }}>
                {history.map((entry) => {
                  const overall = entry.scores?.overall ?? 0
                  const color = scoreColor(overall)
                  const isTop = overall === highestScore && highestScore > 0
                  return (
                    <button key={entry.id} onClick={() => handleRestore(entry)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 11px', borderRadius: 11, border: `1px solid ${isTop ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.12)'}`, background: 'rgba(255,255,255,0.08)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.16)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {isTop && <span style={{ fontSize: 10 }}>🏆</span>}
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.filename}</span>
                        </div>
                        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{formatHistoryDate(entry.timestamp)}</span>
                      </div>
                      <div style={{ flexShrink: 0, padding: '3px 9px', borderRadius: 999, background: color, color: '#fff', fontSize: 12, fontWeight: 700 }}>{overall}</div>
                    </button>
                  )
                })}
                <button onClick={() => setHistory(clearHistory())}
                  style={{ marginTop: 4, width: '100%', padding: '7px 0', borderRadius: 9, border: '1px solid rgba(255,100,100,0.3)', background: 'transparent', color: 'rgba(255,160,160,0.85)', fontWeight: 600, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
                  🗑 Clear history
                </button>
              </div>
            )}
          </div>
        )}

        <p style={{ textAlign: 'center', marginTop: 24, color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>
          Visual + Audio AI · {API_URL ? '🟢 Live' : '🟡 Mock'} · 10 req/hr
        </p>
      </div>
      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40%            { transform: translateY(-8px); opacity: 1; }
        }
      `}</style>
    </div>
  )
}
