import React, { useEffect, useMemo, useState } from 'react'
import type { PullRequestDetail, PullRequestList, PullRequestSummary } from '@gearmod/contracts'
import { toast } from './toasts'
import type { PullRequestsState } from './usePullRequests'
import { plainError } from './NoticeDialog'
import { Select } from './Select'
import { Checkbox } from './Checkbox'
import { KeyIcon } from './icons'
import { useT, dateLocale } from './i18n'
import { splitDiff } from './prDiff'

const when = (value: string): string => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }) }
const message = (error: unknown): string => plainError(error)

/**
 * PR/MR screen: opens in the middle of the Git screen (in place of the graph), with a card per part — header, description,
 * changed files with their diff, and the conversation with the comment and review actions.
 */
export function PrScreen({ sourceId, provider, pr, close, changed }: { sourceId: string; provider: 'github' | 'gitlab' | null; pr: PullRequestSummary; close(): void; changed(): void }): React.JSX.Element {
  const { common, git: { pr: t } } = useT(), decisionLabel = t.decision, reviewLabel = t.review
  const [detail, setDetail] = useState<PullRequestDetail>(), [error, setError] = useState(''), [text, setText] = useState(''), [busy, setBusy] = useState(''), [file, setFile] = useState<string>()
  const load = (): void => { void window.gearmod.invoke('prs:view', { sourceId, number: pr.number }).then(setDetail, (reason) => setError(message(reason))) }
  useEffect(() => { setDetail(undefined); setError(''); setFile(undefined); load() }, [sourceId, pr.number])
  const diffs = useMemo(() => splitDiff(detail?.diff ?? ''), [detail?.diff])
  const act = async (name: string, run: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(name)
    try { await run(); setText(''); toast.success(done); load(); changed() } catch (reason) { toast.error(t.failed, message(reason)) } finally { setBusy('') }
  }
  const review = (action: 'approve' | 'request-changes' | 'comment', done: string) => act(action, () => window.gearmod.invoke('prs:review', { sourceId, number: pr.number, action, body: text }), done)
  const openWeb = (): void => { void window.gearmod.invoke('prs:open', { sourceId, url: pr.url }).catch((reason) => toast.error(t.openFailed, message(reason))) }
  const decision = detail?.reviewDecision ?? pr.reviewDecision, draft = detail?.draft ?? pr.draft
  const added = detail?.files.reduce((sum, item) => sum + item.additions, 0) ?? 0, removed = detail?.files.reduce((sum, item) => sum + item.deletions, 0) ?? 0
  const shown = file ? diffs.get(file) : undefined
  return <section className="prscreen" aria-label={`#${pr.number} ${pr.title}`}>
    <header className="prs-head">
      <button type="button" className="mini secondary" onClick={close}>{t.back}</button>
      <div className="prs-title"><h2><span className="prs-num">#{pr.number}</span> {pr.title}</h2>
        <div className="prs-meta"><span className="rchip"><span className="rn">{pr.head}</span></span><span aria-hidden="true">→</span><span className="rchip head"><span className="rn">{pr.base}</span></span>
          <span>{pr.author}</span>{draft && <span className="prs-pill">{t.draft}</span>}{decision && <span className="prs-pill">{decisionLabel[decision] ?? decision}</span>}{detail?.mergeable === 'CONFLICTING' && <span className="prs-pill bad">{t.withConflict}</span>}</div></div>
      <button type="button" className="mini secondary" onClick={openWeb}>{t.openOn(provider === 'gitlab' ? 'GitLab' : 'GitHub')}</button>
    </header>
    {error && <p className="error prs-pad">{error}</p>}
    {!detail && !error && <p className="gempty prs-pad">{common.loading}</p>}
    {detail && <div className="prs-body">
      <div className="prs-main">
        <div className="prs-card"><div className="cglabel">{t.description}</div>{detail.body.trim() ? <div className="prs-text">{detail.body}</div> : <p className="gempty">{t.noDescription}</p>}</div>
        <div className="prs-card prs-files">
          <div className="prs-cardhead"><span className="cglabel">{t.changedFiles(detail.files.length)}</span><span className="nums"><span className="p">+{added}</span> <span className="m">−{removed}</span></span></div>
          <div className="gfiles">{detail.files.map((item) => { const status = diffs.get(item.path)?.status ?? 'M', on = file === item.path
            return <div key={item.path} className={`gfile click ${on ? 'on' : ''}`} role="button" tabIndex={0} aria-expanded={on} onClick={() => setFile(on ? undefined : item.path)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setFile(on ? undefined : item.path) } }}>
              <span className={`st ${status}`}>{status}</span><span className="pth" data-tip={item.path}>{item.path}</span><span className="nums"><span className="p">+{item.additions}</span> <span className="m">−{item.deletions}</span></span></div> })}</div>
          {file ? <div className="prs-diff"><div className="prs-diffhead"><b>{file}</b><button type="button" className="x" aria-label={common.close} data-tip={common.close} onClick={() => setFile(undefined)}>×</button></div>
            <div className="gdiffbody">{shown?.lines.length ? shown.lines.map((line, index) => <div key={index} className={`dl ${line.startsWith('+') ? 'p' : line.startsWith('-') ? 'm' : line.startsWith('@@') ? 'h' : ''}`}>{line || ' '}</div>) : <p className="gempty prs-pad">{t.noDiff}</p>}</div></div>
            : detail.files.length > 0 && <p className="hint">{t.pickFile}</p>}
        </div>
      </div>
      <aside className="prs-side">
        <div className="prs-card"><div className="cglabel">{t.conversation}</div>
          <div className="prthread">
            {detail.reviews.map((item, index) => <div className="prmsg" key={`r${index}`}><b>{item.author} {reviewLabel[item.state] ?? item.state.toLowerCase()}</b><small>{when(item.at)}</small>{item.body.trim() && <p>{item.body}</p>}</div>)}
            {detail.comments.map((item, index) => <div className="prmsg" key={`c${index}`}><b>{item.author}</b><small>{when(item.at)}</small><p>{item.body}</p></div>)}
            {!detail.reviews.length && !detail.comments.length && <p className="gempty">{t.noComments}</p>}
          </div></div>
        <div className="prs-card"><label className="f"><span className="cglabel">{t.commentOrReview}</span><textarea className="in" rows={4} value={text} onChange={(event) => setText(event.target.value)} placeholder={t.commentPlaceholder} /></label>
          <div className="pract">
            <button type="button" className="mini" disabled={Boolean(busy) || !text.trim()} onClick={() => void act('comment', () => window.gearmod.invoke('prs:comment', { sourceId, number: pr.number, body: text }), t.commentPosted)}>{busy === 'comment' ? '…' : t.comment}</button>
            <button type="button" className="mini" disabled={Boolean(busy)} onClick={() => void review('approve', t.approved)}>{busy === 'approve' ? '…' : t.approve}</button>
            {provider !== 'gitlab' && <button type="button" className="mini danger" disabled={Boolean(busy) || !text.trim()} onClick={() => void review('request-changes', t.changesRequested)}>{busy === 'request-changes' ? '…' : t.requestChanges}</button>}
          </div></div>
      </aside>
    </div>}
  </section>
}

