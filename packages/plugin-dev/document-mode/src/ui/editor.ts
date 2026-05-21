/**
 * Document-Mode editor — runs inside the plugin iframe. Notion-style UX:
 * inline bubble menu on text selection, block hover gutter with insert
 * (`+`) and grip (`⋮⋮`) buttons, slash menu for inserts and turn-into,
 * and a custom taskRef atom node tied to Super Productivity tasks.
 */

import { Editor, Node, mergeAttributes } from '@tiptap/core';
import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import BubbleMenu from '@tiptap/extension-bubble-menu';
import {
  PluginHooks,
  type ActiveWorkContext,
  type AnyTaskUpdatePayload,
  type PluginAPI,
  type Task,
  type WorkContextChangePayload,
} from '@super-productivity/plugin-api';

declare const PluginAPI: PluginAPI;

const SAVE_DEBOUNCE_MS = 5_000;
const STORAGE_VERSION = 1;

interface StoredState {
  version: number;
  docs: Record<string, unknown>;
  [key: string]: unknown; // preserve fields owned by background script
}

let currentCtx: ActiveWorkContext | null = null;
let storedState: StoredState = { version: STORAGE_VERSION, docs: {} };
let taskCache = new Map<string, Task>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let editor: Editor | null = null;
let isLoadingDoc = false;

/* -------------------------------------------------------------------------- */
/* taskRef node                                                                */
/* -------------------------------------------------------------------------- */

/**
 * taskRef is a content-bearing block node — its inline content IS the task
 * title, so typing inside it edits the linked task. We debounce write-back
 * to PluginAPI.updateTask and reconcile against ANY_TASK_UPDATE events
 * from the host without clobbering an active edit.
 */
/**
 * Helper invoked from keyboard shortcuts to create a new empty task and
 * insert a taskRef pointing at it. Hoisted so keybindings inside
 * TaskRefNode can call it without needing the editor closure variable
 * (which isn't initialised at extension creation time).
 */
const createTaskAfter = async (insertPos: number): Promise<void> => {
  if (!editor || !currentCtx) return;
  try {
    const taskId = await PluginAPI.addTask({
      title: '',
      projectId: currentCtx.type === 'PROJECT' ? currentCtx.id : null,
    });
    await refreshTaskCache();
    editor
      .chain()
      .focus()
      .insertContentAt(insertPos, {
        type: 'taskRef',
        attrs: { taskId, isDone: false },
        content: [],
      })
      .run();
    // Cursor lands inside the new chip's empty title; refresh selection.
    editor.commands.focus(insertPos + 1);
  } catch (err) {
    PluginAPI.log.err('createTaskAfter failed', err);
  }
};

