/**
 * The Python snippets the host spawns, and the action registry that names them.
 *
 * Both long-running jobs and the synchronous `add_op` route run the real
 * finance skill through a one-shot interpreter, so a terminal click and an
 * in-conversation `finance.add_op` are semantically identical. The snippets
 * live here, as strings, because they are a second language embedded in this
 * package — keeping them in one file is what makes that boundary visible
 * instead of scattered through the HTTP layer.
 *
 * Result protocol: **the child writes its result to a file the host names,
 * atomically, and exits.** There used to be two protocols — this one for jobs
 * and a `%%RESULT%%` stdout marker for ops — which meant two places to fix and
 * two mental models, and the weaker one was fragile in a way that mattered: a
 * user-controlled `note` containing the literal marker made `add_op` answer
 * 502. One protocol now.
 *
 * @module @deepseek-ai/dsh-finance-board/python-actions
 */

/** Long-running job actions and the runner snippet each of them executes. */
export const JOB_ACTIONS = {
  /** Daily pipeline: fetch market data → RBSA predictions → lock → snapshot. */
  daily_job: 'result = asyncio.run(finance.run_daily_job())',
  /** Re-render the 看板 HTML plus the UI snapshot (cheap). First recomputes
   * intraday estimates from current live quotes (incl. US pre/post market),
   * so a manual refresh reflects then-current US prices when locked
   * predictions aren't available yet. */
  refresh_dashboard: 'asyncio.run(finance.live_estimate()); result = asyncio.run(finance.dashboard())',
  /** Rebuild the UI snapshot including sector look-through (slow on cold cache). */
  deep_snapshot: 'result = asyncio.run(finance.ui_snapshot(include_lookthrough=True))',
  /** Daily AI briefing for the home view: index quotes + holding-related news
   * candidates, written to state/briefing.json. The agent curates/interprets
   * the news in the heartbeat task; this action regenerates the raw briefing. */
  daily_briefing: 'result = asyncio.run(finance.briefing())',
} as const

/** The four job actions, as the type the UI and the route layer share. */
export type JobAction = keyof typeof JOB_ACTIONS

/** The job action names, for the 400 body on an unknown action. */
export const JOB_ACTION_NAMES = Object.keys(JOB_ACTIONS) as JobAction[]

/**
 * One-shot runner executed by the configured Python: runs one job action and
 * reports progress to a status file the host serves back. Arguments:
 * `<action> <statusFile>`.
 */
export const JOB_RUNNER = `
import asyncio, json, os, sys, tempfile, traceback

action, status_path = sys.argv[1], sys.argv[2]

def write(status, **kw):
    try:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(status_path), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"action": action, "status": status, **kw}, fh, ensure_ascii=False)
        os.replace(tmp, status_path)
    except OSError:
        pass

ACTIONS = ${JSON.stringify(JOB_ACTIONS)}
if action not in ACTIONS:
    print(f"unknown action: {action}", file=sys.stderr)
    sys.exit(2)

write("running")
try:
    import finance
    result = None
    exec(ACTIONS[action])
    write("success", result=result)
except Exception:
    write("error", error=traceback.format_exc()[-600:])
    sys.exit(1)
`

/**
 * One-shot runner for `POST /finance/api/ops`. Arguments: `<resultFile>`.
 *
 * The request arrives on stdin as JSON (never interpolated into source, which
 * is how the old snippet invited quoting bugs), and the result is written to
 * `resultFile` with the same mkstemp + `os.replace` the job runner uses — so
 * the host can never read a half-written result, and a user-controlled `note`
 * cannot corrupt the protocol. A raised exception is reported as an `error`
 * key rather than a non-zero exit, so a failure is diagnosable from the file.
 */
export const OPS_RUNNER = `
import asyncio, json, os, sys, tempfile, traceback

out_path = sys.argv[1]

try:
    import finance
    req = json.load(sys.stdin)
    payload = asyncio.run(finance.add_op(
        req["code"], req["side"], req["shares"], req["price"],
        date=req.get("date"), note=req.get("note", ""),
    ))
    if not isinstance(payload, dict):
        payload = {"result": payload}
except Exception:
    payload = {"error": traceback.format_exc()[-600:]}

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out_path), suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    os.replace(tmp, out_path)
except OSError:
    os.unlink(tmp)
    raise
`
