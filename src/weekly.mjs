import { planDay } from './scheduler.mjs';

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export function planWeek(input, state = { progress: [] }) {
  validateWeekInput(input, state);
  validatePriorPlanScope(input, state);

  const { totals: observedMinutes, preWeek, byDate } = observedProgress(
    state.progress, state.plans ?? [], input.days[0].date);
  const taskMap = new Map(input.tasks.map((task) => [task.id, task]));
  for (const taskId of observedMinutes.keys()) {
    if (!taskMap.has(taskId)) throw new Error(`Observed progress references unknown task: ${taskId}`);
  }

  const scheduledMinutes = new Map(observedMinutes);
  const prerequisiteMinutes = new Map(preWeek);
  const days = [];
  const tentativeAllocations = [];

  for (let index = 0; index < input.days.length; index += 1) {
    const dayInput = input.days[index];
    const observedToday = byDate.get(dayInput.date) ?? new Map();
    addObserved(prerequisiteMinutes, observedToday);
    const observedTodayMinutes = sumMap(observedToday);
    const dailyCapacity = dayInput.rest ? 0 : Math.floor(dayInput.availableMinutes * 0.9);
    const tentativeCapacity = Math.max(0, dailyCapacity - observedTodayMinutes);
    const day = planDay({
      date: dayInput.date,
      availableMinutes: availableMinutesForAllocatable(tentativeCapacity),
      rest: dayInput.rest ?? false,
      tasks: forecastTasks(input.tasks, scheduledMinutes, prerequisiteMinutes),
      completedTaskIds: completedTaskIds(input.tasks, prerequisiteMinutes),
      remainingStudyMinutes: remainingStudyMinutes(input.tasks, scheduledMinutes),
      nextTwoDaysReviewMinutes: input.nextTwoDaysReviewMinutes ?? null,
      planVersion: (input.planVersion ?? 1) + index,
    });

    const dayTentative = [];
    for (const allocation of day.allocations) {
      const currentScheduled = scheduledMinutes.get(allocation.taskId) ?? 0;
      const currentPrerequisite = prerequisiteMinutes.get(allocation.taskId) ?? 0;
      scheduledMinutes.set(allocation.taskId, currentScheduled + allocation.minutes);
      prerequisiteMinutes.set(allocation.taskId, currentPrerequisite + allocation.minutes);
      const forecast = {
        date: day.date,
        planVersion: day.planVersion,
        taskId: allocation.taskId,
        title: allocation.title,
        kind: allocation.kind,
        minutes: allocation.minutes,
        status: 'tentative',
      };
      dayTentative.push(forecast);
      tentativeAllocations.push(forecast);
    }

    days.push({
      ...day,
      availableMinutes: dayInput.availableMinutes,
      allocatableMinutes: dailyCapacity,
      slackMinutes: dayInput.availableMinutes - dailyCapacity,
      observedTodayMinutes,
      allocations: day.allocations.map((allocation) => ({ ...allocation, status: 'tentative' })),
      tentativeAllocations: dayTentative,
    });
  }

  const deferredScope = buildDeferredScope(input.tasks, scheduledMinutes, days);
  const goalCoverageStatus = deferredScope.length === 0 ? 'within_week' : 'deferred';

  return {
    startDate: input.days[0].date,
    endDate: input.days[input.days.length - 1].date,
    days,
    observedProgress: [...observedMinutes.entries()].map(([taskId, minutes]) => ({ taskId, minutes, status: 'observed' })),
    tentativeAllocations,
    deferredScope,
    totalAvailableMinutes: days.reduce((sum, day) => sum + day.availableMinutes, 0),
    totalAllocatableMinutes: days.reduce((sum, day) => sum + day.allocatableMinutes, 0),
    totalAssignedMinutes: days.reduce((sum, day) => sum + day.assignedMinutes, 0),
    totalObservedCompletedMinutes: sumMap(observedMinutes),
    totalTentativeMinutes: tentativeAllocations.reduce((sum, allocation) => sum + allocation.minutes, 0),
    goalCoverageStatus,
    warning: goalCoverageStatus === 'deferred'
      ? '임시 진행안: 주간 계획 뒤에도 미배정 범위가 남아 있습니다.'
      : null,
  };
}

function validateWeekInput(input, state) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (!Array.isArray(input.days) || input.days.length === 0) throw new TypeError('days must be a non-empty array');
  if (!Array.isArray(input.tasks)) throw new TypeError('tasks must be an array');
  if (!state || !Array.isArray(state.progress)) throw new TypeError('state.progress must be an array');
  if (state.plans !== undefined && !Array.isArray(state.plans)) throw new TypeError('state.plans must be an array');
  if (input.completedTaskIds !== undefined) {
    throw new TypeError('weekly plan derives completedTaskIds from recorded progress');
  }
  if (input.nextTwoDaysReviewMinutes !== undefined && input.nextTwoDaysReviewMinutes !== null) {
    validateMinute(input.nextTwoDaysReviewMinutes, 'nextTwoDaysReviewMinutes', { allowZero: true });
  }
  if (input.planVersion !== undefined) validateMinute(input.planVersion, 'planVersion');

  const dates = new Set();
  let previousDate = null;
  for (const day of input.days) {
    if (!day || typeof day !== 'object') throw new TypeError('day must be an object');
    validateDate(day.date, 'day.date');
    if (dates.has(day.date)) throw new TypeError(`duplicate day date: ${day.date}`);
    if (previousDate !== null && day.date <= previousDate) throw new TypeError('days must be in ascending date order');
    dates.add(day.date);
    previousDate = day.date;
    validateMinute(day.availableMinutes, `availableMinutes for ${day.date}`, { allowZero: true });
    if (day.rest !== undefined && typeof day.rest !== 'boolean') throw new TypeError(`rest must be boolean for ${day.date}`);
  }
}