/** Form to open a PR from a local branch of the repository (the branch is published to origin). Opens ready for review; the title starts as the branch name. */
function PrCreate({ sourceId, branches, head, back, created }: { sourceId: string; branches: string[]; head: string | null; back(): void; created(): void }): React.JSX.Element {
  const t = useT().git.pr
  const [from, setFrom] = useState(head && branches.includes(head) ? head : branches[0] ?? ''), [base, setBase] = useState(() => ['main', 'master', 'develop'].find((name) => branches.includes(name) && name !== head) ?? branches.find((name) => name !== head) ?? '')
  const [title, setTitle] = useState(from), [titleEdited, setTitleEdited] = useState(false), [body, setBody] = useState(''), [draft, setDraft] = useState(false), [busy, setBusy] = useState(false), [defaultBase, setDefaultBase] = useState<string | null>(null)
  // Target: the repository's default branch (origin/HEAD), when Git knows it.
  useEffect(() => { let alive = true; void window.gearmod.invoke('prs:default-base', { sourceId }).then(({ branch }) => { if (alive && branch && branches.includes(branch)) { setDefaultBase(branch); setBase((current) => branch !== from ? branch : current) } }).catch(() => undefined); return () => { alive = false } }, [sourceId])
  const pickFrom = (value: string): void => { setFrom(value); if (!titleEdited) setTitle(value); if (value === base) setBase(branches.find((name) => name !== value) ?? '') }
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true)
    try { const { url } = await window.gearmod.invoke('prs:create', { sourceId, head: from, base, title, body, draft }); toast.success(t.opened, url); created() } catch (reason) { toast.error(t.createFailed, message(reason)) } finally { setBusy(false) }
  }
  return <form className="prdetail" onSubmit={(event) => void submit(event)}>
    <div className="prbar"><button type="button" className="mini secondary" onClick={back}>{t.back}</button></div>
    <h3>{t.newPr}</h3>
    <div className="f"><span>{t.fromBranch}</span><Select label={t.fromBranch} value={from} options={branches.map((name) => ({ value: name, label: name }))} onChange={pickFrom} /></div>
    <div className="f"><span>{t.toBranch}</span><Select label={t.toBranch} value={base} options={branches.filter((name) => name !== from).map((name) => ({ value: name, label: name }))} onChange={setBase} />{defaultBase && base === defaultBase && <small className="hint">{t.defaultBranchHint(defaultBase)}</small>}</div>
    <label className="f"><span>{t.title}</span><input className="in" value={title} maxLength={240} onChange={(event) => { setTitle(event.target.value); setTitleEdited(true) }} autoFocus />{!titleEdited && <small className="hint">{t.titleFromBranch}</small>}</label>
    <label className="f"><span>{t.description}</span><textarea className="in" rows={5} value={body} onChange={(event) => setBody(event.target.value)} /></label>
    <label className="prcheck"><Checkbox checked={draft} onChange={setDraft} /> {t.openAsDraft}</label>
    <p className="hint">{t.willPush(from)}</p>
    <div className="pract"><button type="submit" disabled={busy || !from || !base || !title.trim()}>{busy ? t.opening : t.openPr}</button></div>
  </form>
}

