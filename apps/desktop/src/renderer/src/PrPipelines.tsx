import React, { useEffect, useRef, useState } from 'react'
import type { PrJob, PrPipeline } from '@gearmod/contracts'
import { toast } from './toasts'
import { plainError } from './NoticeDialog'
import { Checkbox } from './Checkbox'
import { useT } from './i18n'
import { ChevronDownSmallIcon, ChevronRightSmallIcon, ExternalIcon, RefreshIcon, StopIcon } from './icons'
import { Spinner, StatusIcon, duration, fullDate, useAgo } from './prUi'
import { StageDots, stageStatus } from './PrOverview'

/** While the open job runs, its log is asked again this often. */
const LOG_MS = 4_000
const going = (status: string): boolean => status === 'running' || status === 'pending'

/** The log of a job: numbered lines, follows the end while "Seguir o log" is on (scrolling up turns it off). */
function JobLog({ sourceId, number, job, follow, setFollow }: { sourceId: string; number: number; job: PrJob; follow: boolean; setFollow(value: boolean): void }): React.JSX.Element {
  const t = useT().git.pr
  const [log, setLog] = useState<{ text: string; truncated: boolean }>(), [error, setError] = useState('')
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => {
    let alive = true
    const read = (): void => { void window.gearmod.invoke('prs:job-log', { sourceId, number, jobId: job.id }).then((value) => { if (alive) { setLog(value); setError('') } }, (failure) => { if (alive) setError(plainError(failure)) }) }
    setLog(undefined); read()
    if (!going(job.status)) return () => { alive = false }
    const timer = window.setInterval(read, LOG_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [sourceId, number, job.id, job.status])
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight }, [log, follow])
  const lines = (log?.text ?? '').replace(/\n$/, '').split('\n')
  return <pre ref={box} className="pr-log" tabIndex={0} aria-label={t.jobLog(job.name)} onWheel={(event) => { if (event.deltaY < 0 && follow) setFollow(false) }}>
    {error ? <div className="tone-text tone-danger">{error}</div>
      : !log ? <div className="pr-muted"><Spinner /> {t.loadingLog}</div>
      : <>{log.truncated && <div className="pr-muted">{t.logTruncated}</div>}
        {lines.map((line, index) => <div key={index} className={`${line.startsWith('$ ') ? 'cmd' : ''} ${going(job.status) && index === lines.length - 1 ? 'cursor' : ''}`}><i>{index + 1}</i>{line}</div>)}
        {job.status === 'pending' && !log.text && <div className="pr-muted">{t.waitingRunner}</div>}</>}
  </pre>
}

/**
 * Pipelines of the PR (newest first; the newest starts open): status, stages with their jobs, and the log of the chosen job below,
 * live while something runs. Cancel/run again for the pipeline or one job.
 */
