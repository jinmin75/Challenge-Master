// Month calendar and automatic study check (PRD 6.1, D019·D020). Read-only over the event state.
import { creditedTaskMinutes, originalTaskMinutes } from './events.mjs';

export const SIGNAL_RUN_DAYS = 2;
export const OVERDUE_REVIEW_DAYS = 3;
export const SHORT_START_MINUTES = 15;

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function monthDates(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('month는 YYYY-MM 형식이어야 합니다.');
  const dates = [];
  for (let date = `${month}-01`; date.startsWith(month); date = addDays(date, 1)) dates.push(date);
  return dates;
}

function plansByDate(state) {
  const byDate = new Map();
  for (const plan of state.plans) {
    if (!byDate.has(plan.date)) byDate.set(plan.date, []);
    byDate.get(plan.date).push(plan);
  }
  return byDate;
}

function sumBy(items, keyOf, valueOf) {
  const totals = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key !== undefined) totals.set(key, (totals.get(key) ?? 0) + valueOf(item));
  }
  return totals;
}

function isRestPlan(plan) {
  return plan.allocatableMinutes === 0 && plan.deferred.some(item => item.reason === 'rest_day');
}

// Tasks the learner may backfill: those already planned, with minutes still uncredited.
export function backfillableTasks(state) {
  const seen = new Map();
  for (const plan of state.plans) {
    for (const item of [...plan.allocations, ...plan.deferred]) {
      if (seen.has(item.taskId)) continue;
      const title = item.title ?? plan.allocations.find(entry => entry.taskId === item.taskId)?.title ?? item.taskId;
      seen.set(item.taskId, { taskId: item.taskId, title, kind: item.kind ?? null });
    }
  }
  return [...seen.values()].map(task => ({
    ...task,
    remainingMinutes: originalTaskMinutes(state, task.taskId) - creditedTaskMinutes(state, task.taskId),
  })).filter(task => task.remainingMinutes > 0);
}

function dayRecord(date, context) {
  const { today, startDate, plans, confirmed, skipped, late, reviews, makeupsOn, makeupsFor, forecastDays } = context;
  const dayPlans = plans.get(date) ?? [];
  const firstPlan = dayPlans[0] ?? null;
  const lastPlan = dayPlans.at(-1) ?? null;
  const record = {
    date,
    confirmedMinutes: confirmed.get(date) ?? 0,
    assignedMinutes: firstPlan ? firstPlan.assignedMinutes : null,
    lateMinutes: late.get(date) ?? 0,
    skippedTasks: skipped.get(date) ?? 0,
    shortened: Boolean(firstPlan && lastPlan && lastPlan !== firstPlan && !isRestPlan(lastPlan)
      && lastPlan.availableMinutes < firstPlan.availableMinutes),
    makeupMinutes: makeupsOn.get(date) ?? 0,
    makeupScheduledFor: makeupsFor.get(date) ?? 0,
    review: reviews.get(date) ?? null,
    plannedMinutes: null,
    state: null,
  };
  if (date > today) {
    const day = forecastDays.get(date);
    record.plannedMinutes = day ? day.assignedMinutes : null;
    record.state = 'future';
    return record;
  }
  if (startDate === null || date < startDate) {
    record.state = 'before_start';
  } else if (date === today) {
    record.state = lastPlan && isRestPlan(lastPlan) ? 'rest' : 'today';
  } else if (record.review?.status === 'missed') {
    record.state = 'missed';
  } else if (record.review?.status === 'rest' || (lastPlan && isRestPlan(lastPlan) && record.confirmedMinutes === 0)) {
    record.state = 'rest';
  } else if (record.confirmedMinutes > 0) {
    record.state = 'recorded';
  } else if (record.lateMinutes > 0) {
    record.state = 'late';
  } else {
    record.state = 'needs_review';
  }
  return record;
}

