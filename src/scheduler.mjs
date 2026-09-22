const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const taskKinds = new Set(['new', 'review']);

export function planDay(input) {
  validateInput(input);

  const {
    date,
    availableMinutes,
    tasks,
    completedTaskIds = [],
    rest = false,
    remainingStudyMinutes = null,
    nextTwoDaysReviewMinutes = null,
    planVersion = 1,
  } = input;

  const allocatableMinutes = rest ? 0 : Math.floor(availableMinutes * 0.9);
  const slackMinutes = availableMinutes - allocatableMinutes;
  const completed = new Set(completedTaskIds);
  const normalized = tasks.map((task, index) => normalizeTask(task, index));
  const allocations = [];
  const deferred = [];
  const exceptions = [];

  if (rest) {
    for (const item of normalized) {
      if (!completed.has(item.id)) defer(deferred, item, item.minutes, 'rest_day');
    }
    return buildResult({
      date,
      planVersion,
      availableMinutes,
      allocatableMinutes,
      slackMinutes,
      allocations,
      deferred,
      exceptions,
      goalCoverageStatus: coverageStatus(normalized, completed, remainingStudyMinutes),
    });
  }

  const ready = [];
  let blockedNewCount = 0;
  for (const item of normalized) {
    if (completed.has(item.id)) continue;
    if (item.ready === false) {
      defer(deferred, item, item.minutes, 'not_ready');
      continue;
    }
    const unmet = item.prerequisites.filter((id) => !completed.has(id));
    if (unmet.length > 0) {
      defer(deferred, item, item.minutes, 'prerequisite_blocked');
      if (item.kind === 'new') blockedNewCount += 1;
      continue;
    }
    ready.push(item);
  }

  if (blockedNewCount > 0) {
    exceptions.push('new progress blocked by prerequisite; ready review prioritized with weekly adjustment note');
  }

  const reviewReadyMinutes = sumMinutes(ready.filter((item) => item.kind === 'review'));
  const newReadyMinutes = sumMinutes(ready.filter((item) => item.kind === 'new'));
  const normalNewTarget = Math.ceil(allocatableMinutes * 0.6);
  const normalReviewTarget = allocatableMinutes - normalNewTarget;
  const effectiveNextTwoDaysReviewMinutes = nextTwoDaysReviewMinutes ?? normalReviewTarget * 2;
  const overload = reviewReadyMinutes > effectiveNextTwoDaysReviewMinutes;
  const newProtected = overload ? Math.ceil(allocatableMinutes * 0.4) : normalNewTarget;
  const reviewLimit = overload ? allocatableMinutes - Math.ceil(allocatableMinutes * 0.4) : normalReviewTarget;

  let remaining = allocatableMinutes;
  const used = new Map();

  const indivisible = sortTasks(ready.filter((item) => item.splittable === false), date);
  for (const item of indivisible) {
    if (item.minutes > allocatableMinutes) {
      defer(deferred, item, item.minutes, 'over_budget');
      used.set(item.id, 0);
      continue;
    }
    if (item.minutes > remaining) continue;
    const categoryFloorNeedsProtection =
      item.kind === 'review' && newReadyMinutes > allocatedKindMinutes(allocations, 'new');
    const wouldExceedCategoryLimit =
      allocatedKindMinutes(allocations, item.kind) + item.minutes > categoryLimit(item.kind, newProtected, reviewLimit);
    if (categoryFloorNeedsProtection && wouldExceedCategoryLimit) {
      continue;
    }
    addAllocation(allocations, item, item.minutes);
    used.set(item.id, item.minutes);
    remaining -= item.minutes;
    if (item.minutes > categoryLimit(item.kind, newProtected, reviewLimit)) {
      exceptions.push(`indivisible task ${item.id} exceeded ${item.kind} ratio; weekly adjustment required`);
    }
  }

  if (remaining > 0 && newReadyMinutes > 0) {
    const currentNew = allocatedKindMinutes(allocations, 'new');
    const targetNew = Math.min(newProtected, newReadyMinutes);
    remaining = allocateFromKind({
      source: sortTasks(ready.filter((item) => item.kind === 'new' && item.splittable === true), date),
      allocations,
      used,
      remaining,
      targetAdditional: Math.max(0, targetNew - currentNew),
    });
  }

  if (remaining > 0) {
    const currentReview = allocatedKindMinutes(allocations, 'review');
    const reviewAdditionalLimit = Math.max(0, reviewLimit - currentReview);
    remaining = allocateFromKind({
      source: sortTasks(ready.filter((item) => item.kind === 'review' && item.splittable === true), date),
      allocations,
      used,
      remaining,
      targetAdditional: reviewAdditionalLimit,
    });
  }

  if (remaining > 0) {
    remaining = allocateFromKind({
      source: sortTasks(ready.filter((item) => item.splittable === true), date),
      allocations,
      used,
      remaining,
      targetAdditional: remaining,
    });
  }

  for (const item of ready) {
    const assigned = used.get(item.id) ?? 0;
    const unscheduled = item.minutes - assigned;
    if (unscheduled > 0 && !alreadyDeferred(deferred, item.id)) {
      defer(deferred, item, unscheduled, assigned === 0 ? 'capacity' : 'partial_capacity');
    }
  }

  return buildResult({
    date,
    planVersion,
    availableMinutes,
    allocatableMinutes,
    slackMinutes,
    allocations,
    deferred,
    exceptions,
    goalCoverageStatus: coverageStatus(normalized, completed, remainingStudyMinutes),
  });
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  validateDate(input.date, 'date');
  validateMinute(input.availableMinutes, 'availableMinutes', { allowZero: true });
  if (!Array.isArray(input.tasks)) throw new TypeError('tasks must be an array');
  if (input.completedTaskIds !== undefined && !Array.isArray(input.completedTaskIds)) {
    throw new TypeError('completedTaskIds must be an array');
  }
  if (input.rest !== undefined && typeof input.rest !== 'boolean') throw new TypeError('rest must be boolean');
  if (input.remainingStudyMinutes !== undefined && input.remainingStudyMinutes !== null) {
    validateMinute(input.remainingStudyMinutes, 'remainingStudyMinutes', { allowZero: true });
  }
  if (input.nextTwoDaysReviewMinutes !== undefined && input.nextTwoDaysReviewMinutes !== null) {
    validateMinute(input.nextTwoDaysReviewMinutes, 'nextTwoDaysReviewMinutes', { allowZero: true });
  }
  if (input.planVersion !== undefined) validateMinute(input.planVersion, 'planVersion');

  const completed = new Set();
  for (const id of input.completedTaskIds ?? []) {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('completedTaskIds must be non-empty strings');
    if (completed.has(id)) throw new TypeError(`duplicate completedTaskId: ${id}`);
    completed.add(id);
  }

  const ids = new Set();
  for (const task of input.tasks) {
    validateTask(task);
    if (ids.has(task.id)) throw new TypeError(`duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
}

function validateTask(task) {
  if (!task || typeof task !== 'object') throw new TypeError('task must be an object');
  if (typeof task.id !== 'string' || task.id.length === 0) throw new TypeError('task id is required');
  if (typeof task.title !== 'string' || task.title.length === 0) throw new TypeError(`task title is required for ${task.id}`);
  if (!taskKinds.has(task.kind)) throw new TypeError(`invalid task kind for ${task.id}`);
  validateMinute(task.minutes, `task minutes for ${task.id}`);
  if (task.dueDate !== undefined) validateDate(task.dueDate, `dueDate for ${task.id}`);
  if (task.originalDate !== undefined) validateDate(task.originalDate, `originalDate for ${task.id}`);
  if (task.ready !== undefined && typeof task.ready !== 'boolean') throw new TypeError(`ready must be boolean for ${task.id}`);
  if (task.splittable !== undefined && typeof task.splittable !== 'boolean') {
    throw new TypeError(`splittable must be boolean for ${task.id}`);
  }
  if (task.prerequisites !== undefined) {
    if (!Array.isArray(task.prerequisites)) throw new TypeError(`prerequisites must be an array for ${task.id}`);
    const seen = new Set();
    for (const id of task.prerequisites) {
      if (typeof id !== 'string' || id.length === 0) throw new TypeError(`prerequisite id is invalid for ${task.id}`);
      if (seen.has(id)) throw new TypeError(`duplicate prerequisite for ${task.id}`);
      seen.add(id);
    }
  }
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

function normalizeTask(task, index) {
  return {
    id: task.id,
    title: task.title,
    kind: task.kind,
    minutes: task.minutes,
    dueDate: task.dueDate ?? null,
    originalDate: task.originalDate ?? null,
    prerequisites: [...(task.prerequisites ?? [])],
    splittable: task.splittable ?? false,
    ready: task.ready ?? true,
    index,
  };
}

function sortTasks(tasks, date) {
  return [...tasks].sort((a, b) => {
    const priority = priorityFor(a, date) - priorityFor(b, date);
    if (priority !== 0) return priority;
    const due = compareNullableDate(a.dueDate, b.dueDate);
    if (due !== 0) return due;
    const original = compareNullableDate(a.originalDate, b.originalDate);
    if (original !== 0) return original;
    return a.index - b.index;
  });
}

function priorityFor(task, date) {
  if (task.kind === 'review' && task.dueDate !== null && task.dueDate <= date) return 0;
  if (task.kind === 'new') return 1;
  return 2;
}

function compareNullableDate(left, right) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

function allocateFromKind({ source, allocations, used, remaining, targetAdditional }) {
  let available = Math.min(remaining, targetAdditional);
  for (const item of source) {
    if (available <= 0) break;
    const already = used.get(item.id) ?? 0;
    const need = item.minutes - already;
    if (need <= 0) continue;
    const minutes = Math.min(need, available);
    addAllocation(allocations, item, minutes);
    used.set(item.id, already + minutes);
    available -= minutes;
    remaining -= minutes;
  }
  return remaining;
}

function addAllocation(allocations, item, minutes) {
  const current = allocations.find((allocation) => allocation.taskId === item.id);
  if (current) {
    current.minutes += minutes;
    return;
  }
  allocations.push({ taskId: item.id, title: item.title, kind: item.kind, minutes });
}

function defer(deferred, item, minutes, reason) {
  deferred.push({ taskId: item.id, minutes, reason });
}

function alreadyDeferred(deferred, taskId) {
  return deferred.some((item) => item.taskId === taskId);
}

function sumMinutes(tasks) {
  return tasks.reduce((sum, task) => sum + task.minutes, 0);
}

function allocatedKindMinutes(allocations, kind) {
  return allocations
    .filter((allocation) => allocation.kind === kind)
    .reduce((sum, allocation) => sum + allocation.minutes, 0);
}

function categoryLimit(kind, newLimit, reviewLimit) {
  return kind === 'new' ? newLimit : reviewLimit;
}

function coverageStatus(tasks, completed, remainingStudyMinutes) {
  if (remainingStudyMinutes === null || remainingStudyMinutes === undefined) return 'unknown';
  const outstanding = tasks
    .filter((task) => !completed.has(task.id))
    .reduce((sum, task) => sum + task.minutes, 0);
  return outstanding > remainingStudyMinutes ? 'infeasible' : 'within_time';
}

function buildResult({
  date,
  planVersion,
  availableMinutes,
  allocatableMinutes,
  slackMinutes,
  allocations,
  deferred,
  exceptions,
  goalCoverageStatus,
}) {
  const assignedMinutes = allocations.reduce((sum, allocation) => sum + allocation.minutes, 0);
  const warning = goalCoverageStatus === 'infeasible'
    ? '임시 진행안: 현재 시간으로 전체 완료 어려움. 미배정 범위는 유지됩니다.'
    : null;
  return {
    date,
    planVersion,
    availableMinutes,
    allocatableMinutes,
    assignedMinutes,
    slackMinutes,
    allocations,
    deferred,
    exceptions,
    goalCoverageStatus,
    warning,
  };
}
