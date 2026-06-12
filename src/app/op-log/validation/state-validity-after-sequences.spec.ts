/**
 * #8279 regression — post-merge state must pass Checkpoint D validation.
 *
 * Applies realistic *sequences* of actions through the real shared meta-reducers
 * (effects suppressed — exactly what a remote client does when applying ops) and
 * asserts the resulting state passes the same validation that fires at Checkpoint
 * D. Any sequence that yields an invalid state is a latent inconsistency that
 * would trip the post-sync "data corrupted" dialog on the next receive.
 *
 * The two `LWW:` cases reproduce the proven #8279 source: a TASK LWW Update whose
 * own tagIds/projectId reference an entity deleted on the receiving device (an
 * initial cross-device merge). They failed before the forward-ref sanitization in
 * lww-update.meta-reducer.ts and guard against its regression.
 */
import { Action, ActionReducer } from '@ngrx/store';
import {
  createValidAppData,
  createValidTask,
  createValidProject,
  createValidTag,
  validateAppData,
  appDataToRootState,
  rootStateToAppData,
  addProjectToAppData,
  addTagToAppData,
} from './state-validity-test-utils';
import { AppDataComplete } from '../model/model-config';
import { RootState } from '../../root-store/root-state';
import { TaskSharedActions } from '../../root-store/meta/task-shared.actions';
import { WorkContextType } from '../../features/work-context/work-context.model';
import { addSubTask } from '../../features/tasks/store/task.actions';
import { deleteTag } from '../../features/tag/store/tag.actions';
import {
  taskSharedCrudMetaReducer,
  taskSharedLifecycleMetaReducer,
  taskSharedSchedulingMetaReducer,
  taskSharedDeadlineMetaReducer,
  projectSharedMetaReducer,
  tagSharedMetaReducer,
  plannerSharedMetaReducer,
  lwwUpdateMetaReducer,
} from '../../root-store/meta/task-shared-meta-reducers';
import { OpLog } from '../../core/log';
import { TaskWithSubTasks } from '../../features/tasks/task.model';
import {
  projectReducer,
  PROJECT_FEATURE_NAME,
} from '../../features/project/store/project.reducer';
import { tagReducer, TAG_FEATURE_NAME } from '../../features/tag/store/tag.reducer';
import { taskReducer, TASK_FEATURE_NAME } from '../../features/tasks/store/task.reducer';
import { noteReducer, NOTE_FEATURE_NAME } from '../../features/note/store/note.reducer';
import {
  menuTreeReducer,
  menuTreeFeatureKey,
} from '../../features/menu-tree/store/menu-tree.reducer';
import {
  plannerReducer,
  plannerFeatureKey,
} from '../../features/planner/store/planner.reducer';
import {
  boardsReducer,
  BOARDS_FEATURE_NAME,
} from '../../features/boards/store/boards.reducer';
import {
  globalConfigReducer,
  CONFIG_FEATURE_NAME,
} from '../../features/config/store/global-config.reducer';
import {
  timeTrackingReducer,
  TIME_TRACKING_FEATURE_KEY,
} from '../../features/time-tracking/store/time-tracking.reducer';