const TaskRefNode = Node.create({
  name: 'taskRef',
  group: 'block',
  content: 'inline*',
  selectable: true,
  draggable: true,
  addKeyboardShortcuts() {
    const inTaskRef = (): null | {
      from: number;
      to: number;
      atStart: boolean;
      atEnd: boolean;
      isEmpty: boolean;
      taskId: string;
      nodePos: number;
      nodeSize: number;
    } => {
      if (!editor) return null;
      const { $from } = editor.state.selection;
      if ($from.parent.type.name !== 'taskRef') return null;
      const node = $from.parent;
      const nodePos = $from.before($from.depth);
      return {
        from: $from.parentOffset,
        to: $from.parentOffset,
        atStart: $from.parentOffset === 0,
        atEnd: $from.parentOffset === node.content.size,
        isEmpty: node.content.size === 0,
        taskId: node.attrs.taskId as string,
        nodePos,
        nodeSize: node.nodeSize,
      };
    };

    return {
      Enter: () => {
        const info = inTaskRef();
        if (!info) return false;
        if (info.isEmpty) {
          // Empty chip + Enter → convert to paragraph + delete the empty task.
          if (info.taskId) {
            PluginAPI.deleteTask(info.taskId).catch((err) =>
              PluginAPI.log.err('deleteTask failed', err),
            );
          }
          if (!editor) return false;
          editor.chain().focus().setNodeSelection(info.nodePos).setParagraph().run();
          return true;
        }
        if (info.atEnd) {
          // Enter at end of chip → new empty task below.
          const insertAfter = info.nodePos + info.nodeSize;
          void createTaskAfter(insertAfter);
          return true;
        }
        // Enter in the middle: swallow for POC (avoid splitting chip into
        // two with the same taskId). Could split + create new task in v2.
        return true;
      },
      Backspace: () => {
        const info = inTaskRef();
        if (!info) return false;
        if (!info.atStart) return false;
        if (info.isEmpty) {
          // Empty chip + Backspace at start → delete task + remove chip.
          if (info.taskId) {
            PluginAPI.deleteTask(info.taskId).catch((err) =>
              PluginAPI.log.err('deleteTask failed', err),
            );
          }
          if (!editor) return false;
          editor.chain().focus().setNodeSelection(info.nodePos).deleteSelection().run();
          return true;
        }
        // Non-empty chip + Backspace at start: suppress default to avoid
        // merging the chip's content into the previous block (which would
        // detach the title from the task).
        return true;
      },
    };
  },
  addAttributes() {
    return {
      taskId: { default: '' },
      isDone: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-done') === 'true',
        renderHTML: (attrs) => ({ 'data-done': attrs.isDone ? 'true' : 'false' }),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-task-ref]',
        getAttrs: (el: HTMLElement | string) => {
          if (typeof el === 'string') return false;
          return {
            taskId: el.getAttribute('data-task-id') || '',
            isDone: el.getAttribute('data-done') === 'true',
          };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-task-ref': '',
        'data-task-id': HTMLAttributes.taskId,
        class: 'task-ref',
      }),
      0,
    ];
  },
  addNodeView() {
    return ({ node, editor: viewEditor, getPos }: NodeViewRendererProps) => {
      const dom = document.createElement('div');
      dom.className = 'task-ref';
      dom.dataset.taskRef = '';
      dom.dataset.taskId = node.attrs.taskId;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.contentEditable = 'false';
      const title = document.createElement('span');
      title.className = 'title';

      const applyState = (n: ProseMirrorNode): void => {
        const taskId = n.attrs.taskId as string;
        const task = taskCache.get(taskId);
        if (!task) {
          dom.classList.add('is-missing');
          dom.classList.remove('is-done');
          checkbox.checked = false;
          checkbox.disabled = true;
        } else {
          dom.classList.remove('is-missing');
          const done = !!(n.attrs.isDone || task.isDone);
          dom.classList.toggle('is-done', done);
          checkbox.checked = done;
          checkbox.disabled = false;
        }
      };

      checkbox.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const taskId = node.attrs.taskId as string;
        const task = taskCache.get(taskId);
        if (!task) return;
        const next = !task.isDone;
        PluginAPI.updateTask(taskId, { isDone: next }).catch((err) => {
          PluginAPI.log.err('updateTask failed', err);
        });
        taskCache.set(taskId, { ...task, isDone: next });
        // Reflect on attr so undo stack carries it.
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos !== null && pos !== undefined) {
          const tr = viewEditor.state.tr.setNodeAttribute(pos, 'isDone', next);
          viewEditor.view.dispatch(tr);
        } else {
          applyState(node);
        }
      });

      dom.appendChild(checkbox);
      dom.appendChild(title);
      applyState(node);

      return {
        dom,
        contentDOM: title,
        update: (updatedNode: ProseMirrorNode): boolean => {
          if (updatedNode.type.name !== 'taskRef') return false;
          if (updatedNode.attrs.taskId !== node.attrs.taskId) return false;
          applyState(updatedNode);
          return true;
        },
      };
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

