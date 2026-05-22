import { useState } from 'react'

const API_URL = import.meta.env.VITE_VIRALITY_API_URL

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
      body: JSON.stringify({ url, type: 'video' }),
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
  if (audioBlob) {
    form.append('audio', new File([audioBlob], 'audio.wav', { type: 'audio/wav' }))
  }

  const res = await fetch(`${API_URL}/score`, { method: 'POST', body: form })
  if (!res.ok) throw new Error('Backend error')
  return res.json()
}

// ─── UI components ────────────────────────────────────────────────────────────

function ScoreRing({ score, label }) {
  const radius = 36
  const circumference = 2 * Math.PI * radius
  const filled = (score / 100) * circumference
  const color = scoreColor(score)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <svg width="90" height="90" viewBox="0 0 90 90">
        <circle cx="45" cy="45" r={radius} fill="none" stroke="#e5e7eb" strokeWidth="8" />
        <circle
          cx="45" cy="45" r={radius} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={`${filled} ${circumference - filled}`}
          strokeLinecap="round" transform="rotate(-90 45 45)"
          style={{ transition: 'stroke-dasharray 1s ease' }}
        />
        <text x="45" y="49" textAnchor="middle" fontSize="18" fontWeight="700" fill={color}>{score}</text>
      </svg>
      <span style={{ fontSize: 12, color: '#6b7280', textAlign: 'center', maxWidth: 90 }}>{label}</span>
    </div>
  )
}