describe('#8279 regression — action sequences must leave a valid state', () => {
  beforeAll(() => {
    spyOn(OpLog, 'log');
    spyOn(OpLog, 'info');
    spyOn(OpLog, 'error');
    spyOn(OpLog, 'warn');
    spyOn(OpLog, 'err');
    spyOn(OpLog, 'critical');
  });

  const featureReducer = (): ActionReducer<RootState, Action> => {
    return (state: RootState | undefined, action: Action): RootState => {
      if (!state) return state as unknown as RootState;
      return {
        ...state,
        [TASK_FEATURE_NAME]: taskReducer(state[TASK_FEATURE_NAME], action),
        [PROJECT_FEATURE_NAME]: projectReducer(state[PROJECT_FEATURE_NAME], action),
        [TAG_FEATURE_NAME]: tagReducer(state[TAG_FEATURE_NAME], action),
        [NOTE_FEATURE_NAME]: noteReducer(state[NOTE_FEATURE_NAME], action),
        [menuTreeFeatureKey]: menuTreeReducer(state[menuTreeFeatureKey], action),
        [plannerFeatureKey]: plannerReducer(state[plannerFeatureKey], action),
        [BOARDS_FEATURE_NAME]: boardsReducer(state[BOARDS_FEATURE_NAME], action),
        [CONFIG_FEATURE_NAME]: globalConfigReducer(state[CONFIG_FEATURE_NAME], action),
        [TIME_TRACKING_FEATURE_KEY]: timeTrackingReducer(
          state[TIME_TRACKING_FEATURE_KEY],
          action,
        ),
      } as RootState;
    };
  };

  const combinedReducer = (): ActionReducer<RootState, Action> => {
    let r: ActionReducer<RootState, Action> = featureReducer();
    r = taskSharedCrudMetaReducer(r);
    r = taskSharedLifecycleMetaReducer(r);
    r = taskSharedSchedulingMetaReducer(r);
    r = taskSharedDeadlineMetaReducer(r);
    r = projectSharedMetaReducer(r);
    r = tagSharedMetaReducer(r);
    r = plannerSharedMetaReducer(r);
    r = lwwUpdateMetaReducer(r) as ActionReducer<RootState, Action>;
    return r;
  };

  /** Apply a sequence of actions through the meta-reducers, preserving archives. */
  const applySequence = (
    appData: AppDataComplete,
    actions: Action[],
  ): { appData: AppDataComplete; result: ReturnType<typeof validateAppData> } => {
    const reducer = combinedReducer();
    let rootState = appDataToRootState(appData);
    for (const action of actions) {
      rootState = reducer(rootState, action);
    }
    const newAppData = rootStateToAppData(rootState, {
      archiveYoung: appData.archiveYoung,
      archiveOld: appData.archiveOld,
      simpleCounter: appData.simpleCounter,
      taskRepeatCfg: appData.taskRepeatCfg,
      issueProvider: appData.issueProvider,
      metric: appData.metric,
      reminders: appData.reminders,
      pluginUserData: appData.pluginUserData,
      pluginMetadata: appData.pluginMetadata,
    });
    return { appData: newAppData, result: validateAppData(newAppData) };
  };

  const expectValid = (
    label: string,
    r: ReturnType<typeof applySequence>['result'],
  ): void => {
    expect(r.isValid).toBe(true);
    if (!r.isValid) fail(`${label} → invalid: ${r.error}`);
  };

  it('move a parent task (with subtasks) to another project', () => {
    let d = createValidAppData();
    d = addProjectToAppData(d, createValidProject('p2'));
    const parent = createValidTask('parent', { projectId: 'INBOX', subTaskIds: ['s1'] });
    const sub = createValidTask('s1', { projectId: 'INBOX', parentId: 'parent' });
    d = {
      ...d,
      task: { ...d.task, ids: ['parent', 's1'], entities: { parent, s1: sub } },
      project: {
        ...d.project,
        entities: {
          ...d.project.entities,
          INBOX: { ...d.project.entities['INBOX']!, taskIds: ['parent'] },
        },
      },
    };
    const { result } = applySequence(d, [
      TaskSharedActions.moveToOtherProject({
        task: { ...parent, subTasks: [sub] } as TaskWithSubTasks,
        targetProjectId: 'p2',
      }),
    ]);
    expectValid('moveToOtherProject(parent+sub)', result);
  });

  it('archive a parent task with subtasks (active state has no orphans)', () => {
    let d = createValidAppData();
    const parent = createValidTask('parent', { projectId: 'INBOX', subTaskIds: ['s1'] });
    const sub = createValidTask('s1', { projectId: 'INBOX', parentId: 'parent' });
    d = {
      ...d,
      task: { ...d.task, ids: ['parent', 's1'], entities: { parent, s1: sub } },
      project: {
        ...d.project,
        entities: {
          ...d.project.entities,
          INBOX: { ...d.project.entities['INBOX']!, taskIds: ['parent'] },
        },
      },
    };
    const { result } = applySequence(d, [
      TaskSharedActions.moveToArchive({
        tasks: [{ ...parent, subTasks: [sub] } as TaskWithSubTasks],
      }),
    ]);
    expectValid('moveToArchive(parent+sub)', result);
  });

  it('delete a project that still has tasks (in a tag)', () => {
    let d = createValidAppData();
    d = addTagToAppData(d, createValidTag('t1'));
    d = addProjectToAppData(d, createValidProject('p2'));
    const task = createValidTask('task', { projectId: 'p2', tagIds: ['t1'] });
    d = {
      ...d,
      task: { ...d.task, ids: ['task'], entities: { task } },
      project: {
        ...d.project,
        entities: {
          ...d.project.entities,
          p2: { ...d.project.entities['p2']!, taskIds: ['task'] },
        },
      },
      tag: {
        ...d.tag,
        entities: {
          ...d.tag.entities,
          t1: { ...d.tag.entities['t1']!, taskIds: ['task'] },
        },
      },
    };
    const { result } = applySequence(d, [
      TaskSharedActions.deleteProject({
        projectId: 'p2',
        noteIds: [],
        allTaskIds: ['task'],
      }),
    ]);
    expectValid('deleteProject(with tagged task)', result);
  });

  it('task in two tags → delete one tag', () => {
    let d = createValidAppData();
    d = addTagToAppData(d, createValidTag('t1'));
    d = addTagToAppData(d, createValidTag('t2'));
    const task = createValidTask('task', { projectId: 'INBOX', tagIds: ['t1', 't2'] });
    d = {
      ...d,
      task: { ...d.task, ids: ['task'], entities: { task } },
      project: {
        ...d.project,
        entities: {
          ...d.project.entities,
          INBOX: { ...d.project.entities['INBOX']!, taskIds: ['task'] },
        },
      },
      tag: {
        ...d.tag,
        entities: {
          ...d.tag.entities,
          t1: { ...d.tag.entities['t1']!, taskIds: ['task'] },
          t2: { ...d.tag.entities['t2']!, taskIds: ['task'] },
        },
      },
    };
    const { result } = applySequence(d, [deleteTag({ id: 't1' })]);
    expectValid('deleteTag(one of two)', result);
  });

  it('add subtask, then move parent to another project', () => {
    let d = createValidAppData();
    d = addProjectToAppData(d, createValidProject('p2'));
    const parent = createValidTask('parent', { projectId: 'INBOX' });
    d = {
      ...d,
      task: { ...d.task, ids: ['parent'], entities: { parent } },
      project: {
        ...d.project,
        entities: {
          ...d.project.entities,
          INBOX: { ...d.project.entities['INBOX']!, taskIds: ['parent'] },
        },
      },
    };
    const sub = createValidTask('s1', { projectId: 'INBOX', parentId: 'parent' });
    const { appData: afterSub } = applySequence(d, [
      addSubTask({ task: sub, parentId: 'parent' }),
    ]);
    const parentAfter = afterSub.task.entities['parent']!;
    const { result } = applySequence(afterSub, [
      TaskSharedActions.moveToOtherProject({
        task: {
          ...parentAfter,
          subTasks: [afterSub.task.entities['s1']!],
        } as TaskWithSubTasks,
        targetProjectId: 'p2',
      }),
    ]);
    expectValid('addSubTask → moveToOtherProject', result);
  });

  it('move task to a new project, then delete the OLD project', () => {
    let d = createValidAppData();
    d = addProjectToAppData(d, createValidProject('old'));
    d = addProjectToAppData(d, createValidProject('new'));
    const task = createValidTask('task', { projectId: 'old' });
    d = {
      ...d,
      task: { ...d.task, ids: ['task'], entities: { task } },
      project: {
        ...d.project,
        entities: {
          ...d.project.entities,
          old: { ...d.project.entities['old']!, taskIds: ['task'] },
        },
      },
    };
    const { appData: moved } = applySequence(d, [
      TaskSharedActions.moveToOtherProject({
        task: { ...task, subTasks: [] } as TaskWithSubTasks,
        targetProjectId: 'new',
      }),
    ]);
    const { result } = applySequence(moved, [
      TaskSharedActions.deleteProject({
        projectId: 'old',
        noteIds: [],
        allTaskIds: [],
      }),
    ]);
    expectValid('moveToOtherProject → deleteProject(old)', result);
  });

  // CONCURRENT / LWW probes — the "after concurrent edits across devices" case
  // the corruption dialog itself names. These model an initial cross-device merge.

  it('LWW: TASK update whose tagIds reference a tag deleted on this device', () => {
    // Setup: task in regular tag t1.
    let d = createValidAppData();
    d = addTagToAppData(d, createValidTag('t1'));
    const task = createValidTask('task', { projectId: 'INBOX', tagIds: ['t1'] });
    d = {
      ...d,
      task: { ...d.task, ids: ['task'], entities: { task } },
      project: {
        ...d.project,
        entities: {
          ...d.project.entities,
          INBOX: { ...d.project.entities['INBOX']!, taskIds: ['task'] },
        },
      },
      tag: {
        ...d.tag,
        entities: {
          ...d.tag.entities,
          t1: { ...d.tag.entities['t1']!, taskIds: ['task'] },
        },
      },
    };
    // This device deleted t1; a concurrent remote TASK update (LWW winner) still
    // carries tagIds:['t1']. Apply both in order.
    const lwwTask = createValidTask('task', { projectId: 'INBOX', tagIds: ['t1'] });
    const lwwUpdate: Action = {
      type: '[TASK] LWW Update',
      ...lwwTask,
      meta: { isPersistent: true },
    } as unknown as Action;
    const { result } = applySequence(d, [deleteTag({ id: 't1' }), lwwUpdate]);
    expectValid('deleteTag → TASK LWW Update referencing deleted tag', result);
  });

  it('LWW: TASK update whose projectId references a project deleted on this device', () => {
    let d = createValidAppData();
    d = addProjectToAppData(d, createValidProject('p2'));
    const task = createValidTask('task', { projectId: 'p2', tagIds: [] });
    d = {
      ...d,
      task: { ...d.task, ids: ['task'], entities: { task } },
      project: {
        ...d.project,
        entities: {
          ...d.project.entities,
          p2: { ...d.project.entities['p2']!, taskIds: ['task'] },
        },
      },
    };
    const lwwTask = createValidTask('task', { projectId: 'p2', tagIds: [] });
    const lwwUpdate: Action = {
      type: '[TASK] LWW Update',
      ...lwwTask,
      meta: { isPersistent: true },
    } as unknown as Action;
    const { result } = applySequence(d, [
      TaskSharedActions.deleteProject({
        projectId: 'p2',
        noteIds: [],
        allTaskIds: ['task'],
      }),
      lwwUpdate,
    ]);
    expectValid('deleteProject → TASK LWW Update referencing deleted project', result);
  });

  it('LWW: TASK update whose parentId references a parent deleted on this device', () => {
    // Setup: parent P with subtask S.
    let d = createValidAppData();
    const parent = createValidTask('P', { projectId: 'INBOX', subTaskIds: ['S'] });
    const sub = createValidTask('S', { projectId: 'INBOX', parentId: 'P' });
    d = {
      ...d,
      task: { ...d.task, ids: ['P', 'S'], entities: { P: parent, S: sub } },
      project: {
        ...d.project,
        entities: {
          ...d.project.entities,
          INBOX: { ...d.project.entities['INBOX']!, taskIds: ['P'] },
        },
      },
    };
    // This device deleted the parent (and its subtask); a concurrent remote update
    // to the subtask (LWW winner) still carries parentId:'P'.
    const lwwSub = createValidTask('S', { projectId: 'INBOX', parentId: 'P' });
    const lwwUpdate: Action = {
      type: '[TASK] LWW Update',
      ...lwwSub,
      meta: { isPersistent: true },
    } as unknown as Action;
    const { result } = applySequence(d, [
      TaskSharedActions.deleteTask({
        task: { ...parent, subTasks: [sub] } as TaskWithSubTasks,
      }),
      lwwUpdate,
    ]);
    expectValid('deleteTask(parent) → TASK LWW Update referencing deleted parent', result);
  });

  it('add task to a tag-only context (no project)', () => {
    let d = createValidAppData();
    d = addTagToAppData(d, createValidTag('t1'));
    const task = createValidTask('task', { projectId: undefined, tagIds: ['t1'] });
    const { result } = applySequence(d, [
      TaskSharedActions.addTask({
        task,
        workContextId: 't1',
        workContextType: WorkContextType.TAG,
        isAddToBacklog: false,
        isAddToBottom: false,
      }),
    ]);
    expectValid('addTask(tag-only)', result);
  });
});