const readBlob = async (): Promise<StoredState> => {
  try {
    const raw = await PluginAPI.loadSyncedData();
    if (!raw) return { version: STORAGE_VERSION, docs: {} };
    const parsed = JSON.parse(raw) as StoredState;
    if (parsed && typeof parsed === 'object') {
      return {
        ...parsed,
        version: parsed.version || STORAGE_VERSION,
        docs: parsed.docs || {},
      };
    }
  } catch (err) {
    PluginAPI.log.err('Failed to parse stored doc state', err);
  }
  return { version: STORAGE_VERSION, docs: {} };
};

const loadStoredState = async (): Promise<void> => {
  storedState = await readBlob();
};

const flushSave = async (): Promise<void> => {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!currentCtx || !editor) return;
  try {
    const latest = await readBlob();
    const merged: StoredState = {
      ...latest,
      docs: { ...latest.docs, [currentCtx.id]: editor.getJSON() },
    };
    storedState = merged;
    await PluginAPI.persistDataSynced(JSON.stringify(merged));
  } catch (err) {
    PluginAPI.log.err('persistDataSynced failed', err);
  }
};

const scheduleSave = (): void => {
  if (isLoadingDoc) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushSave();
  }, SAVE_DEBOUNCE_MS);
};

/* -------------------------------------------------------------------------- */
/* Seed + task sync                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build a fresh doc from the work-context's task list. Task titles are
 * pulled from the cache (populated by refreshTaskCache before this is
 * called) so the taskRef nodes have content, not just IDs.
 */
const taskRefNodeJSON = (taskId: string): unknown => {
  const task = taskCache.get(taskId);
  const title = task?.title || '';
  return {
    type: 'taskRef',
    attrs: { taskId, isDone: !!task?.isDone },
    content: title ? [{ type: 'text', text: title }] : [],
  };
};

const buildSeedDoc = (ctx: ActiveWorkContext): unknown => {
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: ctx.title }],
      },
      ...ctx.taskIds.map(taskRefNodeJSON),
      { type: 'paragraph' },
    ],
  };
};

type PMText = { type: 'text'; text: string };
type PMNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: (PMNode | PMText)[];
  text?: string;
};

/**
 * Older docs stored taskRef as an atom node (no `content` array). Walk the
 * stored JSON and populate content from the task cache so the new
 * content-bearing schema can load them. Idempotent — nodes that already
 * have content are left alone.
 */
const migrateStoredDoc = (raw: unknown): unknown => {
  const visit = (node: PMNode | PMText | undefined): PMNode | PMText | undefined => {
    if (!node || typeof node !== 'object') return node;
    if ('text' in node) return node;
    if (node.type === 'taskRef') {
      const taskId = (node.attrs?.taskId as string) || '';
      const task = taskCache.get(taskId);
      const hasContent = Array.isArray(node.content) && node.content.length > 0;
      return {
        ...node,
        attrs: {
          taskId,
          isDone: (node.attrs?.isDone as boolean) ?? !!task?.isDone,
        },
        content: hasContent
          ? node.content
          : task?.title
            ? [{ type: 'text', text: task.title }]
            : [],
      };
    }
    if (Array.isArray(node.content)) {
      return {
        ...node,
        content: node.content
          .map(visit)
          .filter((n): n is PMNode | PMText => n !== undefined),
      };
    }
    return node;
  };
  return visit(raw as PMNode);
};

const refreshTaskCache = async (): Promise<void> => {
  try {
    const tasks = await PluginAPI.getTasks();
    taskCache = new Map(tasks.map((t) => [t.id, t]));
  } catch (err) {
    PluginAPI.log.err('getTasks failed', err);
  }
};

const setActiveContext = async (ctx: ActiveWorkContext | null): Promise<void> => {
  await flushSave();
  currentCtx = ctx;
  if (!ctx || !editor) return;

  isLoadingDoc = true;
  await refreshTaskCache();

  const stored = storedState.docs[ctx.id];
  const docJson = stored ? migrateStoredDoc(stored) : buildSeedDoc(ctx);
  try {
    editor.commands.setContent(
      docJson as Parameters<typeof editor.commands.setContent>[0],
      false,
    );
  } catch (err) {
    PluginAPI.log.err('setContent failed, seeding fresh', err);
    editor.commands.setContent(
      buildSeedDoc(ctx) as Parameters<typeof editor.commands.setContent>[0],
      false,
    );
  }
  isLoadingDoc = false;
};

