import React from 'react'

/**
 * Every icon of the app lives here and follows one standard (design-system.css, "Ícones"): line drawing, round ends,
 * no fill (only small dots are solid) and the same thin stroke at any size. CSS decides the color and the size.
 * `box` is the drawing grid (most icons use 24 or 20). `view` frames the drawing so every icon has the same optical size:
 * a shape fills 75% of the box (18 of 24, as Lucide) and a simple arrow 58%; X, +, check and chevrons keep their size.
 * `cls` adds a class the old CSS still looks for.
 */
type IconProps = React.SVGProps<SVGSVGElement>
const make = (children: React.ReactNode, { box = 24, view = '', cls = '' }: { box?: number; view?: string; cls?: string } = {}) => function Icon({ className, ...rest }: IconProps): React.JSX.Element {
  return <svg viewBox={view || `0 0 ${box} ${box}`} aria-hidden="true" {...rest} className={['ico ln', cls, className].filter(Boolean).join(' ')}>{children}</svg>
}
const dot = (cx: number, cy: number, r: number): React.JSX.Element => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />

/** Git: a branch, the Git view of a card or project, the repository. */
export const BranchIcon = make(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10" /><path d="M18 10c0 4-6 3-12 7" /></>)
/** A worktree (the card's working copy of a repository). */
export const TreeIcon = make(<><path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z" /><path d="M12 22v-3" /></>)
/** More options of a bar, column or row (vertical dots). */
export const MoreIcon = make(<>{dot(12, 5, 1.6)}{dot(12, 12, 1.6)}{dot(12, 19, 1.6)}</>)
/** More options of a message or queued item (horizontal dots). */
export const MoreHorizontalIcon = make(<>{dot(5, 12, 1.6)}{dot(12, 12, 1.6)}{dot(19, 12, 1.6)}</>)
/** An access token or key (Git accounts, pull requests). */
export const KeyIcon = make(<><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.7-8.7" /><path d="m16 7 2.5 2.5" /><path d="m14 9 2 2" /></>, { view: '1.42 0.92 20.67 20.67' })
/** Tokens spent by the agent (usage). An access token is KeyIcon. */
export const TokenIcon = make(<><circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" /><path d="M7 6h1v4" /><path d="m16.71 13.88.7.71-2.82 2.82" /></>)
/** A database: the Database view and its connections. */
export const DatabaseIcon = make(<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>)
/** The board (kanban view). */
export const BoardIcon = make(<><rect x="3" y="3" width="5" height="18" rx="1.5" /><rect x="10" y="3" width="5" height="11" rx="1.5" /><rect x="17" y="3" width="4" height="14" rx="1.5" /></>)
/** A card: open the card, a card row. */
export const CardIcon = make(<><rect x="3.5" y="3.5" width="13" height="13" rx="2.5" /><path d="M7 8h6M7 11.5h4" /></>, { view: '1.33 1.33 17.33 17.33' })
/** A chat: open a chat, the Chats view. */
export const ChatIcon = make(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />)
/** The AI (✦): what the agent suggests, generates or recommends. */
export const SparkIcon = make(<><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" /><path d="M20 3v4" /><path d="M22 5h-4" /><path d="M4 17v2" /><path d="M5 18H3" /></>)
/** Archive (archived cards). */
export const ArchiveIcon = make(<><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>)
/** Delete or remove something. */
export const TrashIcon = make(<><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>)
/** Start or run (an agent, SQL, a terminal command). */
export const PlayIcon = make(<path d="M7 4.5v15l12-7.5z" />)
/** Stop a running agent. */
export const StopIcon = make(<rect x="6" y="6" width="12" height="12" rx="2.5" />)
/** Finish a card (done). */
export const FinishIcon = make(<><circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.8 2.8L16.2 9.8" /></>)
/** Show or preview (a hidden value, the rendered document). */
export const EyeIcon = make(<><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>)
/** A folder: the card or project files, a path. */
export const FolderGlyph = make(<path d="M3.5 6.8c0-1 .8-1.8 1.8-1.8h4l2 2h7.4c1 0 1.8.8 1.8 1.8v8.4c0 1-.8 1.8-1.8 1.8H5.3c-1 0-1.8-.8-1.8-1.8V6.8Z" />)
/** Do it yourself (a card without an agent). */
export const HandIcon = make(<><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" /><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" /><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></>)
/** Expand to a bigger view (full screen, wide). */
export const ExpandIcon = make(<><path d="M15 3h6v6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /><path d="M9 21H3v-6" /></>)
/** Go back from the bigger view (restore, back to the corner). */
export const CollapseIcon = make(<><path d="m14 10 7-7" /><path d="M20 10h-6V4" /><path d="m3 21 7-7" /><path d="M4 14h6v6" /></>)
/** Minimize a panel. */
export const MinimizeIcon = make(<path d="M5 18h14" />)
/** Close or hide a panel, chat, file, reply or notice. */
export const CloseIcon = make(<path d="M18 6 6 18M6 6l12 12" />)
/** Send a message, a comment or a queued message. */
export const SendIcon = make(<><path d="M20 4v7a4 4 0 0 1-4 4H4" /><path d="m9 10-5 5 5 5" /></>)
/** Dictate (voice input). */
export const MicIcon = make(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>)
/** Edit (write mode, edit a file, change an image). */
export const PencilIcon = make(<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />)
/** Side by side (editor and preview, diff in two columns). */
export const SplitIcon = make(<><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M12 3v18" /></>)
/** Go left: previous page, fold a side panel. */
export const ChevronLeftIcon = make(<path d="M15 6l-6 6 6 6" />)
/** Done, installed, selected. */
export const CheckIcon = make(<path d="M5 12.5l4.5 4.5L19 7.5" />, { cls: 'chk' })
/** Changed files (see or open the changes). */
export const DiffIcon = make(<><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M12 7v6M9 10h6M9 17h6" /></>)
/** Add something (card, agent, attachment). */
export const PlusIcon = make(<path d="M12 5v14M5 12h14" />)
/** Refresh or reload. */
export const RefreshIcon = make(<><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>)

/** The app's expand/collapse arrow (sections, groups, rows): points right when closed and turns down when open. */
export function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return <span className={`xchev ${open ? 'open' : ''}`} aria-hidden="true"><ChevronRightSmallIcon /></span>
}
/** Small check inside a chip or checklist (has, checked). */
export const CheckMiniIcon = make(<path d="m2.5 6.3 2.3 2.3 4.7-5" />, { box: 12, cls: 'mini-ico' })
/** Small cross inside a chip (does not have). */
export const CrossMiniIcon = make(<path d="m3.2 3.2 5.6 5.6M8.8 3.2 3.2 8.8" />, { box: 12, cls: 'mini-ico' })

/* Icons that were drawn inside the components (one drawing per meaning). */
/** Plan a card (plan mode). The AI itself is SparkIcon. */
export const PlanIcon = make(<><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M12 11h4M12 16h4" />{dot(8, 11, 1.1)}{dot(8, 16, 1.1)}</>)
/** New chat. */
export const ChatPlusIcon = make(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M12 7v6M9 10h6" /></>)
/** Search or filter. */
export const SearchIcon = make(<><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></>, { view: '0.67 0.67 18.67 18.67' })
/** Go right: next page, unfold a side panel, closed section. */
export const ChevronRightIcon = make(<path d="M9 6l6 6-6 6" />)
/** Fold a section that opens downwards. */
export const ChevronUpIcon = make(<path d="M6 15l6-6 6 6" />)
/** Open a section or a list (see more). */
export const ChevronDownIcon = make(<path d="M6 9l6 6 6-6" />)
/** Closed row or tree node (turns down when open). */
export const ChevronRightSmallIcon = make(<path d="m4.5 2.5 3.5 3.5-3.5 3.5" />, { box: 12 })
/** Open row or group. */
export const ChevronDownSmallIcon = make(<path d="m3 4.5 3 3 3-3" />, { box: 12 })
/** Previous match or change. */
export const ArrowUpIcon = make(<path d="M10 16V4m-5 5 5-5 5 5" />, { view: '-0.29 -0.29 20.57 20.57' })
/** Next match or change. */
export const ArrowDownIcon = make(<path d="M10 4v12m-5-5 5 5 5-5" />, { view: '-0.29 -0.29 20.57 20.57' })
/** First page. */
export const FirstPageIcon = make(<path d="M4 3.5v9M12.5 3.5 6.5 8l6 4.5z" />, { view: '0.54 0.29 15.43 15.43' })
/** Last page. */
export const LastPageIcon = make(<path d="M12 3.5v9M3.5 3.5l6 4.5-6 4.5z" />, { view: '0.04 0.29 15.43 15.43' })
/** Comment on (or talk about) selected lines. */
export const CommentIcon = make(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />, { view: '1.17 1.43 22.67 22.67' })
/** A file. */
export const FileIcon = make(<><path d="M5 2.75h6l4 4v10.5H5z" /><path d="M11 2.75v4h4" /></>, { view: '0.33 0.33 19.33 19.33' })
/** New file. */
export const NewFileIcon = make(<path d="M5 2h7l4 4v12H5zM12 2v5h4M10 10v5m-2.5-2.5h5" />, { view: '-0.17 -0.67 21.33 21.33' })
/** New folder. */
export const NewFolderIcon = make(<path d="M2.5 5h5l2 2h8v9h-15zM10 9.5v4m-2-2h4" />, { view: '0 0.5 20 20' })
/** Card artifacts (documents the card produced). */
export const ArtifactIcon = make(<><path d="M6 3.5h6l3 3v8a1.5 1.5 0 0 1-1.5 1.5h-7.5A1.5 1.5 0 0 1 4.5 14.5v-9A1.5 1.5 0 0 1 6 3.5Z" /><path d="M12 3.5v3h3M7.5 10h5M7.5 13h3.5" /></>, { view: '1.37 1.42 16.67 16.67' })
/** Version history. */
export const HistoryIcon = make(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>)
/** A screen: browser tests (Playwright). */
export const ScreenIcon = make(<><rect x="2.5" y="3.5" width="15" height="11" rx="2" /><path d="M7 17.5h6M10 14.5v3" /></>, { view: '0 0.5 20 20' })
/** A list or tree of files, lines of a review. */
export const ListIcon = make(<path d="M4 5h2M4 10h2M4 15h2M9 5h7M9 10h7M9 15h7" />, { view: '2 2 16 16' })
/** Outline of a document (headings). */
export const OutlineIcon = make(<path d="M4 5h12M7 10h9M10 15h6" />, { view: '2 2 16 16' })
/** Hide a value that is shown. */
export const EyeOffIcon = make(<><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /><path d="M4 20 20 4" /></>)
/** Code: see the source, an SQL tab. */
export const CodeIcon = make(<path d="m5 5-3 3 3 3M11 5l3 3-3 3M9.5 3.5l-3 9" />, { view: '0 0 16 16' })
/** One above the other (diff in one column). */
export const RowsIcon = make(<><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 12h18" /></>)
/** Compare with the saved version. */
export const CompareIcon = make(<path d="M7 3H3v14h4M13 3h4v14h-4M10 2v16" />, { view: '-0.67 -0.67 21.33 21.33' })
/** Save. */
export const SaveIcon = make(<path d="M3 2h11l3 3v13H3zM6 2v6h7V2M6 18v-7h8v7" />, { view: '-0.67 -0.67 21.33 21.33' })
/** Open somewhere else (another mode or window). */
export const ExternalIcon = make(<path d="M8 3H3v14h14v-5M11 3h6v6m0-6-8 8" />, { view: '0.67 0.67 18.67 18.67' })
/** Come back to the main window. */
export const DockIcon = make(<path d="M5 6h10v10H5zM8 3H3v5m0-5 7 7" />, { view: '0.33 0.83 17.33 17.33' })
/** A warning (conflict, risk). */
export const WarningIcon = make(<><path d="M10 3 2.5 16h15z" /><path d="M10 8v4" />{dot(10, 14.4, .9)}</>, { view: '0 -0.5 20 20' })
/** Information notice. */
export const InfoIcon = make(<><path d="M10 9.2v4.6" />{dot(10, 6.3, .9)}</>, { box: 20 })
/** Attention notice. */
export const AlertIcon = make(<><path d="M10 6v5" />{dot(10, 14, .9)}</>, { box: 20 })
/** Notification. */
export const BellIcon = make(<path d="M5.5 14.5h9l-1.2-1.6V9.2a3.3 3.3 0 0 0-6.6 0v3.7zM8.6 16.2a1.5 1.5 0 0 0 2.8 0" />, { view: '2.49 4.02 15.01 15.01' })
/** The terminal. */
export const TerminalIcon = make(<path d="m4 5 5 5-5 5M11 15h5" />, { view: '2 2 16 16' })
/** Copy. */
export const CopyIcon = make(<><rect x="7" y="7" width="9" height="9" rx="2" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /></>, { view: '0.83 0.83 17.33 17.33' })
/** Git pull: bring the remote changes. */
export const PullIcon = make(<path d="M10 3v10m0 0-4-4m4 4 4-4M4 17h12" />, { view: '0.67 0.67 18.67 18.67' })
/** Git push: send your changes. */
export const PushIcon = make(<path d="M10 17V7m0 0-4 4m4-4 4 4M4 3h12" />, { view: '0.67 0.67 18.67 18.67' })
/** Git rebase: put your changes on top of the remote ones. */
export const RebaseIcon = make(<path d="M6 3v9a3 3 0 0 0 3 3h5m0 0-3-3m3 3-3 3M6 3 3.5 5.5M6 3l2.5 2.5" />, { view: '-1.25 0.5 20 20' })
/** Background tasks. */
export const ActivityIcon = make(<path d="M3 10h3l2-5 4 10 2-5h3" />, { view: '0.67 0.67 18.67 18.67' })
/** Windows: the layout menu, open in a new window. */
export const WindowIcon = make(<><rect x="2.5" y="3" width="15" height="14" rx="2.5" /><path d="M3 7h14" />{dot(5, 5, .7)}{dot(7, 5, .7)}</>, { view: '0 0 20 20' })
/** Settings. */
export const GearIcon = make(<><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>)

/* Pull requests (list, detail, pipelines, new request). */
/** A pull/merge request: the PR mode, the "Pull requests" section, the "Aberto" state, creating one. */
export const PullRequestIcon = make(<><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 8v8" /><path d="M18 16v-6a3 3 0 0 0-3-3h-4" /><path d="m13 5-2 2 2 2" /></>)
/** Merge a pull request (the merge button and its options). */
export const MergeIcon = make(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="13" r="2" /><path d="M6 7v10" /><path d="M6 7c0 4 4 6 10 6" /></>)
/** React to a comment (opens the 👍/👎 choice). */
export const SmileIcon = make(<><circle cx="12" cy="12" r="9" /><path d="M8.5 14.2a4.5 4.5 0 0 0 7 0" />{dot(9.2, 9.8, 1.1)}{dot(14.8, 9.8, 1.1)}</>)
/** Resolve or reopen a review thread (a check leaving an open circle). */
export const ResolveIcon = make(<><path d="M20.5 11A8.5 8.5 0 1 1 15 4" /><path d="m8.5 11.5 3 3L21 5" /></>)
/** Like (thumbs up) on a pull request. */
export const ThumbUpIcon = make(<><path d="M7 10v10" /><path d="M4 10h3v10H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z" /><path d="m7 10 3.7-6.2a1.6 1.6 0 0 1 2.9 1.2L12.8 9H18a2 2 0 0 1 2 2.3l-1.2 6.9A2 2 0 0 1 16.8 20H7" /></>)
/** Dislike (thumbs down) on a pull request. */
export const ThumbDownIcon = make(<g transform="rotate(180 12 12)"><path d="M7 10v10" /><path d="M4 10h3v10H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z" /><path d="m7 10 3.7-6.2a1.6 1.6 0 0 1 2.9 1.2L12.8 9H18a2 2 0 0 1 2 2.3l-1.2 6.9A2 2 0 0 1 16.8 20H7" /></g>)
/** Approval of a pull request: approve, who approved, reviewers. */
export const ApproverIcon = make(<><circle cx="10" cy="8" r="4" /><path d="M3 20c0-3.5 3-6 7-6 1.3 0 2.5.3 3.5.8" /><path d="m15 18 2 2 4-4" /></>)
/** A person: the assignee of a pull request. */
export const PersonIcon = make(<><circle cx="12" cy="8" r="4" /><path d="M4 20c0-3.8 3.6-6 8-6s8 2.2 8 6" /></>)
/** A milestone of the project. */
export const MilestoneIcon = make(<><path d="M12 3v18" /><path d="M12 5h6l2 2.5-2 2.5h-6" /><path d="M12 12H6l-2 2.5L6 17h6" /></>)
/** A label of the project (pull requests, issues). */
export const LabelIcon = make(<><path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9Z" />{dot(7.5, 7.5, 1.3)}</>)
/** Show or hide the side panel (the file tree of the changes). */
export const SidePanelIcon = make(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d="M5.5 8h1M5.5 11h1" /></>)
/** Files shown as a tree grouped by folder (the list view is ListIcon). */
export const TreeViewIcon = make(<><path d="M6 4v12a2 2 0 0 0 2 2h4" /><path d="M6 9h6" /><rect x="13" y="6.5" width="7" height="5" rx="1.2" /><rect x="13" y="15.5" width="7" height="5" rx="1.2" /></>)
/** Markdown toolbar: bold. */
export const BoldIcon = make(<><path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" /><path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" /></>)
/** Markdown toolbar: italic. */
export const ItalicIcon = make(<path d="M10 5h8M6 19h8M14 5l-4 14" />)
/** Markdown toolbar: strikethrough. */
export const StrikeIcon = make(<><path d="M16 7.5C15.4 6 13.9 5 12 5c-2.5 0-4 1.3-4 3 0 1.4.9 2.3 2.8 3" /><path d="M4 12h16" /><path d="M15.6 14.5c.3.5.4 1 .4 1.5 0 1.8-1.7 3-4 3-2 0-3.6-.9-4.2-2.4" /></>)
/** Markdown toolbar: quote. */
export const QuoteIcon = make(<><path d="M5 6v12" /><path d="M9 8h10M9 12h10M9 16h6" /></>)
/** Markdown toolbar: link. */
export const LinkIcon = make(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>)
/** Markdown toolbar: bulleted list. */
export const BulletListIcon = make(<>{dot(5, 7, 1.2)}{dot(5, 12, 1.2)}{dot(5, 17, 1.2)}<path d="M9 7h10M9 12h10M9 17h10" /></>)
/** Markdown toolbar: numbered list. */
export const NumberedListIcon = make(<><path d="M4.5 5.5h1v4" /><path d="M4.2 14.6a1.2 1.2 0 0 1 2.1.9L4.2 18.5h2.3" /><path d="M10 7h10M10 12h10M10 17h10" /></>)
/** Markdown toolbar: task list. */
export const TaskListIcon = make(<><path d="m3.5 7 1.5 1.5 3-3" /><path d="m3.5 16 1.5 1.5 3-3" /><path d="M11 7h9M11 16.5h9" /></>)
/** Markdown toolbar: table. */
export const TableIcon = make(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M10 4v16" /></>)
/** Attach a file to a text (uploaded to the host). */
export const PaperclipIcon = make(<path d="m20 11-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 16.7a1.7 1.7 0 0 1-2.4-2.4L15 6.6" />)
/** Pipeline or job status: passed. */
export const StatusSuccessIcon = make(<><circle cx="12" cy="12" r="9" /><path d="m8.5 12.3 2.4 2.4 4.6-5" /></>)
/** Pipeline or job status: failed. */
export const StatusFailedIcon = make(<><circle cx="12" cy="12" r="9" /><path d="m9.2 9.2 5.6 5.6m0-5.6-5.6 5.6" /></>)
/** Pipeline or job status: running (spin the element around it, not the svg). Also "sending…" on buttons. */
export const StatusRunningIcon = make(<><circle cx="12" cy="12" r="9" opacity=".3" /><path d="M12 3a9 9 0 0 1 9 9" /></>)
/** Pipeline or job status: waiting to run. */
export const StatusPendingIcon = make(<circle cx="12" cy="12" r="9" strokeDasharray="3.2 3.2" />)
/** Pipeline or job status: canceled or skipped. */
export const StatusCanceledIcon = make(<><circle cx="12" cy="12" r="9" /><path d="m8.5 15.5 7-7" /></>)
/** Pipeline or job status: waiting for someone to start it (manual). */
export const StatusManualIcon = make(<><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7l5.5-3.5z" /></>)
