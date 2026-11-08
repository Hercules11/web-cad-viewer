/** 撤销/重做命令栈 */
import type { EntRecord } from '../core/types';
import type { Doc } from './document';

export interface Command {
  label: string;
  undo(): void;
  redo(): void;
}

export class UndoStack {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private limit = 100;

  push(cmd: Command): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): Command | null {
    const cmd = this.undoStack.pop() ?? null;
    if (cmd) { cmd.undo(); this.redoStack.push(cmd); }
    return cmd;
  }

  redo(): Command | null {
    const cmd = this.redoStack.pop() ?? null;
    if (cmd) { cmd.redo(); this.undoStack.push(cmd); }
    return cmd;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** 新增实体 */
export class AddCommand implements Command {
  label = '添加实体';
  constructor(private doc: Doc, private recs: EntRecord[]) {}

  undo(): void {
    this.doc.removeRecords(this.recs.map((r) => r.id));
  }

  redo(): void {
    this.doc.restoreRecords(this.recs);
  }
}

/** 删除实体 */
export class DeleteCommand implements Command {
  label = '删除实体';
  constructor(private doc: Doc, public recs: EntRecord[]) {}

  undo(): void {
    this.doc.restoreRecords(this.recs);
  }

  redo(): void {
    this.doc.deleteRecords(this.recs.map((r) => r.id));
  }
}

/** 移动实体 */
export class MoveCommand implements Command {
  label = '移动实体';
  constructor(private doc: Doc, private ids: number[], private dx: number, private dy: number) {}

  undo(): void {
    this.doc.moveRecords(this.ids, -this.dx, -this.dy);
  }

  redo(): void {
    this.doc.moveRecords(this.ids, this.dx, this.dy);
  }
}