const collectTaskRefIds = (): Set<string> => {
  const ids = new Set<string>();
  if (!editor) return ids;
  editor.state.doc.descendants((node: ProseMirrorNode): boolean | undefined => {
    if (node.type.name === 'taskRef' && node.attrs.taskId) {
      ids.add(node.attrs.taskId as string);
    }
    return undefined;
  });
  return ids;
};

const appendMissingTask = (taskId: string): void => {
  if (!editor) return;
  if (collectTaskRefIds().has(taskId)) return;
  const endPos = editor.state.doc.content.size;
  editor
    .chain()
    .focus(endPos)
    .insertContentAt(endPos, { type: 'taskRef', attrs: { taskId } })
    .run();
};

/**
 * Per-task debouncers for writing edited titles back to the host. Pending
 * writes prevent ANY_TASK_UPDATE echoes from clobbering the user's typing.
 */
const titleWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingTitleWrites = new Set<string>();

const writeTitleBack = (taskId: string, newTitle: string): void => {
  const existing = titleWriteTimers.get(taskId);
  if (existing) clearTimeout(existing);
  pendingTitleWrites.add(taskId);
  titleWriteTimers.set(
    taskId,
    setTimeout(() => {
      titleWriteTimers.delete(taskId);
      PluginAPI.updateTask(taskId, { title: newTitle })
        .then(() => {
          const cached = taskCache.get(taskId);
          if (cached) taskCache.set(taskId, { ...cached, title: newTitle });
        })
        .catch((err) => {
          PluginAPI.log.err('updateTask (title) failed', err);
        })
        .finally(() => {
          // Keep the "pending" marker briefly to absorb the echo from our
          // own write that will arrive via ANY_TASK_UPDATE.
          setTimeout(() => pendingTitleWrites.delete(taskId), 500);
        });
    }, 600),
  );
};

/**
 * Walk all taskRef nodes in the current doc and emit write-backs for any
 * whose inline content drifted from the task cache.
 */
const reconcileTitlesFromDoc = (): void => {
  if (!editor || isLoadingDoc) return;
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'taskRef') return;
    const taskId = node.attrs.taskId as string;
    if (!taskId) return;
    const docTitle = node.textContent;
    const cached = taskCache.get(taskId);
    if (!cached) return;
    if (docTitle !== cached.title) {
      writeTitleBack(taskId, docTitle);
    }
  });
};

const isTaskRefFocused = (taskId: string): boolean => {
  if (!editor) return false;
  const { from, to } = editor.state.selection;
  let focused = false;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (node.type.name === 'taskRef' && node.attrs.taskId === taskId) {
      focused = true;
      return false;
    }
    return undefined;
  });
  return focused;
};

/**
 * Refresh inline content + isDone attr for one taskRef from the cache.
 * Skips nodes that the user is currently editing or that have a pending
 * write-back (so we don't undo their typing).
 */
const refreshTaskRef = (taskId: string): void => {
  if (!editor) return;
  if (pendingTitleWrites.has(taskId)) return;
  if (isTaskRefFocused(taskId)) return;
  const task = taskCache.get(taskId);
  if (!task) return;

  const updates: { pos: number; nodeSize: number; node: ProseMirrorNode }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'taskRef' && node.attrs.taskId === taskId) {
      updates.push({ pos, nodeSize: node.nodeSize, node });
      return false;
    }
    return undefined;
  });
  if (updates.length === 0) return;

  const tr = editor.state.tr;
  for (const { pos, nodeSize, node } of updates) {
    if (node.attrs.isDone !== !!task.isDone) {
      tr.setNodeAttribute(pos, 'isDone', !!task.isDone);
    }
    if (node.textContent !== task.title) {
      const schema = editor.schema;
      const titleText = task.title || '';
      const newContent = titleText ? schema.text(titleText) : null;
      // Replace inline content of the node: positions are [pos+1, pos+nodeSize-1].
      const from = pos + 1;
      const to = pos + nodeSize - 1;
      if (newContent) {
        tr.replaceWith(from, to, newContent);
      } else {
        tr.delete(from, to);
      }
    }
  }
  if (tr.docChanged) {
    isLoadingDoc = true;
    editor.view.dispatch(tr);
    isLoadingDoc = false;
  }
};

