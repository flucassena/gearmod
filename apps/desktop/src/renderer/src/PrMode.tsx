import React from 'react'
import { useT } from './i18n'
import { ChevronRightSmallIcon } from './icons'

/** One step of the path on top of PR mode; `go` makes it a link (the last one is where you are). */
export interface PrCrumb { label: string; go?(): void }

/**
 * PR mode of the Git screen: the Git sidebar is gone and the path stays on top, as GitLab's (project › repository › Pull requests
 * › the PR). Each step goes back to it: the project shows every repository's PRs, the repository or "Pull requests" its list.
 * Leaving PR mode is the Git/PRs switch before the repository tabs.
 */
export function PrMode({ crumbs, children }: { crumbs: PrCrumb[]; children: React.ReactNode }): React.JSX.Element {
  const t = useT().git.pr
  return <section className="prmode">
    <nav className="pm-bar pm-crumbs" aria-label={t.crumbsAria}>
      {crumbs.map((crumb, index) => <React.Fragment key={index}>
        {index > 0 && <ChevronRightSmallIcon />}
        {index === crumbs.length - 1 || !crumb.go ? <b aria-current={index === crumbs.length - 1 ? 'page' : undefined}>{crumb.label}</b> : <button type="button" className="pm-crumb" onClick={crumb.go}>{crumb.label}</button>}
      </React.Fragment>)}
    </nav>
    <div className="pm-body">{children}</div>
  </section>
}