export function PrPipelines({ sourceId, number, data, reload, openWeb }: { sourceId: string; number: number; data: { pipelines: PrPipeline[]; canAct: boolean } | undefined; reload(): void; openWeb(url: string): void }): React.JSX.Element {
  const t = useT().git.pr, ago = useAgo()
  const [open, setOpen] = useState<Set<string>>(() => new Set()), [picked, setPicked] = useState<{ pipeline: string; job: string }>(), [follow, setFollow] = useState(true), [busy, setBusy] = useState('')
  const first = data?.pipelines[0]
  // The newest pipeline starts open, with its running (or last) job picked.
  useEffect(() => {
    if (!first) return
    setOpen((current) => current.size ? current : new Set([first.id]))
    setPicked((current) => current ?? (() => { const jobs = first.stages.flatMap((stage) => stage.jobs); const job = jobs.find((item) => item.status === 'running') ?? jobs.at(-1); return job ? { pipeline: first.id, job: job.id } : undefined })())
  }, [first?.id])
  // While following, the picked job moves to the one that is running now.
  useEffect(() => {
    if (!follow || !picked) return
    const pipeline = data?.pipelines.find((item) => item.id === picked.pipeline), jobs = pipeline?.stages.flatMap((stage) => stage.jobs) ?? []
    const running = jobs.find((job) => job.status === 'running'), current = jobs.find((job) => job.id === picked.job)
    if (running && current && !going(current.status) && running.id !== current.id) setPicked({ pipeline: picked.pipeline, job: running.id })
  }, [data])
  const label = (status: string): string => t.pipeline[status] ?? status
  const run = async (key: string, call: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(key)
    try { await call(); toast.success(done); reload() } catch (failure) { toast.error(t.failed, plainError(failure)) } finally { setBusy('') }
  }
  if (!data) return <div className="pr-pad"><Spinner /></div>
  if (!data.pipelines.length) return <p className="gempty pr-pad">{t.noPipelines}</p>
  return <div className="pr-pipes">{data.pipelines.map((pipeline) => {
    const jobs = pipeline.stages.flatMap((stage) => stage.jobs), isOpen = open.has(pipeline.id), live = going(pipeline.status)
    const job = picked?.pipeline === pipeline.id ? jobs.find((item) => item.id === picked.job) : undefined
    const toggle = (): void => setOpen((current) => { const next = new Set(current); if (next.has(pipeline.id)) next.delete(pipeline.id); else next.add(pipeline.id); return next })
    return <div className="pr-card pr-pipe" key={pipeline.id}>
      <div className="pr-row pr-pipehead" role="button" tabIndex={0} aria-expanded={isOpen} onClick={toggle} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() } }}>
        <StatusIcon status={pipeline.status} label={label(pipeline.status)} big /><b className="pr-link">#{pipeline.id}</b>
        <span className="pr-muted">{label(pipeline.status)} · <code className="pr-sha">{pipeline.sha.slice(0, 8)}</code> · {pipeline.source} · <span data-tip={fullDate(pipeline.createdAt)}>{ago(pipeline.createdAt)}</span>{live ? ` · ${t.jobsDone(jobs.filter((item) => item.status === 'success').length, jobs.length)}` : pipeline.duration !== null ? ` · ${duration(pipeline.duration)}` : ''}</span>
        <span className="pr-right" onClick={(event) => event.stopPropagation()}>
          <StageDots pipeline={pipeline} label={label} />
          {data.canAct && (live
            ? <button type="button" className="mini secondary" disabled={Boolean(busy)} onClick={() => void run(`p${pipeline.id}`, () => window.gearmod.invoke('prs:pipeline-action', { sourceId, number, pipelineId: pipeline.id, action: 'cancel' }), t.pipelineCanceled)}>{busy === `p${pipeline.id}` ? <Spinner /> : <StopIcon />}{t.cancelRun}</button>
            : <button type="button" className="mini secondary" disabled={Boolean(busy)} onClick={() => void run(`p${pipeline.id}`, () => window.gearmod.invoke('prs:pipeline-action', { sourceId, number, pipelineId: pipeline.id, action: 'retry' }), t.pipelineRetried)}>{busy === `p${pipeline.id}` ? <Spinner /> : <RefreshIcon />}{t.runAgain}</button>)}
          {pipeline.url && <button type="button" className="pr-iconbtn" aria-label={t.openOnHost} data-tip={t.openOnHost} onClick={() => openWeb(pipeline.url!)}><ExternalIcon /></button>}
          <span className="pr-muted">{isOpen ? <ChevronDownSmallIcon /> : <ChevronRightSmallIcon />}</span>
        </span>
      </div>
      {isOpen && <div className="pr-stages">{pipeline.stages.map((stage) => { const status = stageStatus(stage.jobs.map((item) => item.status))
        return <div className="pr-stage" key={stage.name}><h4><StatusIcon status={status} label={label(status)} />{stage.name}</h4>
          {stage.jobs.map((item) => <button type="button" key={item.id} className={`pr-job ${picked?.job === item.id ? 'on' : ''}`} aria-pressed={picked?.job === item.id} onClick={() => setPicked({ pipeline: pipeline.id, job: item.id })}>
            <StatusIcon status={item.status} label={label(item.status)} /><span className="pr-jobname">{item.name}</span><span className="pr-jobtime">{item.status === 'pending' || item.duration === null ? '' : duration(item.duration)}</span></button>)}
        </div> })}</div>}
      {isOpen && job && <>
        <div className="pr-loghead"><StatusIcon status={job.status} label={label(job.status)} /><b>{job.name}</b><span className="pr-muted">{label(job.status)}{job.duration !== null ? ` · ${duration(job.duration)}` : ''}</span>
          <span className="pr-right"><label className="pr-check"><Checkbox checked={follow} onChange={setFollow} />{t.followLog}</label>
            {data.canAct && (going(job.status)
              ? <button type="button" className="mini secondary" disabled={Boolean(busy)} onClick={() => void run(`j${job.id}`, () => window.gearmod.invoke('prs:job-action', { sourceId, number, jobId: job.id, action: 'cancel' }), t.jobCanceled)}>{busy === `j${job.id}` ? <Spinner /> : <StopIcon />}{t.cancelJob}</button>
              : <button type="button" className="mini secondary" disabled={Boolean(busy)} onClick={() => void run(`j${job.id}`, () => window.gearmod.invoke('prs:job-action', { sourceId, number, jobId: job.id, action: 'retry' }), t.jobRetried)}>{busy === `j${job.id}` ? <Spinner /> : <RefreshIcon />}{t.runJobAgain}</button>)}
            {job.url && <button type="button" className="mini secondary" onClick={() => openWeb(job.url!)}><ExternalIcon />{t.openOnHost}</button>}</span></div>
        <JobLog sourceId={sourceId} number={number} job={job} follow={follow} setFollow={setFollow} />
      </>}
    </div>
  })}</div>
}