const onAnyTaskUpdate = (payload: AnyTaskUpdatePayload): void => {
  if (!currentCtx || !editor) return;
  void refreshTaskCache().then(() => {
    if (payload.taskId) {
      refreshTaskRef(payload.taskId);
    }
  });
  if (payload.task && payload.taskId) {
    const inProject =
      currentCtx.type === 'PROJECT' && payload.task.projectId === currentCtx.id;
    const inToday =
      currentCtx.id === 'TODAY' &&
      (payload.task.tagIds?.includes('TODAY') ||
        !!payload.task.dueDay ||
        !!payload.task.dueWithTime);
    if (inProject || inToday) appendMissingTask(payload.taskId);
  }
};

/* -------------------------------------------------------------------------- */
/* Slash menu + block menu (Notion-style)                                      */
/* -------------------------------------------------------------------------- */

interface MenuItem {
  label: string;
  icon: string;
  hint?: string;
  action: () => void;
}

const insertItems = (): MenuItem[] => {
  if (!editor) return [];
  const ed = editor;
  return [
    {
      label: 'Paragraph',
      icon: 'segment',
      action: () => ed.chain().focus().setParagraph().run(),
    },
    {
      label: 'Heading 1',
      icon: 'title',
      action: () => ed.chain().focus().setHeading({ level: 1 }).run(),
    },
    {
      label: 'Heading 2',
      icon: 'text_fields',
      action: () => ed.chain().focus().setHeading({ level: 2 }).run(),
    },
    {
      label: 'Heading 3',
      icon: 'short_text',
      action: () => ed.chain().focus().setHeading({ level: 3 }).run(),
    },
    {
      label: 'Bullet list',
      icon: 'format_list_bulleted',
      action: () => ed.chain().focus().toggleBulletList().run(),
    },
    {
      label: 'Numbered list',
      icon: 'format_list_numbered',
      action: () => ed.chain().focus().toggleOrderedList().run(),
    },
    {
      label: 'Quote',
      icon: 'format_quote',
      action: () => ed.chain().focus().setBlockquote().run(),
    },
    {
      label: 'Code block',
      icon: 'code',
      action: () => ed.chain().focus().toggleCodeBlock().run(),
    },
    {
      label: 'Divider',
      icon: 'horizontal_rule',
      action: () => ed.chain().focus().setHorizontalRule().run(),
    },
    {
      label: 'New task',
      icon: 'check_circle_outline',
      action: async () => {
        if (!currentCtx) return;
        const taskId = await PluginAPI.addTask({
          title: 'New task',
          projectId: currentCtx.type === 'PROJECT' ? currentCtx.id : null,
        });
        await refreshTaskCache();
        ed.chain().focus().insertContent({ type: 'taskRef', attrs: { taskId } }).run();
      },
    },
  ];
};

let menuEl: HTMLDivElement | null = null;
let menuActiveIndex = 0;
let menuFilter = '';
let menuCurrentItems: MenuItem[] = [];

const closeMenu = (): void => {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
  menuFilter = '';
  menuActiveIndex = 0;
  menuCurrentItems = [];
};

