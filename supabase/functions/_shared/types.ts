export type IntentType =
  | "create_reminder"
  | "create_list"
  | "add_to_list"
  | "complete_list_item"
  | "remove_list_item"
  | "create_task"
  | "complete_task"
  | "create_memory_bubble"
  | "query_park"
  | "query_office"
  | "store_file"
  | "retrieve_file"
  | "calendar_query"
  | "calendar_create"
  | "cancel_reminder"
  | "list_reminders"
  | "pause_reminder"
  | "resume_reminder"
  | "update_reminder"
  | "add_pre_notifications"
  | "help"
  | "unknown";

export type ReminderKind =
  | "static"
  | "recurring"
  | "dynamic"
  | "conditional"
  | "escalation"
  | "composite";

export type ReminderStatus =
  | "scheduled"
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export type JobStatus =
  | "pending"
  | "in_flight"
  | "delivered"
  | "failed"
  | "dead_letter";

export type ConditionPredicateType =
  | "task_not_completed"
  | "list_item_not_completed"
  | "calendar_resource_busy"
  | "calendar_resource_free"
  | "time_window_reached_without_completion";

export type EscalationPolicy =
  | "recur_until_completed"
  | "repeat_after_delay";

export type StopConditionType =
  | "task_completed"
  | "list_item_completed"
  | "user_acknowledged"
  | "max_attempts_reached"
  | "until_datetime_reached";

export type TemplateId =
  | "daily_briefing"
  | "tomorrow_agenda"
  | "weekly_review"
  | "pending_tasks"
  | "next_calendar_event"
  | "stale_followup";

export type ListItemStatus = "pending" | "completed";

export type TaskStatus = "pending" | "completed" | "cancelled";

export interface ConditionPredicate {
  predicate_type: ConditionPredicateType;
  params: Record<string, unknown>;
}

export interface EscalationRule {
  policy: EscalationPolicy;
  interval_minutes?: number;

  recurrence_rule?: string;
  max_attempts?: number;
}

export interface StopCondition {
  type: StopConditionType;
  params: Record<string, unknown>;
}

export interface PreNotification {
  lead_time_minutes: number;
  content_template: string;
}

export interface ThenActionSingle {
  type: "send_message" | "create_reminder";
  content?: string;
  kind?: ReminderKind;

  next_trigger_at?: string;

  recurrence_rule?: string;
  escalation_rule?: EscalationRule;
  stop_condition?: StopCondition;
  linked_task_id?: string;
  linked_list_item_id?: string;
  template_id?: TemplateId;
  template_params?: Record<string, unknown>;
}

export interface ThenActionBranched {
  branch_true: ThenActionSingle;
  branch_false: ThenActionSingle;
}

export type ThenAction = ThenActionSingle | ThenActionBranched;

export interface IntentEntities {
  content?: string;

  trigger_at?: string;

  recurrence_rule?: string;

  deadline_at?: string;
  condition?: ConditionPredicate;
  then_action?: ThenAction;

  re_evaluation_rule?: string;
  escalation_rule?: EscalationRule;
  stop_condition?: StopCondition;
  pre_notifications?: PreNotification[];

  components?: IntentEnvelope[];
  template_id?: TemplateId;
  template_params?: Record<string, unknown>;
  list_name?: string;
  tags?: string[];

  short_id?: string;
  task_id?: string;
  list_item_id?: string;
  list_id?: string;
  reminder_id?: string;

  reply_text?: string;

  context_updates?: Array<{ category: string; key: string; value: string }>;

  lead_times_days?: number[];

  trigger_at_confidence?: "explicit" | "inferred" | "none";

  events?: Array<{
    title: string;

    trigger_at: string;

    ends_at?: string;
    location?: string;
    tags?: string[];
  }>;
}

export interface IntentEnvelope {
  intent: IntentType;

  confidence: number;
  raw_text?: string;
  reminder_kind?: ReminderKind;
  entities: IntentEntities;

  language?: string;
}

export interface OwnerRow {
  id: number;
  chat_id: number;
  display_name: string | null;

  timezone: string;

  language: string;

  tz_confirmed: boolean;

  tz_prompt_sent: boolean;

  created_at: string;
}

export interface DynamicTemplateRow {
  id: TemplateId;
  description: string;
  param_schema: Record<string, unknown>;

  resolver: string;
}

export interface ReminderRow {
  id: string;
  kind: ReminderKind;
  status: ReminderStatus;
  content: string | null;
  raw_text: string | null;

  recurrence_rule: string | null;

  start_at: string | null;

  next_trigger_at: string | null;

  deadline_at: string | null;

  timezone: string;
  condition: ConditionPredicate | null;
  then_action: ThenAction | null;

  re_evaluation_rule: string | null;
  escalation_rule: EscalationRule | null;
  stop_condition: StopCondition | null;

  attempt_count: number;

  parent_reminder_id: string | null;
  template_id: TemplateId | null;
  template_params: Record<string, unknown> | null;

  linked_task_id: string | null;

  linked_list_item_id: string | null;

  created_at: string;

  updated_at: string;
}

export interface JobOutboxRow {
  id: string;

  reminder_id: string;

  occurrence_at: string;
  idempotency_key: string;
  status: JobStatus;
  attempts: number;

  next_attempt_at: string;
  last_error: string | null;

  in_flight_until: string | null;

  delivered_at: string | null;

  created_at: string;
}

export interface ListRow {
  id: string;
  name: string;

  created_at: string;
}

export interface ListItemRow {
  id: string;

  list_id: string;
  content: string;
  position: number;
  status: ListItemStatus;

  completed_at: string | null;

  created_at: string;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;

  due_at: string | null;

  priority: number;
  tags: string[];
  status: TaskStatus;

  completed_at: string | null;

  created_at: string;
}

export interface MemoryBubbleRow {
  id: string;
  content: string;
  tags: string[];
  source: string | null;
  language: string;
  embedding: number[] | null;

  created_at: string;

  updated_at: string;

  deleted_at: string | null;
}

export interface TrunkObjectRow {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  tags: string[];

  storage_path: string;

  created_at: string;
}

export interface AuditLogRow {
  id: number;
  event_type: string;
  payload: Record<string, unknown>;

  created_at: string;
}

export interface InboundMessageRow {
  id: number;
  telegram_update: Record<string, unknown>;
  raw_text: string | null;
  intent_envelope: IntentEnvelope | null;

  processed_at: string | null;

  created_at: string;
}

export interface NlpContext {
  now: string;

  timezone: string;
  list_names: string[];
  pending_short_items: Array<{
    short_id: string;
    kind: "reminder" | "task";
    title: string;

    next_trigger_at?: string;

    due_at?: string;
  }>;

  upcoming_events?: Array<{ title: string; starts_at: string }>;

  stale_reminders?: string[];

  owner_context?: Array<{ category: string; key: string; value: string }>;
}

export interface EventRow {
  id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}
