// A strategy's goal: "gain at least <target>% within <days> days". The goal is what the learned rules are searched
// for and what tracked picks are judged against.
const DEFAULT_GOAL = { target: 5, days: 30 };

function cleanGoal(g){
  const target = g && typeof g.target === 'number' && isFinite(g.target) ? Math.min(100, Math.max(0.5, g.target)) : DEFAULT_GOAL.target;
  const days = g && typeof g.days === 'number' && isFinite(g.days) ? Math.min(120, Math.max(7, Math.round(g.days))) : DEFAULT_GOAL.days;
  return { target, days };
}
// Weekly bars are the finest price data used for learning, so the horizon is rounded to whole weeks (at least one).
const horizonWeeks = (goal) => Math.max(1, Math.round(goal.days / 7));
const goalText = (goal) => `+${goal.target}% within ${goal.days} days`;

export { DEFAULT_GOAL, cleanGoal, goalText, horizonWeeks };