const renderMenu = (rect: DOMRect, items: MenuItem[]): void => {
  if (menuEl) menuEl.remove();
  menuCurrentItems = items;
  if (items.length === 0) {
    menuEl = document.createElement('div');
    menuEl.className = 'slash-menu';
    menuEl.style.top = `${rect.bottom + 4}px`;
    menuEl.style.left = `${rect.left}px`;
    const empty = document.createElement('div');
    empty.className = 'slash-menu-empty';
    empty.textContent = 'No matches';
    menuEl.appendChild(empty);
    document.body.appendChild(menuEl);
    return;
  }
  menuEl = document.createElement('div');
  menuEl.className = 'slash-menu';
  menuEl.style.top = `${rect.bottom + 4}px`;
  menuEl.style.left = `${rect.left}px`;
  items.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = 'slash-menu-item';
    if (idx === menuActiveIndex) el.classList.add('is-active');
    el.innerHTML = `
      <span class="material-icons slash-menu-icon">${item.icon}</span>
      <span class="slash-menu-label">${item.label}</span>
      ${item.hint ? `<span class="slash-menu-hint">${item.hint}</span>` : ''}
    `;
    el.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      closeMenu();
      item.action();
    });
    el.addEventListener('mouseenter', () => {
      menuActiveIndex = idx;
      menuEl
        ?.querySelectorAll('.slash-menu-item')
        .forEach((n, i) => n.classList.toggle('is-active', i === idx));
    });
    menuEl!.appendChild(el);
  });
  document.body.appendChild(menuEl);
};

const showSlashMenu = (): void => {
  if (!editor) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  menuActiveIndex = 0;
  menuFilter = '';
  renderMenu(rect, insertItems());
};

const filterAndRender = (rect: DOMRect): void => {
  const items = insertItems().filter((i) =>
    i.label.toLowerCase().includes(menuFilter.toLowerCase()),
  );
  if (menuActiveIndex >= items.length) menuActiveIndex = 0;
  renderMenu(rect, items);
};

/* -------------------------------------------------------------------------- */
/* Block hover gutter (Notion-style + / drag handle)                           */
/* -------------------------------------------------------------------------- */

let gutterEl: HTMLDivElement | null = null;
let hoveredBlock: HTMLElement | null = null;
let hideGutterTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleHideGutter = (): void => {
  if (hideGutterTimer) clearTimeout(hideGutterTimer);
  hideGutterTimer = setTimeout(() => {
    hideGutterTimer = null;
    positionGutter(null);
  }, 200);
};

const cancelHideGutter = (): void => {
  if (hideGutterTimer) {
    clearTimeout(hideGutterTimer);
    hideGutterTimer = null;
  }
};

const createGutter = (): HTMLDivElement => {
  const g = document.createElement('div');
  g.className = 'block-gutter';
  g.innerHTML = `
    <button class="block-gutter-btn" data-action="add" title="Insert below">
      <span class="material-icons">add</span>
    </button>
    <button class="block-gutter-btn" data-action="grip" title="Drag to move; click for menu" draggable="true">
      <span class="material-icons">drag_indicator</span>
    </button>
  `;
  g.style.display = 'none';
  document.body.appendChild(g);

  g.querySelector('[data-action="add"]')?.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!hoveredBlock || !editor) return;
    const pos = editor.view.posAtDOM(hoveredBlock, 0);
    // Insert paragraph after hovered block then open slash menu at new pos.
    const $pos = editor.state.doc.resolve(pos);
    const blockEnd = $pos.end($pos.depth);
    editor
      .chain()
      .focus(blockEnd + 1)
      .insertContentAt(blockEnd + 1, { type: 'paragraph' })
      .run();
    requestAnimationFrame(() => showSlashMenu());
  });

  const grip = g.querySelector('[data-action="grip"]') as HTMLElement | null;
  if (grip) {
    grip.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      if (!hoveredBlock || !editor) return;
      const pos = editor.view.posAtDOM(hoveredBlock, 0);
      const resolved = editor.state.doc.resolve(pos);
      const nodePos = resolved.before(resolved.depth);
      try {
        editor.view.dispatch(
          editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, nodePos)),
        );
      } catch {
        // selection may not be valid (e.g. doc root)
      }
    });
    grip.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!hoveredBlock || !editor) return;
      const rect = (grip as HTMLElement).getBoundingClientRect();
      openBlockMenu(rect);
    });
  }

  return g;
};

