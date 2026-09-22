const evidenceTypes = new Set(['observed_attempt', 'self_reported_reading', 'self_reported_external_upload', 'unobserved']);
const assistanceTypes = new Set(['none', 'hint', 'solution', 'unknown']);
const eventFields = {
  plan_created: ['plan'],
  attempt_recorded: ['taskId', 'planVersion', 'evidenceType', 'assistanceExposure', 'sourceVersion', 'response'],
  feedback_received: ['taskId', 'planVersion', 'text', 'sourceStatus'],
  notification_observed: ['notificationId', 'deliveryStatus', 'openedAt'],
  noncompletion_confirmed: ['taskId', 'planVersion', 'confirmed'],
};

export function emptyState() {
  return { schemaVersion: 1, events: [], currentPlan: null, plans: [], attempts: [],
    feedback: [], notifications: [], noncompletion: [] };
}

function text(value, field, maximum = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`Invalid ${field}`);
}

function timestamp(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10))
    throw new Error('Invalid timestamp');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function validatePlan(plan, state) {
  if (!plan || !Number.isSafeInteger(plan.planVersion) || plan.planVersion !== (state.currentPlan?.planVersion ?? 0) + 1)
    throw new Error('Plan version must advance by one');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.date) || new Date(`${plan.date}T00:00:00Z`).toISOString().slice(0, 10) !== plan.date)
    throw new Error('Invalid plan date');
  for (const name of ['availableMinutes', 'allocatableMinutes', 'assignedMinutes', 'slackMinutes']) {
    if (!Number.isSafeInteger(plan[name]) || plan[name] < 0) throw new Error(`Invalid plan ${name}`);
  }
  if (plan.assignedMinutes > plan.allocatableMinutes || plan.allocatableMinutes + plan.slackMinutes > plan.availableMinutes)
    throw new Error('Plan exceeds time budget');
  if (![0, Math.floor(plan.availableMinutes * 0.9)].includes(plan.allocatableMinutes)
    || plan.allocatableMinutes + plan.slackMinutes !== plan.availableMinutes) throw new Error('Invalid policy budget');
  if (!Array.isArray(plan.allocations) || !Array.isArray(plan.deferred) || !Array.isArray(plan.exceptions))
    throw new Error('Invalid plan collections');
  const seen = new Set();
  let total = 0;
  for (const item of plan.allocations) {
    text(item.taskId, 'taskId');
    text(item.title, 'title');
    if (seen.has(item.taskId) || !['new', 'review'].includes(item.kind)
      || !Number.isSafeInteger(item.minutes) || item.minutes <= 0) throw new Error('Invalid plan allocation');
    seen.add(item.taskId);
    total += item.minutes;
  }
  if (total !== plan.assignedMinutes) throw new Error('Plan assigned time mismatch');
}

export function applyEvent(state, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event');
  text(event.id, 'event id', 200);
  timestamp(event.at);
  if (!Object.hasOwn(eventFields, event.type)) throw new Error('Unsupported event type');
  const allowed = new Set(['id', 'type', 'at', ...eventFields[event.type]]);
  if (Object.keys(event).some(key => !allowed.has(key))) throw new Error('Unexpected event field');
  const previous = state.events.find(item => item.id === event.id);
  if (previous) {
    if (canonical(previous) !== canonical(event)) throw new Error('Event id conflict');
    return structuredClone(state);
  }
  if (event.type === 'plan_created') validatePlan(event.plan, state);
  if (['attempt_recorded', 'feedback_received', 'noncompletion_confirmed'].includes(event.type)) {
    text(event.taskId, 'taskId');
    const plan = state.plans.find(item => item.planVersion === event.planVersion);
    if (!plan?.allocations.some(item => item.taskId === event.taskId)) throw new Error('Unknown task or plan version');
  }
  if (event.type === 'attempt_recorded') {
    if (!evidenceTypes.has(event.evidenceType)) throw new Error('Invalid evidence type');
    if (!assistanceTypes.has(event.assistanceExposure)) throw new Error('Invalid assistance exposure');
    if (event.sourceVersion !== null) text(event.sourceVersion, 'source version');
    if (typeof event.response !== 'string' || event.response.length > 50000) throw new Error('Invalid response');
  }
  if (event.type === 'feedback_received') {
    text(event.text, 'feedback text', 50000);
    if (!['ready', 'needs_review', 'unknown', 'conflict'].includes(event.sourceStatus)) throw new Error('Invalid source status');
  }
  if (event.type === 'notification_observed') {
    text(event.notificationId, 'notification id');
    if (!['unknown', 'sent', 'confirmed', 'failed'].includes(event.deliveryStatus)) throw new Error('Invalid delivery status');
    if (event.openedAt !== null) timestamp(event.openedAt);
  }
  if (event.type === 'noncompletion_confirmed' && event.confirmed !== true) throw new Error('Explicit confirmation required');
  const next = structuredClone(state);
  const saved = structuredClone(event);
  next.events.push(saved);
  switch (saved.type) {
    case 'plan_created':
      next.currentPlan = saved.plan;
      next.plans.push(saved.plan);
      next.feedback = next.feedback.map(item => ({ ...item, eligibleForCurrentPlan: false, reason: 'stale_plan' }));
      break;
    case 'attempt_recorded': next.attempts.push(saved); break;
    case 'feedback_received': {
      const reason = saved.planVersion !== next.currentPlan.planVersion ? 'stale_plan'
        : saved.sourceStatus !== 'ready' ? 'unverified_source' : 'current_source_claim';
      // Eligibility is a guard result, never automatic grading or plan mutation.
      next.feedback.push({ ...saved, eligibleForCurrentPlan: reason === 'current_source_claim', reason });
      break;
    }
    case 'notification_observed': next.notifications.push(saved); break;
    case 'noncompletion_confirmed': next.noncompletion.push(saved); break;
  }
  return next;
}