function signalsFor(days, context) {
  const signals = [];
  const past = days.filter(day => day.date < context.today && day.state !== 'before_start');
  let run = [];
  let longest = [];
  for (const day of past) {
    if (day.state === 'needs_review' || day.state === 'missed') run.push(day.date);
    else run = [];
    if (run.length > longest.length) longest = [...run];
  }
  if (longest.length >= SIGNAL_RUN_DAYS) {
    signals.push({
      kind: 'gap_run',
      dates: longest,
      message: `기록이 없거나 못 한 날이 ${longest.length}일 이어졌어요. 기록이 없는 날을 안 한 날로 치지는 않아요. `
        + `다시 시작하기 어렵다면 오늘은 ${SHORT_START_MINUTES}분 이하의 짧은 공부 하나부터 해 보세요. 하루 분량은 늘리지 않아요.`,
    });
  }
  const overdue = context.overdueReviews;
  if (overdue.length > 0) {
    signals.push({
      kind: 'overdue_review',
      tasks: overdue,
      message: `복습 ${overdue.length}개가 처음 들어간 날로부터 ${OVERDUE_REVIEW_DAYS}일 넘게 남아 있어요.`,
    });
  }
  if (context.deferredScope > 0) {
    signals.push({
      kind: 'deferred_scope',
      message: '앞으로 7일 뒤에도 못 들어간 공부가 남아 있어요. 하루 시간이나 공부할 것을 바꿀지 생각해 보세요.',
    });
  }
  return signals;
}

function overdueReviews(state, today) {
  const firstPlanned = new Map();
  for (const plan of state.plans) {
    for (const item of plan.allocations) {
      if (item.kind === 'review' && !firstPlanned.has(item.taskId)) firstPlanned.set(item.taskId, { date: plan.date, title: item.title });
    }
  }
  const limit = addDays(today, -OVERDUE_REVIEW_DAYS);
  return [...firstPlanned.entries()]
    .filter(([taskId, first]) => first.date < limit
      && originalTaskMinutes(state, taskId) - creditedTaskMinutes(state, taskId) > 0)
    .map(([taskId, first]) => ({ taskId, title: first.title, firstPlannedDate: first.date }));
}

export function buildCalendar({ state, month, today, startDate, forecast = null }) {
  const planDates = new Map(state.plans.map(plan => [plan.planVersion, plan.date]));
  const context = {
    today,
    startDate: startDate ?? state.plans[0]?.date ?? null,
    plans: plansByDate(state),
    confirmed: sumBy(state.progress, item => planDates.get(item.planVersion), item => item.completedMinutes),
    skipped: sumBy(state.noncompletion.filter(item => item.confirmed === true),
      item => planDates.get(item.planVersion), () => 1),
    late: sumBy(state.lateProgress ?? [], item => item.date, item => item.minutes),
    reviews: new Map((state.dayReviews ?? []).map(item => [item.date, item])),
    makeupsOn: sumBy(state.makeups ?? [], item => item.date, item => item.minutes),
    makeupsFor: sumBy(state.makeups ?? [], item => item.forDate, item => item.minutes),
    forecastDays: new Map((forecast?.days ?? []).map(day => [day.date, day])),
    overdueReviews: overdueReviews(state, today),
    deferredScope: forecast?.deferredScope?.length ?? 0,
  };
  const days = monthDates(month).map(date => dayRecord(date, context));
  const pastDays = days.filter(day => day.date < today && day.state !== 'before_start');
  const count = name => pastDays.filter(day => day.state === name).length;
  const summary = {
    recordedDays: count('recorded'),
    restDays: count('rest'),
    needsReviewDays: count('needs_review'),
    missedDays: count('missed'),
    lateDays: count('late'),
    confirmedMinutes: days.reduce((sum, day) => sum + day.confirmedMinutes, 0),
    assignedMinutes: days.filter(day => day.date <= today && day.assignedMinutes !== null)
      .reduce((sum, day) => sum + day.assignedMinutes, 0),
    lateMinutes: days.reduce((sum, day) => sum + day.lateMinutes, 0),
    makeupMinutes: days.reduce((sum, day) => sum + day.makeupMinutes, 0),
  };
  return {
    month,
    today,
    startDate: context.startDate,
    days,
    summary,
    needsReview: pastDays.filter(day => day.state === 'needs_review').map(day => day.date).reverse(),
    signals: signalsFor(days, context),
    backfillableTasks: backfillableTasks(state),
  };
}
