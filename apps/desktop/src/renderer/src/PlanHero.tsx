import { PlanIcon } from './icons'
import { useT } from './i18n'

/** Central card of an empty planning chat: invites to plan for the project; the ideas (when given) fill the input. */
export function PlanHero({ projectName, text, pick, talk = false }: { projectName: string; text?: string; pick?(prompt: string): void; talk?: boolean }): React.JSX.Element {
  const f = useT().chat.freeChat
  // Free chat (not the board's planning one): an open conversation about the project.
  const hero = talk ? { eyebrow: f.talk.eyebrow, title: f.talk.title, text: f.talk.text, ideas: f.talk.ideas } : { eyebrow: f.hero.eyebrow, title: f.hero.title(projectName), text: f.hero.text, ideas: f.hero.ideas }
  return <div className="plan-hero">
    <span className="plan-hero-mark" aria-hidden="true"><PlanIcon /></span>
    <div className="plan-hero-eyebrow">{hero.eyebrow}</div>
    <h3>{hero.title}</h3>
    <p>{text ?? hero.text}</p>
    {pick && <div className="plan-hero-ideas">{hero.ideas.map((idea) => <button type="button" key={idea.label} onClick={() => pick(idea.prompt)}>{idea.label}</button>)}</div>}
  </div>
}
