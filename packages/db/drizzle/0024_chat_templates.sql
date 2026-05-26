-- Quick-reply шаблоны для admin chat (2026-05-27).
--
-- Общий пул на всех админов: любой может добавить/использовать любой
-- шаблон. created_by храним только для аудита; ON DELETE SET NULL,
-- чтобы удаление автора не каскадно убивало шаблон.
--
-- sort_order для drag-and-drop переупорядочивания в будущем. UI
-- использует ASC sort_order, ASC created_at как tiebreaker.

CREATE TABLE IF NOT EXISTS chat_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_templates_order_idx
  ON chat_templates (sort_order, created_at);
