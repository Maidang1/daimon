/**
 * dsh-learning-hub — browser half.
 *
 * Registers three right-Sidebar tab types (progress / diagrams / quiz) through
 * the public two-stage path (type into ctx.sidebarRightTabs, body into the
 * keyed `sidebar.right.pane.tab` seat), following ui-sidebar-files. All data
 * flows through the host half's JSON API at /__learning-hub (see index.js).
 * React comes from the browser module table; Mermaid is served as a vendored
 * asset by the host half and lazy-loaded on first diagram render.
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

    /* ── shared bits ─────────────────────────────────────────────────── */

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, fontSize: 13, color: 'inherit', height: '100%', boxSizing: 'border-box', overflowY: 'auto' },
      title: { margin: 0, fontSize: 15, fontWeight: 600 },
      muted: { opacity: 0.65, fontSize: 12 },
      card: { border: '1px solid color-mix(in srgb, currentColor 18%, transparent)', borderRadius: 10, padding: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      bar: { height: 8, borderRadius: 4, background: 'color-mix(in srgb, currentColor 12%, transparent)', overflow: 'hidden' },
      barFill: { height: '100%', borderRadius: 4, background: '#247bbf', transition: 'width .3s' },
      btn: { font: 'inherit', fontSize: 12, padding: '4px 12px', borderRadius: 8, border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      option: (state) => ({
        display: 'block', width: '100%', textAlign: 'left', font: 'inherit', fontSize: 13,
        padding: '8px 12px', margin: '6px 0', borderRadius: 8, cursor: state.disabled ? 'default' : 'pointer',
        border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
        background: state.correct ? 'color-mix(in srgb, #2da44e 22%, transparent)'
          : state.wrong ? 'color-mix(in srgb, #cf222e 18%, transparent)' : 'transparent',
        color: 'inherit',
      }),
      error: { color: '#cf222e', fontSize: 12 },
    }

    function ErrorText({ error }) { return error ? h('div', { style: styles.error }, String(error.message || error)) : null }

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

      const toggle = (chapterId, completed) => {
        api('/api/progress/toggle', { chapterId, completed }).then(setProgress, setError)
      }
      const setLevel = (level) => {
        api('/api/progress/level', { level }).then(setProgress, setError)
      }

      return h('div', { style: styles.root },
        h('h2', { style: styles.title }, '学习中心'),
        h(ErrorText, { error }),
        progress && !progress.learnerLevel && h('div', { style: styles.card },
          h('div', { style: { marginBottom: 8 } }, '先告诉导师你的起点：'),
          h('div', { style: styles.row },
            h('button', { style: styles.btn, onClick: () => setLevel('beginner') }, '入门'),
            h('button', { style: styles.btn, onClick: () => setLevel('advanced') }, '进阶'))),
        h('div', null,
          h('div', { style: { ...styles.row, justifyContent: 'space-between', marginBottom: 6 } },
            h('span', { style: styles.muted }, `总体进度 ${done}/${chapters.length}`),
            h('span', { style: styles.muted }, `${pct}%`)),
          h('div', { style: styles.bar }, h('div', { style: { ...styles.barFill, width: pct + '%' } }))),
        chapters.map((ch, i) => h('label', { key: ch.id, style: { ...styles.card, ...styles.row, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', checked: Boolean(ch.completed),
            onChange: (e) => toggle(ch.id, e.target.checked),
          }),
          h('span', { style: { textDecoration: ch.completed ? 'line-through' : 'none', opacity: ch.completed ? 0.6 : 1 } },
            `第 ${i} 章 · ${ch.title}`))),
        h('div', { style: styles.muted }, '勾选状态持久化在 learning/progress.json，导师 Agent 也能读到。'),
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

      return h('div', { style: styles.root },
        h('h2', { style: styles.title }, '架构图解'),
        h(ErrorText, { error }),
        h('div', { style: { ...styles.row, flexWrap: 'wrap' } },
          names.map((n) => h('button', {
            key: n, style: { ...styles.btn, fontWeight: n === current ? 700 : 400 },
            onClick: () => open(n),
          }, n.replace(/\.mmd$/, '')))),
        !names.length && h('div', { style: styles.muted }, '还没有图。导师讲解架构时会写入 learning/diagrams/*.mmd。'),
        current && !svg && !error && h('div', { style: styles.muted }, '渲染中…'),
        svg && h('div', {
          style: { ...styles.card, overflowX: 'auto' },
          dangerouslySetInnerHTML: { __html: svg },
        }),
        source && h('details', null,
          h('summary', { style: { ...styles.muted, cursor: 'pointer' } }, '查看 Mermaid 源码'),
          h('pre', { style: { ...styles.card, fontSize: 11, whiteSpace: 'pre-wrap' } }, source)),
      )
    }

    /* ── quiz view ───────────────────────────────────────────────────── */

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
        api('/api/progress').then((p) => setChapters((p.chapters ?? []).map((c) => c.id)), setError)
      }, [])

      const start = useCallback((ch) => {
        setChapter(ch); setIndex(0); setPicked(null); setFeedback(null); setScore({ right: 0, total: 0 })
        api('/api/quiz?chapter=' + encodeURIComponent(ch)).then(setQuestions, setError)
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
        return h('div', { style: styles.root },
          h('h2', { style: styles.title }, '学习测验'),
          h(ErrorText, { error }),
          h('div', { style: styles.muted }, '选择一章开始答题：'),
          chapters.map((c, i) => h('button', { key: c, style: { ...styles.btn, display: 'block', margin: '4px 0' }, onClick: () => start(c) }, `第 ${i} 章`)),
        )
      }

      const q = questions[index]
      const finished = index >= questions.length
      return h('div', { style: styles.root },
        h('div', { style: styles.row },
          h('button', { style: styles.btn, onClick: () => setChapter(null) }, '← 返回'),
          h('h2', { style: { ...styles.title, margin: 0 } }, `${chapter} 测验`),
          h('span', { style: styles.muted }, `得分 ${score.right}/${score.total}`)),
        h(ErrorText, { error }),
        finished
          ? h('div', { style: styles.card },
              h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 6 } },
                `本章完成：${score.right}/${score.total} 正确`),
              h('div', { style: styles.muted },
                score.right === score.total ? '全部答对，可以让导师加深难度了。' : '答错的题已记录到 learning/quiz-log.jsonl，导师会据此调整讲解。'),
              h('button', { style: { ...styles.btn, marginTop: 8 }, onClick: () => setChapter(null) }, '回到章节选择'))
          : q && h('div', null,
              h('div', { style: styles.muted }, `第 ${index + 1}/${questions.length} 题`),
              h('div', { style: { ...styles.card, marginTop: 6, fontWeight: 600 } }, q.question),
              q.options.map((opt, i) => h('button', {
                key: i,
                style: styles.option({
                  disabled: Boolean(feedback),
                  correct: Boolean(feedback) && i === feedback.answer,
                  wrong: Boolean(feedback) && i === picked && !feedback.correct,
                }),
                onClick: () => submit(i),
              }, `${'ABCD'[i]}. ${opt}`)),
              feedback && h('div', { style: styles.card },
                h('div', { style: { fontWeight: 700, color: feedback.correct ? '#2da44e' : '#cf222e', marginBottom: 4 } },
                  feedback.correct ? '✓ 回答正确' : '✗ 回答错误'),
                h('div', null, feedback.explanation),
                h('button', { style: { ...styles.btn, marginTop: 8 }, onClick: next },
                  index + 1 < questions.length ? '下一题' : '查看成绩'))),
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
