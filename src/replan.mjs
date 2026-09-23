import { planDay } from './scheduler.mjs';

export function planFromProgress(input, state) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.tasks)) {
    throw new TypeError('tasks input is required');
  }
  if (!state || !Array.isArray(state.progress) || !Array.isArray(state.plans)) {
    throw new TypeError('recorded progress state is required');
  }
  if (input.planVersion !== undefined) {
    throw new TypeError('planVersion is assigned from the store');
  }
  if (input.completedTaskIds !== undefined) {
    throw new TypeError('replan derives completedTaskIds from recorded progress');
  }

  const providedTaskIds = new Set(input.tasks.map(task => task?.id));
  const originalMinutes = new Map();
  for (const plan of state.plans) {
    const planTotals = new Map();
    for (const item of [...plan.allocations, ...plan.deferred]) {
      if (!providedTaskIds.has(item.taskId)) {
        throw new Error(`Prior task missing from replan input: ${item.taskId}`);
      }
      planTotals.set(item.taskId, (planTotals.get(item.taskId) ?? 0) + item.minutes);
    }
    for (const [taskId, minutes] of planTotals) {
      if (!Number.isSafeInteger(minutes)) throw new Error(`Invalid prior task estimate: ${taskId}`);
      if (!originalMinutes.has(taskId)) originalMinutes.set(taskId, minutes);
    }
  }

  const completedMinutes = new Map();
  for (const event of state.progress) {
    completedMinutes.set(event.taskId, (completedMinutes.get(event.taskId) ?? 0) + event.completedMinutes);
  }

  const completedTaskIds = new Set();
  const tasks = input.tasks.map(task => {
    const original = originalMinutes.get(task.id);
    if (original !== undefined && task.minutes !== original) {
      throw new Error(`Input differs from original task estimate: ${task.id}`);
    }
    const credit = completedMinutes.get(task.id) ?? 0;
    if (!Number.isSafeInteger(credit) || credit < 0 || credit > task.minutes) {
      throw new Error(`Confirmed progress exceeds task estimate: ${task.id}`);
    }
    if (credit === task.minutes) completedTaskIds.add(task.id);
    return { ...task, minutes: credit === task.minutes ? task.minutes : task.minutes - credit };
  });

  return planDay({ ...input, tasks, completedTaskIds: [...completedTaskIds],
    planVersion: (state.currentPlan?.planVersion ?? 0) + 1 });
}