function BarScore({ label, score }) {
  const color = scoreColor(score)
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 14 }}>
        <span style={{ color: '#374151' }}>{label}</span>
        <span style={{ fontWeight: 700, color }}>{score}/100</span>
      </div>
      <div style={{ background: '#e5e7eb', borderRadius: 999, height: 8, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, background: color, height: '100%', borderRadius: 999, transition: 'width 1s ease' }} />
      </div>
    </div>
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

  async function handleScore() {
    setError(null)
    setScores(null)
    setLoading(true)
    setStatus('Starting...')
    try {
      const result = await fetchScore({ file, url, inputMode, setStatus })
      setScores(result)
    } catch {
      setError('Scoring failed. Please try again.')
    } finally {
      setLoading(false)
      setStatus('')
    }
  }

  const canScore = inputMode === 'file' ? !!file : url.trim().length > 0

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', padding: '32px 16px' }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⚡</div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: '#fff', marginBottom: 6 }}>Virality Score</h1>
          <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 15 }}>
            Predict how viral your video will go — visual + audio AI analysis
          </p>
          {!API_URL && (
            <span style={{ display: 'inline-block', marginTop: 10, background: 'rgba(255,255,255,0.15)', color: '#fff', fontSize: 12, padding: '3px 12px', borderRadius: 999 }}>
              Mock mode — connect backend via VITE_VIRALITY_API_URL
            </span>
          )}
        </div>

        {/* Card */}
        <div style={{ background: '#fff', borderRadius: 20, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>

          {/* Input mode tabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[{ key: 'file', label: 'Upload File' }, { key: 'url', label: 'Paste URL' }].map(({ key, label }) => (
              <button key={key} onClick={() => { setInputMode(key); setScores(null) }}
                style={{ padding: '6px 16px', borderRadius: 8, border: `2px solid ${inputMode === key ? '#4f46e5' : '#e5e7eb'}`, background: inputMode === key ? '#eef2ff' : '#fff', color: inputMode === key ? '#4f46e5' : '#6b7280', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                {label}
              </button>
            ))}
          </div>

          {/* Input area */}
          {inputMode === 'file' ? (
            <label style={{ display: 'block', border: '2px dashed #c7d2fe', borderRadius: 14, padding: '28px 20px', textAlign: 'center', cursor: 'pointer', background: '#fafafa', marginBottom: 20 }}>
              <input type="file" accept="image/*,video/*" style={{ display: 'none' }}
                onChange={e => { setFile(e.target.files[0]); setScores(null) }} />
              {file ? (
                <div>
                  <div style={{ fontSize: 28, marginBottom: 6 }}>✅</div>
                  <div style={{ fontWeight: 600, color: '#4f46e5' }}>{file.name}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                    {file.type.startsWith('video/') ? ' → 6-frame storyboard + audio' : file.size > 1024 * 1024 ? ' → will compress' : ''}
                    {' · Click to change'}
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>📁</div>
                  <div style={{ fontWeight: 600, color: '#374151' }}>Drop file here or click to browse</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                    Images (JPG, PNG) or Videos (MP4, MOV, AVI) · Any size
                  </div>
                </div>
              )}
            </label>
          ) : (
            <input type="url" placeholder="https://example.com/my-video.mp4" value={url}
              onChange={e => { setUrl(e.target.value); setScores(null) }}
              style={{ width: '100%', padding: '14px 16px', borderRadius: 12, border: '2px solid #e5e7eb', fontSize: 14, marginBottom: 20, outline: 'none', fontFamily: 'inherit' }} />
          )}

          {/* Score button */}
          <button onClick={handleScore} disabled={!canScore || loading}
            style={{ width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: canScore && !loading ? 'linear-gradient(135deg, #667eea, #764ba2)' : '#e5e7eb', color: canScore && !loading ? '#fff' : '#9ca3af', fontWeight: 700, fontSize: 16, cursor: canScore && !loading ? 'pointer' : 'not-allowed', transition: 'all 0.2s' }}>
            {loading ? status || '⚡ Analyzing...' : '🚀 Get Virality Score'}
          </button>

          {error && (
            <div style={{ marginTop: 16, padding: '12px 16px', background: '#fef2f2', borderRadius: 10, color: '#dc2626', fontSize: 14 }}>
              {error}
            </div>
          )}
        </div>

        {/* Results */}
        {scores && (
          <div style={{ background: '#fff', borderRadius: 20, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.15)', marginTop: 20, animation: 'fadeIn 0.4s ease' }}>
            <h2 style={{ fontWeight: 700, fontSize: 18, marginBottom: 20, color: '#1a1a2e' }}>Score Results</h2>

            {/* Rings */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center', marginBottom: 28 }}>
              {Object.entries(scores)
                .filter(([, val]) => typeof val === 'number')
                .map(([key, val]) => <ScoreRing key={key} score={val} label={SCORE_LABELS[key] ?? key} />)}
            </div>

            {/* Bars */}
            <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#6b7280', marginBottom: 16, textTransform: 'uppercase', letterSpacing: 1 }}>Breakdown</h3>
              {Object.entries(scores)
                .filter(([k, val]) => k !== 'overall' && typeof val === 'number')
                .map(([key, val]) => <BarScore key={key} label={SCORE_LABELS[key] ?? key} score={val} />)}
            </div>

            {/* Verdict */}
            <div style={{ marginTop: 20, padding: '16px 20px', borderRadius: 14, background: scores.overall >= 80 ? '#f0fdf4' : scores.overall >= 60 ? '#fffbeb' : '#fef2f2', borderLeft: `4px solid ${scoreColor(scores.overall)}` }}>
              <div style={{ fontWeight: 700, color: scoreColor(scores.overall), marginBottom: 4 }}>
                {scores.overall >= 80 ? '🔥 High Viral Potential' : scores.overall >= 60 ? '📈 Moderate Potential' : '⚠️ Needs Improvement'}
              </div>
              <div style={{ fontSize: 13, color: '#4b5563' }}>
                {scores.overall >= 80 ? 'This content has strong viral signals. Consider boosting with paid promotion.'
                  : scores.overall >= 60 ? 'Decent virality. Strengthen your hook and emotional appeal for better results.'
                  : 'Low viral likelihood. Revisit the concept, hook, and audience targeting.'}
              </div>
            </div>

            {/* Transcript pill (if available) */}
            {scores.transcript && (
              <div style={{ marginTop: 16, padding: '10px 14px', background: '#f8faff', borderRadius: 10, border: '1px solid #e0e7ff' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: 1 }}>🎙 Transcript detected</span>
                <p style={{ fontSize: 13, color: '#374151', marginTop: 4, marginBottom: 0, lineHeight: 1.5 }}>
                  {scores.transcript.length > 200 ? scores.transcript.slice(0, 200) + '…' : scores.transcript}
                </p>
              </div>
            )}

            {/* AI Feedback */}
            {scores.feedback && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {scores.feedback.summary && (
                  <div style={{ background: '#fff', borderRadius: 20, padding: '18px 20px', boxShadow: '0 4px 14px rgba(0,0,0,0.06)', border: '1px solid #eef2ff' }}>
                    <h3 style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>AI Summary</h3>
                    <p style={{ fontSize: 14, color: '#1f2937', lineHeight: 1.55, margin: 0 }}>{scores.feedback.summary}</p>
                  </div>
                )}
                {scores.feedback.strengths?.length > 0 && (
                  <div style={{ background: '#f0fdf4', borderRadius: 20, padding: '18px 20px', boxShadow: '0 4px 14px rgba(0,0,0,0.06)', borderLeft: '4px solid #22c55e' }}>
                    <h3 style={{ fontSize: 12, fontWeight: 700, color: '#166534', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Strengths</h3>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {scores.feedback.strengths.map((item, i) => (
                        <li key={i} style={{ fontSize: 14, color: '#14532d', lineHeight: 1.5, display: 'flex', gap: 8 }}>
                          <span>✅</span><span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {scores.feedback.improvements?.length > 0 && (
                  <div style={{ background: '#fffbeb', borderRadius: 20, padding: '18px 20px', boxShadow: '0 4px 14px rgba(0,0,0,0.06)', borderLeft: '4px solid #f59e0b' }}>
                    <h3 style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Improvements</h3>
                    <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {scores.feedback.improvements.map((item, i) => (
                        <li key={i} style={{ fontSize: 14, color: '#78350f', lineHeight: 1.5, display: 'flex', gap: 10 }}>
                          <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 999, background: '#f59e0b', color: '#fff', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <p style={{ textAlign: 'center', marginTop: 20, color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
          Visual + Audio AI Analysis · {API_URL ? 'Live backend' : 'Mock mode'}
        </p>
      </div>
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  )
}