/** Opens the project settings on the Git tab, where the accounts (tokens) live. */
export const openGitAccounts = (): void => { window.dispatchEvent(new CustomEvent('gearmod:open-project-config', { detail: { tab: 'git', focus: 'git-accounts' } })) }

/** Why the PRs did not load, with the right output: update the expired token or add one (in place of gh/glab). */
export function PrAccessNotice({ list }: { list: PullRequestList }): React.JSX.Element | null {
  const ta = useT().git.accounts
  if (list.problem === 'invalid-token') return <div className="cx-note warn gacc-note"><i className="gacc-dot" aria-hidden="true" /><span>{list.error ?? ta.invalidBanner}</span><button type="button" className="mini secondary withicon" onClick={openGitAccounts}><KeyIcon />{ta.updateToken}</button></div>
  if (list.problem === 'no-cli' || list.problem === 'not-logged-in') return <div className="cx-note gacc-note"><span>{list.error}</span><button type="button" className="mini secondary withicon" onClick={openGitAccounts}><KeyIcon />{ta.needToken}</button></div>
  return list.error ? <p className="error">{list.error}</p> : null
}

/** Git right sidebar: the repository's open PRs (a yellow dot stays on the ones with news until the PR is closed). The open PR shows in the middle (PrScreen). */
export function PrPanel({ sourceId, repoName, branches, head, prs, focus, shown, show, close }: { focus?: { number: number; at: number }; sourceId: string; repoName: string; branches: string[]; head: string | null; prs: PullRequestsState; shown?: number; show(pr: PullRequestSummary | undefined): void; close(): void }): React.JSX.Element {
  const { common, git: { pr: t } } = useT(), decisionLabel = t.decision
  const [creating, setCreating] = useState(false), [loading, setLoading] = useState(false)
  const list = prs.lists[sourceId]
  useEffect(() => { setCreating(false) }, [sourceId])
  useEffect(() => { const found = focus && list?.prs.find((item) => item.number === focus.number); if (found) { setCreating(false); show(found) } }, [focus?.at])
  const reload = (): void => { setLoading(true); void prs.refresh(sourceId).finally(() => setLoading(false)) }
  if (creating) return <aside className="gdetail gprs"><PrCreate sourceId={sourceId} branches={branches} head={head} back={() => setCreating(false)} created={() => { setCreating(false); reload() }} /></aside>
  return <aside className="gdetail gprs">
    <div className="prbar"><h3>{t.panelTitle(repoName)}</h3><button type="button" className="x" onClick={close} data-tip={common.close} aria-label={common.close}>×</button></div>
    <div className="pract"><button type="button" className="mini secondary" onClick={() => setCreating(true)} disabled={list?.supported === false || branches.length < 2}>{t.newButton}</button><button type="button" className="mini secondary" onClick={reload} disabled={loading}>{loading ? '…' : common.refresh}</button></div>
    {!list && <p className="gempty">{common.loading}</p>}
    {list && !list.supported && <p className="hint">{list.error}</p>}
    {list?.supported && list.error && <PrAccessNotice list={list} />}
    {list?.supported && !list.error && !list.prs.length && <p className="gempty">{t.noOpen}</p>}
    {list?.prs.map((pr) => <button type="button" className={`prrow ${shown === pr.number ? 'on' : ''}`} aria-current={shown === pr.number} key={pr.number} onClick={() => show(shown === pr.number ? undefined : pr)}>
      <span className="prtitle">{prs.isUnread(sourceId, pr) && <i className="ydot" data-tip={t.newsTip} />}#{pr.number} {pr.title}</span>
      <small>{pr.author} · <code>{pr.head}</code>{pr.draft ? ` · ${t.draft}` : ''}{pr.reviewRequested ? ` · ${t.reviewRequested}` : ''}{pr.reviewDecision ? ` · ${decisionLabel[pr.reviewDecision] ?? pr.reviewDecision}` : ''}{pr.comments ? ` · ${t.commentsCount(pr.comments)}` : ''}</small>
    </button>)}
  </aside>
}