function validatePriorPlanScope(input, state) {
  const providedTaskIds = new Set(input.tasks.map((task) => task?.id));
  const originalMinutes = new Map();
  for (const plan of state.plans ?? []) {
    const planTotals = new Map();
    for (const item of [...(plan.allocations ?? []), ...(plan.deferred ?? [])]) {
      if (!providedTaskIds.has(item.taskId)) {
        throw new Error(`Prior task missing from weekly input: ${item.taskId}`);
      }
      planTotals.set(item.taskId, (planTotals.get(item.taskId) ?? 0) + item.minutes);
    }
    for (const [taskId, minutes] of planTotals) {
      if (!Number.isSafeInteger(minutes)) throw new Error(`Invalid prior task estimate: ${taskId}`);
      if (!originalMinutes.has(taskId)) originalMinutes.set(taskId, minutes);
    }
  }

  const inputTasks = new Map(input.tasks.map((task) => [task.id, task]));
  for (const [taskId, minutes] of originalMinutes) {
    if (inputTasks.get(taskId).minutes !== minutes) {
      throw new Error(`Input differs from original task estimate: ${taskId}`);
    }
  }
}

function observedProgress(progress, plans, startDate) {
  const totals = new Map();
  const preWeek = new Map();
  const byDate = new Map();
  const eventsById = new Map();
  const planDates = new Map(plans.map((plan) => [plan.planVersion, plan.date]));
  for (const event of progress) {
    if (!event || event.type !== 'task_progress_recorded') continue;
    if (typeof event.id !== 'string' || event.id.length === 0) throw new TypeError('progress id is required');
    const previous = eventsById.get(event.id);
    if (previous !== undefined) {
      if (canonical(previous) !== canonical(event)) throw new Error(`Duplicate progress event id: ${event.id}`);
      throw new Error(`Duplicate progress event id: ${event.id}`);
    }
    eventsById.set(event.id, event);
    if (event.learnerConfirmed !== true) continue;
    if (typeof event.taskId !== 'string' || event.taskId.length === 0) throw new TypeError('progress taskId is required');
    validateMinute(event.completedMinutes, `completedMinutes for ${event.taskId}`);
    totals.set(event.taskId, (totals.get(event.taskId) ?? 0) + event.completedMinutes);
    const date = planDates.get(event.planVersion);
    const bucket = date === undefined || date < startDate ? preWeek : mapForDate(byDate, date);
    bucket.set(event.taskId, (bucket.get(event.taskId) ?? 0) + event.completedMinutes);
  }
  return { totals, preWeek, byDate };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function forecastTasks(tasks, scheduledMinutes, prerequisiteMinutes) {
  return tasks.map((task) => {
    const scheduled = scheduledMinutes.get(task.id) ?? 0;
    if (scheduled < 0 || scheduled > task.minutes) {
      throw new Error(`Progress exceeds task estimate: ${task.id}`);
    }
    const prerequisiteCredit = prerequisiteMinutes.get(task.id) ?? 0;
    if (scheduled === task.minutes && prerequisiteCredit < task.minutes) {
      return { ...task, ready: false };
    }
    return scheduled === task.minutes ? task : { ...task, minutes: task.minutes - scheduled };
  });
}

function addObserved(projectedMinutes, observed) {
  for (const [taskId, minutes] of observed) {
    projectedMinutes.set(taskId, (projectedMinutes.get(taskId) ?? 0) + minutes);
  }
}

function availableMinutesForAllocatable(allocatableMinutes) {
  if (allocatableMinutes === 0) return 0;
  return Math.ceil(allocatableMinutes / 0.9);
}

function mapForDate(byDate, date) {
  const current = byDate.get(date);
  if (current !== undefined) return current;
  const created = new Map();
  byDate.set(date, created);
  return created;
}

function sumMap(map) {
  return [...map.values()].reduce((sum, minutes) => sum + minutes, 0);
}

function completedTaskIds(tasks, projectedMinutes) {
  return tasks
    .filter((task) => (projectedMinutes.get(task.id) ?? 0) === task.minutes)
    .map((task) => task.id);
}

function remainingStudyMinutes(tasks, projectedMinutes) {
  return tasks.reduce((sum, task) => sum + Math.max(0, task.minutes - (projectedMinutes.get(task.id) ?? 0)), 0);
}

function buildDeferredScope(tasks, projectedMinutes, days) {
  const lastReasons = new Map();
  for (const day of days) {
    for (const item of day.deferred) {
      lastReasons.set(item.taskId, item.reason);
    }
  }
  return tasks.flatMap((task) => {
    const remaining = task.minutes - (projectedMinutes.get(task.id) ?? 0);
    if (remaining <= 0) return [];
    return [{
      taskId: task.id,
      title: task.title,
      kind: task.kind,
      minutes: remaining,
      reason: lastReasons.get(task.id) ?? 'unscheduled',
    }];
  });
}

function validateMinute(value, name, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a finite safe integer`);
  if (allowZero ? value < 0 : value <= 0) throw new RangeError(`${name} must be ${allowZero ? 'nonnegative' : 'positive'}`);
}

function validateDate(value, name) {
  if (typeof value !== 'string' || !isoDatePattern.test(value)) throw new TypeError(`${name} must be an ISO date`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${name} must be a valid ISO date`);
  }
}
