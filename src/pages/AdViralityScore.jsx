import { useState } from 'react'

const API_URL = import.meta.env.VITE_VIRALITY_API_URL

const MOCK_SCORES = {
  overall: 78,
  emotion: 82,
  hook: 71,
  retention: 75,
  shareability: 84,
  trend: 69,
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
          cx="45" cy="45" r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={`${filled} ${circumference - filled}`}
          strokeLinecap="round"
          transform="rotate(-90 45 45)"
          style={{ transition: 'stroke-dasharray 1s ease' }}
        />
        <text x="45" y="49" textAnchor="middle" fontSize="18" fontWeight="700" fill={color}>
          {score}
        </text>
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
        <div
          style={{
            width: `${score}%`,
            background: color,
            height: '100%',
            borderRadius: 999,
            transition: 'width 1s ease',
          }}
        />
      </div>
    </div>
  )
}

async function fetchScore({ file, url, type, inputMode }) {
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
        summary: "Mock analysis: strong visual but hook could be sharper.",
        strengths: ["Clear product focus", "Good color contrast"],
        improvements: [
          "Strengthen the opening 3 seconds",
          "Add captions for silent viewers",
          "Test a curiosity-gap headline",
        ],
      },
    }
  }
  if (inputMode === 'url') {
    const res = await fetch(`${API_URL}/score-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type }),
    })
    if (!res.ok) throw new Error('Backend error')
    return res.json()
  }
  const form = new FormData()
  form.append('file', file)
  form.append('type', type)
  const res = await fetch(`${API_URL}/score`, { method: 'POST', body: form })
  if (!res.ok) throw new Error('Backend error')
  return res.json()
}

export default function AdViralityScore() {
  const [mode, setMode] = useState('ad')
  const [file, setFile] = useState(null)
  const [url, setUrl] = useState('')
  const [inputMode, setInputMode] = useState('file')
  const [loading, setLoading] = useState(false)
  const [scores, setScores] = useState(null)
  const [error, setError] = useState(null)

  async function handleScore() {
    setError(null)
    setScores(null)
    setLoading(true)
    try {
      const result = await fetchScore({ file, url, type: mode, inputMode })
      setScores(result)
    } catch (e) {
      setError('Scoring failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const canScore = inputMode === 'file' ? !!file : url.trim().length > 0

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', padding: '32px 16px' }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⚡</div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: '#fff', marginBottom: 6 }}>
            Virality Score
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 15 }}>
            Predict how viral your ad or video will go — powered by TRIBE v2
          </p>
          {!API_URL && (
            <span style={{
              display: 'inline-block', marginTop: 10, background: 'rgba(255,255,255,0.15)',
              color: '#fff', fontSize: 12, padding: '3px 12px', borderRadius: 999,
            }}>
              Mock mode — connect backend via VITE_VIRALITY_API_URL
            </span>
          )}
        </div>

        {/* Card */}
        <div style={{
          background: '#fff', borderRadius: 20, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
        }}>

          {/* Mode tabs */}
          <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 12, padding: 4, marginBottom: 24 }}>
            {[{ key: 'ad', label: '📢 Ad Creative' }, { key: 'video', label: '🎬 Video' }].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => { setMode(key); setScores(null) }}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 600,
                  fontSize: 14, transition: 'all 0.2s',
                  background: mode === key ? '#fff' : 'transparent',
                  color: mode === key ? '#4f46e5' : '#6b7280',
                  boxShadow: mode === key ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Input mode */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[{ key: 'file', label: 'Upload File' }, { key: 'url', label: 'Paste URL' }].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => { setInputMode(key); setScores(null) }}
                style={{
                  padding: '6px 16px', borderRadius: 8, border: `2px solid ${inputMode === key ? '#4f46e5' : '#e5e7eb'}`,
                  background: inputMode === key ? '#eef2ff' : '#fff', color: inputMode === key ? '#4f46e5' : '#6b7280',
                  fontWeight: 600, fontSize: 13, cursor: 'pointer',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Input area */}
          {inputMode === 'file' ? (
            <label style={{
              display: 'block', border: '2px dashed #c7d2fe', borderRadius: 14, padding: '28px 20px',
              textAlign: 'center', cursor: 'pointer', background: '#fafafa', marginBottom: 20,
              transition: 'border-color 0.2s',
            }}>
              <input
                type="file"
                accept="image/*,video/*"
                style={{ display: 'none' }}
                onChange={e => { setFile(e.target.files[0]); setScores(null) }}
              />
              {file ? (
                <div>
                  <div style={{ fontSize: 28, marginBottom: 6 }}>✅</div>
                  <div style={{ fontWeight: 600, color: '#4f46e5' }}>{file.name}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                    {(file.size / 1024 / 1024).toFixed(2)} MB · Click to change
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>📁</div>
                  <div style={{ fontWeight: 600, color: '#374151' }}>Drop file here or click to browse</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                    Images (JPG, PNG, GIF) or Videos (MP4, MOV, AVI)
                  </div>
                </div>
              )}
            </label>
          ) : (
            <input
              type="url"
              placeholder="https://example.com/my-ad.mp4"
              value={url}
              onChange={e => { setUrl(e.target.value); setScores(null) }}
              style={{
                width: '100%', padding: '14px 16px', borderRadius: 12, border: '2px solid #e5e7eb',
                fontSize: 14, marginBottom: 20, outline: 'none',
                fontFamily: 'inherit',
              }}
            />
          )}

          {/* Score button */}
          <button
            onClick={handleScore}
            disabled={!canScore || loading}
            style={{
              width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
              background: canScore && !loading ? 'linear-gradient(135deg, #667eea, #764ba2)' : '#e5e7eb',
              color: canScore && !loading ? '#fff' : '#9ca3af',
              fontWeight: 700, fontSize: 16, cursor: canScore && !loading ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s', letterSpacing: 0.3,
            }}
          >
            {loading ? '⚡ Analyzing...' : '🚀 Get Virality Score'}
          </button>

          {error && (
            <div style={{ marginTop: 16, padding: '12px 16px', background: '#fef2f2', borderRadius: 10, color: '#dc2626', fontSize: 14 }}>
              {error}
            </div>
          )}
        </div>

        {/* Results */}
        {scores && (
          <div style={{
            background: '#fff', borderRadius: 20, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
            marginTop: 20, animation: 'fadeIn 0.4s ease',
          }}>
            <h2 style={{ fontWeight: 700, fontSize: 18, marginBottom: 20, color: '#1a1a2e' }}>
              Score Results
            </h2>

            {/* Ring row */}
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center', marginBottom: 28,
            }}>
              {Object.entries(scores)
                .filter(([, val]) => typeof val === 'number')
                .map(([key, val]) => (
                  <ScoreRing key={key} score={val} label={SCORE_LABELS[key] ?? key} />
                ))}
            </div>

            {/* Bar breakdown */}
            <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#6b7280', marginBottom: 16, textTransform: 'uppercase', letterSpacing: 1 }}>
                Breakdown
              </h3>
              {Object.entries(scores)
                .filter(([k, val]) => k !== 'overall' && typeof val === 'number')
                .map(([key, val]) => (
                  <BarScore key={key} label={SCORE_LABELS[key] ?? key} score={val} />
                ))}
            </div>

            {/* Verdict */}
            <div style={{
              marginTop: 20, padding: '16px 20px', borderRadius: 14,
              background: scores.overall >= 80 ? '#f0fdf4' : scores.overall >= 60 ? '#fffbeb' : '#fef2f2',
              borderLeft: `4px solid ${scoreColor(scores.overall)}`,
            }}>
              <div style={{ fontWeight: 700, color: scoreColor(scores.overall), marginBottom: 4 }}>
                {scores.overall >= 80 ? '🔥 High Viral Potential' : scores.overall >= 60 ? '📈 Moderate Potential' : '⚠️ Needs Improvement'}
              </div>
              <div style={{ fontSize: 13, color: '#4b5563' }}>
                {scores.overall >= 80
                  ? 'This content has strong viral signals. Consider boosting with paid promotion.'
                  : scores.overall >= 60
                  ? 'Decent virality. Strengthen your hook and emotional appeal for better results.'
                  : 'Low viral likelihood. Revisit the concept, hook, and audience targeting.'}
              </div>
            </div>

            {/* AI Feedback */}
            {scores.feedback && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

                {/* Summary */}
                {scores.feedback.summary && (
                  <div style={{
                    background: '#fff', borderRadius: 20, padding: '18px 20px',
                    boxShadow: '0 4px 14px rgba(0,0,0,0.06)', border: '1px solid #eef2ff',
                  }}>
                    <h3 style={{
                      fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 8,
                      textTransform: 'uppercase', letterSpacing: 1,
                    }}>
                      AI Summary
                    </h3>
                    <p style={{ fontSize: 14, color: '#1f2937', lineHeight: 1.55, margin: 0 }}>
                      {scores.feedback.summary}
                    </p>
                  </div>
                )}

                {/* Strengths */}
                {scores.feedback.strengths?.length > 0 && (
                  <div style={{
                    background: '#f0fdf4', borderRadius: 20, padding: '18px 20px',
                    boxShadow: '0 4px 14px rgba(0,0,0,0.06)', borderLeft: '4px solid #22c55e',
                  }}>
                    <h3 style={{
                      fontSize: 12, fontWeight: 700, color: '#166534', marginBottom: 10,
                      textTransform: 'uppercase', letterSpacing: 1,
                    }}>
                      Strengths
                    </h3>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {scores.feedback.strengths.map((item, i) => (
                        <li key={i} style={{ fontSize: 14, color: '#14532d', lineHeight: 1.5, display: 'flex', gap: 8 }}>
                          <span aria-hidden="true">✅</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Improvements */}
                {scores.feedback.improvements?.length > 0 && (
                  <div style={{
                    background: '#fffbeb', borderRadius: 20, padding: '18px 20px',
                    boxShadow: '0 4px 14px rgba(0,0,0,0.06)', borderLeft: '4px solid #f59e0b',
                  }}>
                    <h3 style={{
                      fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 10,
                      textTransform: 'uppercase', letterSpacing: 1,
                    }}>
                      Improvements
                    </h3>
                    <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {scores.feedback.improvements.map((item, i) => (
                        <li key={i} style={{ fontSize: 14, color: '#78350f', lineHeight: 1.5, display: 'flex', gap: 10 }}>
                          <span style={{
                            flexShrink: 0, width: 22, height: 22, borderRadius: 999,
                            background: '#f59e0b', color: '#fff', fontSize: 12, fontWeight: 700,
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {i + 1}
                          </span>
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
          Powered by TRIBE v2 · {API_URL ? 'Live backend' : 'Mock mode'}
        </p>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  )
}