const positionGutter = (block: HTMLElement | null): void => {
  if (!gutterEl) return;
  if (!block) {
    gutterEl.style.display = 'none';
    hoveredBlock = null;
    return;
  }
  const rect = block.getBoundingClientRect();
  gutterEl.style.display = 'flex';
  gutterEl.style.top = `${rect.top + window.scrollY}px`;
  gutterEl.style.left = `${rect.left + window.scrollX - 52}px`;
  gutterEl.style.height = `${Math.max(28, rect.height)}px`;
  hoveredBlock = block;
};

const findBlockFromEvent = (ev: MouseEvent): HTMLElement | null => {
  if (!editor) return null;
  const target = ev.target as HTMLElement | null;
  if (!target) return null;
  const root = editor.view.dom as HTMLElement;
  if (!root.contains(target) && target !== gutterEl && !gutterEl?.contains(target)) {
    return null;
  }
  // Walk up to the direct child of .ProseMirror.
  let node: HTMLElement | null = target;
  while (node && node.parentElement && node.parentElement !== root) {
    node = node.parentElement;
  }
  return node && node.parentElement === root ? node : null;
};

const openBlockMenu = (anchorRect: DOMRect): void => {
  if (!editor || !hoveredBlock) return;
  const ed = editor;
  const pos = ed.view.posAtDOM(hoveredBlock, 0);
  const $pos = ed.state.doc.resolve(pos);
  const nodePos = $pos.before($pos.depth);

  const items: MenuItem[] = [
    {
      label: 'Turn into paragraph',
      icon: 'segment',
      action: () => ed.chain().focus().setNodeSelection(nodePos).setParagraph().run(),
    },
    {
      label: 'Turn into H1',
      icon: 'title',
      action: () =>
        ed.chain().focus().setNodeSelection(nodePos).setHeading({ level: 1 }).run(),
    },
    {
      label: 'Turn into H2',
      icon: 'text_fields',
      action: () =>
        ed.chain().focus().setNodeSelection(nodePos).setHeading({ level: 2 }).run(),
    },
    {
      label: 'Turn into H3',
      icon: 'short_text',
      action: () =>
        ed.chain().focus().setNodeSelection(nodePos).setHeading({ level: 3 }).run(),
    },
    {
      label: 'Duplicate',
      icon: 'content_copy',
      action: () => {
        const node = ed.state.doc.nodeAt(nodePos);
        if (!node) return;
        ed.chain()
          .focus()
          .insertContentAt(nodePos + node.nodeSize, node.toJSON())
          .run();
      },
    },
    {
      label: 'Delete',
      icon: 'delete',
      action: () => {
        ed.chain().focus().setNodeSelection(nodePos).deleteSelection().run();
      },
    },
  ];

  menuActiveIndex = 0;
  menuFilter = '';
  renderMenu(anchorRect, items);
};

/* -------------------------------------------------------------------------- */
/* Mount                                                                       */
/* -------------------------------------------------------------------------- */

