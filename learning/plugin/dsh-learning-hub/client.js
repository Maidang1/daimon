/**
 * dsh-learning-hub — browser half.
 *
 * Registers three right-Sidebar tab types (progress / diagrams / quiz) through
 * the public two-stage path (type into ctx.sidebarRightTabs, body into the
 * keyed `sidebar.right.pane.tab` seat), following ui-sidebar-files. All data
 * flows through the host half's JSON API at /__learning-hub (see index.js).
 * React comes from the browser module table; Mermaid is served as a vendored
 * asset by the host half and lazy-loaded on first diagram render.
 *
 * Visual design: theme-adaptive via color-mix + currentColor (works in both
 * light and dark host themes), one injected stylesheet for hover states and
 * keyframe animations (inline styles cannot express those).
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-learning-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/__learning-hub'

    async function api(pathname, options) {
      const res = await fetch(API + pathname, options && {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    /* ── design system ───────────────────────────────────────────────── */

    const STYLE_ID = 'dsh-learning-hub-styles'
    const CSS = `
.lh-root { display:flex; flex-direction:column; gap:14px; padding:18px 16px 24px; font-size:13px; line-height:1.55; color:inherit; height:100%; box-sizing:border-box; overflow-y:auto; }
.lh-root * { box-sizing:border-box; }
.lh-root ::-webkit-scrollbar { width:8px; }
.lh-root ::-webkit-scrollbar-thumb { background:color-mix(in srgb, currentColor 15%, transparent); border-radius:4px; }

.lh-header { display:flex; align-items:center; gap:10px; }
.lh-header-icon { width:32px; height:32px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:16px;
  background:linear-gradient(135deg, color-mix(in srgb,#4f6ef7 22%, transparent), color-mix(in srgb,#8b5cf6 18%, transparent));
  border:1px solid color-mix(in srgb,#4f6ef7 30%, transparent); }
.lh-title { margin:0; font-size:15px; font-weight:650; letter-spacing:.01em; }
.lh-sub { font-size:12px; opacity:.55; margin-top:1px; }
.lh-muted { font-size:12px; opacity:.55; }
.lh-error { font-size:12px; color:#e5484d; background:color-mix(in srgb,#e5484d 10%, transparent); border:1px solid color-mix(in srgb,#e5484d 30%, transparent); border-radius:10px; padding:8px 12px; }

.lh-card { border:1px solid color-mix(in srgb, currentColor 11%, transparent); border-radius:14px; padding:14px 16px;
  background:color-mix(in srgb, currentColor 2.5%, transparent); animation:lh-fade .25s ease both; }
.lh-lift { transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
.lh-lift:hover { transform:translateY(-1px); border-color:color-mix(in srgb, currentColor 22%, transparent);
  box-shadow:0 6px 16px -6px color-mix(in srgb, currentColor 18%, transparent); }

.lh-hero { border:1px solid color-mix(in srgb,#4f6ef7 32%, transparent); border-radius:16px; padding:16px 18px;
  background:linear-gradient(135deg, color-mix(in srgb,#4f6ef7 13%, transparent), color-mix(in srgb,#8b5cf6 10%, transparent));
  animation:lh-fade .25s ease both; }
.lh-hero-pct { font-size:30px; font-weight:750; line-height:1.1;
  background:linear-gradient(135deg,#4f6ef7,#8b5cf6); -webkit-background-clip:text; background-clip:text; color:transparent; }
.lh-bar { height:8px; border-radius:99px; background:color-mix(in srgb, currentColor 9%, transparent); overflow:hidden; }
.lh-bar-fill { height:100%; border-radius:99px; background:linear-gradient(90deg,#4f6ef7,#8b5cf6); transition:width .5s cubic-bezier(.4,0,.2,1); }

.lh-btn { font:inherit; font-size:12px; font-weight:550; padding:6px 14px; border-radius:99px; cursor:pointer; color:inherit;
  border:1px solid color-mix(in srgb, currentColor 20%, transparent); background:transparent;
  transition:all .15s ease; }
.lh-btn:hover { border-color:color-mix(in srgb,#4f6ef7 60%, transparent); color:#4f6ef7; }
.lh-btn:active { transform:scale(.97); }
.lh-btn-primary { border-color:transparent; color:#fff; background:linear-gradient(135deg,#4f6ef7,#6a5cf0); box-shadow:0 2px 8px -2px color-mix(in srgb,#4f6ef7 55%, transparent); }
.lh-btn-primary:hover { color:#fff; filter:brightness(1.08); }

.lh-chip { font:inherit; font-size:12px; font-weight:550; padding:5px 13px; border-radius:99px; cursor:pointer; color:inherit;
  border:1px solid color-mix(in srgb, currentColor 16%, transparent); background:transparent; transition:all .15s ease; }
.lh-chip:hover { border-color:color-mix(in srgb,#4f6ef7 55%, transparent); }
.lh-chip-active { border-color:transparent; color:#fff; background:linear-gradient(135deg,#4f6ef7,#8b5cf6); }

.lh-chapter { display:flex; align-items:center; gap:12px; width:100%; text-align:left; cursor:pointer;
  border:1px solid color-mix(in srgb, currentColor 11%, transparent); border-radius:14px; padding:12px 14px;
  background:color-mix(in srgb, currentColor 2.5%, transparent); color:inherit; font:inherit;
  transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease, opacity .18s ease;
  animation:lh-fade .3s ease both; }
.lh-chapter:hover { transform:translateY(-1px); border-color:color-mix(in srgb,#4f6ef7 45%, transparent);
  box-shadow:0 6px 16px -6px color-mix(in srgb, currentColor 16%, transparent); }
.lh-badge { flex:none; width:30px; height:30px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  font-size:12px; font-weight:650; border:1.5px solid color-mix(in srgb, currentColor 22%, transparent); color:inherit; opacity:.75; }
.lh-badge-done { opacity:1; border-color:transparent; color:#fff; background:linear-gradient(135deg,#4f6ef7,#8b5cf6); }
.lh-chapter-title { flex:1; font-weight:550; }
.lh-check { flex:none; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  font-size:12px; border:1.5px solid color-mix(in srgb, currentColor 22%, transparent); color:transparent; transition:all .18s ease; }
.lh-check-done { border-color:transparent; background:#22a35a; color:#fff; animation:lh-pop .25s ease; }
.lh-done { opacity:.55; }
.lh-done .lh-chapter-title { text-decoration:line-through; text-decoration-color:color-mix(in srgb, currentColor 40%, transparent); }

.lh-tag { font-size:10px; font-weight:650; padding:2px 8px; border-radius:99px; letter-spacing:.03em;
  background:color-mix(in srgb,#22a35a 15%, transparent); color:#22a35a; border:1px solid color-mix(in srgb,#22a35a 35%, transparent); }

.lh-option { display:flex; align-items:center; gap:11px; width:100%; text-align:left; font:inherit; font-size:13px; cursor:pointer;
  padding:10px 13px; border-radius:12px; color:inherit;
  border:1px solid color-mix(in srgb, currentColor 14%, transparent); background:color-mix(in srgb, currentColor 2%, transparent);
  transition:all .15s ease; animation:lh-fade .25s ease both; }
.lh-option:hover:not(:disabled) { border-color:color-mix(in srgb,#4f6ef7 55%, transparent); background:color-mix(in srgb,#4f6ef7 6%, transparent); transform:translateX(2px); }
.lh-option:disabled { cursor:default; }
.lh-letter { flex:none; width:26px; height:26px; border-radius:8px; display:flex; align-items:center; justify-content:center;
  font-size:12px; font-weight:700; border:1.5px solid color-mix(in srgb, currentColor 20%, transparent); opacity:.8; }
.lh-option-correct { border-color:color-mix(in srgb,#22a35a 65%, transparent)!important; background:color-mix(in srgb,#22a35a 12%, transparent)!important; animation:lh-pop .3s ease; }
.lh-option-correct .lh-letter { background:#22a35a; border-color:transparent; color:#fff; opacity:1; }
.lh-option-wrong { border-color:color-mix(in srgb,#e5484d 65%, transparent)!important; background:color-mix(in srgb,#e5484d 10%, transparent)!important; animation:lh-shake .3s ease; }
.lh-option-wrong .lh-letter { background:#e5484d; border-color:transparent; color:#fff; opacity:1; }
.lh-option-dim { opacity:.45; }

.lh-feedback { border-radius:14px; padding:14px 16px; animation:lh-fade .25s ease both;
  border:1px solid color-mix(in srgb, currentColor 11%, transparent);
  border-left:3px solid #22a35a; background:color-mix(in srgb,#22a35a 7%, transparent); }
.lh-feedback-bad { border-left-color:#e5484d; background:color-mix(in srgb,#e5484d 7%, transparent); }

.lh-dots { display:flex; gap:6px; }
.lh-dot { width:7px; height:7px; border-radius:50%; background:color-mix(in srgb, currentColor 15%, transparent); transition:all .2s ease; }
.lh-dot-on { background:linear-gradient(135deg,#4f6ef7,#8b5cf6); transform:scale(1.25); }

.lh-score-ring { width:88px; height:88px; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:4px auto 10px; }
.lh-score-inner { width:70px; height:70px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center;
  background:color-mix(in srgb, currentColor 4%, transparent); }
.lh-pre { font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-all; padding:12px 14px; border-radius:12px;
  background:color-mix(in srgb, currentColor 5%, transparent); border:1px solid color-mix(in srgb, currentColor 8%, transparent); }
.lh-svg-wrap { display:flex; justify-content:center; padding:8px; overflow-x:auto; }
.lh-svg-wrap svg { max-width:100%; height:auto; }
.lh-details summary { font-size:12px; opacity:.55; cursor:pointer; user-select:none; }
.lh-details summary:hover { opacity:.8; }

@keyframes lh-fade { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
@keyframes lh-pop { 0% { transform:scale(.92); } 60% { transform:scale(1.04); } 100% { transform:scale(1); } }
@keyframes lh-shake { 0%,100% { transform:translateX(0); } 25% { transform:translateX(-4px); } 75% { transform:translateX(4px); } }
`
    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /* ── shared bits ─────────────────────────────────────────────────── */

    function Header({ icon, title, sub }) {
      return h('div', { className: 'lh-header' },
        h('div', { className: 'lh-header-icon' }, icon),
        h('div', null,
          h('h2', { className: 'lh-title' }, title),
          sub && h('div', { className: 'lh-sub' }, sub)))
    }

    function ErrorText({ error }) {
      return error ? h('div', { className: 'lh-error' }, '⚠ ' + String(error.message || error)) : null
    }

    /* ── progress view ───────────────────────────────────────────────── */

    function ProgressBody() {
      const [progress, setProgress] = useState(null)
      const [error, setError] = useState(null)

      const refresh = useCallback(() => {
        api('/api/progress').then(setProgress, setError)
      }, [])
      useEffect(() => { refresh() }, [refresh])

      const chapters = progress?.chapters ?? []
      const done = chapters.filter((c) => c.completed).length
      const pct = chapters.length ? Math.round((done / chapters.length) * 100) : 0
      const levelLabel = progress?.learnerLevel === 'advanced' ? '进阶' : progress?.learnerLevel === 'beginner' ? '入门' : null

      const toggle = (chapterId, completed) => {
        api('/api/progress/toggle', { chapterId, completed }).then(setProgress, setError)
      }
      const setLevel = (level) => {
        api('/api/progress/level', { level }).then(setProgress, setError)
      }

      return h('div', { className: 'lh-root' },
        h(Header, { icon: '🎓', title: '学习中心', sub: '用 Harness 学 Harness' }),
        h(ErrorText, { error }),

        progress && !progress.learnerLevel && h('div', { className: 'lh-hero' },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '👋 先告诉导师你的起点'),
          h('div', { className: 'lh-muted', style: { marginBottom: 10 } }, '导师会据此调整讲解深度与节奏'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { className: 'lh-btn lh-btn-primary', onClick: () => setLevel('beginner') }, '入门'),
            h('button', { className: 'lh-btn', onClick: () => setLevel('advanced') }, '进阶'))),

        progress && h('div', { className: 'lh-hero' },
          h('div', { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10 } },
            h('div', null,
              h('div', { className: 'lh-hero-pct' }, pct + '%'),
              h('div', { className: 'lh-muted' }, `总体进度 ${done}/${chapters.length} 章`),
            ),
            levelLabel && h('div', { style: { textAlign: 'right' } },
              h('div', { className: 'lh-muted', style: { marginBottom: 4 } }, '当前级别'),
              h('div', { style: { display: 'flex', gap: 6 } },
                h('button', {
                  className: 'lh-chip' + (progress.learnerLevel === 'beginner' ? ' lh-chip-active' : ''),
                  onClick: () => setLevel('beginner'),
                }, '入门'),
                h('button', {
                  className: 'lh-chip' + (progress.learnerLevel === 'advanced' ? ' lh-chip-active' : ''),
                  onClick: () => setLevel('advanced'),
                }, '进阶')))),
          h('div', { className: 'lh-bar' }, h('div', { className: 'lh-bar-fill', style: { width: pct + '%' } })),
          done === chapters.length && chapters.length > 0 && h('div', { style: { marginTop: 10, fontSize: 12, fontWeight: 600, color: '#22a35a' } }, '🎉 全部章节完成，毕业快乐！')),

        chapters.map((ch, i) => h('button', {
          key: ch.id,
          className: 'lh-chapter' + (ch.completed ? ' lh-done' : ''),
          style: { animationDelay: (i * 30) + 'ms' },
          onClick: () => toggle(ch.id, !ch.completed),
        },
          h('span', { className: 'lh-badge' + (ch.completed ? ' lh-badge-done' : '') }, ch.completed ? '✓' : i),
          h('span', { className: 'lh-chapter-title' }, `第 ${i} 章 · ${ch.title}`),
          h('span', { className: 'lh-check' + (ch.completed ? ' lh-check-done' : '') }, '✓'))),

        h('div', { className: 'lh-muted', style: { textAlign: 'center', marginTop: 2 } },
          '进度持久化在 learning/progress.json · 导师 Agent 可读取'),
      )
    }

    /* ── diagrams view ───────────────────────────────────────────────── */

    let mermaidPromise = null
    function loadMermaid() {
      if (!mermaidPromise) {
        mermaidPromise = new Promise((resolve, reject) => {
          const script = document.createElement('script')
          script.src = API + '/vendor/mermaid.min.js'
          script.onload = () => {
            const mermaid = window.mermaid
            mermaid.initialize({
              startOnLoad: false,
              theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
            })
            resolve(mermaid)
          }
          script.onerror = () => reject(new Error('mermaid 加载失败'))
          document.head.appendChild(script)
        })
      }
      return mermaidPromise
    }

    function DiagramsBody() {
      const [names, setNames] = useState([])
      const [current, setCurrent] = useState(null)
      const [svg, setSvg] = useState(null)
      const [source, setSource] = useState('')
      const [error, setError] = useState(null)
      const seq = useRef(0)

      useEffect(() => { api('/api/diagrams').then(setNames, setError) }, [])

      const open = useCallback((name) => {
        setCurrent(name); setSvg(null); setError(null)
        api('/api/diagram?name=' + encodeURIComponent(name))
          .then(async ({ source }) => {
            setSource(source)
            const mermaid = await loadMermaid()
            const my = ++seq.current
            const { svg } = await mermaid.render('learning-mmd-' + my, source)
            if (my === seq.current) setSvg(svg)
          })
          .catch((e) => setError(e))
      }, [])

      return h('div', { className: 'lh-root' },
        h(Header, { icon: '📊', title: '架构图解', sub: '导师讲解时产出的 Mermaid 图' }),
        h(ErrorText, { error }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          names.map((n) => h('button', {
            key: n,
            className: 'lh-chip' + (n === current ? ' lh-chip-active' : ''),
            onClick: () => open(n),
          }, n.replace(/\.mmd$/, '')))),
        !names.length && h('div', { className: 'lh-card' },
          h('div', { className: 'lh-muted' }, '还没有图。导师讲解架构时会写入 learning/diagrams/*.mmd。')),
        current && !svg && !error && h('div', { className: 'lh-muted' }, '渲染中…'),
        svg && h('div', { className: 'lh-card', key: current },
          h('div', { className: 'lh-svg-wrap', dangerouslySetInnerHTML: { __html: svg } })),
        source && h('details', { className: 'lh-details' },
          h('summary', null, '查看 Mermaid 源码'),
          h('pre', { className: 'lh-pre', style: { marginTop: 8 } }, source)),
      )
    }

    /* ── quiz view ───────────────────────────────────────────────────── */

    function ScoreRing({ right, total }) {
      const pct = total ? Math.round((right / total) * 100) : 0
      const color = pct === 100 ? '#22a35a' : pct >= 60 ? '#4f6ef7' : '#e8a33d'
      return h('div', {
        className: 'lh-score-ring',
        style: { background: `conic-gradient(${color} ${pct * 3.6}deg, color-mix(in srgb, currentColor 10%, transparent) 0deg)` },
      },
        h('div', { className: 'lh-score-inner' },
          h('div', { style: { fontSize: 20, fontWeight: 750, color } }, `${right}/${total}`),
          h('div', { className: 'lh-muted', style: { fontSize: 10 } }, '正确')),
      )
    }

    function QuizBody() {
      const [chapters, setChapters] = useState([])
      const [chapter, setChapter] = useState(null)
      const [questions, setQuestions] = useState([])
      const [index, setIndex] = useState(0)
      const [picked, setPicked] = useState(null)
      const [feedback, setFeedback] = useState(null)
      const [score, setScore] = useState({ right: 0, total: 0 })
      const [error, setError] = useState(null)

      useEffect(() => {
        api('/api/progress').then((p) => setChapters(p.chapters ?? []), setError)
      }, [])

      const start = useCallback((ch) => {
        setChapter(ch); setIndex(0); setPicked(null); setFeedback(null); setScore({ right: 0, total: 0 }); setQuestions([])
        api('/api/quiz?chapter=' + encodeURIComponent(ch.id)).then(setQuestions, setError)
      }, [])

      const submit = (choice) => {
        if (feedback) return
        setPicked(choice)
        api('/api/quiz/submit', { quizId: questions[index].id, choice })
          .then((result) => {
            setFeedback(result)
            setScore((s) => ({ right: s.right + (result.correct ? 1 : 0), total: s.total + 1 }))
          })
          .catch(setError)
      }

      const next = () => { setIndex((i) => i + 1); setPicked(null); setFeedback(null) }

      if (!chapter) {
        return h('div', { className: 'lh-root' },
          h(Header, { icon: '✏️', title: '学习测验', sub: '每章 5–6 题 · 即时判分与解析' }),
          h(ErrorText, { error }),
          h('div', { className: 'lh-muted' }, '选择一章开始答题：'),
          chapters.map((c, i) => h('button', {
            key: c.id,
            className: 'lh-chapter',
            style: { animationDelay: (i * 30) + 'ms' },
            onClick: () => start(c),
          },
            h('span', { className: 'lh-badge' }, i),
            h('span', { className: 'lh-chapter-title' }, `第 ${i} 章 · ${c.title}`),
            c.completed && h('span', { className: 'lh-tag' }, '已学完'))),
        )
      }

      const q = questions[index]
      const finished = questions.length > 0 && index >= questions.length
      return h('div', { className: 'lh-root' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('button', { className: 'lh-btn', onClick: () => setChapter(null) }, '← 返回'),
          h('div', { style: { flex: 1 } },
            h('div', { style: { fontWeight: 650, fontSize: 14 } }, chapter.title),
            h('div', { className: 'lh-muted' }, `第 ${Math.min(index + 1, questions.length)}/${questions.length} 题 · 得分 ${score.right}/${score.total}`)),
          h('div', { className: 'lh-dots' },
            questions.map((_, i) => h('span', { key: i, className: 'lh-dot' + (i === index ? ' lh-dot-on' : '') })))),
        h(ErrorText, { error }),
        finished
          ? h('div', { className: 'lh-card', style: { textAlign: 'center', padding: '22px 16px' } },
              h(ScoreRing, { right: score.right, total: score.total }),
              h('div', { style: { fontSize: 15, fontWeight: 650, marginBottom: 6 } },
                score.right === score.total ? '🏆 满分！' : score.right >= score.total * 0.6 ? '💪 不错，继续巩固' : '📖 建议重读本章'),
              h('div', { className: 'lh-muted', style: { marginBottom: 14 } },
                score.right === score.total
                  ? '全部答对，可以让导师加深难度了。'
                  : '答错的题已记录到 learning/quiz-log.jsonl，导师会据此调整讲解。'),
              h('div', { style: { display: 'flex', gap: 8, justifyContent: 'center' } },
                h('button', { className: 'lh-btn', onClick: () => start(chapter) }, '再做一次'),
                h('button', { className: 'lh-btn lh-btn-primary', onClick: () => setChapter(null) }, '回到章节选择')))
          : q && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', { className: 'lh-card', style: { fontWeight: 600, lineHeight: 1.6 } }, q.question),
              q.options.map((opt, i) => {
                let cls = 'lh-option'
                if (feedback) {
                  if (i === feedback.answer) cls += ' lh-option-correct'
                  else if (i === picked) cls += ' lh-option-wrong'
                  else cls += ' lh-option-dim'
                }
                return h('button', {
                  key: i,
                  className: cls,
                  style: { animationDelay: (i * 40) + 'ms' },
                  disabled: Boolean(feedback),
                  onClick: () => submit(i),
                },
                  h('span', { className: 'lh-letter' }, 'ABCD'[i]),
                  h('span', null, opt))
              }),
              feedback && h('div', { className: 'lh-feedback' + (feedback.correct ? '' : ' lh-feedback-bad') },
                h('div', { style: { fontWeight: 700, marginBottom: 5, color: feedback.correct ? '#22a35a' : '#e5484d' } },
                  feedback.correct ? '✓ 回答正确' : '✗ 回答错误'),
                h('div', { style: { lineHeight: 1.65, opacity: 0.9 } }, feedback.explanation),
                h('button', { className: 'lh-btn lh-btn-primary', style: { marginTop: 10 }, onClick: next },
                  index + 1 < questions.length ? '下一题 →' : '查看成绩 🎯'))),
      )
    }

    /* ── registration ────────────────────────────────────────────────── */

    const TABS = [
      { id: '@local/dsh-learning-hub/progress', kind: 'learning-progress', label: '学习中心', desc: '章节进度与完成勾选', order: 1, Body: ProgressBody },
      { id: '@local/dsh-learning-hub/diagrams', kind: 'learning-diagrams', label: '架构图解', desc: '导师写入的 Mermaid 架构图', order: 2, Body: DiagramsBody },
      { id: '@local/dsh-learning-hub/quiz', kind: 'learning-quiz', label: '学习测验', desc: '每章选择题，即时反馈', order: 3, Body: QuizBody },
    ]

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ensureStyles()
        for (const tab of TABS) {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: tab.id,
            kind: tab.kind,
            priority: 'extension',
            title: () => tab.label,
            guide: [{ id: tab.kind, order: tab.order, title: () => tab.label, description: () => tab.desc }],
          }), `learning-hub: ${tab.kind} type`)
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: tab.id },
            tab.Body,
          )), `learning-hub: ${tab.kind} body`)
        }
      },
    }
  },
})
