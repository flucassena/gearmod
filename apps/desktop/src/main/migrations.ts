import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  checksum: string
  /** Migration that recreates tables referenced by others: runs with foreign_keys off (outside the transaction) and checks the keys at the end. */
  disableForeignKeys?: boolean
  up(db: Database.Database): void
}

const initialSchema = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, local_path TEXT NOT NULL UNIQUE,
  base_branch TEXT NOT NULL DEFAULT 'dev', remote_provider TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, scope TEXT NOT NULL,
  config_dir TEXT NOT NULL, executable_path TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE project_agent_profiles (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  allowed INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(project_id, profile_id)
);
CREATE TABLE board_columns (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL, sort_order INTEGER NOT NULL, semantic_state TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id, semantic_state)
);
CREATE TABLE cards (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES board_columns(id), type TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL, order_key REAL NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
);
CREATE TABLE card_acceptance_criteria (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  body TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL
);
CREATE TABLE card_tags (card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY(card_id, tag));
CREATE TABLE card_attachments (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL, relative_path TEXT NOT NULL, media_type TEXT, size_bytes INTEGER NOT NULL,
  checksum TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE plans (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
  content_md TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT,
  UNIQUE(card_id, version)
);
CREATE TABLE chats (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  card_id TEXT REFERENCES cards(id) ON DELETE SET NULL, purpose TEXT NOT NULL, provider TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id), provider_session_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  provider_message_id TEXT
);
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  repo_path TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base_ref TEXT NOT NULL,
  created_at TEXT NOT NULL, cleanup_state TEXT NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id), profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
  status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, exit_reason TEXT,
  worktree_id TEXT REFERENCES worktrees(id), provider_turn_id TEXT
);
CREATE TABLE run_events (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json_sanitized TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(run_id, seq)
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, remote_url TEXT, remote_id TEXT, state TEXT NOT NULL,
  target_branch TEXT NOT NULL, source_branch TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE test_runs (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id), command TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER,
  summary TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE column_history (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  from_column_id TEXT REFERENCES board_columns(id), to_column_id TEXT NOT NULL REFERENCES board_columns(id),
  changed_at TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider_request_id TEXT NOT NULL, description TEXT NOT NULL, decision TEXT,
  requested_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, json_value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE notes (
  id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_cards_project ON cards(project_id, archived_at, order_key);
CREATE INDEX idx_chats_card ON chats(card_id, updated_at);
CREATE INDEX idx_runs_card ON runs(card_id, started_at);
CREATE INDEX idx_events_run ON run_events(run_id, seq);
`

export const migrations: readonly Migration[] = [
  {
    version: 1,
    checksum: 'sha256:gearmod-schema-v1-2026-10-20',
    up(db) { db.exec(initialSchema) }
  },
  {
    version: 2,
    checksum: 'sha256:gearmod-project-sources-v2-2026-10-20',
    up(db) {
      db.exec(`
        CREATE TABLE project_sources (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL, local_path TEXT NOT NULL, is_git_repository INTEGER NOT NULL DEFAULT 0,
          current_branch TEXT, sort_order INTEGER NOT NULL, UNIQUE(project_id, local_path)
        );
        ALTER TABLE cards ADD COLUMN source_id TEXT REFERENCES project_sources(id);
        INSERT INTO project_sources(id, project_id, name, local_path, is_git_repository, current_branch, sort_order)
          SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
            id, name, local_path, 1, base_branch, 0 FROM projects;
        UPDATE cards SET source_id = (SELECT ps.id FROM project_sources ps WHERE ps.project_id = cards.project_id ORDER BY ps.sort_order LIMIT 1);
        CREATE INDEX idx_project_sources_project ON project_sources(project_id, sort_order);
      `)
    }
  },
  {
    version: 3,
    checksum: 'sha256:gearmod-remove-automatic-profiles-v3-2026-10-20',
    up(db) {
      db.exec(`
        DELETE FROM agent_profiles
        WHERE id IN (
          '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004',
          '10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000006'
        )
        AND NOT EXISTS (SELECT 1 FROM project_agent_profiles WHERE profile_id = agent_profiles.id)
        AND NOT EXISTS (SELECT 1 FROM plans WHERE agent_profile_id = agent_profiles.id)
        AND NOT EXISTS (SELECT 1 FROM chats WHERE profile_id = agent_profiles.id)
        AND NOT EXISTS (SELECT 1 FROM runs WHERE profile_id = agent_profiles.id);
        UPDATE agent_profiles SET enabled = 0, updated_at = datetime('now')
        WHERE id IN (
          '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004',
          '10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000006'
        );
      `)
    }
  },
  {
    version: 4,
    checksum: 'sha256:gearmod-multi-repo-worktrees-v4-2026-10-20',
    up(db) {
      db.exec(`
        CREATE TABLE worktree_members (
          id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          repo_path TEXT NOT NULL, path TEXT NOT NULL, base_ref TEXT NOT NULL,
          UNIQUE(worktree_id, repo_path)
        );
        CREATE INDEX idx_worktree_members_worktree ON worktree_members(worktree_id);
      `)
    }
  },
  {
    version: 5,
    checksum: 'sha256:gearmod-agent-color-v5-2026-10-21',
    up(db) {
      db.exec(`
        ALTER TABLE agent_profiles ADD COLUMN color TEXT NOT NULL DEFAULT '#aeb9ff';
        UPDATE agent_profiles SET color = CASE provider WHEN 'claude' THEN '#D97757' ELSE '#aeb9ff' END;
      `)
    }
  },
  {
    version: 6,
    checksum: 'sha256:gearmod-backlog-and-no-mr-v6-2026-10-21',
    up(db) {
      // Columns Backlog/To do/Doing/Test/Done. The 'mr' row stays in the database (safe rollback, history points to it), but leaves the board.
      const projects = db.prepare('SELECT id FROM projects').all() as { id: string }[]
      const now = new Date().toISOString()
      for (const { id: projectId } of projects) {
        const column = (state: string): { id: string } | undefined => db.prepare('SELECT id FROM board_columns WHERE project_id = ? AND semantic_state = ?').get(projectId, state) as { id: string } | undefined
        if (!column('backlog')) {
          db.prepare('UPDATE board_columns SET sort_order = sort_order + 1 WHERE project_id = ?').run(projectId)
          db.prepare(`INSERT INTO board_columns(id, project_id, label, sort_order, semantic_state, is_default)
            VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))), ?, 'Backlog', 0, 'backlog', 1)`).run(projectId)
        }
        db.prepare(`UPDATE board_columns SET label = 'To do' WHERE project_id = ? AND semantic_state = 'todo' AND label = 'To Do'`).run(projectId)
        const mr = column('mr'), test = column('test')
        if (mr && test) {
          const cards = db.prepare('SELECT id FROM cards WHERE column_id = ? ORDER BY order_key').all(mr.id) as { id: string }[]
          const next = db.prepare('SELECT COALESCE(MAX(order_key), 0) AS value FROM cards WHERE column_id = ?')
          for (const card of cards) {
            const order = (next.get(test.id) as { value: number }).value + 1024
            db.prepare('UPDATE cards SET column_id = ?, order_key = ?, updated_at = ? WHERE id = ?').run(test.id, order, now, card.id)
            db.prepare(`INSERT INTO column_history(id, card_id, from_column_id, to_column_id, changed_at, actor, reason)
              VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))), ?, ?, ?, ?, 'system', 'migration-mr-to-test')`).run(card.id, mr.id, test.id, now)
          }
        }
      }
    }
  },
  {
    version: 7,
    checksum: 'sha256:gearmod-card-documents-v7-2026-10-21',
    up(db) {
      db.exec(`
        CREATE TABLE card_documents (
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('resumo', 'especificacao', 'plano', 'tasks')),
          content_md TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
          PRIMARY KEY(card_id, kind)
        );
        CREATE TABLE card_document_versions (
          id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          kind TEXT NOT NULL, version INTEGER NOT NULL, content_md TEXT NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL,
          UNIQUE(card_id, kind, version)
        );
      `)
      // The old description becomes the Summary, the criteria become top-level tasks and the last plan becomes the Plan document.
      // Old columns and tables stay in the database (safe rollback).
      const insertDoc = db.prepare('INSERT INTO card_documents(card_id, kind, content_md, updated_at, updated_by) VALUES (?, ?, ?, ?, \'system\')')
      const insertVersion = db.prepare(`INSERT INTO card_document_versions(id, card_id, kind, version, content_md, created_at, actor)
        VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))), ?, ?, 1, ?, ?, 'system')`)
      const save = (cardId: string, kind: string, content: string, at: string): void => { insertDoc.run(cardId, kind, content, at); insertVersion.run(cardId, kind, content, at) }
      const cards = db.prepare('SELECT id, description, updated_at AS updatedAt FROM cards').all() as { id: string; description: string; updatedAt: string }[]
      for (const card of cards) {
        if (card.description.trim()) save(card.id, 'resumo', card.description, card.updatedAt)
        const criteria = db.prepare('SELECT body, checked FROM card_acceptance_criteria WHERE card_id = ? ORDER BY sort_order').all(card.id) as { body: string; checked: number }[]
        if (criteria.length) save(card.id, 'tasks', criteria.map((item, index) => `- [${item.checked ? 'x' : ' '}] T${String(index + 1).padStart(3, '0')} ${item.body}`).join('\n'), card.updatedAt)
        const plan = db.prepare(`SELECT content_md AS body, created_at AS at FROM plans WHERE card_id = ? ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, version DESC LIMIT 1`).get(card.id) as { body: string; at: string } | undefined
        if (plan?.body.trim()) save(card.id, 'plano', plan.body, plan.at)
      }
    }
  },
  {
    version: 8,
    checksum: 'sha256:gearmod-card-viewed-v8-2026-10-21',
    up(db) {
      // viewed_at marks when the user saw the result of the last run ("finished" highlight); what already exists counts as seen.
      db.exec(`ALTER TABLE cards ADD COLUMN viewed_at TEXT; UPDATE cards SET viewed_at = datetime('now');`)
    }
  },
  {
    version: 9,
    checksum: 'sha256:gearmod-agent-config-v9-2026-10-21',
    up(db) {
      db.exec(`
        CREATE TABLE card_agent_settings (
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL CHECK (purpose IN ('planning', 'execution')),
          profile_id TEXT NOT NULL REFERENCES agent_profiles(id), model TEXT, effort TEXT, mode TEXT NOT NULL,
          updated_at TEXT NOT NULL, PRIMARY KEY(card_id, purpose)
        );
        CREATE TABLE agent_usage_stats (
          profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', effort TEXT NOT NULL DEFAULT '',
          count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT NOT NULL, PRIMARY KEY(profile_id, purpose, model, effort)
        );
      `)
    }
  },
  {
    version: 10,
    checksum: 'sha256:gearmod-chat-skill-v10-2026-10-21',
    up(db) { db.exec('ALTER TABLE chats ADD COLUMN skill_name TEXT; ALTER TABLE chats ADD COLUMN skill_path TEXT;') }
  },
  {
    version: 11,
    checksum: 'sha256:gearmod-usage-snapshots-v11-2026-10-21',
    up(db) {
      db.exec(`CREATE TABLE agent_usage_snapshots (
        profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE, window TEXT NOT NULL,
        utilization REAL NOT NULL, resets_at TEXT, captured_at TEXT NOT NULL, PRIMARY KEY(profile_id, window)
      )`)
    }
  },
  {
    version: 12,
    checksum: 'sha256:gearmod-test-purpose-v12-2026-10-21',
    up(db) {
      // The "test" purpose (test agent) enters the table; the old CHECK only accepted planning/execution, so the table is recreated.
      db.exec(`
        CREATE TABLE card_agent_settings_new (
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL CHECK (purpose IN ('planning', 'execution', 'test')),
          profile_id TEXT NOT NULL REFERENCES agent_profiles(id), model TEXT, effort TEXT, mode TEXT NOT NULL,
          updated_at TEXT NOT NULL, PRIMARY KEY(card_id, purpose)
        );
        INSERT INTO card_agent_settings_new SELECT card_id, purpose, profile_id, model, effort, mode, updated_at FROM card_agent_settings;
        DROP TABLE card_agent_settings;
        ALTER TABLE card_agent_settings_new RENAME TO card_agent_settings;
      `)
    }
  },
  {
    version: 13,
    checksum: 'sha256:gearmod-collaboration-v13-2026-10-21',
    up(db) {
      // Communication between steps: questions (dev/test → planner → user) and change proposals (wait for authorization).
      // The Questions and Changes documents are generated from these tables; card_documents is recreated to accept the two new types.
      db.exec(`
        CREATE TABLE card_documents_new (
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('resumo', 'especificacao', 'plano', 'tasks', 'duvidas', 'mudancas')),
          content_md TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
          PRIMARY KEY(card_id, kind)
        );
        INSERT INTO card_documents_new SELECT card_id, kind, content_md, updated_at, updated_by FROM card_documents;
        DROP TABLE card_documents;
        ALTER TABLE card_documents_new RENAME TO card_documents;
        CREATE TABLE card_questions (
          id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, number INTEGER NOT NULL,
          asker_purpose TEXT NOT NULL, asker_chat_id TEXT, question TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'planner', 'user', 'answered')),
          answer TEXT, answered_by TEXT, user_question TEXT, rounds INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, answered_at TEXT, UNIQUE(card_id, number)
        );
        CREATE TABLE card_changes (
          id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, number INTEGER NOT NULL,
          proposer_purpose TEXT NOT NULL, proposer_chat_id TEXT, title TEXT NOT NULL, details TEXT NOT NULL, reason TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'suggested', 'rejected', 'applied')),
          user_note TEXT, created_at TEXT NOT NULL, decided_at TEXT, UNIQUE(card_id, number)
        );
      `)
    }
  },
  {
    version: 14,
    checksum: 'sha256:gearmod-plan-ready-v14-2026-10-21',
    up(db) {
      // The planner declares the plan complete (tool/marker); before that the card is only "in planning". Old cards with a written Plan stay ready.
      db.exec(`ALTER TABLE cards ADD COLUMN plan_ready_at TEXT;
        UPDATE cards SET plan_ready_at = datetime('now') WHERE EXISTS (SELECT 1 FROM card_documents d WHERE d.card_id = cards.id AND d.kind = 'plano' AND length(trim(d.content_md)) > 0);`)
    }
  },
  {
    version: 15,
    checksum: 'sha256:gearmod-free-chat-v15-2026-10-21',
    disableForeignKeys: true,
    up(db) {
      // Free chat: a conversation without a card. runs.card_id now accepts NULL (table recreated, keeping run_events/test_runs/approvals) and the chat gets a title.
      db.exec(`
        CREATE TABLE runs_new (
          id TEXT PRIMARY KEY, card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
          chat_id TEXT NOT NULL REFERENCES chats(id), profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
          status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, exit_reason TEXT,
          worktree_id TEXT REFERENCES worktrees(id), provider_turn_id TEXT
        );
        INSERT INTO runs_new SELECT id, card_id, chat_id, profile_id, status, started_at, ended_at, exit_reason, worktree_id, provider_turn_id FROM runs;
        DROP TABLE runs;
        ALTER TABLE runs_new RENAME TO runs;
        CREATE INDEX idx_runs_card ON runs(card_id, started_at);
        ALTER TABLE chats ADD COLUMN title TEXT;
      `)
    }
  },
  {
    version: 16,
    checksum: 'sha256:gearmod-profile-removed-v16-2026-10-21',
    up(db) {
      // Removing an agent with history only deactivates it: it disappears from lists and no longer runs, but cards and chats keep showing who ran.
      db.exec('ALTER TABLE agent_profiles ADD COLUMN removed_at TEXT;')
    }
  },
  {
    version: 17,
    checksum: 'sha256:gearmod-card-base-branch-v17-2026-10-22',
    up(db) {
      // Base branch chosen when starting the run: the card worktree is born from it (empty = each repository's current branch).
      db.exec('ALTER TABLE cards ADD COLUMN base_branch TEXT;')
    }
  },
  {
    version: 18,
    checksum: 'sha256:gearmod-run-tokens-v18-2026-10-22',
    up(db) {
      // Tokens spent per run (summed per card step): read again, from cache and written by the agent.
      db.exec(`ALTER TABLE runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;`)
    }
  },
  {
    version: 19,
    checksum: 'sha256:gearmod-constitution-v19-2026-10-21',
    up(db) {
      // Project Constitution (optional): current text, versions and the changes agents suggest outside its chat.
      db.exec(`CREATE TABLE project_constitutions (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, content_md TEXT NOT NULL, version INTEGER NOT NULL,
          updated_at TEXT NOT NULL, updated_by TEXT NOT NULL CHECK (updated_by IN ('user', 'agent', 'system')));
        CREATE TABLE project_constitution_versions (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, version INTEGER NOT NULL, content_md TEXT NOT NULL,
          created_at TEXT NOT NULL, actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')), UNIQUE(project_id, version));
        CREATE TABLE constitution_proposals (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, number INTEGER NOT NULL,
          card_id TEXT REFERENCES cards(id) ON DELETE SET NULL, chat_id TEXT, title TEXT NOT NULL, details TEXT NOT NULL, reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')), created_at TEXT NOT NULL, UNIQUE(project_id, number));`)
    }
  },
  {
    version: 20,
    checksum: 'sha256:gearmod-project-icon-v20-2026-10-21',
    up(db) {
      // Project icon (image as data URL) in place of the initial in the sidebar.
      db.exec('ALTER TABLE projects ADD COLUMN icon TEXT;')
    }
  },
  {
    version: 21,
    checksum: 'sha256:gearmod-test-checklist-v21-2026-10-21',
    up(db) {
      // Tester checklist: what it will verify, checked off as it verifies (appears next to the test chat).
      db.exec(`CREATE TABLE card_checklists (
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, purpose TEXT NOT NULL CHECK (purpose IN ('test')),
          content_md TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(card_id, purpose));`)
    }
  },
  {
    version: 22,
    checksum: 'sha256:gearmod-project-order-v22-2026-10-21',
    up(db) {
      // Project order in the sidebar (the user drags). Starts in the previous order: most recent on top.
      db.exec(`ALTER TABLE projects ADD COLUMN sort_order INTEGER;
        UPDATE projects SET sort_order = (SELECT COUNT(*) FROM projects p WHERE p.updated_at > projects.updated_at OR (p.updated_at = projects.updated_at AND p.id < projects.id));`)
    }
  },
  {
    version: 23,
    checksum: 'sha256:gearmod-auto-resume-v23-2026-10-21',
    up(db) {
      // Resumes scheduled for when the agent's usage limit comes back.
      db.exec(`CREATE TABLE auto_resumes (
          id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL, profile_id TEXT NOT NULL, resume_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'cancelled', 'replaced')), created_at TEXT NOT NULL);
        CREATE INDEX idx_auto_resumes_pending ON auto_resumes(status, resume_at);`)
    }
  },
  {
    version: 24,
    checksum: 'sha256:gearmod-git-manager-v24-2026-10-22',
    up(db) {
      // Git manager: per-project agent commit rule (JSON), commit requests waiting for the user and who (agent) made each commit.
      db.exec(`ALTER TABLE projects ADD COLUMN git_policy TEXT;
        CREATE TABLE git_commit_requests (
          id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, source_id TEXT NOT NULL, repo_name TEXT NOT NULL, repo_path TEXT NOT NULL,
          chat_id TEXT, profile_id TEXT, message TEXT NOT NULL, files TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'denied', 'failed')),
          hash TEXT, error TEXT, created_at TEXT NOT NULL, decided_at TEXT);
        CREATE INDEX idx_git_commit_requests_card ON git_commit_requests(card_id, status);
        CREATE TABLE git_commit_agents (repo_path TEXT NOT NULL, hash TEXT NOT NULL, profile_id TEXT NOT NULL, PRIMARY KEY(repo_path, hash));`)
    }
  },
  {
    version: 25,
    checksum: 'sha256:gearmod-change-sent-v25-2026-10-22',
    up(db) {
      // An authorized change only stops reminding the user once it was sent to the developer (automatic at the end of the planner, or via the button). Already applied ones count as sent.
      db.exec(`ALTER TABLE card_changes ADD COLUMN sent_at TEXT;
        UPDATE card_changes SET sent_at = COALESCE(decided_at, created_at) WHERE status = 'applied';`)
    }
  },
  {
    version: 26,
    checksum: 'sha256:gearmod-assessments-v26-2026-10-23',
    up(db) {
      // Complexity Engine and traceability (docs/09): versioned evaluations (never overwritten), decisions, events mirrored in
      // history.jsonl, the card's chosen flow, project workflow configuration and per-run metrics (only what the agent reports).
      db.exec(`CREATE TABLE card_assessments (
          id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, version INTEGER NOT NULL, preliminary INTEGER NOT NULL,
          scores_json TEXT NOT NULL, weights_json TEXT NOT NULL, total INTEGER NOT NULL, level TEXT NOT NULL CHECK (level IN ('simple', 'medium', 'complex')),
          confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')), critical_risks_json TEXT NOT NULL, justifications_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
          workflow TEXT NOT NULL, trigger TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL CHECK (actor IN ('agent', 'user')),
          profile_id TEXT, provider TEXT, model TEXT, effort TEXT, code_version TEXT, supersedes_id TEXT, created_at TEXT NOT NULL, UNIQUE(card_id, version));
        CREATE TABLE card_decisions (
          id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, number INTEGER NOT NULL, kind TEXT NOT NULL, statement TEXT NOT NULL,
          rationale TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'superseded')), actor TEXT NOT NULL CHECK (actor IN ('agent', 'user')),
          supersedes_id TEXT, created_at TEXT NOT NULL, UNIQUE(card_id, number));
        CREATE TABLE card_events (
          id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, project_id TEXT NOT NULL, type TEXT NOT NULL, schema_version INTEGER NOT NULL,
          actor TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL, synced_at TEXT);
        CREATE INDEX idx_card_assessments_card ON card_assessments(card_id, version);
        CREATE INDEX idx_card_events_card ON card_events(card_id, created_at);
        CREATE INDEX idx_card_events_unsynced ON card_events(synced_at) WHERE synced_at IS NULL;
        ALTER TABLE cards ADD COLUMN workflow TEXT;
        ALTER TABLE projects ADD COLUMN workflow_config TEXT;
        ALTER TABLE runs ADD COLUMN purpose TEXT;
        ALTER TABLE runs ADD COLUMN provider TEXT;
        ALTER TABLE runs ADD COLUMN model TEXT;
        ALTER TABLE runs ADD COLUMN effort TEXT;
        ALTER TABLE runs ADD COLUMN cost_usd REAL;
        ALTER TABLE runs ADD COLUMN prompt_chars INTEGER;`)
    }
  },
  {
    version: 27,
    checksum: 'sha256:gearmod-coordinated-worktrees-v27-2026-10-23',
    up(db) {
      // Coordinated worktrees: repositories involved in the card (empty = all, as before), state of each worktree repository
      // (a partial failure does not take the others down) and each one's PR. Playwright CLI usage per run, to compare cost.
      db.exec(`ALTER TABLE cards ADD COLUMN repo_ids TEXT;
        ALTER TABLE worktree_members ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
        ALTER TABLE worktree_members ADD COLUMN error TEXT;
        ALTER TABLE worktree_members ADD COLUMN pr_url TEXT;
        ALTER TABLE runs ADD COLUMN used_playwright_cli INTEGER NOT NULL DEFAULT 0;`)
    }
  },
  {
    version: 28,
    checksum: 'sha256:gearmod-checklist-marks-v28-2026-10-26',
    up(db) {
      // Who checked each test checklist item (user or agent) and when: JSON { "<item text>": { by, at } }.
      db.exec(`ALTER TABLE card_checklists ADD COLUMN marks TEXT;`)
    }
  },
  {
    version: 29,
    checksum: 'sha256:gearmod-shared-worktree-v29-2026-10-27',
    up(db) {
      // Card that uses another card's worktree (instead of creating its own): stores who the owner is. Empty = the card has its own.
      db.exec(`ALTER TABLE cards ADD COLUMN worktree_card_id TEXT;`)
    }
  },
  {
    version: 30,
    checksum: 'sha256:gearmod-usage-ledger-v30-2026-10-28',
    up(db) {
      db.exec(`
        CREATE TABLE usage_ledger (
          id TEXT PRIMARY KEY, at TEXT NOT NULL,
          run_id TEXT, seq INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL CHECK (source IN ('run','probe','skill-review','model-list','backfill')),
          provider TEXT NOT NULL, profile_id TEXT NOT NULL, account_key TEXT,
          model_configured TEXT, model_effective TEXT,
          project_id TEXT, project_name TEXT, card_id TEXT, card_title TEXT, purpose TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0, cached_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER,
          billing_mode TEXT NOT NULL DEFAULT 'unknown' CHECK (billing_mode IN ('subscription','api','credits','unknown')),
          cost_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (cost_kind IN ('billed','api_equivalent','unknown')), cost_usd REAL,
          partial INTEGER NOT NULL DEFAULT 0,
          UNIQUE (run_id, seq)
        );
        CREATE INDEX usage_ledger_at ON usage_ledger(at);
        CREATE INDEX usage_ledger_card ON usage_ledger(card_id, at);
        CREATE INDEX usage_ledger_profile ON usage_ledger(profile_id, at);
        CREATE TRIGGER usage_ledger_no_update BEFORE UPDATE ON usage_ledger BEGIN SELECT RAISE(ABORT, 'usage_ledger é append-only'); END;
        CREATE TRIGGER usage_ledger_no_delete BEFORE DELETE ON usage_ledger BEGIN SELECT RAISE(ABORT, 'usage_ledger é append-only'); END;
      `)
    }
  },
  {
    version: 31,
    checksum: 'sha256:gearmod-usage-ledger-backfill-v31-2026-10-28',
    up(db) {
      db.exec(`INSERT OR IGNORE INTO usage_ledger (
        id, at, run_id, seq, source, provider, profile_id, model_configured, project_id, project_name, card_id, card_title, purpose,
        input_tokens, cached_read_tokens, output_tokens, cost_kind, cost_usd, partial
      ) SELECT lower(hex(randomblob(16))), r.started_at, r.id, 0, 'backfill', COALESCE(r.provider, c.provider, 'unknown'), r.profile_id,
        r.model, p.id, p.name, r.card_id, c.title, COALESCE(r.purpose, c.purpose), r.input_tokens, r.cached_tokens, r.output_tokens,
        'unknown', r.cost_usd, 0
        FROM runs r LEFT JOIN chats c ON c.id = r.chat_id LEFT JOIN cards k ON k.id = r.card_id
        LEFT JOIN projects p ON p.id = k.project_id;`)
    }
  },
  {
    version: 32,
    checksum: 'sha256:gearmod-quota-snapshots-v32-2026-10-28',
    up(db) {
      db.exec(`
        CREATE TABLE quota_snapshots (
          id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, provider TEXT NOT NULL, profile_id TEXT NOT NULL, account_key TEXT,
          bucket TEXT NOT NULL, window_id TEXT NOT NULL, used_percent REAL NOT NULL, resets_at TEXT, window_duration_mins INTEGER,
          credits_json TEXT, plan_type TEXT, reliability TEXT NOT NULL CHECK (reliability IN ('reported','projected')),
          source TEXT NOT NULL CHECK (source IN ('provider-event','session-file','probe'))
        );
        CREATE INDEX quota_snapshots_lookup ON quota_snapshots(account_key, provider, bucket, window_id, captured_at);
        CREATE TRIGGER quota_snapshots_no_update BEFORE UPDATE ON quota_snapshots BEGIN SELECT RAISE(ABORT, 'quota_snapshots é append-only'); END;
        CREATE TRIGGER quota_snapshots_no_delete BEFORE DELETE ON quota_snapshots BEGIN SELECT RAISE(ABORT, 'quota_snapshots é append-only'); END;
        ALTER TABLE agent_profiles ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'unknown' CHECK (billing_mode IN ('subscription','api','credits','unknown'));
        ALTER TABLE agent_profiles ADD COLUMN account_key TEXT;
        INSERT INTO quota_snapshots(id, captured_at, provider, profile_id, bucket, window_id, used_percent, resets_at, reliability, source)
          SELECT lower(hex(randomblob(16))), s.captured_at, p.provider, s.profile_id, s.window, s.window, s.utilization, s.resets_at, 'reported', 'provider-event'
          FROM agent_usage_snapshots s JOIN agent_profiles p ON p.id = s.profile_id;
      `)
    }
  },
  {
    version: 33,
    checksum: 'sha256:gearmod-approval-records-v33-2026-10-28',
    up(db) {
      db.exec(`
        CREATE TABLE approval_records (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_ref TEXT NOT NULL, op_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
          requested_actor TEXT NOT NULL CHECK (requested_actor IN ('agent','system','user')), run_id TEXT, card_id TEXT, project_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('requested','approved','denied','expired')),
          decided_by TEXT CHECK (decided_by IS NULL OR decided_by = 'user'), decided_at TEXT, note TEXT,
          requested_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
        );
        CREATE INDEX approval_records_pending ON approval_records(status, expires_at);
      `)
    }
  },
  {
    version: 34,
    checksum: 'sha256:gearmod-quota-account-key-v34-2026-10-28',
    up(db) {
      db.exec(`CREATE INDEX quota_snapshots_profile_lookup ON quota_snapshots(profile_id, provider, bucket, captured_at);
        CREATE INDEX agent_profiles_account_key ON agent_profiles(account_key) WHERE account_key IS NOT NULL;`)
    }
  },
  {
    version: 35,
    checksum: 'sha256:gearmod-effective-model-v35-2026-10-29',
    up(db) { db.exec('ALTER TABLE runs ADD COLUMN model_effective TEXT;') }
  },
  {
    version: 36,
    checksum: 'sha256:gearmod-billing-hint-commit-approval-v36-2026-10-29',
    up(db) {
      db.exec(`ALTER TABLE agent_profiles ADD COLUMN api_key_source_hint TEXT;
        ALTER TABLE git_commit_requests ADD COLUMN approval_id TEXT;`)
    }
  },
  {
    version: 37,
    checksum: 'sha256:gearmod-env-passthrough-v37-2026-10-29',
    up(db) {
      db.exec(`ALTER TABLE agent_profiles ADD COLUMN env_passthrough TEXT NOT NULL DEFAULT '[]';`)
      // The migration result must not depend on the machine's environment at upgrade time: it does not read environment variables.
      // Whoever uses an API key from the environment declares the variable in the agent profile (envPassthrough).
    }
  },
  {
    version: 38,
    checksum: 'sha256:gearmod-db-manager-v38-2026-10-29',
    up(db) {
      db.exec(`CREATE TABLE db_connections (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, klass TEXT NOT NULL CHECK(klass IN ('dev','test','prod','external')),
        host TEXT NOT NULL, port INTEGER NOT NULL, database_name TEXT NOT NULL, username TEXT NOT NULL,
        ssl_mode TEXT NOT NULL CHECK(ssl_mode IN ('disable','require','verify-full')),
        has_secret INTEGER NOT NULL DEFAULT 0 CHECK(has_secret IN (0,1)), allow_write INTEGER NOT NULL CHECK(allow_write IN (0,1)),
        agent_access TEXT NOT NULL CHECK(agent_access IN ('none','read')), origin TEXT NOT NULL DEFAULT 'manual', env_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT
      );
      CREATE INDEX db_connections_project ON db_connections(project_id);
      CREATE TABLE db_query_audit (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, sql_hash TEXT NOT NULL, duration_ms INTEGER NOT NULL, rows INTEGER NOT NULL, status TEXT NOT NULL, history_ref TEXT);
      CREATE INDEX db_query_audit_connection ON db_query_audit(connection_id, at);`)
    }
  },
  {
    version: 39,
    checksum: 'sha256:gearmod-mcp-registry-v39-2026-10-30',
    up(db) {
      db.exec(`CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('global','project')),
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, preset_id TEXT, transport TEXT NOT NULL CHECK(transport IN ('stdio','http')),
        command TEXT, args_json TEXT NOT NULL DEFAULT '[]', url TEXT,
        env_keys_json TEXT NOT NULL DEFAULT '[]', header_keys_json TEXT NOT NULL DEFAULT '[]',
        providers_json TEXT NOT NULL DEFAULT '["claude","codex"]', enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX mcp_servers_project ON mcp_servers(project_id);
      CREATE TABLE mcp_project_disabled (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        PRIMARY KEY (project_id, server_id)
      );`)
    }
  },
  {
    version: 40,
    checksum: 'sha256:gearmod-db-server-parent-v40-2026-10-30',
    up(db) {
      // Server = root connection (null parent_id); database = child connection that inherits the server's host, user, SSL, environment and password.
      db.exec(`ALTER TABLE db_connections ADD COLUMN parent_id TEXT REFERENCES db_connections(id) ON DELETE CASCADE;
      CREATE INDEX db_connections_parent ON db_connections(parent_id);`)
    }
  },
  {
    version: 41,
    checksum: 'sha256:gearmod-db-server-first-database-v41-2026-10-30',
    up(db) {
      // The server is only the container: old connections, with no database inside, now show their own database as a child.
      const roots = db.prepare(`SELECT * FROM db_connections r WHERE r.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM db_connections c WHERE c.parent_id = r.id)`).all() as Array<Record<string, unknown>>
      const insert = db.prepare(`INSERT INTO db_connections(id,project_id,parent_id,name,klass,host,port,database_name,username,ssl_mode,has_secret,allow_write,agent_access,origin,env_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`)
      for (const row of roots) insert.run(randomUUID(), row.project_id, row.id, row.database_name, row.klass, row.host, row.port, row.database_name, row.username, row.ssl_mode, row.allow_write, row.agent_access, row.origin, row.env_id, row.created_at, row.updated_at)
    }
  },
  {
    version: 42,
    checksum: 'sha256:gearmod-card-types-v42-2026-10-31',
    up(db) {
      // Card types configurable per project (JSON; null = follows the default list). "Tarefa pequena" stops being a type: it becomes the short flow.
      db.exec(`ALTER TABLE projects ADD COLUMN card_types TEXT;
      UPDATE cards SET workflow = 'light' WHERE type = 'minor' AND workflow IS NULL;
      UPDATE cards SET type = 'improvement' WHERE type IN ('minor', 'task');`)
    }
  },
  {
    version: 43,
    checksum: 'sha256:gearmod-external-worktree-v43-2026-11-06',
    up(db) {
      // A worktree the user made by hand and the card adopted: GearMod never deletes its folder or its branch.
      db.exec('ALTER TABLE worktrees ADD COLUMN external INTEGER NOT NULL DEFAULT 0;')
    }
  },
  {
    version: 44,
    checksum: 'sha256:gearmod-excluded-repos-v44-2026-11-06',
    up(db) {
      // Repositories the user took out of a project: the project folder is rescanned and would otherwise bring them back.
      db.exec(`CREATE TABLE project_excluded_repos (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        local_path TEXT NOT NULL,
        PRIMARY KEY (project_id, local_path)
      );`)
    }
  },
  {
    version: 45,
    checksum: 'sha256:gearmod-backlog-into-todo-v45-2026-11-06',
    up(db) {
      // Backlog and To do become a single "To do" column. Its cards go to the end of To do, the history of moves follows them, and the column goes away.
      const projects = db.prepare('SELECT id FROM projects').all() as { id: string }[]
      const find = (projectId: string, state: string): { id: string; sortOrder: number; isDefault: number } | undefined =>
        db.prepare('SELECT id, sort_order AS sortOrder, is_default AS isDefault FROM board_columns WHERE project_id = ? AND semantic_state = ?').get(projectId, state) as { id: string; sortOrder: number; isDefault: number } | undefined
      for (const { id: projectId } of projects) {
        const backlog = find(projectId, 'backlog'), todo = find(projectId, 'todo')
        if (!backlog) continue
        if (!todo) { db.prepare(`UPDATE board_columns SET semantic_state = 'todo', label = 'To do' WHERE id = ?`).run(backlog.id); continue }
        const offset = (db.prepare('SELECT COALESCE(MAX(order_key), 0) + 1024 FROM cards WHERE column_id = ?').pluck().get(todo.id) as number)
        db.prepare('UPDATE cards SET column_id = ?, order_key = order_key + ? WHERE column_id = ?').run(todo.id, offset, backlog.id)
        db.prepare('UPDATE column_history SET from_column_id = ? WHERE from_column_id = ?').run(todo.id, backlog.id)
        db.prepare('UPDATE column_history SET to_column_id = ? WHERE to_column_id = ?').run(todo.id, backlog.id)
        if (backlog.isDefault) db.prepare('UPDATE board_columns SET is_default = 1 WHERE id = ?').run(todo.id)
        db.prepare('DELETE FROM board_columns WHERE id = ?').run(backlog.id)
        db.prepare('UPDATE board_columns SET sort_order = sort_order - 1 WHERE project_id = ? AND sort_order > ?').run(projectId, backlog.sortOrder)
      }
    }
  },
  {
    version: 46,
    checksum: 'sha256:gearmod-mcp-sse-v46-2026-11-06',
    up(db) {
      // A remote MCP server can speak SSE (the older remote transport) instead of streamable HTTP.
      db.exec('ALTER TABLE mcp_servers ADD COLUMN sse INTEGER NOT NULL DEFAULT 0;')
    }
  },
  {
    version: 47,
    checksum: 'sha256:gearmod-source-base-branch-v47-2026-11-07',
    up(db) {
      // Each repository has its own base branch: new card worktrees start from its latest version. Empty follows the current branch, as before.
      db.exec('ALTER TABLE project_sources ADD COLUMN base_branch TEXT;')
    }
  },
  {
    version: 48,
    checksum: 'sha256:gearmod-test-run-repos-v48-2026-11-09',
    up(db) {
      // Automated tests run one command per repository the card changed: the result of each one, as JSON.
      db.exec("ALTER TABLE test_runs ADD COLUMN repos_json TEXT NOT NULL DEFAULT '[]';")
    }
  },
  {
    version: 49,
    checksum: 'sha256:gearmod-commit-request-amend-v49-2026-11-09',
    up(db) {
      // An agent commit request can amend the last commit of the card branch instead of creating a new one.
      db.exec('ALTER TABLE git_commit_requests ADD COLUMN amend INTEGER NOT NULL DEFAULT 0;')
    }
  },
  {
    version: 50,
    checksum: 'sha256:gearmod-card-finalized-v50-2026-11-10',
    up(db) {
      // The user finalized the card: runs that ended before this no longer show as paused, failed or finished.
      db.exec('ALTER TABLE cards ADD COLUMN finalized_at TEXT;')
    }
  },
  {
    version: 51,
    checksum: 'sha256:gearmod-assessment-limits-v51-2026-11-11',
    up(db) {
      // The simple/medium/complex limits each assessment was scored with (null for the ones before this version).
      db.exec('ALTER TABLE card_assessments ADD COLUMN limits_json TEXT;')
    }
  },
  {
    version: 52,
    checksum: 'sha256:gearmod-card-attachments-v52-2026-11-10',
    up(db) {
      // Card attachments: the app keeps its own copy of each file (relative_path inside the attachments folder); the same content is not kept twice per card.
      db.exec(`ALTER TABLE card_attachments ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE card_attachments ADD COLUMN source_message_id TEXT;
      ALTER TABLE card_attachments ADD COLUMN original_path TEXT;
      CREATE UNIQUE INDEX card_attachments_card_checksum ON card_attachments(card_id, checksum);
      CREATE INDEX card_attachments_card ON card_attachments(card_id, created_at);`)
    }
  }
]

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0