const mount = async (): Promise<void> => {
  await loadStoredState();
  const initialCtx = await PluginAPI.getActiveWorkContext();

  const root = document.getElementById('editor-root');
  if (!root) {
    PluginAPI.log.err('Document mode: #editor-root not found');
    return;
  }

  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'bubble-menu';
  bubbleEl.innerHTML = `
    <button data-action="bold" title="Bold"><b>B</b></button>
    <button data-action="italic" title="Italic"><i>I</i></button>
    <button data-action="strike" title="Strike"><s>S</s></button>
    <button data-action="code" title="Code"><code>{}</code></button>
  `;
  document.body.appendChild(bubbleEl);

  editor = new Editor({
    element: root,
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Type '/' for commands…" }),
      TaskRefNode,
      BubbleMenu.configure({
        element: bubbleEl,
        shouldShow: ({ from, to, state }) => {
          if (from === to) return false;
          // Don't show on atom node selections (taskRef).
          const node = state.doc.nodeAt(from);
          if (node?.isAtom) return false;
          return true;
        },
      }),
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    onUpdate: () => {
      reconcileTitlesFromDoc();
      scheduleSave();
    },
  });

  bubbleEl.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const action = (btn as HTMLElement).dataset.action;
      if (!editor) return;
      const chain = editor.chain().focus();
      if (action === 'bold') chain.toggleBold().run();
      else if (action === 'italic') chain.toggleItalic().run();
      else if (action === 'strike') chain.toggleStrike().run();
      else if (action === 'code') chain.toggleCode().run();
    });
  });

  gutterEl = createGutter();

  root.addEventListener('mousemove', (ev) => {
    cancelHideGutter();
    const block = findBlockFromEvent(ev);
    if (block !== hoveredBlock) positionGutter(block);
  });
  root.addEventListener('mouseleave', (ev) => {
    const next = ev.relatedTarget as HTMLElement | null;
    if (next && gutterEl?.contains(next)) return;
    // Debounce: gives the mouse ~200 ms to reach the gutter across the gap.
    scheduleHideGutter();
  });
  gutterEl.addEventListener('mouseenter', () => {
    cancelHideGutter();
  });
  gutterEl.addEventListener('mouseleave', (ev) => {
    const next = ev.relatedTarget as HTMLElement | null;
    if (next && (root.contains(next) || gutterEl?.contains(next))) return;
    scheduleHideGutter();
  });

  editor.view.dom.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (menuEl) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeMenu();
        return;
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (menuCurrentItems.length === 0) return;
        if (ev.key === 'ArrowDown') {
          menuActiveIndex = (menuActiveIndex + 1) % menuCurrentItems.length;
        } else {
          menuActiveIndex =
            (menuActiveIndex - 1 + menuCurrentItems.length) % menuCurrentItems.length;
        }
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          renderMenu(sel.getRangeAt(0).getBoundingClientRect(), menuCurrentItems);
        }
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (menuCurrentItems[menuActiveIndex]) {
          const action = menuCurrentItems[menuActiveIndex].action;
          closeMenu();
          action();
        }
        return;
      }
      if (ev.key === 'Backspace') {
        if (menuFilter === '') {
          closeMenu();
        } else {
          menuFilter = menuFilter.slice(0, -1);
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            filterAndRender(sel.getRangeAt(0).getBoundingClientRect());
          }
        }
        return;
      }
      if (ev.key.length === 1) {
        menuFilter += ev.key;
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          filterAndRender(sel.getRangeAt(0).getBoundingClientRect());
        }
        return;
      }
    } else if (ev.key === '/') {
      setTimeout(() => showSlashMenu(), 0);
    }
  });

  document.addEventListener('mousedown', (ev) => {
    if (menuEl && ev.target instanceof globalThis.Node && !menuEl.contains(ev.target)) {
      closeMenu();
    }
  });

  await setActiveContext(initialCtx);

  PluginAPI.registerHook(PluginHooks.WORK_CONTEXT_CHANGE, (payload) => {
    void setActiveContext(payload as WorkContextChangePayload);
  });
  PluginAPI.registerHook(PluginHooks.ANY_TASK_UPDATE, (payload) => {
    onAnyTaskUpdate(payload as AnyTaskUpdatePayload);
  });

  window.addEventListener('pagehide', () => {
    void flushSave();
  });
};

const waitForPluginAPI = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const check = (): void => {
      if (
        typeof (window as unknown as { PluginAPI?: unknown }).PluginAPI !== 'undefined'
      ) {
        resolve();
      } else {
        setTimeout(check, 20);
      }
    };
    check();
  });

void waitForPluginAPI().then(() => mount());
