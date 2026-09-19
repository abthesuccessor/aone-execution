import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

export const ENGINEERING_PLAN_STAGES = Object.freeze(['capture_context', 'propose_plan', 'validate_plan']);

export async function runEngineeringPlanningStages(tasks, observer) {
  const State = Annotation.Root({ completedStages: Annotation() });
  const graph = new StateGraph(State);
  for (const stage of ENGINEERING_PLAN_STAGES) graph.addNode(stage, async (state) => {
    const spanId = `engineering-plan:${stage}`;
    observer?.startSpan(spanId, {
      name: `Engineering plan: ${stage.replaceAll('_', ' ')}`, category: stage === 'validate_plan' ? 'CHECKPOINT' : 'PLANNER', spanKind: 'INTERNAL',
      attributes: { orchestrationEngine: 'langgraph', stage }, input: { completedStages: state.completedStages },
    });
    try {
      await tasks[stage]();
      const completedStages = [...state.completedStages, stage];
      observer?.endSpan(spanId, { status: 'OK', output: { completedStages } });
      return { completedStages };
    } catch (error) {
      observer?.endSpan(spanId, { status: 'ERROR', output: { code: error.code || 'PLANNING_STAGE_FAILED', message: error.message } });
      throw error;
    }
  });
  graph.addEdge(START, 'capture_context').addEdge('capture_context', 'propose_plan').addEdge('propose_plan', 'validate_plan').addEdge('validate_plan', END);
  return graph.compile().invoke({ completedStages: [] }, { recursionLimit: 16 });
}
