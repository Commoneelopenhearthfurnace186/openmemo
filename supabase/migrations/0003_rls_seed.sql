-- -----------------------------------------------------------------------------
-- Enable RLS
--
-- Diseño "deny-all": habilitamos RLS pero no creamos `CREATE POLICY` alguna.
-- Cross-ref design.md > "Esquema relacional" comentario:
--   "Sin policies => acceso solo a service_role (que bypasea RLS)."
--
-- Nota sobre FORCE ROW LEVEL SECURITY:
--   Se consideró añadir `ALTER TABLE ... FORCE ROW LEVEL SECURITY` como
--   defensa en profundidad, pero se descartó: en algunos contextos de
--   Supabase FORCE puede afectar al rol propietario y romper migraciones o
--   queries administrativas que esperan saltarse RLS. Con `ENABLE` basta
--   porque `service_role` (el único cliente real del backend) ya bypasea
--   RLS y los roles `anon`/`authenticated` quedan bloqueados al no existir
--   policies.
-- -----------------------------------------------------------------------------
ALTER TABLE owner                ENABLE ROW LEVEL SECURITY;
ALTER TABLE dynamic_template     ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder             ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_outbox           ENABLE ROW LEVEL SECURITY;
ALTER TABLE list                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_item            ENABLE ROW LEVEL SECURITY;
ALTER TABLE task                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_bubble        ENABLE ROW LEVEL SECURITY;
ALTER TABLE trunk_object         ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_message      ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Seed dynamic templates
--
-- Las cinco plantillas mínimas exigidas por Req 5.1 y por el enum `TemplateId`
-- del diseño. `param_schema` se inicializa vacío; futuras migraciones podrán
-- ampliarlo cuando alguna plantilla acepte parámetros.
--
-- `ON CONFLICT (id) DO NOTHING` mantiene la inserción idempotente para
-- entornos de desarrollo donde se reaplica el seed.
-- -----------------------------------------------------------------------------
INSERT INTO dynamic_template (id, description, resolver, param_schema) VALUES
  (
    'daily_briefing',
    'Resumen del día actual: agenda, tareas pendientes y notas relevantes.',
    'resolveDailyBriefing',
    '{}'::jsonb
  ),
  (
    'tomorrow_agenda',
    'Agenda completa del día siguiente combinando reminders y eventos del calendario interno.',
    'resolveTomorrowAgenda',
    '{}'::jsonb
  ),
  (
    'weekly_review',
    'Revisión semanal con tareas completadas, pendientes y notas destacadas.',
    'resolveWeeklyReview',
    '{}'::jsonb
  ),
  (
    'pending_tasks',
    'Lista de tareas pendientes ordenadas por due_at y prioridad.',
    'resolvePendingTasks',
    '{}'::jsonb
  ),
  (
    'next_calendar_event',
    'Próximo evento del calendario conectado.',
    'resolveNextCalendarEvent',
    '{}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;
